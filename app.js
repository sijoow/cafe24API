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

const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// ========== 디버깅 미들웨어 ==========
// 요청 쿼리/경로 확인용 — 배포 후에는 로그 레벨 낮추세요.
app.use((req, res, next) => {
  try {
    console.log('--- INCOMING REQUEST ---', req.method, req.originalUrl);
    console.log(' query:', req.query);
    // console.log(' headers:', req.headers); // 필요하면 활성화
  } catch (e) {
    console.error('[DEBUG LOG ERROR]', e);
  }
  next();
});

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

// ─── MongoDB 연결 ───────────────────────────────────────────────
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  await db.collection('token').createIndex({ mallId: 1 }, { unique: true });
  console.log('▶️ MongoDB connected to', DB_NAME);
}

// ===================================================================
// Root / client handler (카페24에서 app이 열릴 때 설치 여부 확인 후 권한요청 처리)
//  - 반드시 static 미들버퍼보다 먼저 동작해야 함.
// ===================================================================
app.get(['/', '/client'], async (req, res, next) => {
  try {
    // 카페24가 보내는 mall id 파라명들 일부를 수용
    const mallId = req.query.mall_id || req.query.mallId || req.query.mall || req.query.shop || req.query.shop_no;
    if (!mallId) {
      // mallId가 없으면 SPA 기본(index.html) 제공하도록 다음 미들웨어로 넘김
      return next();
    }

    // 이미 설치되어 토큰이 있으면 SPA 제공
    const tokenDoc = await db.collection('token').findOne({ mallId });
    if (tokenDoc && tokenDoc.accessToken) {
      console.log(`[CLIENT] mallId=${mallId} already installed -> serve SPA`);
      return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }

    // 설치되지 않았으면 카페24 권한요청 URL 생성 후 top-level redirect 시도
    const redirectUri = `${APP_URL}/auth/callback`;
    const scope = [
      'mall.read_promotion','mall.write_promotion',
      'mall.read_category','mall.write_category',
      'mall.read_product','mall.write_product',
      'mall.read_collection','mall.read_application','mall.write_application',
      'mall.read_analytics','mall.read_salesreport','mall.read_store'
    ].join(',');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     CAFE24_CLIENT_ID,
      redirect_uri:  redirectUri,
      scope,
      state:         mallId
    });

    const authorizeUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params.toString()}`;
    console.log(`[INSTALL REDIRECT] mallId=${mallId} -> ${authorizeUrl}`);

    // iframe 내부에서도 top-level으로 강제 이동시키는 HTML 응답
    return res.send(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8"/>
          <title>Redirecting to install...</title>
        </head>
        <body>
          <p>설치 화면으로 이동 중입니다. 이동되지 않으면 <a id="link" href="${authorizeUrl}" target="_top">설치하기</a>를 클릭하세요.</p>
          <script>
            try {
              if (window.top && window.top !== window) {
                window.top.location.href = ${JSON.stringify(authorizeUrl)};
              } else {
                window.location.href = ${JSON.stringify(authorizeUrl)};
              }
            } catch (e) {
              console.error('redirect failed', e);
              document.getElementById('link').style.display = 'inline';
            }
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[CLIENT HANDLER ERROR]', err);
    return res.status(500).send('서버 오류가 발생했습니다.');
  }
});

// ─── static 파일 제공 (위의 client 핸들러 이후에 둡니다) ─────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ===================================================================
// ① 설치 → 권한요청 → 콜백 (code → 토큰) → DB 저장
// ===================================================================

// 설치 시작: mallId 기반 OAuth 권한 요청 (디버깅용 직접 이동 가능)
app.get('/install/:mallId', (req, res) => {
  const { mallId } = req.params;
  const redirectUri = `${APP_URL}/auth/callback`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CAFE24_CLIENT_ID,
    redirect_uri:  redirectUri,
    scope:         'mall.read_promotion,mall.write_promotion,mall.read_category,mall.write_category,mall.read_product,mall.write_product,mall.read_collection,mall.read_application,mall.write_application,mall.read_analytics,mall.read_salesreport,mall.read_store',
    state:         mallId,
  });
  res.redirect(`https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params}`);
});

// 콜백 핸들러: code → 토큰 발급 → DB 저장 → 앱 루트로 리다이렉트
app.get('/auth/callback', async (req, res) => {
  const { code, state: mallId } = req.query;
  if (!code || !mallId) {
    console.warn('[AUTH CALLBACK] missing code or state', req.query);
    return res.status(400).send('code 또는 mallId가 없습니다.');
  }

  try {
    const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
    const creds    = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const body     = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: `${APP_URL}/auth/callback`
    }).toString();

    const { data } = await axios.post(tokenUrl, body, {
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`
      }
    });

    await db.collection('token').updateOne(
      { mallId },
      {
        $set: {
          mallId,
          accessToken:  data.access_token,
          refreshToken: data.refresh_token,
          obtainedAt:   new Date(),
          expiresIn:    data.expires_in
        }
      },
      { upsert: true }
    );

    console.log(`[AUTH CALLBACK] App installed for mallId: ${mallId}`);
    // 설치 완료 후 top-level으로 앱 루트(또는 별도 설치 완료 페이지)로 이동
    return res.send(`
      <!doctype html>
      <html>
        <head><meta charset="utf-8"/></head>
        <body>
          <script>
            try {
              if (window.top && window.top !== window) {
                window.top.location.href = ${JSON.stringify(APP_URL + '?installed=1&mall_id=' + mallId)};
              } else {
                window.location.href = ${JSON.stringify(APP_URL + '?installed=1&mall_id=' + mallId)};
              }
            } catch (e) {
              location.href = ${JSON.stringify(APP_URL + '?installed=1&mall_id=' + mallId)};
            }
          </script>
          <p>설치 완료. 이동 중입니다...</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[AUTH CALLBACK ERROR]', err.response?.data || err);
    return res.status(500).send('토큰 교환 중 오류가 발생했습니다.');
  }
});

// ===================================================================
// ② mallId-aware API 요청 헬퍼 (기존 코드 유지)
// ===================================================================

// refresh token → access token 갱신
async function refreshAccessToken(mallId, refreshToken) {
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
        expiresIn:    data.expires_in
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
        Authorization:         `Bearer ${doc.accessToken}`,
        'Content-Type':        'application/json',
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
// (이하 기존의 API 엔드포인트들과 analytics, products, events 등 코드를
//  그대로 붙여 넣으시면 됩니다 — 사용자께서 제공한 원본 코드를 그대로 유지함)
// ===================================================================

// ... (생략하지 마시고 원본의 나머지 엔드포인트들을 여기 아래에 그대로 붙여 넣으세요)
// 예: /api/:mallId/uploads/image, /api/:mallId/events, /api/:mallId/coupons, 등등

// ===================================================================
// 서버 시작 (초기화 후 실행)
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
