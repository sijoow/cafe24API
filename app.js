require('dotenv').config();
process.env.TZ = 'Asia/Seoul';

const express     = require('express');
const path        = require('path');
const bodyParser  = require('body-parser');
const fs          = require('fs');
const cors        = require('cors');
const compression = require('compression');
const axios       = require('axios');
const multer      = require('multer');
const dayjs       = require('dayjs');
const utc         = require('dayjs/plugin/utc');
const tz          = require('dayjs/plugin/timezone');
const { MongoClient, ObjectId } = require('mongodb');
dayjs.extend(utc);
dayjs.extend(tz);

const {
  MONGODB_URI,
  DB_NAME,
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  CAFE24_API_VERSION,
  REDIRECT_URI,
  PORT = 5000,
  R2_ACCESS_KEY,
  R2_SECRET_KEY,
  R2_BUCKET_NAME,
  R2_ENDPOINT,
  R2_REGION = 'us-east-1',
  R2_PUBLIC_BASE,
} = process.env;

// ─── 전역 변수 ─────────────────────────────────────────────────────
let db;
const globalTokens = {};

// ─── Express 앱 생성 ───────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json({  limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Multer 설정 ───────────────────────────────────────────────────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// ─── R2 클라이언트 ─────────────────────────────────────────────────
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const s3Client = new S3Client({
  region:   R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
  forcePathStyle: true,
});

// ─── MongoDB 연결/인덱스 ────────────────────────────────────────────
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('▶️ MongoDB connected to', DB_NAME);
}

async function initIndexes() {
  console.log('🔧 Setting up indexes');
  const tokensCol = db.collection('tokens');
  try {
    await tokensCol.dropIndex('mallId_1');
    console.log('🗑  Dropped old index mallId_1');
  } catch {}
  await tokensCol.createIndex({ mallId: 1 }, { unique: true, name: 'idx_tokens_mallId' });
  console.log('✔️ Created idx_tokens_mallId on tokens');
}

async function preloadTokensFromDb() {
  const docs = await db.collection('tokens').find().toArray();
  docs.forEach(({ mallId, accessToken, refreshToken }) => {
    globalTokens[mallId] = { accessToken, refreshToken };
  });
  console.log('▶️ Preloaded tokens for', Object.keys(globalTokens));
}

// ─── OAuth 토큰 헬퍼 ────────────────────────────────────────────────
async function saveTokens(mallId, accessToken, refreshToken) {
  globalTokens[mallId] = { accessToken, refreshToken };
}

async function loadTokens(mallId) {
  if (!globalTokens[mallId]) {
    const doc = await db.collection('tokens').findOne({ mallId });
    if (!doc) throw new Error(`토큰 없음. 먼저 앱 설치해주세요 (mallId=${mallId})`);
    globalTokens[mallId] = { accessToken: doc.accessToken, refreshToken: doc.refreshToken };
  }
  return globalTokens[mallId];
}

async function refreshAccessToken(mallId, oldRefreshToken) {
  try {
    const url   = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
    const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const params = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: oldRefreshToken
    }).toString();

    const r = await axios.post(url, params, {
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`
      }
    });

    await saveTokens(mallId, r.data.access_token, r.data.refresh_token);
    return { accessToken: r.data.access_token, refreshToken: r.data.refresh_token };
  } catch (err) {
    if (err.response?.data?.error === 'invalid_grant') {
      console.warn(`❗[${mallId}] refresh_token expired, clearing stored token`);
      await db.collection('tokens').deleteOne({ mallId });
      throw new Error('refresh_token이 유효하지 않습니다. 앱을 재설치해주세요.');
    }
    throw err;
  }
}

async function apiRequest(mallId, method, path, data = {}, params = {}) {
  let { accessToken, refreshToken } = await loadTokens(mallId);
  const url = `https://${mallId}.cafe24api.com${path}`;
  try {
    const resp = await axios({ method, url, data, params, headers: {
      Authorization:          `Bearer ${accessToken}`,
      'X-Cafe24-Api-Version': CAFE24_API_VERSION
    }});
    return resp.data;
  } catch (err) {
    if (err.response?.status === 401) {
      ({ accessToken, refreshToken } = await refreshAccessToken(mallId, refreshToken));
      return apiRequest(mallId, method, path, data, params);
    }
    throw err;
  }
}
// ─── 1) root("/") 로 설치 시작 시 → 카페24 OAuth로 리다이렉트 ───────────────────────────────────
app.get('/', (req, res, next) => {
  const { mall_id } = req.query;
  if (mall_id) {
    // 동적으로 mall_id를 붙인 콜백 URI
   const callbackUri = `${REDIRECT_URI}?shop=${mall_id}`;

    const authorizeUrl =
      `https://${mall_id}.cafe24api.com/api/v2/oauth/authorize` +
      `?response_type=code` +
      `&client_id=${CAFE24_CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(callbackUri)}` +
      `&state=app_install` +
      `&scope=mall.read_category,mall.read_product,mall.read_analytics`;

    return res.redirect(authorizeUrl);
  }
  next(); // mall_id 없으면 static 파일 서빙
});


// ─── 2) React 정적 파일 서빙 ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── 2) /redirect 콜백 핸들러 ───────────────────────────────────────────────────────────────────
app.get('/redirect', async (req, res) => {
const code    = req.query.code;
  const mall_id = req.query.shop || req.query.mall_id;    // 반드시 mall_id가 붙어야 합니다.

  console.log('📲 [REDIRECT] 호출됨', { code, mall_id });
  if (!code || !mall_id) {
    return res
      .status(400)
      .send(`<h1>잘못된 접근입니다</h1><p>code 또는 mall_id 파라미터가 필요합니다.</p>`);
  }

  try {
    const tokenUrl = `https://${mall_id}.cafe24api.com/api/v2/oauth/token`;
    const creds    = Buffer.from(
      `${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`
    ).toString('base64');

    // 토큰 교환 요청
    const params = new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      client_id:     CAFE24_CLIENT_ID,
      client_secret: CAFE24_CLIENT_SECRET,
      redirect_uri:  `${REDIRECT_URI}?shop=${mall_id}`, // root와 동일하게 mall_id 포함
      shop:          mall_id
    }).toString();

    const tokenResp = await axios.post(tokenUrl, params, {
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`,
      }
    });

    const { access_token, refresh_token } = tokenResp.data;
    await db.collection('tokens').updateOne(
      { mallId: mall_id },
      { $set: {
          accessToken:  access_token,
          refreshToken: refresh_token,
          updatedAt:    new Date()
        }
      },
      { upsert: true }
    );

    console.log(`✔️ [${mall_id}] OAuth 성공, DB 저장 완료`);

    // 1.5초 후 React 관리자 페이지로 돌려보내기
    return res.send(`
      <!DOCTYPE html>
      <html lang="ko">
      <head><meta charset="utf-8"/><title>인증 완료</title></head>
      <body style="text-align:center; padding:2rem;">
        <h1>🛠️ 인증 완료!</h1>
        <p>앱 설치가 완료되었습니다. 잠시만 기다려 주세요…</p>
        <script>
          setTimeout(() => window.location.href = '/admin', 1500);
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('❌ [REDIRECT ERROR]', err.response?.data || err);
    return res
      .status(500)
      .send('<h1>OAuth 인증 실패</h1><p>서버 로그를 확인하세요.</p>');
  }
});

// ─── API Handlers ───────────────────────────────────────────────────
async function handleGetAllCategories(req, res) {
  const mallId = req.params.mallId || req.query.shop || '';
  try {
    let all = [], offset = 0, limit = 100;
    while (true) {
      const { categories } = await apiRequest(mallId, 'GET', '/api/v2/admin/categories', {}, { limit, offset });
      if (!categories.length) break;
      all.push(...categories);
      offset += categories.length;
    }
    res.json(all);
  } catch (err) {
    console.error('[CATEGORIES ERROR]', err.message || err);
    res.status(500).json({ error: '전체 카테고리 조회 실패' });
  }
}

async function handleGetAllCoupons(req, res) {
  const mallId = req.params.mallId || req.query.shop || '';
  try {
    let all = [], offset = 0, limit = 100;
    while (true) {
      const { coupons } = await apiRequest(mallId, 'GET', '/api/v2/admin/coupons', {}, { shop_no: 1, limit, offset });
      if (!coupons.length) break;
      all.push(...coupons);
      offset += coupons.length;
    }
    res.json(all.map(c => ({
      coupon_no:          c.coupon_no,
      coupon_name:        c.coupon_name,
      benefit_text:       c.benefit_text,
      benefit_percentage: c.benefit_percentage,
      issued_count:       c.issued_count,
      issue_type:         c.issue_type,
      available_begin:    c.available_begin_datetime,
      available_end:      c.available_end_datetime,
    })));
  } catch (err) {
    console.error('[COUPONS ERROR]', err.message || err);
    res.status(500).json({ error: '쿠폰 조회 실패' });
  }
}

// 공통 API 라우트
app.get('/api/:mallId/categories/all', handleGetAllCategories);
app.get('/api/categories/all',        handleGetAllCategories);
app.get('/api/:mallId/coupons',       handleGetAllCoupons);
app.get('/api/coupons',               handleGetAllCoupons);

// …이하 이벤트 CRUD, analytics, track, etc. 동일하게 붙여주세요…

// ─── 서버 시작 ─────────────────────────────────────────────────────
(async () => {
  try {
    await initDb();
    await initIndexes();
    await preloadTokensFromDb();
    app.listen(PORT, () => console.log(`▶️ Server running on port ${PORT}`));
  } catch (err) {
    console.error('❌ 초기화 실패', err);
    process.exit(1);
  }
})();
