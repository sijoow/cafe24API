// app.js
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
  CAFE24_SCOPES // 문자열: 개발자센터에 등록한 scope를 정확히 넣어야 함 (쉼표로 구분)
} = process.env;

// 기본 스코프(환경변수 없을 때) — 필요하면 개발자센터에 등록된 그대로 수정하세요.
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

if (!APP_URL) console.warn('⚠️ APP_URL 환경변수를 확인하세요 (예: https://onimon.shop)');
if (!CAFE24_CLIENT_ID || !CAFE24_CLIENT_SECRET) console.warn('⚠️ CAFE24_CLIENT_ID/SECRET 설정 필요');
if (!MONGODB_URI || !DB_NAME) console.warn('⚠️ MONGODB_URI/DB_NAME 설정 필요');

const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 간단 요청 로거
app.use((req, res, next) => {
  console.log(new Date().toISOString(), '--- INCOMING REQUEST ---', req.method, req.originalUrl);
  if (Object.keys(req.query || {}).length) console.log(' query:', req.query);
  next();
});

// MongoDB 연결
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  // 토큰 컬렉션 인덱스
  await db.collection('token').createIndex({ mallId: 1 }, { unique: true });
  console.log('▶️ MongoDB connected to', DB_NAME);
}

// Multer (업로드 임시)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// S3 / R2 클라이언트
const s3Client = new S3Client({
  region: R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
  forcePathStyle: true
});

// ----------------- OAuth 설치/콜백 -----------------

// 설치 시작: mallId 기반 권한요청 URL 생성
app.get('/install/:mallId', (req, res) => {
  const { mallId } = req.params;
  const redirectUri = `${APP_URL.replace(/\/$/, '')}/auth/callback`;
  const scopes = DEFAULT_SCOPES;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CAFE24_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: scopes,
    state: mallId
  }).toString();
  const url = `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params}`;
  console.log('[INSTALL] redirect ->', url);
  return res.redirect(url);
});

// 콜백: code -> token 교환 -> DB 저장 -> 프론트 redirect
app.get('/auth/callback', async (req, res) => {
  const incoming = { query: req.query, ip: req.ip, at: new Date() };
  console.log('[AUTH CALLBACK] incoming:', incoming);

  // debug record (도움이 필요하면 여기 확인)
  try {
    await db.collection('debug_callbacks').insertOne({ ...incoming, savedAt: new Date() });
  } catch (e) {
    console.warn('[AUTH CALLBACK] debug insert failed', e && e.message);
  }

  const { error, error_description, code, state: mallId } = req.query;

  if (error) {
    console.warn('[AUTH CALLBACK] provider returned error', error, error_description);
    // 프론트의 redirect 경로로 포워딩 (프론트에서 처리)
    const q = new URLSearchParams({
      mall_id: mallId || '',
      auth_error: error_description || error
    }).toString();
    return res.redirect(`${APP_URL.replace(/\/$/, '')}/redirect?${q}`);
  }

  if (!code || !mallId) {
    console.error('[AUTH CALLBACK] missing code or state', { code, mallId });
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

    console.log('[AUTH CALLBACK] exchanging token for mallId=', mallId);
    const resp = await axios.post(tokenUrl, body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`
      },
      timeout: 15000
    });

    const data = resp.data;
    console.log('[AUTH CALLBACK] token response keys:', Object.keys(data));

    const doc = {
      mallId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      obtainedAt: new Date(),
      expiresIn: data.expires_in ?? null,
      raw: data
    };

    const upsertResult = await db.collection('token').updateOne(
      { mallId },
      { $set: doc },
      { upsert: true }
    );

    console.log('[AUTH CALLBACK] token saved', { mallId, upsertResult: !!upsertResult });
    // 성공 시 프론트로 포워딩 (프론트 Redirect 컴포넌트가 처리)
    return res.redirect(`${APP_URL.replace(/\/$/, '')}/redirect?mall_id=${encodeURIComponent(mallId)}&installed=1`);
  } catch (err) {
    console.error('[AUTH CALLBACK ERROR]', err.response?.data || err.message || err);
    // 실패 로그 저장
    try {
      await db.collection('debug_callbacks').insertOne({
        mallId,
        code,
        error: err.response?.data || err.message || String(err),
        savedAt: new Date()
      });
    } catch (e2) {
      console.warn('[AUTH CALLBACK] failed to insert error debug record', e2 && e2.message);
    }
    const msg = err.response?.data?.error_description || err.response?.data || err.message || 'token_exchange_failed';
    const q = new URLSearchParams({ mall_id: mallId || '', auth_error: msg }).toString();
    return res.redirect(`${APP_URL.replace(/\/$/, '')}/redirect?${q}`);
  }
});

// (프론트 리다이렉트 포워더) — 만약 카페24 등록된 redirect_uri가 /redirect 로 되어있다면 서버가 프론트로 포워드
app.get('/redirect', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const target = `${APP_URL.replace(/\/$/, '')}/redirect${qs ? ('?' + qs) : ''}`;
  console.log('[REDIRECT FORWARD] ->', target);
  return res.redirect(target);
});

// ----------------- API 헬퍼: 토큰 조회/refresh 및 요청 -----------------

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
    }
  });

  await db.collection('token').updateOne(
    { mallId },
    { $set: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        obtainedAt: new Date(),
        expiresIn: data.expires_in ?? null,
        raw_refresh_response: data
      }
    }
  );
  console.log('[TOKEN REFRESH] mallId=', mallId);
  return data.access_token;
}

async function apiRequest(mallId, method, url, data = {}, params = {}) {
  const doc = await db.collection('token').findOne({ mallId });
  if (!doc) {
    // 설치 안됨 — throw 구체적 에러 (앞단에서 처리)
    const installParams = new URLSearchParams({
      response_type: 'code',
      client_id: CAFE24_CLIENT_ID,
      redirect_uri: `${APP_URL.replace(/\/$/, '')}/auth/callback`,
      scope: DEFAULT_SCOPES,
      state: mallId
    }).toString();
    const installUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${installParams}`;
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
      timeout: 15000
    });
    return resp.data;
  } catch (err) {
    if (err.response?.status === 401 && doc.refreshToken) {
      // 토큰 만료 → refresh 후 재시도
      const newAccess = await refreshAccessToken(mallId, doc.refreshToken);
      const retry = await axios({
        method, url, data, params,
        headers: {
          Authorization: `Bearer ${newAccess}`,
          'Content-Type': 'application/json',
          'X-Cafe24-Api-Version': CAFE24_API_VERSION
        },
        timeout: 15000
      });
      return retry.data;
    }
    throw err;
  }
}

// ----------------- 핵심: 설치여부 확인 API -----------------
app.get('/api/:mallId/mall', async (req, res) => {
  const { mallId } = req.params;
  try {
    const doc = await db.collection('token').findOne({ mallId });
    if (doc && doc.accessToken) {
      return res.json({
        installed: true,
        mallId,
        userId: doc.userId || null,
        userName: doc.userName || null
      });
    }

    // 설치 안된 경우 설치 URL 반환
    const redirectUri = `${APP_URL.replace(/\/$/, '')}/auth/callback`;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CAFE24_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: DEFAULT_SCOPES,
      state: mallId
    }).toString();
    const installUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params}`;

    console.log(`[API BLOCK] not installed: mallId=${mallId} -> ${installUrl}`);

    return res.json({ installed: false, mallId, installUrl });
  } catch (err) {
    console.error('[MALL CHECK ERROR]', err);
    return res.status(500).json({ error: 'mall check failed' });
  }
});

// ----------------- 기존 엔드포인트들 (events, uploads, track, analytics 등) -----------------
// 여기부터는 기존에 사용하시던 엔드포인트 전체를 그대로 붙여 넣으세요.
// (아래 예시는 파일 업로드 + events 간단 CRUD, 그 외 analytics 엔드포인트 모두 동일하게 포함)
// -- 예시: 이미지 업로드 --
app.post('/api/:mallId/uploads/image', upload.single('file'), async (req, res) => {
  try {
    const { mallId } = req.params;
    const { filename, path: localPath, mimetype } = req.file;
    const key = `uploads/${mallId}/${filename}`;

    await s3Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: fs.createReadStream(localPath),
      ContentType: mimetype
      // R2 may not accept ACL option depending on provider
    }));

    fs.unlink(localPath, () => {});
    const url = `${R2_PUBLIC_BASE}/${key}`;
    res.json({ url });
  } catch (err) {
    console.error('[IMAGE UPLOAD ERROR]', err);
    res.status(500).json({ error: '이미지 업로드 실패' });
  }
});

// (여기에 질문자님이 이전에 쓰던 events, track, categories, coupons, analytics 등 모든 엔드포인트를
//  그대로 붙여넣으시면 됩니다.)
// --- 생략된 나머지 엔드포인트는 원본 그대로 복사해서 붙여넣으세요 ---


// ----------------- 서버 시작 -----------------
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
