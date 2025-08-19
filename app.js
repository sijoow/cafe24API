// app.js (수정본)
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
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

dayjs.extend(utc);
dayjs.extend(tz);

const {
  MONGODB_URI,
  DB_NAME,
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  CAFE24_API_VERSION,
  APP_URL,
  PORT = 5000,
  R2_ACCESS_KEY,
  R2_SECRET_KEY,
  R2_BUCKET_NAME,
  R2_ENDPOINT,
  R2_REGION = 'us-east-1',
  R2_PUBLIC_BASE,
} = process.env;

if (!MONGODB_URI || !DB_NAME || !CAFE24_CLIENT_ID || !CAFE24_CLIENT_SECRET || !APP_URL) {
  console.error('❌ 필수 환경변수가 설정되지 않았습니다. MONGODB_URI, DB_NAME, CAFE24_CLIENT_ID, CAFE24_CLIENT_SECRET, APP_URL 확인');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 간단 요청 로거
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// ─── MongoDB 연결 ───────────────────────────────────────────────
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  await db.collection('token').createIndex({ mallId: 1 }, { unique: true });
  await db.collection('install_states').createIndex({ state: 1 }, { unique: true });
  await db.collection('install_states').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  console.log('▶️ MongoDB connected to', DB_NAME);
}

// ─── Multer (파일 업로드 임시저장) ─────────────────────────────────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// ─── R2 (AWS S3 호환) 클라이언트 ─────────────────────────────────
const s3Client = new S3Client({
  region:   R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId:     R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
  forcePathStyle: true,
});

// ───────────────────────────────────────────────────────────────────
// 간단 인메모리 스로틀: 동일 mallId에 대해 초당 과다 요청 방지
const apiThrottleMap = new Map(); // mallId -> { count, windowStart }
function throttleCheck(mallId, maxPerWindow = 10, windowMs = 5000) {
  if (!mallId) return false;
  const entry = apiThrottleMap.get(mallId) || { count: 0, windowStart: Date.now() };
  if (Date.now() - entry.windowStart > windowMs) {
    entry.count = 1;
    entry.windowStart = Date.now();
    apiThrottleMap.set(mallId, entry);
    return false;
  } else {
    entry.count += 1;
    apiThrottleMap.set(mallId, entry);
    return entry.count > maxPerWindow;
  }
}

// 공통 /api 라우트 앞에서 mallId 기반 간단 스로틀 적용
app.use('/api', (req, res, next) => {
  const parts = req.path.split('/').filter(Boolean); // ['', 'yogibo', 'coupons'] -> ['yogibo','coupons']
  const mallId = parts[0];
  if (throttleCheck(mallId)) {
    console.warn(`[THROTTLE] mallId=${mallId} exceeded request rate`);
    res.set('Retry-After', '30');
    return res.status(429).json({ error: 'throttled', message: '요청이 너무 많습니다. 잠시 후 시도하세요.' });
  }
  next();
});

// ===================================================================
// ① 설치 → 권한요청 → 콜백 (code → 토큰) → DB 저장
// ===================================================================

// 설치 시작: mallId 기반 OAuth 권한 요청
app.get('/install/:mallId', async (req, res) => {
  try {
    const { mallId } = req.params;
    if (!mallId) return res.status(400).send('mallId required');

    const redirectUri = `${APP_URL}/auth/callback`;
    // 랜덤 state 생성 및 TTL(5분)로 DB에 저장
    const state = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5분
    await db.collection('install_states').updateOne(
      { state },
      { $set: { state, mallId, expiresAt, createdAt: new Date() } },
      { upsert: true }
    );

    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     CAFE24_CLIENT_ID,
      redirect_uri:  redirectUri,
      scope:         'mall.read_promotion,mall.write_promotion,mall.read_category,mall.write_category,mall.read_product,mall.write_product,mall.read_collection,mall.read_application,mall.write_application,mall.read_analytics,mall.read_salesreport,mall.read_store',
      state,
    });
    const authorizeUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params.toString()}`;
    console.log('[INSTALL] redirect to', authorizeUrl);
    res.redirect(authorizeUrl);
  } catch (err) {
    console.error('[INSTALL ERROR]', err);
    res.status(500).send('Install redirect error');
  }
});

// 이미지 업로드 (Multer + R2/S3)
app.post('/api/:mallId/uploads/image', upload.single('file'), async (req, res) => {
  try {
    const { mallId } = req.params;
    const { filename, path: localPath, mimetype } = req.file || {};
    if (!filename) return res.status(400).json({ error: '파일이 없습니다.' });

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

// 콜백 핸들러: code → 토큰 발급 → DB에 mallId별 저장 → 설치완료 페이지로 리다이렉트
app.get('/auth/callback', async (req, res) => {
  console.log('[AUTH CALLBACK REQ]', new Date().toISOString(), req.query);
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.error('[AUTH CALLBACK] OAuth error param:', error, error_description);
    return res.status(400).send(`OAuth error: ${error} ${error_description || ''}`);
  }

  if (!code || !state) {
    return res.status(400).send('code 또는 state가 없습니다.');
  }

  try {
    // Try to resolve state -> mallId from DB
    let st = await db.collection('install_states').findOne({ state });
    let mallId;
    if (st && st.mallId) {
      mallId = st.mallId;
    } else {
      // legacy: if state is actually mallId (older flow), accept it but warn
      mallId = state;
      console.warn('[AUTH CALLBACK] state mapping not found, falling back to state as mallId', state);
    }

    const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
    const creds    = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const redirectUri = `${APP_URL}/auth/callback`;

    const body = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: redirectUri
    }).toString();

    let data;
    try {
      const resp = await axios.post(tokenUrl, body, {
        headers: {
          'Content-Type':  'application/x-www-form-urlencoded',
          'Authorization': `Basic ${creds}`
        }
      });
      data = resp.data;
    } catch (err) {
      console.error('[AUTH CALLBACK - TOKEN EXCHANGE ERROR]', err.response?.data || err.message || err);
      return res.status(500).send(`토큰 교환 중 오류가 발생했습니다. (${err.response?.data?.error || err.message})`);
    }

    await db.collection('token').updateOne(
      { mallId },
      {
        $set: {
          mallId,
          accessToken:  data.access_token,
          refreshToken: data.refresh_token,
          obtainedAt:   new Date(),
          expiresIn:    data.expires_in || 7200,
          scopes:       data.scopes || [],
          raw:          data
        }
      },
      { upsert: true }
    );

    console.log(`[AUTH CALLBACK] App installed for mallId: ${mallId}`);

    // remove used state (if any)
    if (st) await db.collection('install_states').deleteOne({ state });

    // redirect to installation success page (prevents immediate root reload -> loop)
    return res.redirect(`${APP_URL}/installed?mallId=${encodeURIComponent(mallId)}`);
  } catch (err) {
    console.error('[AUTH CALLBACK ERROR]', err);
    return res.status(500).send('토큰 교환 중 오류가 발생했습니다.');
  }
});

// ===================================================================
// ② mallId-aware API 요청 헬퍼 (토큰 없을 땐 NO_TOKEN 오류 발생)
// ===================================================================

async function refreshAccessToken(mallId, refreshToken) {
  const url = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
  const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken
  }).toString();

  const resp = await axios.post(url, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`
    }
  });

  const data = resp.data;

  await db.collection('token').updateOne(
    { mallId },
    { $set: {
        accessToken:  data.access_token,
        refreshToken: data.refresh_token,
        obtainedAt:   new Date(),
        expiresIn:    data.expires_in,
        raw:          data
      }
    }
  );

  return data.access_token;
}

async function apiRequest(mallId, method, url, data = {}, params = {}) {
  const doc = await db.collection('token').findOne({ mallId });
  if (!doc) {
    const installUrl = `${APP_URL}/install/${mallId}`;
    const err = new Error(`토큰 정보 없음: mallId=${mallId}`);
    err.code = 'NO_TOKEN';
    err.installUrl = installUrl;
    throw err;
  }

  try {
    const resp = await axios({
      method, url, data, params,
      headers: {
        Authorization:         `Bearer ${doc.accessToken}`,
        'Content-Type':        'application/json',
        'X-Cafe24-Api-Version': CAFE24_API_VERSION,
      }
    });
    return resp.data;
  } catch (err) {
    if (err.response?.status === 401) {
      // try refresh once
      try {
        const newAccess = await refreshAccessToken(mallId, doc.refreshToken);
        const retry = await axios({
          method, url, data, params,
          headers: {
            Authorization:         `Bearer ${newAccess}`,
            'Content-Type':        'application/json',
            'X-Cafe24-Api-Version': CAFE24_API_VERSION,
          }
        });
        return retry.data;
      } catch (refreshErr) {
        console.error('[apiRequest] refresh failed', refreshErr.response?.data || refreshErr.message || refreshErr);
        throw refreshErr;
      }
    }
    throw err;
  }
}

// ===================================================================
// ③ mallId-aware 전용 엔드포인트 (원본 로직 유지, catch에서 NO_TOKEN 처리)
// ===================================================================

// (0) 기본 Ping
app.get('/api/:mallId/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// helper: install error responder
function sendInstallRequired(res, installUrl) {
  res.set('Retry-After', '30');
  return res.status(412).json({ error: 'install_required', installUrl });
}

// ─── 생성
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

// ─── 목록 조회
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

// ─── 단건 조회
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
    if (!ev) {
      return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    }
    res.json(ev);
  } catch (err) {
    console.error('[GET EVENT ERROR]', err);
    res.status(500).json({ error: '이벤트 조회에 실패했습니다.' });
  }
});

// ─── 수정
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

// ─── 삭제
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

// (8) 트래킹 저장중
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
    if (!ev) {
      return res.sendStatus(204);
    }

    const kstTs   = dayjs(timestamp).tz('Asia/Seoul').toDate();
    const dateKey = dayjs(timestamp).tz('Asia/Seoul').format('YYYY-MM-DD');

    let pathOnly;
    try {
      pathOnly = new URL(pageUrl).pathname;
    } catch {
      pathOnly = pageUrl;
    }

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
      await db
        .collection(`prdClick_${mallId}`)
        .updateOne(filter, update, { upsert: true });
      return res.sendStatus(204);
    }

    if (type === 'click') {
      if (element === 'coupon') {
        const coupons = Array.isArray(productNo) ? productNo : [productNo];
        await Promise.all(coupons.map(cpn => {
          const clickDoc = {
            pageId,
            visitorId,
            dateKey,
            pageUrl:   pathOnly,
            referrer:  referrer || null,
            device:    device   || null,
            type,
            element,
            timestamp: kstTs,
            couponNo:  cpn
          };
          return db.collection(`clicks_${mallId}`).insertOne(clickDoc);
        }));
        return res.sendStatus(204);
      }

      if (element === 'url') {
        const clickDoc = {
          pageId,
          visitorId,
          dateKey,
          pageUrl:   pathOnly,
          referrer:  referrer || null,
          device:    device   || null,
          type,
          element,
          timestamp: kstTs
        };
        await db.collection(`clicks_${mallId}`).insertOne(clickDoc);
        return res.sendStatus(204);
      }

      const clickDoc = {
        pageId,
        visitorId,
        dateKey,
        pageUrl:   pathOnly,
        referrer:  referrer || null,
        device:    device   || null,
        type,
        element,
        timestamp: kstTs
      };
      await db.collection(`clicks_${mallId}`).insertOne(clickDoc);
      return res.sendStatus(204);
    }

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

    await db
      .collection(`visits_${mallId}`)
      .updateOne(filter2, update2, { upsert: true });

    return res.sendStatus(204);
  } catch (err) {
    console.error('[TRACK ERROR]', err);
    return res.status(500).json({ error: '트래킹 실패' });
  }
});

// (9) 카테고리 전체 조회
app.get('/api/:mallId/categories/all', async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/categories`;
      const { categories } = await apiRequest(mallId, 'GET', url, {}, { limit, offset });
      if (!categories.length) break;
      all.push(...categories);
      offset += categories.length;
    }
    res.json(all);
  } catch (err) {
    if (err.code === 'NO_TOKEN') return sendInstallRequired(res, err.installUrl);
    console.error('[CATEGORIES ERROR]', err);
    res.status(500).json({ message: '전체 카테고리 조회 실패', error: err.message });
  }
});

// (10) 쿠폰 전체 조회
app.get('/api/:mallId/coupons', async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons } = await apiRequest(mallId, 'GET', url, {}, { shop_no:1, limit, offset });
      if (!coupons.length) break;
      all.push(...coupons);
      offset += coupons.length;
    }
    res.json(all);
  } catch (err) {
    if (err.code === 'NO_TOKEN') return sendInstallRequired(res, err.installUrl);
    console.error('[COUPONS ERROR]', err);
    res.status(500).json({ message: '쿠폰 조회 실패', error: err.message });
  }
});

// (나머지 엔드포인트들은 원본 로직을 유지 — 오류시 NO_TOKEN 체크 후 500 처리)
// ... (다른 라우트들도 동일한 패턴으로 err.code === 'NO_TOKEN' 체크를 해주시면 됩니다)
// (위 코드는 핵심 경로를 우선 적용하였고, 필요하시면 모든 apiRequest 사용처에 동일한 체크를 붙여드릴게요)

// ===================================================================
// 전역 에러 핸들러 (마지막 미들웨어)
// ===================================================================
app.use((err, req, res, next) => {
  console.error('[GLOBAL ERROR HANDLER]', err.code || err.message, err);
  if (err.code === 'NO_TOKEN') {
    res.set('Retry-After', '30');
    return res.status(412).json({ error: 'install_required', installUrl: err.installUrl });
  }
  if (err.code === 'THROTTLED') {
    res.set('Retry-After', '30');
    return res.status(429).json({ error: 'throttled', message: '잠시 후 다시 시도하세요.' });
  }
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'server_error' });
});

// ===================================================================
// 서버 시작
// ===================================================================
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`▶️ Server running at ${APP_URL} (port ${PORT})`);
    });
  })
  .catch(err => {
    console.error('❌ 초기화 실패:', err);
    process.exit(1);
  });
