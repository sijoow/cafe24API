// app.js
require('dotenv').config();
process.env.TZ = 'Asia/Seoul';

const express     = require('express');
const path        = require('path');
const bodyParser  = require('body-parser');
const cors        = require('cors');
const compression = require('compression');
const axios       = require('axios');
const { MongoClient, ObjectId } = require('mongodb');

const {
  MONGODB_URI,
  DB_NAME,
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  CAFE24_API_VERSION,
  REDIRECT_URI,
  PORT = 5000,
} = process.env;

let db;
const tokens = {}; // 메모리 캐시

/** MongoDB 연결 및 인덱스 초기화 */
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('▶️ MongoDB connected to', DB_NAME);
  await db.collection('tokens')
    .createIndex({ mallId: 1 }, { unique: true, name: 'idx_tokens_mallId' });
}

/** DB에 저장된 토큰을 메모리로 로드 */
async function preloadTokens() {
  const docs = await db.collection('tokens').find().toArray();
  docs.forEach(d => tokens[d.mallId] = {
    accessToken: d.accessToken,
    refreshToken: d.refreshToken
  });
  console.log('▶️ Preloaded tokens for', Object.keys(tokens));
}

/** 토큰 저장 헬퍼 */
async function saveTokens(mallId, at, rt) {
  tokens[mallId] = { accessToken: at, refreshToken: rt };
  await db.collection('tokens').updateOne(
    { mallId },
    { $set: { accessToken: at, refreshToken: rt, updatedAt: new Date() } },
    { upsert: true }
  );
}

/** 토큰 불러오기, 없으면 에러 */
async function loadTokens(mallId) {
  if (!tokens[mallId]) {
    const doc = await db.collection('tokens').findOne({ mallId });
    if (!doc) throw new Error(`토큰 없음. 먼저 앱 설치해주세요 (mallId=${mallId})`);
    tokens[mallId] = { accessToken: doc.accessToken, refreshToken: doc.refreshToken };
  }
  return tokens[mallId];
}

/** 토큰 리프레시 */
async function refreshAccessToken(mallId, oldRefreshToken) {
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
}

/** Cafe24 API 요청 공통 래퍼 */
async function apiRequest(mallId, method, path, data = {}, params = {}) {
  let { accessToken, refreshToken } = await loadTokens(mallId);
  const url = `https://${mallId}.cafe24api.com${path}`;
  try {
    const resp = await axios({ method, url, data, params, headers: {
      Authorization:          `Bearer ${accessToken}`,
      'X-Cafe24-Api-Version': CAFE24_CLIENT_VERSION
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

const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// 1) 설치 시작: ?mall_id=xxx 쿼리로 들어오면 OAuth authorize로 리다이렉트
app.get('/', (req, res, next) => {
  const mall_id = req.query.mall_id;
  if (mall_id) {
    const callback = `${REDIRECT_URI}?mall_id=${mall_id}`;
    const authorizeUrl =
      `https://${mall_id}.cafe24api.com/api/v2/oauth/authorize` +
      `?response_type=code` +
      `&client_id=${CAFE24_CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(callback)}` +
      `&state=app_install` +
      `&scope=mall.read_category,mall.read_product,mall.read_analytics`;
    return res.redirect(authorizeUrl);
  }
  next();
});

// 2) React 빌드 정적 자산
app.use(express.static(path.join(__dirname, 'public')));

// 3) OAuth 콜백 처리
app.get('/redirect', async (req, res) => {
  const code    = req.query.code;
  const mall_id = req.query.mall_id;
  if (!code || !mall_id) {
    return res.status(400).send('<h1>잘못된 접근입니다</h1><p>code 또는 mall_id 파라미터가 필요합니다.</p>');
  }
  try {
    const tokenUrl = `https://${mall_id}.cafe24api.com/api/v2/oauth/token`;
    const creds    = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const params   = new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      client_id:     CAFE24_CLIENT_ID,
      client_secret: CAFE24_CLIENT_SECRET,
      redirect_uri:  `${REDIRECT_URI}?mall_id=${mall_id}`,
      shop:          mall_id
    }).toString();

    const tokenResp = await axios.post(tokenUrl, params, {
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`
      }
    });

    await saveTokens(mall_id, tokenResp.data.access_token, tokenResp.data.refresh_token);
    console.log(`✔️ [${mall_id}] OAuth 성공, 토큰 저장 완료`);

    return res.send(`
      <!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>인증 완료</title></head>
      <body style="text-align:center;padding:2rem">
        <h1>🛠️ 인증 완료!</h1>
        <p>앱 설치가 완료되었습니다. 관리자 페이지로 이동합니다…</p>
        <script>setTimeout(()=>window.location.href='/admin',1500)</script>
      </body></html>
    `);
  } catch (err) {
    console.error('❌ [REDIRECT ERROR]', err.response?.data||err);
    return res.status(500).send('<h1>OAuth 인증 실패</h1><p>서버 로그를 확인하세요.</p>');
  }
});

// 4) React Admin SPA 라우팅
app.get(['/admin','/admin/*'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 5) API: Categories 조회
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
    console.error('[CATEGORIES ERROR]', err.message||err);
    res.status(500).json({ error: '전체 카테고리 조회 실패' });
  }
}
// 6) API: Coupons 조회
async function handleGetAllCoupons(req, res) {
  const mallId = req.params.mallId || req.query.shop || '';
  try {
    let all = [], offset = 0, limit = 100;
    while (true) {
      const { coupons } = await apiRequest(mallId, 'GET', '/api/v2/admin/coupons', {}, { shop_no:1, limit, offset });
      if (!coupons.length) break;
      all.push(...coupons);
      offset += coupons.length;
    }
    res.json(all.map(c=>({
      coupon_no: c.coupon_no,
      coupon_name: c.coupon_name,
      benefit_text: c.benefit_text,
      benefit_percentage: c.benefit_percentage,
      issued_count: c.issued_count,
      issue_type: c.issue_type,
      available_begin: c.available_begin_datetime,
      available_end:   c.available_end_datetime,
    })));
  } catch (err) {
    console.error('[COUPONS ERROR]', err.message||err);
    res.status(500).json({ error: '쿠폰 조회 실패' });
  }
}

app.get('/api/:mallId/categories/all', handleGetAllCategories);
app.get('/api/categories/all',        handleGetAllCategories);
app.get('/api/:mallId/coupons',       handleGetAllCoupons);
app.get('/api/coupons',               handleGetAllCoupons);

// …여기에 이벤트 CRUD, analytics, track 등 나머지 라우트도 동일 패턴으로 붙여주세요…

// 서버 기동
(async () => {
  try {
    await initDb();
    await preloadTokens();
    app.listen(PORT, () => console.log(`▶️ Server running on port ${PORT}`));
  } catch (err) {
    console.error('❌ 초기화 실패', err);
    process.exit(1);
  }
})();
