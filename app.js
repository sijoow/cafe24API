// app.js (전체 — 토큰 저장/로깅 강화 버전)
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
  CAFE24_SCOPES, // optional: if set must match developer center
} = process.env;

if (!MONGODB_URI) console.warn('⚠️ MONGODB_URI is not set');
if (!DB_NAME) console.warn('⚠️ DB_NAME is not set');
if (!CAFE24_CLIENT_ID || !CAFE24_CLIENT_SECRET) console.warn('⚠️ CAFE24 client id/secret missing');
if (!APP_URL) console.warn('⚠️ APP_URL is not set - Redirect URIs must match this exactly');
if (!R2_PUBLIC_BASE) console.warn('⚠️ R2_PUBLIC_BASE not set - image URLs may be wrong');

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

const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// simple request logger
app.use((req, res, next) => {
  console.log(new Date().toISOString(), '--- INCOMING REQUEST ---', req.method, req.originalUrl);
  if (Object.keys(req.query || {}).length) {
    console.log(' query:', req.query);
  }
  if (Object.keys(req.body || {}).length) {
    // do not log large bodies, but helpful for debugging
    console.log(' body keys:', Object.keys(req.body));
  }
  next();
});

// ─── MongoDB 연결 ───────────────────────────────────────────────
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  await db.collection('token').createIndex({ mallId: 1 }, { unique: true });
  console.log('▶️ MongoDB connected to', DB_NAME);
}

// ─── Multer (파일 업로드 임시저장)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// ─── R2 / S3 client
const s3Client = new S3Client({
  region:   R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId:     R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
  forcePathStyle: true,
});

// ================= Helper: build install URL ========================
function buildInstallUrl(mallId, scopes = DEFAULT_SCOPES) {
  const redirectUri = `${APP_URL.replace(/\/$/, '')}/auth/callback`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CAFE24_CLIENT_ID,
    redirect_uri:  redirectUri,
    scope:         scopes,
    state:         mallId,
  }).toString();
  return `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params}`;
}

// ===================================================================
// ① 설치 → 권한요청 → 콜백 (code → 토큰) → DB 저장
// ===================================================================

// 설치 시작: mallId 기반 OAuth 권한 요청
app.get('/install/:mallId', (req, res) => {
  const { mallId } = req.params;
  const installUrl = buildInstallUrl(mallId);
  console.log('[INSTALL] redirect to', installUrl);
  return res.redirect(installUrl);
});

// 콜백: 카페24가 code(or error)와 state(mallId) 를 보냄
app.get('/auth/callback', async (req, res) => {
  const q = req.query || {};
  console.log('[AUTH CALLBACK HIT] query:', q);

  const { error, error_description, code, state: mallId } = q;

  if (error) {
    console.warn('[AUTH CALLBACK] provider returned error:', error, error_description);
    // redirect to frontend redirect handler with error info
    const errDesc = encodeURIComponent(error_description || '');
    const redirect = `${APP_URL.replace(/\/$/, '')}/redirect?mall_id=${encodeURIComponent(mallId||'')}&auth_error=${encodeURIComponent(error)}&error_description=${errDesc}`;
    return res.redirect(redirect);
  }

  if (!code || !mallId) {
    console.error('[AUTH CALLBACK] missing code or mallId', { code, mallId });
    return res.status(400).send('code 또는 mallId가 없습니다.');
  }

  try {
    const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
    const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${APP_URL.replace(/\/$/, '')}/auth/callback`
    }).toString();

    console.log('[AUTH CALLBACK] exchanging token at', tokenUrl);
    const resp = await axios.post(tokenUrl, body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`
      },
      timeout: 10000
    });

    console.log('[AUTH CALLBACK] token response received:', resp.data);
    const data = resp.data;

    // save to DB (upsert)
    const doc = {
      mallId,
      accessToken:  data.access_token,
      refreshToken: data.refresh_token,
      obtainedAt:   new Date(),
      expiresIn:    data.expires_in || null,
      raw: data
    };

    await db.collection('token').updateOne(
      { mallId },
      { $set: doc },
      { upsert: true }
    );

    console.log(`[AUTH CALLBACK] token stored for mallId=${mallId}`);

    // redirect to frontend redirect route so React can finish setup
    const redirect = `${APP_URL.replace(/\/$/, '')}/redirect?mall_id=${encodeURIComponent(mallId)}&installed=1`;
    return res.redirect(redirect);

  } catch (err) {
    console.error('[AUTH CALLBACK ERROR] token exchange or DB save failed:', err.response?.data || err.message || err);
    // send error info to frontend redirect so UI can show it
    const errMsg = encodeURIComponent(err.response?.data?.error_description || err.response?.data || err.message || 'token_error');
    const redirect = `${APP_URL.replace(/\/$/, '')}/redirect?mall_id=${encodeURIComponent(mallId||'')}&auth_error=token_exchange&error_description=${errMsg}`;
    return res.redirect(redirect);
  }
});

// optional: forward route if cafe24 redirect URI is set to /redirect on server
app.get('/redirect', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const target = `${APP_URL.replace(/\/$/, '')}/redirect${qs ? ('?' + qs) : ''}`;
  console.log('[REDIRECT FORWARD] ->', target);
  return res.redirect(target);
});
// --- 디버그용 auth callback (임시로 기존 /auth/callback 대신 사용하세요)
app.get('/auth/callback', async (req, res) => {
  console.log('[DEBUG AUTH CALLBACK] raw query:', req.query);
  const { error, error_description, code, state: mallId } = req.query;

  if (error) {
    console.warn('[DEBUG AUTH CALLBACK] provider error:', error, error_description);
    return res.status(400).json({ ok: false, stage: 'provider_error', error, error_description });
  }

  if (!code || !mallId) {
    console.error('[DEBUG AUTH CALLBACK] missing code or mallId', { code, mallId });
    return res.status(400).json({ ok: false, stage: 'missing_params', code, mallId });
  }

  try {
    const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
    const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${APP_URL.replace(/\/$/, '')}/auth/callback`
    }).toString();

    console.log('[DEBUG] requesting token from', tokenUrl);
    const tokenResp = await axios.post(tokenUrl, body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`
      },
      validateStatus: status => true, // 모든 상태코드 수신해서 로그 확인
      timeout: 15000
    });

    console.log('[DEBUG] token response status:', tokenResp.status);
    console.log('[DEBUG] token response data:', tokenResp.data);

    if (tokenResp.status !== 200) {
      // 응답 실패면 그대로 돌려줌 (카페24가 준 에러 메시지 확인용)
      return res.status(502).json({ ok: false, stage: 'token_exchange_failed', status: tokenResp.status, data: tokenResp.data });
    }

    const data = tokenResp.data;
    const doc = {
      mallId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      obtainedAt: new Date(),
      expiresIn: data.expires_in || null,
      raw: data
    };

    console.log('[DEBUG] about to upsert token doc into DB:', { mallId, hasAccessToken: !!doc.accessToken, hasRefreshToken: !!doc.refreshToken });

    const upsertResult = await db.collection('token').updateOne(
      { mallId },
      { $set: doc },
      { upsert: true }
    );

    console.log('[DEBUG] DB upsert result:', upsertResult);

    // 개발용: DB 상태와 토큰 응답을 JSON으로 반환
    const savedDoc = await db.collection('token').findOne({ mallId });
    return res.json({ ok: true, stage: 'token_saved', tokenResponse: data, dbUpsert: upsertResult, savedDoc });

  } catch (err) {
    console.error('[DEBUG AUTH CALLBACK ERROR]', err.response?.data || err.message || err);
    return res.status(500).json({ ok: false, stage: 'exception', error: err.response?.data || err.message });
  }
});

// ===================================================================
// ② mallId-aware API 요청 헬퍼 (토큰조회, refresh 포함)
// ===================================================================

async function refreshAccessToken(mallId, refreshToken) {
  const url = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
  const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  }).toString();

  const { data } = await axios.post(url, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`
    },
    timeout: 10000
  });

  console.log(`[TOKEN REFRESH] mallId=${mallId} refresh response:`, data);

  await db.collection('token').updateOne(
    { mallId },
    { $set: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        obtainedAt: new Date(),
        expiresIn: data.expires_in || null,
        raw_refresh_response: data
      }},
    { upsert: true }
  );

  return data.access_token;
}

async function apiRequest(mallId, method, url, data = {}, params = {}) {
  const doc = await db.collection('token').findOne({ mallId });
  if (!doc) {
    const installUrl = buildInstallUrl(mallId);
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
        Authorization: `Bearer ${doc.accessToken}`,
        'Content-Type': 'application/json',
        'X-Cafe24-Api-Version': CAFE24_API_VERSION
      },
      timeout: 10000
    });
    return resp.data;
  } catch (err) {
    if (err.response?.status === 401 && doc.refreshToken) {
      console.log(`[API REQUEST] 401 received, attempting refresh for mallId=${mallId}`);
      const newAccess = await refreshAccessToken(mallId, doc.refreshToken);
      const retry = await axios({
        method, url, data, params,
        headers: {
          Authorization: `Bearer ${newAccess}`,
          'Content-Type': 'application/json',
          'X-Cafe24-Api-Version': CAFE24_API_VERSION
        },
        timeout: 10000
      });
      return retry.data;
    }
    // bubble up
    throw err;
  }
}

// ===================================================================
// ③ mallId-aware 전용 엔드포인트 모음
// ===================================================================

// (0) basic ping
app.get('/api/:mallId/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// (X) front: check installation state
app.get('/api/:mallId/mall', async (req, res) => {
  const { mallId } = req.params;
  try {
    const doc = await db.collection('token').findOne({ mallId });
    if (!doc || !doc.accessToken) {
      const installUrl = buildInstallUrl(mallId);
      return res.json({ installed: false, mallId, installUrl });
    }
    // optional: you can fetch additional account info if needed
    return res.json({
      installed: true,
      mallId: doc.mallId,
      userId: doc.userId || null,
      userName: doc.userName || null
    });
  } catch (err) {
    console.error('[MALL CHECK ERROR]', err);
    return res.status(500).json({ error: 'mall check failed' });
  }
});

// image upload endpoint (Multer -> R2)
app.post('/api/:mallId/uploads/image', upload.single('file'), async (req, res) => {
  try {
    const { mallId } = req.params;
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const { filename, path: localPath, mimetype } = req.file;
    const key = `uploads/${mallId}/${filename}`;
    await s3Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: fs.createReadStream(localPath),
      ContentType: mimetype,
      ACL: 'public-read'
    }));
    fs.unlink(localPath, () => {});
    const url = `${R2_PUBLIC_BASE.replace(/\/$/, '')}/${key}`;
    res.json({ url });
  } catch (err) {
    console.error('[IMAGE UPLOAD ERROR]', err);
    res.status(500).json({ error: '이미지 업로드 실패' });
  }
});

// ---- 이하: 이벤트 CRUD, 트래킹, analytics 등 (원래 있던 모든 엔드포인트를 그대로 붙여넣어 주세요) ----
// (길이상 반복을 피하기 위해 예시 몇개만 포함했습니다. 실제로는 기존 파일의 모든 엔드포인트를 여기에 동일하게 포함해야 합니다.)

// create event
app.post('/api/:mallId/events', async (req, res) => {
  const { mallId } = req.params;
  const payload = req.body;
  if (!payload.title || typeof payload.title !== 'string') return res.status(400).json({ error: '제목(title)을 입력해주세요.' });
  if (!Array.isArray(payload.images)) return res.status(400).json({ error: 'images를 배열로 보내주세요.' });
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

// you must paste the rest of your original endpoints here (events list/get/put/delete, track, categories, coupons, analytics, etc.)
// to keep this example manageable I omitted repeating every endpoint. In your deployment, make sure to include them all exactly.


// ===================================================================
// start server
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
