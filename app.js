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

// --- 간단 요청 로거 (디버그용)
app.use((req, res, next) => {
  console.log('--- INCOMING REQUEST ---', req.method, req.originalUrl);
  if (Object.keys(req.query || {}).length) console.log(' query:', req.query);
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
// Root 진입 가로채기: mall_id가 있으면 카페24 권한요청 URL로 이동
// (express.static 보다 위에 있어야 index.html 로 내려가기 전에 가로챕니다)
// ===================================================================
app.get('/', (req, res, next) => {
  try {
    const mallId = req.query.mall_id || req.query.mallId || req.query.mall || req.query.shop || req.query.user_id || req.query.state;
    if (!mallId) return next();

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
    console.log(`[ROOT HANDLER] mall_id=${mallId} -> ${authorizeUrl}`);

    // iframe 내에 열려도 상위창으로 강제 이동
    return res.send(`
      <!doctype html>
      <html>
        <head><meta charset="utf-8"/><title>앱 설치로 이동</title></head>
        <body>
          <p>앱 설치 화면으로 이동합니다. 자동 이동되지 않으면 <a id="lnk" href="${authorizeUrl}" target="_top">설치하기 (팝업 차단시 클릭)</a>를 눌러주세요.</p>
          <script>
            try {
              const url = ${JSON.stringify(authorizeUrl)};
              if (window.top && window.top !== window) {
                window.top.location.href = url;
              } else {
                window.location.href = url;
              }
            } catch(e) {
              document.getElementById('lnk').style.display = 'inline';
            }
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[ROOT HANDLER ERROR]', err);
    return res.status(500).send('서버 오류');
  }
});

// ─── 정적 파일 제공 (SPA) ─────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ===================================================================
// ① 설치 → 권한요청(이미 위에서 처리 가능) → 콜백 (code → 토큰) → DB 저장
// ===================================================================

// 설치 시작: mallId 기반 OAuth 권한 요청 (기존 /install 유지)
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

// 콜백 핸들러: code → 토큰 발급 → DB에 mallId별 저장 → SPA의 /auth/callback 로 리다이렉트
app.get('/auth/callback', async (req, res) => {
  const { code, state: mallId } = req.query;
  if (!code || !mallId) {
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

    // 토큰 응답의 가능한 필드(샘플 기준)를 DB에 저장
    await db.collection('token').updateOne(
      { mallId },
      {
        $set: {
          mallId,
          accessToken:  data.access_token,
          refreshToken: data.refresh_token,
          obtainedAt:   new Date(),
          expiresIn:    data.expires_in || data.expires_at || null,
          clientId:     data.client_id || null,
          mall_id_resp: data.mall_id || data.mallId || null,
          userId:       data.user_id || data.userId || null,
          scopes:       data.scopes || data.scope || null,
          issuedAt:     data.issued_at || data.issuedAt || null,
          raw:          data
        }
      },
      { upsert: true }
    );

    console.log(`[AUTH CALLBACK] App installed for mallId: ${mallId}`);

    // SPA 가 처리할 수 있도록 mall_id를 쿼리로 붙여서 /auth/callback (프론트 라우트) 로 리다이렉트
    return res.redirect(`${APP_URL}/auth/callback?mall_id=${encodeURIComponent(mallId)}`);
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
// ③ mallId-aware 전용 엔드포인트 모음
// ===================================================================

// (A) Redirect.jsx 가 호출하는 엔드포인트 — 설치 여부/간단한 정보 반환
app.get('/api/:mallId/mall', async (req, res) => {
  try {
    const { mallId } = req.params;
    const doc = await db.collection('token').findOne({ mallId });
    if (!doc) {
      return res.json({ installed: false, mallId });
    }
    // 반환 필드: installed, mallId, userId, userName(없으면 null)
    return res.json({
      installed: true,
      mallId: doc.mallId,
      userId: doc.userId || null,
      userName: doc.userName || null, // userName은 토큰 응답에 항상 없는 경우가 많음
      scopes: doc.scopes || null,
      issuedAt: doc.issuedAt || doc.issuedAt
    });
  } catch (err) {
    console.error('[API /mall ERROR]', err);
    return res.status(500).json({ error: '서버 오류' });
  }
});

// (0) 기본 Ping
app.get('/api/:mallId/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ─── 이미지 업로드 (Multer + R2/S3) ─────────────────────────────────
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

// (이하 기존 API들 — 원본 파일에서 제공하신 그대로 붙여넣기)
// ... (생략하지 마시고 원본에 있던 엔드포인트들을 그대로 이어 붙이세요)
// 예: events, track, categories/all, coupons 등 기존 모든 라우트가 뒤에 옵니다.

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
