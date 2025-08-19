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
} = process.env;

if (!MONGODB_URI || !DB_NAME || !CAFE24_CLIENT_ID || !CAFE24_CLIENT_SECRET || !APP_URL) {
  console.error('환경변수(MONGODB_URI/DB_NAME/CAFE24_CLIENT_ID/CAFE24_CLIENT_SECRET/APP_URL)를 확인하세요.');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// ─── MongoDB 연결 ───────────────────────────────────────────────
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI, { useUnifiedTopology: true });
  await client.connect();
  db = client.db(DB_NAME);
  await db.collection('token').createIndex({ mallId: 1 }, { unique: true });
  console.log('▶️ MongoDB connected to', DB_NAME);
}

// ─── Multer (파일 업로드 임시저장) ─────────────────────────────────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// ─── R2 (AWS S3 호환) 클라이언트 ─────────────────────────────────
const s3Client = new S3Client({
  region: R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
  forcePathStyle: true,
});

// ===================================================================
// 선행 라우트: 카페24가 앱을 열 때 전달하는 mall_id 등을 처리.
// (static보다 먼저 와야 카페24 콜백/설치 흐름을 SPA가 가로채지 않습니다.)
// ===================================================================

// 유저가 관리자 화면에서 앱을 클릭하면 카페24는 client URL(예: https://onimon.shop/)로 쿼리파라미터와 함께 접근합니다.
// 예: https://onimon.shop/?mall_id=yogibo&shop_no=1&... 등
// 이 경우 토큰 유무 확인 → 없으면 authorize로 리다이렉트(설치 시작), 있으면 SPA 제공
app.get(['/', '/client'], async (req, res, next) => {
  try {
    const mallId = req.query.mall_id || req.query.mallId || req.query.site || req.query.client; // 안전하게 여러 케이스
    // 만약 mallId가 없으면 일반 홈페이지/landing으로 진행(다음 미들웨어로)
    if (!mallId) return next();

    // 토큰 정보가 DB에 있나 확인
    const tokenDoc = await db.collection('token').findOne({ mallId });
    if (tokenDoc && tokenDoc.accessToken) {
      // 이미 설치되어 있는 쇼핑몰: SPA로 보냄 (index.html)
      return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }

    // 설치 안된 경우 → 카페24 권한 요청 페이지로 리다이렉트 (install flow)
    const redirectUri = `${APP_URL}/auth/callback`;
    const scope = [
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

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CAFE24_CLIENT_ID,
      redirect_uri: redirectUri,
      scope,
      state: mallId // 간단하게 mallId를 state로 사용 (OAuth 흐름에서는 state 검증 필수)
    });

    const authorizeUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params.toString()}`;
    console.log(`[INSTALL REDIRECT] mallId=${mallId} -> ${authorizeUrl}`);
    return res.redirect(authorizeUrl);
  } catch (err) {
    console.error('[CLIENT HANDLER ERROR]', err);
    return res.status(500).send('서버 오류가 발생했습니다.');
  }
});

// ───────────────────────────────────────────────────────────────────
// 이제 static 파일 제공 (위의 '/' 핸들러가 mall_id를 처리하므로 가로채지 않습니다)
// ───────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ===================================================================
// ① 설치 → 권한요청 → 콜백 (code → 토큰) → DB 저장
// ===================================================================

// 설치 시작: mallId 기반 OAuth 권한 요청 (외부에서 직접 호출하고 싶을 때 사용)
app.get('/install/:mallId', (req, res) => {
  const { mallId } = req.params;
  const redirectUri = `${APP_URL}/auth/callback`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CAFE24_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'mall.read_promotion,mall.write_promotion,mall.read_category,mall.write_category,mall.read_product,mall.write_product,mall.read_collection,mall.read_application,mall.write_application,mall.read_analytics,mall.read_salesreport,mall.read_store',
    state: mallId,
  });
  res.redirect(`https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params}`);
});

// 콜백 핸들러: code → 토큰 발급 → DB에 mallId별 저장 → onimon.shop 으로 리다이렉트
app.get('/auth/callback', async (req, res) => {
  const { code, state: mallId } = req.query;
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

    const { data } = await axios.post(tokenUrl, body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`
      }
    });

    await db.collection('token').updateOne(
      { mallId },
      {
        $set: {
          mallId,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          obtainedAt: new Date(),
          expiresIn: data.expires_in,
          scopes: data.scopes || []
        }
      },
      { upsert: true }
    );

    console.log(`[AUTH CALLBACK] App installed for mallId: ${mallId}`);
    // 설치 후에는 카페24에서 앱을 열어준 원래 관리 화면으로 돌아가게 하고 싶다면
    // onimon.shop이 아닌 카페24 내부 경로로 redirect할 수도 있음. 우선 onimon.shop 루트로.
    return res.redirect(`${APP_URL}`);
  } catch (err) {
    console.error('[AUTH CALLBACK ERROR]', err.response?.data || err);
    return res.status(500).send('토큰 교환 중 오류가 발생했습니다.');
  }
});

// ===================================================================
// ② mallId-aware API 요청 헬퍼
// ===================================================================

// refresh token → access token 갱신
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
    {
      $set: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        obtainedAt: new Date(),
        expiresIn: data.expires_in
      }
    }
  );

  return data.access_token;
}

// mallId 기준으로 토큰 조회 → API 호출 → 401시 refresh → 재시도
async function apiRequest(mallId, method, url, data = {}, params = {}) {
  const doc = await db.collection('token').findOne({ mallId });
  if (!doc) throw new Error(`토큰 정보 없음: mallId=${mallId}`);

  try {
    const resp = await axios({
      method, url, data, params,
      headers: {
        Authorization: `Bearer ${doc.accessToken}`,
        'Content-Type': 'application/json',
        'X-Cafe24-Api-Version': CAFE24_API_VERSION,
      }
    });
    return resp.data;
  } catch (err) {
    if (err.response?.status === 401) {
      const newAccess = await refreshAccessToken(mallId, doc.refreshToken);
      const retry = await axios({
        method, url, data, params,
        headers: {
          Authorization: `Bearer ${newAccess}`,
          'Content-Type': 'application/json',
          'X-Cafe24-Api-Version': CAFE24_API_VERSION,
        }
      });
      return retry.data;
    }
    throw err;
  }
}

// (이하 기존 엔드포인트들 그대로 유지: 이미지 업로드, events, categories, coupons, analytics 등)
// ... (원래 코드의 나머지 엔드포인트들을 그대로 붙여넣으세요: 이미지 업로드, events CRUD, track, categories, coupons, analytics 등)
// 위 예시는 핵심 변경 포인트(클라이언트 핸들러 + static 위치 변경 + auth 콜백)만 보여준 것입니다.
// 실제로는 기존 파일의 모든 엔드포인트(이미지 업로드 /events /track /api 등)를 아래에 그대로 위치시켜 배포하세요.

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
