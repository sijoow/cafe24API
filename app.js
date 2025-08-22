// app.js (완성본: uninstall 정리 포함)
require('dotenv').config();
process.env.TZ = 'Asia/Seoul';

const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const compression = require('compression');
const bodyParser = require('body-parser');
const axios = require('axios');
const multer = require('multer');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
const { MongoClient, ObjectId } = require('mongodb');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

dayjs.extend(utc);
dayjs.extend(tz);

const {
  // --- 필수 ENV ---
  MONGODB_URI,
  DB_NAME,
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  CAFE24_API_VERSION,
  FRONTEND_URL,          // 예: https://onimon.shop
  BACKEND_URL,           // 예: https://port-0-...cloudtype.app
  CAFE24_SCOPES,         // 예: mall.read_store,mall.read_product,...

  // --- 서버/스토리지 ---
  PORT = 5000,
  R2_ACCESS_KEY,
  R2_SECRET_KEY,
  R2_BUCKET_NAME,
  R2_ENDPOINT,
  R2_REGION = 'us-east-1',
  R2_PUBLIC_BASE,

  // --- 언인스톨 보안 토큰(선택) ---
  UNINSTALL_TOKEN
} = process.env;

// ---- ENV 체크 ----
if (!MONGODB_URI || !DB_NAME) {
  console.error('❌ MONGODB_URI / DB_NAME 환경변수 필요');
  process.exit(1);
}
if (!CAFE24_CLIENT_ID || !CAFE24_CLIENT_SECRET) {
  console.error('❌ CAFE24_CLIENT_ID / CAFE24_CLIENT_SECRET 환경변수 필요');
  process.exit(1);
}
if (!FRONTEND_URL || !BACKEND_URL) {
  console.error('❌ FRONTEND_URL / BACKEND_URL 환경변수 필요');
  process.exit(1);
}
if (!CAFE24_SCOPES) {
  console.error('❌ CAFE24_SCOPES 환경변수 필요 (개발자센터 Permissions와 동일)');
  process.exit(1);
}

// 트레일링 슬래시 방지
const stripSlash = (s) => (s || '').replace(/\/+$/, '');
const FRONTEND_BASE = stripSlash(FRONTEND_URL);
const BACKEND_BASE  = stripSlash(BACKEND_URL);
const REDIRECT_URI  = `${BACKEND_BASE}/auth/callback`;

const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── 요청 로거 (디버깅용) ─────────────────────────────────────────
app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.originalUrl, req.query || {});
  next();
});

// ─── MongoDB 연결 ───────────────────────────────────────────────
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  await client.connect();
  db = client.db(DB_NAME);
  await db.collection('token').createIndex({ mallId: 1 }, { unique: true });
  console.log('▶️ MongoDB connected to', DB_NAME);
}

// ─── Multer (파일 업로드 임시저장) ───────────────────────────────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// ─── R2 (AWS S3 호환) 클라이언트 ───────────────────────────────
const s3Client = new S3Client({
  region:   R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId:     R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
  forcePathStyle: true,
});

// ─── OAuth Authorize URL 빌더 ───────────────────────────────────
function buildAuthorizeUrl(mallId) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CAFE24_CLIENT_ID,
    redirect_uri:  REDIRECT_URI, // 반드시 백엔드 콜백
    scope:         CAFE24_SCOPES, // 개발자센터와 100% 동일
    state:         mallId,
  });
  return `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params.toString()}`;
}

// ─── 언인스톨시 데이터 정리 유틸 ───────────────────────────────
async function cleanupMallData(mallId) {
  // 1) 토큰 삭제
  await db.collection('token').deleteOne({ mallId });

  // 2) 테넌트 데이터 정리(존재할 때만)
  const dropIfExists = async (name) => {
    try {
      const exists = await db.listCollections({ name }).hasNext();
      if (exists) await db.collection(name).drop();
    } catch (e) {
      if (e.codeName !== 'NamespaceNotFound') throw e;
    }
  };

  await Promise.allSettled([
    db.collection('events').deleteMany({ mallId }),
    dropIfExists(`visits_${mallId}`),
    dropIfExists(`clicks_${mallId}`),
    dropIfExists(`prdClick_${mallId}`),
  ]);

  console.log(`[UNINSTALL CLEANUP] mallId=${mallId} done`);
}

// ===================================================================
// ① 설치 시작 → 권한요청
// ===================================================================
app.get('/install/:mallId', (req, res) => {
  const { mallId } = req.params;
  const url = buildAuthorizeUrl(mallId);
  console.log('[INSTALL REDIRECT]', url);
  res.redirect(url);
});

// ===================================================================
// ② 콜백 (code → 토큰) → DB 저장 → 프론트로 리다이렉트
// ===================================================================
app.get('/auth/callback', async (req, res) => {
  const { code, state: mallId, error, error_description } = req.query;

  if (error) {
    console.error('[AUTH CALLBACK ERROR FROM PROVIDER]', error, error_description);
    return res.redirect(`${FRONTEND_BASE}/?auth_error=${encodeURIComponent(error)}&mall_id=${encodeURIComponent(mallId || '')}`);
  }
  if (!code || !mallId) {
    return res.status(400).send('code 또는 mallId가 없습니다.');
  }

  try {
    const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
    const creds    = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const body     = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: REDIRECT_URI // authorize와 완전히 동일해야 함
    }).toString();

    const { data } = await axios.post(tokenUrl, body, {
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`
      }
    });

    // DB에 토큰 저장
    await db.collection('token').updateOne(
      { mallId },
      {
        $set: {
          mallId,
          accessToken:  data.access_token,
          refreshToken: data.refresh_token,
          obtainedAt:   new Date(),
          expiresIn:    data.expires_in,
          raw: data
        }
      },
      { upsert: true }
    );

    console.log(`[AUTH CALLBACK] installed mallId=${mallId}`);

    // 프론트로 mall_id 전달
    return res.redirect(`${FRONTEND_BASE}/?mall_id=${encodeURIComponent(mallId)}`);
  } catch (err) {
    console.error('[AUTH CALLBACK ERROR]', err.response?.data || err.message || err);
    return res.status(500).send('토큰 교환 중 오류가 발생했습니다.');
  }
});

// 프론트 redirect 호환 포워드(선택)
app.get('/redirect', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const target = `${FRONTEND_BASE}/redirect${qs ? ('?' + qs) : ''}`;
  console.log('[REDIRECT FORWARD] ->', target);
  return res.redirect(target);
});

// ===================================================================
// ③ mallId-aware API 요청 헬퍼 (refresh + uninstall 방어)
// ===================================================================
async function refreshAccessToken(mallId, refreshToken) {
  const url   = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
  const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken
  }).toString();

  const { data } = await axios.post(url, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`
    }
  });

  await db.collection('token').updateOne(
    { mallId },
    { $set: {
        accessToken:  data.access_token,
        refreshToken: data.refresh_token,
        obtainedAt:   new Date(),
        expiresIn:    data.expires_in,
        raw_refresh_response: data
      }
    }
  );

  console.log(`[TOKEN REFRESH] mallId=${mallId}`);
  return data.access_token;
}

async function apiRequest(mallId, method, url, data = {}, params = {}) {
  const doc = await db.collection('token').findOne({ mallId });
  if (!doc) throw new Error(`토큰 정보 없음: mallId=${mallId}`);

  try {
    const resp = await axios({
      method, url, data, params,
      headers: {
        Authorization:          `Bearer ${doc.accessToken}`,
        'Content-Type':         'application/json',
        'X-Cafe24-Api-Version': CAFE24_API_VERSION,
      }
    });
    return resp.data;
  } catch (err) {
    const status = err.response?.status;

    // 액세스 토큰 만료 → refresh 시도
    if (status === 401 && doc.refreshToken) {
      try {
        const newAccess = await refreshAccessToken(mallId, doc.refreshToken);
        const retry = await axios({
          method, url, data, params,
          headers: {
            Authorization:          `Bearer ${newAccess}`,
            'Content-Type':         'application/json',
            'X-Cafe24-Api-Version': CAFE24_API_VERSION,
          }
        });
        return retry.data;
      } catch (refreshErr) {
        const code = refreshErr.response?.data?.error || refreshErr.response?.data?.code;
        // refresh 자체가 invalid_grant 등으로 실패 → 언인스톨로 간주하고 정리
        if (code === 'invalid_grant' || refreshErr.response?.status === 400) {
          console.warn('[TOKEN INVALID] uninstall assumed, cleaning up…', { mallId, code });
          await cleanupMallData(mallId);
          const e = new Error('APP_UNINSTALLED');
          e.status = 410; // 프론트가 재설치 유도할 수 있게 410 사용
          throw e;
        }
        throw refreshErr;
      }
    }
    throw err;
  }
}

// ===================================================================
// ④ 공용 / 설치여부 확인 / 디버그
// ===================================================================

// Ping
app.get('/api/:mallId/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// 설치 여부 확인 (프론트 Redirect.jsx가 호출)
app.get('/api/:mallId/mall', async (req, res) => {
  const { mallId } = req.params;
  try {
    const doc = await db.collection('token').findOne({ mallId });
    if (doc?.accessToken) {
      return res.json({
        installed: true,
        mallId,
        userId:   doc.userId   || null,
        userName: doc.userName || null
      });
    }
    const installUrl = buildAuthorizeUrl(mallId);
    console.log(`[INSTALL NEEDED] mallId=${mallId} -> ${installUrl}`);
    return res.json({ installed: false, mallId, installUrl });
  } catch (err) {
    console.error('[MALL INFO ERROR]', err);
    return res.status(500).json({ error: 'mall info fetch failed' });
  }
});

// (디버깅) 토큰 존재 확인
app.get('/debug/tokens/:mallId', async (req, res) => {
  const { mallId } = req.params;
  try {
    const doc = await db.collection('token').findOne({ mallId });
    res.json({
      mallId,
      exists: !!doc,
      hasAccessToken: !!doc?.accessToken,
      hasRefreshToken: !!doc?.refreshToken,
      obtainedAt: doc?.obtainedAt || null,
      expiresIn: doc?.expiresIn || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===================================================================
// ⑤ 언인스톨(Webhook) 콜백
// ===================================================================
// 개발자센터에 등록: POST/GET  https://<백엔드>/cafe24/uninstalled?token=<UNINSTALL_TOKEN>
app.all('/cafe24/uninstalled', async (req, res) => {
  try {
    const token = req.query.token || req.get('X-Webhook-Token');
    if (UNINSTALL_TOKEN && token !== UNINSTALL_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const mallId =
      req.query.mall_id || req.query.mallId ||
      req.body?.mall_id || req.body?.mallId ||
      req.query.site || req.body?.site;

    if (!mallId) {
      console.warn('[UNINSTALL] missing mallId', { query: req.query, body: req.body });
      return res.json({ ok: true, note: 'no mallId, skipped' });
    }

    await cleanupMallData(mallId);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[UNINSTALL CALLBACK ERROR]', e);
    // 재시도 방지 위해 200으로 마무리하는 편이 안전
    return res.json({ ok: true });
  }
});

// ===================================================================
// ⑥ 기능 엔드포인트들
// ===================================================================

// ─── 이미지 업로드 (Multer + R2/S3) ─────────────────────────────
app.post('/api/:mallId/uploads/image', upload.single('file'), async (req, res) => {
  try {
    const { mallId } = req.params;
    const { filename, path: localPath, mimetype } = req.file;
    const key = `uploads/${mallId}/${filename}`;

    await s3Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key:    key,
      Body:   fs.createReadStream(localPath),
      ContentType: mimetype,
      ACL:    'public-read'
    }));

    fs.unlink(localPath, () => {});
    const url = `${R2_PUBLIC_BASE}/${key}`;
    res.json({ url });
  } catch (err) {
    console.error('[IMAGE UPLOAD ERROR]', err);
    res.status(500).json({ error: '이미지 업로드 실패' });
  }
});

// ─── Events: 생성 ───────────────────────────────────────────────
app.post('/api/:mallId/events', async (req, res) => {
  const { mallId } = req.params;
  const payload = req.body;

  if (!payload.title || typeof payload.title !== 'string') {
    return res.status(400).json({ error: '제목(title)을 입력해주세요.' });
  }
  if (!Array.isArray(payload.images)) {
    return res.status(400).json({ error: 'images를 배열로 보내주세요.' });
  }

  try {
    const now = new Date();
    const doc = {
      mallId,
      title: payload.title.trim(),
      content: payload.content || '',
      images: payload.images,
      gridSize: payload.gridSize || null,
      layoutType: payload.layoutType || 'none',
      classification: payload.classification || {},
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection('events').insertOne(doc);
    res.json({ _id: result.insertedId, ...doc });
  } catch (err) {
    console.error('[CREATE EVENT ERROR]', err);
    res.status(500).json({ error: '이벤트 생성에 실패했습니다.' });
  }
});

// ─── Events: 목록 ───────────────────────────────────────────────
app.get('/api/:mallId/events', async (req, res) => {
  const { mallId } = req.params;
  try {
    const list = await db
      .collection('events')
      .find({ mallId })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(list);
  } catch (err) {
    console.error('[GET EVENTS ERROR]', err);
    res.status(500).json({ error: '이벤트 목록 조회에 실패했습니다.' });
  }
});

// ─── Events: 단건 ───────────────────────────────────────────────
app.get('/api/:mallId/events/:id', async (req, res) => {
  const { mallId, id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
  }
  try {
    const ev = await db.collection('events').findOne({
      _id: new ObjectId(id),
      mallId
    });
    if (!ev) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    res.json(ev);
  } catch (err) {
    console.error('[GET EVENT ERROR]', err);
    res.status(500).json({ error: '이벤트 조회에 실패했습니다.' });
  }
});

// ─── Events: 수정 ───────────────────────────────────────────────
app.put('/api/:mallId/events/:id', async (req, res) => {
  const { mallId, id } = req.params;
  const payload = req.body;

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
  }
  if (!payload.title && !payload.content && !payload.images) {
    return res.status(400).json({ error: '수정할 내용을 하나 이상 보내주세요.' });
  }

  const update = { updatedAt: new Date() };
  if (payload.title)   update.title   = payload.title.trim();
  if (payload.content) update.content = payload.content;
  if (Array.isArray(payload.images)) update.images = payload.images;
  if (payload.gridSize !== undefined)   update.gridSize   = payload.gridSize;
  if (payload.layoutType)               update.layoutType = payload.layoutType;
  if (payload.classification)           update.classification = payload.classification;

  try {
    const result = await db.collection('events').updateOne(
      { _id: new ObjectId(id), mallId },
      { $set: update }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    }
    const updated = await db.collection('events').findOne({ _id: new ObjectId(id) });
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[UPDATE EVENT ERROR]', err);
    res.status(500).json({ error: '이벤트 수정에 실패했습니다.' });
  }
});

// ─── Events: 삭제 (연관 로그도 삭제) ────────────────────────────
app.delete('/api/:mallId/events/:id', async (req, res) => {
  const { mallId, id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
  }
  const eventId = new ObjectId(id);
  const visitsColl = `visits_${mallId}`;
  const clicksColl = `clicks_${mallId}`;

  try {
    const { deletedCount } = await db.collection('events').deleteOne({
      _id: eventId,
      mallId
    });
    if (!deletedCount) {
      return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    }

    await Promise.all([
      db.collection(visitsColl).deleteMany({ pageId: id }),
      db.collection(clicksColl).deleteMany({ pageId: id })
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE EVENT ERROR]', err);
    res.status(500).json({ error: '이벤트 삭제에 실패했습니다.' });
  }
});

// ─── 트래킹 수집 ────────────────────────────────────────────────
app.post('/api/:mallId/track', async (req, res) => {
  try {
    const { mallId } = req.params;
    const {
      pageId, pageUrl, visitorId, referrer,
      device, type, element, timestamp,
      productNo
    } = req.body;

    if (!pageId || !visitorId || !type || !timestamp) {
      return res.status(400).json({ error: '필수 필드 누락' });
    }
    if (!ObjectId.isValid(pageId)) {
      return res.sendStatus(204);
    }

    const ev = await db.collection('events')
                       .findOne({ _id: new ObjectId(pageId) }, { projection:{ _id:1 } });
    if (!ev) return res.sendStatus(204);

    const kstTs   = dayjs(timestamp).tz('Asia/Seoul').toDate();
    const dateKey = dayjs(timestamp).tz('Asia/Seoul').format('YYYY-MM-DD');

    let pathOnly;
    try { pathOnly = new URL(pageUrl).pathname; } catch { pathOnly = pageUrl; }

    // 상품 클릭 → prdClick_{mallId} upsert
    if (type === 'click' && element === 'product' && productNo) {
      let productName = null;
      try {
        const productRes = await apiRequest(
          mallId,
          'GET',
          `https://${mallId}.cafe24api.com/api/v2/admin/products/${productNo}`,
          {},
          { shop_no: 1 }
        );
        const prod = productRes.product || productRes.products?.[0];
        productName = prod?.product_name || null;
      } catch (err) {
        console.error('[PRODUCT NAME FETCH ERROR]', err);
      }

      const filter = { pageId, productNo };
      const update = {
        $inc: { clickCount: 1 },
        $setOnInsert: {
          productName,
          firstClickAt: kstTs,
          pageUrl:      pathOnly,
          referrer:     referrer || null,
          device:       device   || null
        },
        $set: { lastClickAt: kstTs }
      };
      await db.collection(`prdClick_${mallId}`).updateOne(filter, update, { upsert: true });
      return res.sendStatus(204);
    }

    // 기타 클릭 → clicks_{mallId}
    if (type === 'click') {
      // 쿠폰(배열 가능)
      if (element === 'coupon') {
        const coupons = Array.isArray(productNo) ? productNo : [productNo];
        await Promise.all(coupons.map(cpn => {
          const clickDoc = {
            pageId, visitorId, dateKey, pageUrl: pathOnly,
            referrer: referrer || null, device: device || null,
            type, element, timestamp: kstTs, couponNo: cpn
          };
          return db.collection(`clicks_${mallId}`).insertOne(clickDoc);
        }));
        return res.sendStatus(204);
      }
      // 일반 URL
      if (element === 'url') {
        const clickDoc = {
          pageId, visitorId, dateKey, pageUrl: pathOnly,
          referrer: referrer || null, device: device || null,
          type, element, timestamp: kstTs
        };
        await db.collection(`clicks_${mallId}`).insertOne(clickDoc);
        return res.sendStatus(204);
      }
      // 그 외
      const clickDoc = {
        pageId, visitorId, dateKey, pageUrl: pathOnly,
        referrer: referrer || null, device: device || null,
        type, element, timestamp: kstTs
      };
      await db.collection(`clicks_${mallId}`).insertOne(clickDoc);
      return res.sendStatus(204);
    }

    // view / revisit → visits_{mallId} upsert
    const filter2 = { pageId, visitorId, dateKey };
    const update2 = {
      $set: {
        lastVisit: kstTs,
        pageUrl:   pathOnly,
        referrer:  referrer || null,
        device:    device   || null
      },
      $setOnInsert: { firstVisit: kstTs },
      $inc: {}
    };
    if (type === 'view')    update2.$inc.viewCount    = 1;
    if (type === 'revisit') update2.$inc.revisitCount = 1;

    await db.collection(`visits_${mallId}`).updateOne(filter2, update2, { upsert: true });
    return res.sendStatus(204);
  } catch (err) {
    console.error('[TRACK ERROR]', err);
    return res.status(500).json({ error: '트래킹 실패' });
  }
});

// ─── 카테고리 전체 ────────────────────────────────────────────
app.get('/api/:mallId/categories/all', async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/categories`;
      const { categories = [] } = await apiRequest(mallId, 'GET', url, {}, { limit, offset });
      if (!categories.length) break;
      all.push(...categories);
      offset += categories.length;
    }
    res.json(all);
  } catch (err) {
    console.error('[CATEGORIES ERROR]', err);
    res.status(500).json({ message: '전체 카테고리 조회 실패', error: err.message });
  }
});

// ─── 쿠폰 전체 ────────────────────────────────────────────────
app.get('/api/:mallId/coupons', async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons = [] } = await apiRequest(mallId, 'GET', url, {}, { shop_no:1, limit, offset });
      if (!coupons.length) break;
      all.push(...coupons);
      offset += coupons.length;
    }
    res.json(all);
  } catch (err) {
    console.error('[COUPONS ERROR]', err);
    res.status(500).json({ message: '쿠폰 조회 실패', error: err.message });
  }
});

// ─── 쿠폰 통계(발급/사용/미사용/자동삭제) ─────────────────────────
app.get('/api/:mallId/analytics/:pageId/coupon-stats', async (req, res) => {
  const { mallId } = req.params;
  const { coupon_no, start_date, end_date } = req.query;
  if (!coupon_no) return res.status(400).json({ error: 'coupon_no is required' });

  const shop_no   = 1;
  const couponNos = coupon_no.split(',');
  const now       = new Date();
  const results   = [];

  try {
    for (const no of couponNos) {
      // 쿠폰명 확보
      let couponName = '(이름없음)';
      try {
        const nameRes = await apiRequest(
          mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/coupons`, {}, {
            shop_no, coupon_no: no, coupon_status: 'ALL',
            fields: 'coupon_no,coupon_name', limit: 1
          }
        );
        couponName = nameRes.coupons?.[0]?.coupon_name || couponName;
      } catch {}

      // issues 페이지네이션
      let issued = 0, used = 0, unused = 0, autoDel = 0;
      const pageSize = 500;
      for (let offset = 0; ; offset += pageSize) {
        const issuesRes = await apiRequest(
          mallId, 'GET',
          `https://${mallId}.cafe24api.com/api/v2/admin/coupons/${no}/issues`,
          {},
          { shop_no, limit: pageSize, offset, issued_start_date: start_date, issued_end_date: end_date }
        );
        const issues = issuesRes.issues || [];
        if (issues.length === 0) break;

        for (const item of issues) {
          issued++;
          if (item.used_coupon === 'T') used++;
          else {
            const exp = item.expiration_date ? new Date(item.expiration_date) : null;
            if (exp && exp < now) autoDel++;
            else unused++;
          }
        }
      }

      results.push({
        couponNo:         no,
        couponName,
        issuedCount:      issued,
        usedCount:        used,
        unusedCount:      unused,
        autoDeletedCount: autoDel
      });
    }

    return res.json(results);
  } catch (err) {
    console.error('[COUPON-STATS ERROR]', err);
    return res.status(500).json({ error: '쿠폰 통계 조회 실패', message: err.response?.data?.message || err.message });
  }
});

// ─── 카테고리별 상품 + 쿠폰 적용가 계산 ──────────────────────────
app.get('/api/:mallId/categories/:category_no/products', async (req, res) => {
  const { mallId, category_no } = req.params;
  try {
    const coupon_query = req.query.coupon_no || '';
    const coupon_nos   = coupon_query ? coupon_query.split(',') : [];
    const limit        = parseInt(req.query.limit, 10)  || 100;
    const offset       = parseInt(req.query.offset, 10) || 0;
    const shop_no      = 1;
    const display_group = 1;

    // 쿠폰 정보
    const coupons = await Promise.all(coupon_nos.map(async no => {
      const urlCoupon = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons: arr } = await apiRequest(mallId, 'GET', urlCoupon, {}, {
        shop_no,
        coupon_no: no,
        fields: [
          'coupon_no',
          'available_product','available_product_list',
          'available_category','available_category_list',
          'benefit_amount','benefit_percentage'
        ].join(',')
      });
      return arr?.[0] || null;
    }));
    const validCoupons = coupons.filter(c => c);

    // 카테고리 상품
    const urlCats = `https://${mallId}.cafe24api.com/api/v2/admin/categories/${category_no}/products`;
    const catRes  = await apiRequest(mallId, 'GET', urlCats, {}, { shop_no, display_group, limit, offset });
    const sorted  = (catRes.products||[]).slice().sort((a,b)=>a.sequence_no-b.sequence_no);
    const productNos = sorted.map(p=>p.product_no);
    if (!productNos.length) return res.json([]);

    // 상세
    const urlProds = `https://${mallId}.cafe24api.com/api/v2/admin/products`;
    const detailRes = await apiRequest(mallId, 'GET', urlProds, {}, {
      shop_no, product_no: productNos.join(','), limit: productNos.length
    });
    const details = detailRes.products || [];
    const detailMap = details.reduce((m,p)=>{ m[p.product_no]=p; return m; },{});

    // 즉시할인가
    const discountMap = {};
    await Promise.all(productNos.map(async no => {
      const urlDis = `https://${mallId}.cafe24api.com/api/v2/admin/products/${no}/discountprice`;
      const { discountprice } = await apiRequest(mallId, 'GET', urlDis, {}, { shop_no });
      discountMap[no] = discountprice?.pc_discount_price != null
        ? parseFloat(discountprice.pc_discount_price)
        : null;
    }));

    const formatKRW = num => num!=null ? Number(num).toLocaleString('ko-KR') + '원' : null;

    function calcCouponInfos(prodNo) {
      return validCoupons.map(coupon=>{
        const pList = coupon.available_product_list||[];
        const prodOk = coupon.available_product==='U'
          || (coupon.available_product==='I' && pList.includes(prodNo))
          || (coupon.available_product==='E' && !pList.includes(prodNo));
        const cList = coupon.available_category_list||[];
        const catOk = coupon.available_category==='U'
          || (coupon.available_category==='I' && cList.includes(parseInt(category_no,10)))
          || (coupon.available_category==='E' && !cList.includes(parseInt(category_no,10)));
        if (!prodOk||!catOk) return null;
        const orig = parseFloat(detailMap[prodNo].price||0);
        const pct  = parseFloat(coupon.benefit_percentage||0);
        const amt  = parseFloat(coupon.benefit_amount||0);
        let benefit_price = null;
        if (pct>0) benefit_price = +(orig*(100-pct)/100).toFixed(2);
        else if (amt>0) benefit_price = +(orig-amt).toFixed(2);
        if (benefit_price==null) return null;
        return { coupon_no: coupon.coupon_no, benefit_percentage: pct, benefit_price };
      }).filter(Boolean).sort((a,b)=>b.benefit_percentage-a.benefit_percentage);
    }

    const full = sorted.map(item=>{
      const prod = detailMap[item.product_no];
      if (!prod) return null;
      return {
        product_no: item.product_no,
        product_name: prod.product_name,
        price: prod.price,
        summary_description: prod.summary_description,
        list_image: prod.list_image,
        sale_price: discountMap[item.product_no],
        couponInfos: calcCouponInfos(item.product_no)
      };
    }).filter(Boolean);

    const slim = full.map(p=>{
      const infos = p.couponInfos||[];
      const first = infos.length?infos[0]:null;
      return {
        product_no: p.product_no,
        product_name: p.product_name,
        price: formatKRW(parseFloat(p.price)),
        summary_description: p.summary_description,
        list_image: p.list_image,
        sale_price: (p.sale_price!=null && +p.sale_price!==+p.price)?formatKRW(p.sale_price):null,
        benefit_price: first?formatKRW(first.benefit_price):null,
        benefit_percentage: first?first.benefit_percentage:null,
        couponInfos: infos.length?infos:null
      };
    });

    res.json(slim);
  } catch (err) {
    console.error('[CATEGORY PRODUCTS ERROR]', err);
    res.status(err.response?.status||500).json({ message: '카테고리 상품 조회 실패', error: err.message });
  }
});

// ─── 전체 상품 (검색/페이징) ────────────────────────────────────
app.get('/api/:mallId/products', async (req, res) => {
  const { mallId } = req.params;
  try {
    const shop_no = 1;
    const limit   = parseInt(req.query.limit, 10)||1000;
    const offset  = parseInt(req.query.offset,10)||0;
    const q       = (req.query.q||'').trim();
    const url     = `https://${mallId}.cafe24api.com/api/v2/admin/products`;

    const params = { shop_no, limit, offset };
    if (q) params['search[product_name]'] = q;

    const data = await apiRequest(mallId, 'GET', url, {}, params);
    const slim = (data.products||[]).map(p=>({
      product_no: p.product_no,
      product_code: p.product_code,
      product_name: p.product_name,
      price: p.price,
      list_image: p.list_image
    }));

    res.json({ products: slim, total: data.total_count });
  } catch (err) {
    console.error('[GET PRODUCTS ERROR]', err);
    res.status(500).json({ error: '전체 상품 조회 실패' });
  }
});

// ─── 단일 상품 + 쿠폰할인가 ─────────────────────────────────────
app.get('/api/:mallId/products/:product_no', async (req, res) => {
  const { mallId, product_no } = req.params;
  try {
    const shop_no = 1;
    const coupon_query = req.query.coupon_no||'';
    const coupon_nos = coupon_query.split(',').filter(Boolean);

    const prodUrl = `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}`;
    const prodData = await apiRequest(mallId, 'GET', prodUrl, {}, { shop_no });
    const p = prodData.product||prodData.products?.[0];
    if (!p) return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });

    const disUrl = `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}/discountprice`;
    const disData = await apiRequest(mallId, 'GET', disUrl, {}, { shop_no });
    const rawSale = disData.discountprice?.pc_discount_price;
    const sale_price = rawSale != null ? parseFloat(rawSale) : null;

    const coupons = await Promise.all(coupon_nos.map(async no=>{
      const urlCoupon = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons: arr } = await apiRequest(mallId, 'GET', urlCoupon, {}, {
        shop_no,
        coupon_no: no,
        fields: [
          'coupon_no',
          'available_product','available_product_list',
          'available_category','available_category_list',
          'benefit_amount','benefit_percentage'
        ].join(',')
      });
      return arr?.[0]||null;
    }));
    const validCoupons = coupons.filter(c=>c);
    let benefit_price = null, benefit_percentage = null;
    validCoupons.forEach(coupon=>{
      const pList = coupon.available_product_list||[];
      const ok = coupon.available_product==='U'
        || (coupon.available_product==='I' && pList.includes(parseInt(product_no,10)))
        || (coupon.available_product==='E' && !pList.includes(parseInt(product_no,10)));
      if (!ok) return;
      const orig = parseFloat(p.price);
      const pct  = parseFloat(coupon.benefit_percentage||0);
      const amt  = parseFloat(coupon.benefit_amount||0);
      let bPrice = null;
      if (pct>0) bPrice = +(orig*(100-pct)/100).toFixed(2);
      else if (amt>0) bPrice = +(orig-amt).toFixed(2);
      if (bPrice!=null && pct>(benefit_percentage||0)) {
        benefit_price = bPrice;
        benefit_percentage = pct;
      }
    });

    res.json({
      product_no,
      product_code: p.product_code,
      product_name: p.product_name,
      price: p.price,
      summary_description: p.summary_description||'',
      sale_price,
      benefit_price,
      benefit_percentage,
      list_image: p.list_image
    });
  } catch (err) {
    console.error('[GET PRODUCT ERROR]', err);
    res.status(500).json({ error: '단일 상품 조회 실패' });
  }
});

// ─── Analytics: visitors-by-date ───────────────────────────────
app.get('/api/:mallId/analytics/:pageId/visitors-by-date', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });
  }

  const startKey = start_date.slice(0, 10);
  const endKey   = end_date.slice(0, 10);
  const match    = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
  if (url) match.pageUrl = url;

  const pipeline = [
    { $match: match },
    { $group: {
        _id: { date: '$dateKey', visitorId: '$visitorId' },
        viewCount:    { $sum: { $ifNull: ['$viewCount',   0] } },
        revisitCount: { $sum: { $ifNull: ['$revisitCount', 0] } }
    }},
    { $group: {
        _id: '$_id.date',
        totalVisitors:     { $sum: 1 },
        newVisitors:       { $sum: { $cond: [ { $gt: ['$viewCount',    0] }, 1, 0 ] } },
        returningVisitors: { $sum: { $cond: [ { $gt: ['$revisitCount', 0] }, 1, 0 ] } }
    }},
    { $project: {
        _id: 0,
        date: '$_id',
        totalVisitors:     1,
        newVisitors:       1,
        returningVisitors: 1,
        revisitRate: {
          $concat: [
            { $toString: {
                $round: [
                  { $multiply: [
                      { $cond: [
                          { $gt:['$totalVisitors', 0] },
                          { $divide:['$returningVisitors', '$totalVisitors'] },
                          0
                      ]},
                      100
                  ]},
                  0
                ]
              }
            },
            ' %'
          ]
        }
    }},
    { $sort: { date: 1 } }
  ];

  try {
    const stats = await db.collection(`visits_${mallId}`).aggregate(pipeline).toArray();
    res.json(stats);
  } catch (err) {
    console.error('[VISITORS-BY-DATE ERROR]', err);
    res.status(500).json({ error: '집계 중 오류가 발생했습니다.' });
  }
});

// ─── Analytics: clicks-by-date ─────────────────────────────────
app.get('/api/:mallId/analytics/:pageId/clicks-by-date', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });
  }

  const startKey = start_date.slice(0,10);
  const endKey   = end_date.slice(0,10);

  const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
  if (url) match.pageUrl = url;

  const pipeline = [
    { $match: match },
    { $group: {
        _id: { date: '$dateKey', element: '$element' },
        count: { $sum: 1 }
    }},
    { $group: {
        _id: '$_id.date',
        url:     { $sum: { $cond: [ { $eq: ['$_id.element', 'url']    }, '$count', 0 ] } },
        product: { $sum: { $cond: [ { $eq: ['$_id.element', 'product']}, '$count', 0 ] } },
        coupon:  { $sum: { $cond: [ { $eq: ['$_id.element', 'coupon'] }, '$count', 0 ] } }
    }},
    { $project: {
        _id: 0,
        date: '$_id',
        'URL 클릭':'$url',
        'URL 클릭(기존 product)': '$product',
        '쿠폰 클릭':'$coupon'
    }},
    { $sort: { date: 1 }}
  ];
  try {
    const data = await db.collection(`clicks_${mallId}`).aggregate(pipeline).toArray();
    res.json(data);
  } catch (err) {
    console.error('[CLICKS-BY-DATE ERROR]', err);
    res.status(500).json({ error: '클릭 집계에 실패했습니다.' });
  }
});

// ─── Analytics: url-clicks count (clicks_에서 집계) ─────────────
app.get('/api/:mallId/analytics/:pageId/url-clicks', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date||!end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });

  const match = {
    pageId, type:'click', element:'url',
    timestamp: { $gte: new Date(start_date), $lte: new Date(end_date) }
  };
  if (url) match.pageUrl = url;

  try {
    const count = await db.collection(`clicks_${mallId}`).countDocuments(match);
    res.json({ count });
  } catch (err) {
    console.error('[URL CLICKS COUNT ERROR]', err);
    res.status(500).json({ error: 'URL 클릭 수 조회 실패' });
  }
});

// ─── Analytics: coupon-clicks count (clicks_에서 집계) ──────────
app.get('/api/:mallId/analytics/:pageId/coupon-clicks', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date||!end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });

  const match = {
    pageId, type:'click', element:'coupon',
    timestamp: { $gte: new Date(start_date), $lte: new Date(end_date) }
  };
  if (url) match.pageUrl = url;

  try {
    const count = await db.collection(`clicks_${mallId}`).countDocuments(match);
    res.json({ count });
  } catch (err) {
    console.error('[COUPON CLICKS COUNT ERROR]', err);
    res.status(500).json({ error: '쿠폰 클릭 수 조회 실패' });
  }
});

// ─── Analytics: distinct urls (visits_) ────────────────────────
app.get('/api/:mallId/analytics/:pageId/urls', async (req, res) => {
  const { mallId, pageId } = req.params;
  try {
    const urls = await db.collection(`visits_${mallId}`).distinct('pageUrl', { pageId });
    res.json(urls);
  } catch (err) {
    console.error('[URLS DISTINCT ERROR]', err);
    res.status(500).json({ error: 'URL 목록 조회 실패' });
  }
});

// ─── Analytics: distinct couponNos (clicks_) ───────────────────
app.get('/api/:mallId/analytics/:pageId/coupons-distinct', async (req, res) => {
  const { mallId, pageId } = req.params;
  try {
    const couponNos = await db.collection(`clicks_${mallId}`).distinct('couponNo', { pageId, element: 'coupon' });
    res.json(couponNos);
  } catch (err) {
    console.error('[COUPONS-DISTINCT ERROR]', err);
    res.status(500).json({ error: '쿠폰 목록 조회 실패' });
  }
});

// ─── Analytics: devices distribution (visits_) ─────────────────
app.get('/api/:mallId/analytics/:pageId/devices', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date||!end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });

  const startKey = start_date.slice(0,10), endKey = end_date.slice(0,10);
  const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
  if (url) match.pageUrl = url;

  const pipeline = [
    { $match: match },
    { $group: {
        _id: '$device',
        count: { $sum: { $add: [ { $ifNull: ['$viewCount',0] }, { $ifNull: ['$revisitCount',0] } ] } }
    }},
    { $project: { _id:0, device_type:'$_id', count:1 }}
  ];

  try {
    const data = await db.collection(`visits_${mallId}`).aggregate(pipeline).toArray();
    res.json(data);
  } catch (err) {
    console.error('[ANALYTICS DEVICES ERROR]', err);
    res.status(500).json({ error: '디바이스 분포 집계 실패' });
  }
});

// ─── Analytics: devices by date (visits_) ──────────────────────
app.get('/api/:mallId/analytics/:pageId/devices-by-date', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date||!end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });

  const startKey = start_date.slice(0,10), endKey = end_date.slice(0,10);
  const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
  if (url) match.pageUrl = url;

  const pipeline = [
    { $match: match },
    { $group: { _id: { date:'$dateKey', device:'$device', visitor:'$visitorId' } }},
    { $group: { _id: { date:'$_id.date', device:'$_id.device' }, count: { $sum:1 } }},
    { $project: { _id:0, date:'$_id.date', device:'$_id.device', count:1 }},
    { $sort: { date:1, device:1 }}
  ];

  try {
    const data = await db.collection(`visits_${mallId}`).aggregate(pipeline).toArray();
    res.json(data);
  } catch (err) {
    console.error('[ANALYTICS DEVICES-BY-DATE ERROR]', err);
    res.status(500).json({ error: '날짜별 고유 디바이스 집계 실패' });
  }
});

// ─── Analytics: product-clicks (랭킹) ──────────────────────────
app.get('/api/:mallId/analytics/:pageId/product-clicks', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date } = req.query;

  const filter = { pageId };
  if (start_date && end_date) {
    filter.lastClickAt = { $gte: new Date(start_date), $lte: new Date(end_date) };
  }

  const docs = await db
    .collection(`prdClick_${mallId}`)
    .find(filter)
    .sort({ clickCount: -1 })
    .toArray();

  const results = docs.map(d => ({ productNo: d.productNo, clicks: d.clickCount }));
  res.json(results);
});

// ─── Analytics: product-performance (상품명 포함) ───────────────
app.get('/api/:mallId/analytics/:pageId/product-performance', async (req, res) => {
  const { mallId, pageId } = req.params;
  try {
    const clicks = await db
      .collection(`prdClick_${mallId}`)
      .aggregate([
        { $match: { pageId } },
        { $group: { _id: '$productNo', clicks: { $sum: '$clickCount' } } }
      ]).toArray();

    if (clicks.length === 0) return res.json([]);

    const productNos = clicks.map(c => c._id);

    const urlProds = `https://${mallId}.cafe24api.com/api/v2/admin/products`;
    const prodRes = await apiRequest(mallId, 'GET', urlProds, {}, {
      shop_no: 1,
      product_no: productNos.join(','),
      limit: productNos.length,
      fields: 'product_no,product_name'
    });
    const detailMap = (prodRes.products||[]).reduce((m,p) => {
      m[p.product_no] = p.product_name; return m;
    }, {});

    const performance = clicks
      .map(c => ({
        productNo:   c._id,
        productName: detailMap[c._id] || '이름없음',
        clicks:      c.clicks
      }))
      .sort((a,b) => b.clicks - a.clicks);

    res.json(performance);
  } catch (err) {
    console.error('[PRODUCT PERFORMANCE ERROR]', err);
    res.status(500).json({ error: '상품 퍼포먼스 집계 실패' });
  }
});

// ===================================================================
// ⑦ 서버 시작
// ===================================================================
initDb()
  .then(() => {
    console.log('[BOOT] FRONTEND_BASE =', FRONTEND_BASE);
    console.log('[BOOT] BACKEND_BASE  =', BACKEND_BASE);
    console.log('[BOOT] REDIRECT_URI  =', REDIRECT_URI);
    console.log('[BOOT] CAFE24_SCOPES =', CAFE24_SCOPES);

    app.listen(PORT, () => {
      console.log(`▶️ Server running at ${BACKEND_BASE} (port ${PORT})`);
    });
  })
  .catch(err => {
    console.error('❌ 초기화 실패:', err);
    process.exit(1);
  });
