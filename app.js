// app.js (전체 파일 — 디버그 로깅/토큰 저장 강화 포함)
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
  CAFE24_SCOPES, // optional override via env
  DEBUG_MODE // optional: if '1' will show debug pages
} = process.env;

const DEFAULT_SCOPES = CAFE24_SCOPES || [
  'mall.read_promotion',
  'mall.write_promotion',
  'mall.read_category',
  'mall.write_category',
  'mall.read_product',
  'mall.write_product',
  'mall.read_collection',
  'mall.read_application',
  'mall.write_application',
  'mall.read_analytics',
  'mall.read_salesreport',
  'mall.read_store'
].join(',');

if (!MONGODB_URI || !DB_NAME) {
  console.warn('⚠️ MONGODB_URI or DB_NAME missing in env — DB connection will fail.');
}
if (!CAFE24_CLIENT_ID || !CAFE24_CLIENT_SECRET) {
  console.warn('⚠️ CAFE24 client id/secret missing in env.');
}
if (!APP_URL) {
  console.warn('⚠️ APP_URL missing in env. Example: https://onimon.shop');
}

const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────────────────────────────
// 간단한 요청 로거: 디버깅용
app.use((req, res, next) => {
  console.log(new Date().toISOString(), '--- INCOMING REQUEST ---', req.method, req.originalUrl);
  if (Object.keys(req.query || {}).length) console.log(' query:', req.query);
  next();
});

// ─── MongoDB 연결 ─────────────────────────────────────────────────────
let db = null;
async function initDb() {
  const client = new MongoClient(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  await client.connect();
  db = client.db(DB_NAME);
  // Ensure index
  await db.collection('token').createIndex({ mallId: 1 }, { unique: true });
  console.log('▶️ MongoDB connected to', DB_NAME);
}

// ─── Multer (파일 업로드 임시저장) ─────────────────────────────────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
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

// ===================================================================
// ① 설치 → 권한요청 → 콜백 (code → 토큰) → DB 저장
// ===================================================================

// 설치 시작: mallId 기반 OAuth 권한 요청
app.get('/install/:mallId', (req, res) => {
  const { mallId } = req.params;
  if (!mallId) return res.status(400).send('mallId required');
  const redirectUri = `${APP_URL}/auth/callback`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CAFE24_CLIENT_ID,
    redirect_uri:  redirectUri,
    scope:         DEFAULT_SCOPES,
    state:         mallId,
  });
  const url = `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params.toString()}`;
  console.log('[INSTALL] redirect to', url);
  res.redirect(url);
});

// 콜백 핸들러: code → 토큰 발급 → DB에 mallId별 저장 → 프론트로 리다이렉트
app.get('/auth/callback', async (req, res) => {
  console.log('[AUTH CALLBACK ARRIVED] query=', req.query);
  const { error, error_description, code, state: mallId } = req.query;

  if (error) {
    console.error('[AUTH CALLBACK][PROVIDER ERROR]', error, error_description);
    if (DEBUG_MODE === '1') {
      return res.status(400).send(`<h3>OAuth Error</h3><pre>${error} - ${error_description || ''}</pre>`);
    }
    return res.redirect(`${APP_URL}/redirect?auth_error=${encodeURIComponent(error)}&mall_id=${encodeURIComponent(mallId||'')}`);
  }

  if (!code || !mallId) {
    console.warn('[AUTH CALLBACK] missing code or state:', { code, mallId });
    return res.status(400).send('code 또는 mallId(state)가 없습니다.');
  }

  if (!db) {
    console.error('[AUTH CALLBACK] DB is not initialized (db is null).');
    return res.status(500).send('서버 DB 연결이 준비되지 않았습니다. 잠시 후 다시 시도해주세요.');
  }

  try {
    const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
    const creds    = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const body     = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: `${APP_URL}/auth/callback`
    }).toString();

    console.log(`[AUTH CALLBACK] requesting token from ${tokenUrl} for mallId=${mallId}`);
    const response = await axios.post(tokenUrl, body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`
      },
      timeout: 10000
    });

    console.log('[AUTH CALLBACK] token response data keys:', Object.keys(response.data || {}));
    const data = response.data;

    if (!data || !data.access_token) {
      console.error('[AUTH CALLBACK] token response missing access_token:', data);
      return res.status(500).send('토큰 응답이 예상과 다릅니다. 서버 로그를 확인하세요.');
    }

    // Upsert token doc
    const setDoc = {
      mallId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      obtainedAt: new Date(),
      expiresIn: data.expires_in || null,
      raw: data
    };

    const upsertResult = await db.collection('token').updateOne(
      { mallId },
      { $set: setDoc },
      { upsert: true }
    );

    console.log('[AUTH CALLBACK] updateOne result:', upsertResult);

    // 확인 차 DB에서 다시 읽어서 로그
    const saved = await db.collection('token').findOne({ mallId });
    console.log('[AUTH CALLBACK] saved token doc exists:', !!saved, saved ? {
      mallId: saved.mallId,
      obtainedAt: saved.obtainedAt,
      accessTokenPresent: !!saved.accessToken,
      refreshTokenPresent: !!saved.refreshToken
    } : null);

    // 리다이렉트: 프론트의 Redirect 컴포넌트가 처리하도록 mall_id 포함
    if (DEBUG_MODE === '1') {
      // 디버그 모드: 결과 페이지 보여줌
      return res.status(200).send(`
        <html><body style="font-family:Arial,Helvetica,sans-serif">
          <h2>앱 설치 완료 (디버그)</h2>
          <pre>${JSON.stringify({ mallId, saved }, null, 2)}</pre>
          <p><a href="${APP_URL}">대시보드로 돌아가기</a></p>
        </body></html>
      `);
    }

    return res.redirect(`${APP_URL}/redirect?mall_id=${encodeURIComponent(mallId)}&installed=1`);
  } catch (err) {
    console.error('[AUTH CALLBACK ERROR] token exchange or DB upsert failed:', err.response?.data || err.message || err);
    if (DEBUG_MODE === '1') {
      return res.status(500).send(`<pre>${JSON.stringify(err.response?.data || err.message || err, null, 2)}</pre>`);
    }
    return res.redirect(`${APP_URL}/redirect?mall_id=${encodeURIComponent(req.query.state||'')}&auth_error=${encodeURIComponent(err.response?.data?.error_description || err.message || 'token_error')}`);
  }
});

// 프론트용 redirect forward (만약 카페24에 redirect_uri로 /redirect를 등록했다면)
app.get('/redirect', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const target = `${APP_URL}/redirect${qs ? ('?' + qs) : ''}`;
  console.log('[REDIRECT FORWARD] ->', target);
  return res.redirect(target);
});

// ===================================================================
// ② mallId-aware API 요청 헬퍼 (토큰조회, refresh 포함)
// ===================================================================

async function refreshAccessToken(mallId, refreshToken) {
  if (!refreshToken) throw new Error('refresh token missing');
  const url = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
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
  if (!doc) {
    // 설치 유도용 installUrl 만들고 에러 객체로 던짐
    const redirectUri = `${APP_URL}/auth/callback`;
    const paramsQ = new URLSearchParams({
      response_type: 'code',
      client_id:     CAFE24_CLIENT_ID,
      redirect_uri:  redirectUri,
      scope:         DEFAULT_SCOPES,
      state:         mallId,
    }).toString();
    const installUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${paramsQ}`;
    console.warn(`[API BLOCK] API request blocked because not installed: mallId=${mallId} -> ${installUrl}`);
    const e = new Error(`NOT_INSTALLED:${installUrl}`);
    e.code = 'NOT_INSTALLED';
    e.installUrl = installUrl;
    throw e;
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
    if (err.response?.status === 401 && doc.refreshToken) {
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
    }
    throw err;
  }
}

// ===================================================================
// ③ mallId-aware 전용 엔드포인트 모음 (events, uploads, track, analytics...)
// ===================================================================

// (0) 기본 Ping
app.get('/api/:mallId/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// (프론트용) 설치 여부 확인
app.get('/api/:mallId/mall', async (req, res) => {
  const { mallId } = req.params;
  try {
    const doc = await db.collection('token').findOne({ mallId });
    if (!doc) {
      const redirectUri = `${APP_URL}/auth/callback`;
      const paramsQ = new URLSearchParams({
        response_type: 'code',
        client_id:     CAFE24_CLIENT_ID,
        redirect_uri:  redirectUri,
        scope:         DEFAULT_SCOPES,
        state:         mallId,
      }).toString();
      const installUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${paramsQ}`;
      return res.json({ installed: false, installUrl });
    }
    return res.json({ installed: true, mallId: doc.mallId });
  } catch (err) {
    console.error('[MALL CHECK ERROR]', err);
    res.status(500).json({ error: 'mall check failed' });
  }
});

// ─── 이미지 업로드 (Multer + R2/S3)
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

// ---------------------------------------------------------------------
// events CRUD, track, categories, coupons, analytics 등 (원본 로직 그대로)
// 아래는 대표적인 엔드포인트들을 포함 — 필요시 추가/확장하세요.
// ---------------------------------------------------------------------

// CREATE event
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
      updatedAt: now
    };
    const result = await db.collection('events').insertOne(doc);
    res.json({ _id: result.insertedId, ...doc });
  } catch (err) {
    console.error('[CREATE EVENT ERROR]', err);
    res.status(500).json({ error: '이벤트 생성에 실패했습니다.' });
  }
});

// LIST events
app.get('/api/:mallId/events', async (req, res) => {
  const { mallId } = req.params;
  try {
    const list = await db.collection('events').find({ mallId }).sort({ createdAt: -1 }).toArray();
    res.json(list);
  } catch (err) {
    console.error('[GET EVENTS ERROR]', err);
    res.status(500).json({ error: '이벤트 목록 조회에 실패했습니다.' });
  }
});

// GET single event
app.get('/api/:mallId/events/:id', async (req, res) => {
  const { mallId, id } = req.params;
  if (!ObjectId.isValid(id)) return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
  try {
    const ev = await db.collection('events').findOne({ _id: new ObjectId(id), mallId });
    if (!ev) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    res.json(ev);
  } catch (err) {
    console.error('[GET EVENT ERROR]', err);
    res.status(500).json({ error: '이벤트 조회에 실패했습니다.' });
  }
});

// UPDATE event
app.put('/api/:mallId/events/:id', async (req, res) => {
  const { mallId, id } = req.params;
  const payload = req.body;
  if (!ObjectId.isValid(id)) return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
  if (!payload.title && !payload.content && !payload.images) return res.status(400).json({ error: '수정할 내용을 하나 이상 보내주세요.' });

  const update = { updatedAt: new Date() };
  if (payload.title) update.title = payload.title.trim();
  if (payload.content) update.content = payload.content;
  if (Array.isArray(payload.images)) update.images = payload.images;
  if (payload.gridSize !== undefined) update.gridSize = payload.gridSize;
  if (payload.layoutType) update.layoutType = payload.layoutType;
  if (payload.classification) update.classification = payload.classification;

  try {
    const result = await db.collection('events').updateOne({ _id: new ObjectId(id), mallId }, { $set: update });
    if (result.matchedCount === 0) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    const updated = await db.collection('events').findOne({ _id: new ObjectId(id) });
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[UPDATE EVENT ERROR]', err);
    res.status(500).json({ error: '이벤트 수정에 실패했습니다.' });
  }
});

// DELETE event + cascade deletes
app.delete('/api/:mallId/events/:id', async (req, res) => {
  const { mallId, id } = req.params;
  if (!ObjectId.isValid(id)) return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
  const eventId = new ObjectId(id);
  try {
    const { deletedCount } = await db.collection('events').deleteOne({ _id: eventId, mallId });
    if (!deletedCount) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    await Promise.all([
      db.collection(`visits_${mallId}`).deleteMany({ pageId: id }),
      db.collection(`clicks_${mallId}`).deleteMany({ pageId: id }),
      db.collection(`prdClick_${mallId}`).deleteMany({ pageId: id })
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE EVENT ERROR]', err);
    res.status(500).json({ error: '이벤트 삭제에 실패했습니다.' });
  }
});

// TRACK endpoint (뷰/클릭 등)
app.post('/api/:mallId/track', async (req, res) => {
  try {
    const { mallId } = req.params;
    const {
      pageId, pageUrl, visitorId, referrer,
      device, type, element, timestamp,
      productNo
    } = req.body;

    if (!pageId || !visitorId || !type || !timestamp) return res.status(400).json({ error: '필수 필드 누락' });
    if (!ObjectId.isValid(pageId)) return res.sendStatus(204);

    const ev = await db.collection('events').findOne({ _id: new ObjectId(pageId) }, { projection:{ _id:1 } });
    if (!ev) return res.sendStatus(204);

    const kstTs   = dayjs(timestamp).tz('Asia/Seoul').toDate();
    const dateKey = dayjs(timestamp).tz('Asia/Seoul').format('YYYY-MM-DD');

    let pathOnly;
    try { pathOnly = new URL(pageUrl).pathname; } catch { pathOnly = pageUrl; }

    if (type === 'click' && element === 'product' && productNo) {
      let productName = null;
      try {
        const productRes = await apiRequest(mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/products/${productNo}`, {}, { shop_no: 1 });
        const prod = productRes.product || productRes.products?.[0];
        productName = prod?.product_name || null;
      } catch (err) { console.error('[PRODUCT NAME FETCH ERROR]', err); }

      const filter = { pageId, productNo };
      const update = {
        $inc: { clickCount: 1 },
        $setOnInsert: { productName, firstClickAt: kstTs, pageUrl: pathOnly, referrer: referrer || null, device: device || null },
        $set: { lastClickAt: kstTs }
      };
      await db.collection(`prdClick_${mallId}`).updateOne(filter, update, { upsert: true });
      return res.sendStatus(204);
    }

    if (type === 'click') {
      if (element === 'coupon') {
        const coupons = Array.isArray(productNo) ? productNo : [productNo];
        await Promise.all(coupons.map(cpn => db.collection(`clicks_${mallId}`).insertOne({
          pageId, visitorId, dateKey, pageUrl: pathOnly, referrer: referrer || null, device: device || null, type, element, timestamp: kstTs, couponNo: cpn
        })));
        return res.sendStatus(204);
      }
      if (element === 'url') {
        await db.collection(`clicks_${mallId}`).insertOne({ pageId, visitorId, dateKey, pageUrl: pathOnly, referrer: referrer || null, device: device || null, type, element, timestamp: kstTs });
        return res.sendStatus(204);
      }
      await db.collection(`clicks_${mallId}`).insertOne({ pageId, visitorId, dateKey, pageUrl: pathOnly, referrer: referrer || null, device: device || null, type, element, timestamp: kstTs });
      return res.sendStatus(204);
    }

    const filter2 = { pageId, visitorId, dateKey };
    const update2 = {
      $set: { lastVisit: kstTs, pageUrl: pathOnly, referrer: referrer || null, device: device || null },
      $setOnInsert: { firstVisit: kstTs },
      $inc: {}
    };
    if (type === 'view') update2.$inc.viewCount = 1;
    if (type === 'revisit') update2.$inc.revisitCount = 1;

    await db.collection(`visits_${mallId}`).updateOne(filter2, update2, { upsert: true });
    return res.sendStatus(204);
  } catch (err) {
    console.error('[TRACK ERROR]', err);
    return res.status(500).json({ error: '트래킹 실패' });
  }
});

// (9) categories all
app.get('/api/:mallId/categories/all', async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/categories`;
      const { categories } = await apiRequest(mallId, 'GET', url, {}, { limit, offset });
      if (!categories || categories.length === 0) break;
      all.push(...categories);
      offset += categories.length;
    }
    res.json(all);
  } catch (err) {
    console.error('[CATEGORIES ERROR]', err);
    if (err.code === 'NOT_INSTALLED') return res.status(400).json({ message: '앱 미설치', installUrl: err.installUrl });
    res.status(500).json({ message: '전체 카테고리 조회 실패', error: err.message });
  }
});

// (10) coupons all
app.get('/api/:mallId/coupons', async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons } = await apiRequest(mallId, 'GET', url, {}, { shop_no:1, limit, offset });
      if (!coupons || coupons.length === 0) break;
      all.push(...coupons);
      offset += coupons.length;
    }
    res.json(all);
  } catch (err) {
    console.error('[COUPONS ERROR]', err);
    if (err.code === 'NOT_INSTALLED') return res.status(400).json({ message: '앱 미설치', installUrl: err.installUrl });
    res.status(500).json({ message: '쿠폰 조회 실패', error: err.message });
  }
});

// ... (여기에 필요하면 나머지 상세 analytics 엔드포인트들을 동일하게 붙여 넣으세요)
// 위 예시들(카테고리, 쿠폰, products, analytics 등)은 필요에 맞게 그대로 확장 가능.

// ----------------- 디버그: 토큰 조회 (운영에선 삭제 or 인증 필요) -----------------
app.get('/debug/token/:mallId', async (req, res) => {
  try {
    const { mallId } = req.params;
    const doc = await db.collection('token').findOne({ mallId });
    if (!doc) return res.status(404).json({ error: 'not found' });
    res.json(doc);
  } catch (err) {
    console.error('[DEBUG TOKEN ERROR]', err);
    res.status(500).json({ error: 'failed' });
  }
});
app.get('/debug/tokens', async (req, res) => {
  try {
    const list = await db.collection('token').find({}).limit(100).toArray();
    res.json(list.map(d=>({ mallId: d.mallId, obtainedAt: d.obtainedAt })));
  } catch (err) {
    console.error('[DEBUG TOKENS ERROR]', err);
    res.status(500).json({ error: 'failed' });
  }
});

// ===================================================================
// 서버 시작 (DB 연결 후 시작)
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
