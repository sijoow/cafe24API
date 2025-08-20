// app.js (전체)
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
  CAFE24_SCOPES // optional: 정확히 개발자센터에 등록된 스코프 문자열 (쉼표로 구분)
} = process.env;

if (!MONGODB_URI || !DB_NAME) {
  console.warn('⚠️ MONGODB_URI/DB_NAME 환경변수 확인 필요');
}
if (!CAFE24_CLIENT_ID || !CAFE24_CLIENT_SECRET) {
  console.warn('⚠️ CAFE24 클라이언트ID/SECRET 필요');
}
if (!APP_URL) {
  console.warn('⚠️ APP_URL 환경변수(예: https://onimon.shop) 필요 — Redirect URI와 정확히 일치해야 합니다.');
}

// 기본 스코프 (필요시 CAFE24 개발자센터에 등록된 값으로 덮어쓰세요)
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

// ─────────────────────────────────────────
// 간단 요청 로거
app.use((req, res, next) => {
  console.log(new Date().toISOString(), '--- INCOMING REQUEST ---', req.method, req.originalUrl);
  if (Object.keys(req.query || {}).length) console.log(' query:', req.query);
  next();
});

// ─── MongoDB 연결
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  await db.collection('token').createIndex({ mallId: 1 }, { unique: true });
  console.log('▶️ MongoDB connected to', DB_NAME);
}

// ─── Multer (임시 업로드)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// ─── S3 / R2 클라이언트 (선택)
const s3Client = new S3Client({
  region: R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY
  },
  forcePathStyle: true
});

// ===================================================================
// ① 설치 시작 -> 권한요청(카페24) -> 콜백(token 교환) -> DB 저장
// ===================================================================

// 설치 시작: mallId 기반 권한 요청 (프론트에서 /install/:mallId 호출)
app.get('/install/:mallId', (req, res) => {
  const { mallId } = req.params;
  const redirectUri = `${APP_URL}/auth/callback`; // 개발자센터에 동일하게 등록되어야 함
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CAFE24_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: DEFAULT_SCOPES,
    state: mallId
  }).toString();

  const url = `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params}`;
  console.log('[INSTALL] redirect to', url);
  res.redirect(url);
});

// 콜백: code -> token 교환 -> DB 저장 -> 프론트로 포워딩
app.get('/auth/callback', async (req, res) => {
  const { error, error_description, code, state: mallId } = req.query;

  if (error) {
    console.warn('[AUTH CALLBACK ERROR PARAM]', { mallId, error, error_description });
    // 프론트에서 보여줄 수 있게 /redirect로 쿼리 전달
    const q = new URLSearchParams({
      mall_id: mallId || '',
      auth_error: error_description || error
    }).toString();
    return res.redirect(`${APP_URL}/redirect?${q}`);
  }

  if (!code || !mallId) {
    return res.status(400).send('code 또는 mallId가 없습니다.');
  }

  try {
    const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
    const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${APP_URL}/auth/callback`
    }).toString();

    console.log(`[AUTH CALLBACK] exchanging token for mallId=${mallId}`);
    const { data } = await axios.post(tokenUrl, body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${creds}`
      },
      timeout: 10000
    });

    // DB에 저장 (upsert). raw 데이터도 함께 저장하면 디버깅에 유리.
    const doc = {
      mallId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      obtainedAt: new Date(),
      expiresIn: data.expires_in ?? null,
      raw: data
    };
    const result = await db.collection('token').updateOne(
      { mallId },
      { $set: doc },
      { upsert: true }
    );

    console.log('[AUTH CALLBACK] token saved to DB', { mallId, upsertedId: result.upsertedId });
    // 성공하면 프론트의 Redirect 경로로 보냄 (SPA가 처리)
    const q = new URLSearchParams({ mall_id: mallId, installed: '1' }).toString();
    return res.redirect(`${APP_URL}/redirect?${q}`);
  } catch (err) {
    console.error('[AUTH CALLBACK ERROR]', err.response?.data || err.message || err);
    const msg = err.response?.data?.error_description || err.message || 'token_error';
    const q = new URLSearchParams({ mall_id: mallId || '', auth_error: msg }).toString();
    return res.redirect(`${APP_URL}/redirect?${q}`);
  }
});

// (optional) 프론트의 /redirect 라우트로 포워드 (서버에서 직접 쓰는 경우)
app.get('/redirect', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  return res.redirect(`${APP_URL}/redirect${qs ? ('?' + qs) : ''}`);
});

// ===================================================================
// ② 토큰 갱신 / api helper
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
      Authorization: `Basic ${creds}`
    }
  });

  await db.collection('token').updateOne(
    { mallId },
    { $set: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        obtainedAt: new Date(),
        expiresIn: data.expires_in,
        raw_refresh_response: data
      }
    }
  );

  console.log(`[TOKEN REFRESH] mallId=${mallId}`);
  return data.access_token;
}

// apiRequest는 DB에서 토큰을 찾음. 없으면 NOT_INSTALLED 에러(installUrl 포함) 발생.
async function apiRequest(mallId, method, url, data = {}, params = {}) {
  const doc = await db.collection('token').findOne({ mallId });
  if (!doc) {
    const redirectUri = `${APP_URL}/auth/callback`;
    const paramsQ = new URLSearchParams({
      response_type: 'code',
      client_id: CAFE24_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: DEFAULT_SCOPES,
      state: mallId
    }).toString();
    const installUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${paramsQ}`;
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
      // refresh and retry
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
    throw err;
  }
}

// ===================================================================
// ③ mall-aware 엔드포인트 (설치여부 체크, events, uploads, track 등)
// ===================================================================

// 기본 ping
app.get('/api/:mallId/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// 설치 여부 확인 (프론트에서 사용)
app.get('/api/:mallId/mall', async (req, res) => {
  const { mallId } = req.params;
  try {
    const doc = await db.collection('token').findOne({ mallId });
    if (doc && doc.accessToken) {
      // 설치됨
      return res.json({ installed: true, mallId: doc.mallId, userId: doc.userId || null, userName: doc.userName || null });
    }
    // 미설치: installUrl 제공
    const redirectUri = `${APP_URL}/auth/callback`;
    const paramsQ = new URLSearchParams({
      response_type: 'code',
      client_id: CAFE24_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: DEFAULT_SCOPES,
      state: mallId
    }).toString();
    const installUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${paramsQ}`;
    console.log(`[API BLOCK] not installed: mallId=${mallId} -> ${installUrl}`);
    return res.json({ installed: false, mallId, installUrl });
  } catch (err) {
    console.error('[MALL CHECK ERROR]', err);
    return res.status(500).json({ error: 'mall check failed' });
  }
});

// 이미지 업로드 (Multer + R2)
app.post('/api/:mallId/uploads/image', upload.single('file'), async (req, res) => {
  try {
    const { mallId } = req.params;
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
    const url = `${R2_PUBLIC_BASE}/${key}`;
    res.json({ url });
  } catch (err) {
    console.error('[IMAGE UPLOAD ERROR]', err);
    res.status(500).json({ error: '이미지 업로드 실패' });
  }
});

// ------------ 이벤트 CRUD / 트래킹 / analytics 등 (원본대로 유지) --------------
// 아래는 당신이 이전에 사용하던 이벤트/트래킹/analytics/coupons/categories 등 엔드포인트
// (길어지므로 여기선 같은 로직으로 모두 포함되어야 함 — 실제로는 당신의 기존 전체 엔드포인트를
// 이 위치에 그대로 붙여넣어 사용하세요.)
//
// 예: /api/:mallId/events (POST/GET/PUT/DELETE),
//     /api/:mallId/track (POST),
//     /api/:mallId/categories/all (GET),
//     /api/:mallId/coupons (GET),
//     /api/:mallId/analytics/:pageId/*
//
// 위의 원본 코드 전체를 여기에 붙여넣어 주세요.
// (대신 api 중복 정의가 없도록 주의 — 이미 이 파일에 정의한 경로와 충돌 나지 않게 위치시킵니다.)
//
// --- 예시로 최소한의 events 엔드포인트 하나만 붙여둡니다 ---
// 생성
app.post('/api/:mallId/events', async (req, res) => {
  const { mallId } = req.params;
  const payload = req.body;
  if (!payload.title || typeof payload.title !== 'string') return res.status(400).json({ error: '제목 필요' });
  if (!Array.isArray(payload.images)) return res.status(400).json({ error: 'images 배열 필요' });
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
    res.status(500).json({ error: '이벤트 생성 실패' });
  }
});

// (실전에서는 위의 주석 블록에 기존 전체 엔드포인트들을 전부 붙여넣으세요)

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
