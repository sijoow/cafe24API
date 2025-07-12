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
  REDIRECT_URI,          // e.g. "https://onimon.shop/redirect"
  PORT = 5000,
} = process.env;

let db;
const globalTokens = {};

// ── MongoDB 초기화 ────────────────────────────────────────────────
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('▶️ MongoDB connected to', DB_NAME);

  // tokens 컬렉션 인덱스
  const col = db.collection('tokens');
  try { await col.dropIndex('mallId_1'); } catch {}
  await col.createIndex({ mallId:1 }, { unique:true, name:'idx_tokens_mallId' });
}

// 기존 DB 토큰 메모리 로드
async function preloadTokens() {
  const docs = await db.collection('tokens').find().toArray();
  docs.forEach(d => globalTokens[d.mallId] = {
    accessToken:  d.accessToken,
    refreshToken: d.refreshToken
  });
  console.log('▶️ Preloaded tokens for', Object.keys(globalTokens));
}

// 토큰 저장·로드·갱신 헬퍼
async function saveTokens(mallId, at, rt) {
  await db.collection('tokens').updateOne(
    { mallId },
    { $set:{ accessToken:at, refreshToken:rt, updatedAt:new Date() } },
    { upsert:true }
  );
  globalTokens[mallId] = { accessToken:at, refreshToken:rt };
}

async function loadTokens(mallId) {
  if (!globalTokens[mallId]) {
    const doc = await db.collection('tokens').findOne({ mallId });
    if (!doc) throw new Error(`토큰 없음. 먼저 앱 설치해주세요 (mallId=${mallId})`);
    globalTokens[mallId] = {
      accessToken:  doc.accessToken,
      refreshToken: doc.refreshToken
    };
  }
  return globalTokens[mallId];
}

async function refreshAccessToken(mallId, oldRt) {
  const url   = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
  const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: oldRt
  }).toString();

  const r = await axios.post(url, params, {
    headers:{
      'Content-Type':'application/x-www-form-urlencoded',
      'Authorization':`Basic ${creds}`
    }
  });
  await saveTokens(mallId, r.data.access_token, r.data.refresh_token);
  return { accessToken:r.data.access_token, refreshToken:r.data.refresh_token };
}

async function apiRequest(mallId, method, path, data={}, params={}) {
  let { accessToken, refreshToken } = await loadTokens(mallId);
  try {
    const resp = await axios({
      method,
      url: `https://${mallId}.cafe24api.com${path}`,
      data, params,
      headers:{
        Authorization:          `Bearer ${accessToken}`,
        'X-Cafe24-Api-Version': CAFE24_API_VERSION
      }
    });
    return resp.data;
  } catch (err) {
    if (err.response?.status === 401) {
      ({ accessToken, refreshToken } = await refreshAccessToken(mallId, refreshToken));
      return apiRequest(mallId, method, path, data, params);
    }
    throw err;
  }
}

// ── 1) 설치 시작: ?mall_id=… 로 들어오면 카페24로 리다이렉트 ────────────
const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended:true }));
app.use(express.static(path.join(__dirname,'public')));

app.get('/', (req, res, next) => {
  const { mall_id } = req.query;
  if (mall_id) {
    const cb = `${REDIRECT_URI}?mall_id=${mall_id}`;
    const authUrl =
      `https://${mall_id}.cafe24api.com/api/v2/oauth/authorize` +
      `?response_type=code` +
      `&client_id=${CAFE24_CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(cb)}` +
      `&state=app_install` +
      `&scope=mall.read_category,mall.read_product,mall.read_analytics`;
    return res.redirect(authUrl);
  }
  next();
});

// ── 2) OAuth 콜백: 카페24가 이 경로로 code·mall_id 보냄 ─────────────────
app.get('/redirect', async (req, res) => {
  const { code, mall_id } = req.query;
  if (!code || !mall_id) {
    return res.status(400).send('<h1>잘못된 접근</h1><p>code 또는 mall_id가 필요합니다.</p>');
  }
  try {
    const tokenUrl = `https://${mall_id}.cafe24api.com/api/v2/oauth/token`;
    const creds    = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const params = new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      client_id:     CAFE24_CLIENT_ID,
      client_secret: CAFE24_CLIENT_SECRET,
      redirect_uri:  `${REDIRECT_URI}?mall_id=${mall_id}`,
      shop:          mall_id
    }).toString();

    const r = await axios.post(tokenUrl, params, {
      headers:{
        'Content-Type':'application/x-www-form-urlencoded',
        'Authorization':`Basic ${creds}`
      }
    });
    await saveTokens(mall_id, r.data.access_token, r.data.refresh_token);
    console.log(`✔️ [${mall_id}] 인증 완료, 토큰 저장`);

    return res.send(`
      <!doctype html>
      <html><head><meta charset="utf-8"><title>인증 완료</title></head>
      <body style="text-align:center;padding:2rem">
        <h1>인증 성공!</h1>
        <p>1.5초 후 관리자 페이지로 이동합니다…</p>
        <script>setTimeout(()=>location.href='/admin',1500)</script>
      </body>
      </html>
    `);
  } catch (e) {
    console.error('🔴 [REDIRECT ERROR]', e.response?.data || e);
    return res.status(500).send('<h1>인증 실패</h1><p>서버 로그를 확인하세요.</p>');
  }
});

// ── 3) API 라우트 예시 ─────────────────────────────────────────────
app.get('/api/:mallId/categories/all', async (req, res) => {
  try {
    const data = await apiRequest(req.params.mallId, 'GET', '/api/v2/admin/categories', {}, { limit:100, offset:0 });
    res.json(data.categories || []);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error:'카테고리 조회 실패' });
  }
});
app.get('/api/:mallId/coupons', async (req, res) => {
  try {
    const data = await apiRequest(req.params.mallId, 'GET', '/api/v2/admin/coupons', {}, { shop_no:1, limit:100, offset:0 });
    res.json(data.coupons || []);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error:'쿠폰 조회 실패' });
  }
});

// ── 4) SPA 관리자 페이지(publish된 React) 앞단 ───────────────────────
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname,'public','index.html'));
});

// ── 5) 서버 시작 ─────────────────────────────────────────────────────
;(async()=>{
  try {
    await initDb();
    await preloadTokens();
    app.listen(PORT,()=>console.log(`▶️ listening on ${PORT}`));
  } catch(e){
    console.error('❌ 초기화 실패', e);
    process.exit(1);
  }
})();
