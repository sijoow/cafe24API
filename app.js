require('dotenv').config();
process.env.TZ = 'Asia/Seoul';

const express     = require('express');
const path        = require('path');
const bodyParser  = require('body-parser');
const cors        = require('cors');
const compression = require('compression');
const axios       = require('axios');
const { MongoClient } = require('mongodb');

const {
  MONGODB_URI,
  DB_NAME,
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  CAFE24_API_VERSION,
  REDIRECT_URI,        // ex: https://onimon.shop/redirect
  PORT = 5000,
} = process.env;

let db;
const tokens = {};  // in-memory cache

async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('▶️ MongoDB connected to', DB_NAME);
  // load existing tokens into memory
  const docs = await db.collection('tokens').find().toArray();
  docs.forEach(d => { tokens[d.mallId] = { accessToken:d.accessToken, refreshToken:d.refreshToken }; });
  console.log('▶️ Preloaded tokens for', Object.keys(tokens));
}

async function saveTokens(mallId, at, rt) {
  tokens[mallId] = { accessToken:at, refreshToken:rt };
  await db.collection('tokens').updateOne(
    { mallId },
    { $set: { accessToken:at, refreshToken:rt, updatedAt: new Date() } },
    { upsert:true }
  );
}

// 토큰 로드 or 에러
async function loadTokens(mallId) {
  if (!tokens[mallId]) {
    const doc = await db.collection('tokens').findOne({ mallId });
    if (!doc) throw new Error(`토큰 없음. 먼저 앱 설치해주세요 (mallId=${mallId})`);
    tokens[mallId] = { accessToken:doc.accessToken, refreshToken:doc.refreshToken };
  }
  return tokens[mallId];
}

async function refreshAccessToken(mallId, oldRefreshToken) {
  const url   = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
  const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: oldRefreshToken
  }).toString();

  try {
    const r = await axios.post(url, params, {
      headers: {
        'Content-Type':'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`
      }
    });
    await saveTokens(mallId, r.data.access_token, r.data.refresh_token);
    return r.data;
  } catch (err) {
    if (err.response?.data?.error === 'invalid_grant') {
      console.warn(`❗[${mallId}] refresh_token expired, deleting stored token`);
      await db.collection('tokens').deleteOne({ mallId });
      delete tokens[mallId];
      throw new Error('refresh_token이 유효하지 않습니다. 앱을 재설치해주세요.');
    }
    throw err;
  }
}

async function apiRequest(mallId, method, path, data={}, params={}) {
  let { accessToken, refreshToken } = await loadTokens(mallId);
  const url = `https://${mallId}.cafe24api.com${path}`;
  try {
    const resp = await axios({ method, url, data, params, headers:{
      Authorization:          `Bearer ${accessToken}`,
      'X-Cafe24-Api-Version': CAFE24_API_VERSION
    }});
    return resp.data;
  } catch (err) {
    if (err.response?.status === 401) {
      const refreshed = await refreshAccessToken(mallId, refreshToken);
      accessToken = refreshed.access_token;
      refreshToken = refreshed.refresh_token;
      return apiRequest(mallId, method, path, data, params);
    }
    throw err;
  }
}

const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit:'10mb' }));
app.use(bodyParser.urlencoded({ extended:true }));

// 1) 설치 시작: ?mall_id=onimon  → 카페24 OAuth authorize 로 리다이렉트
app.get('/', (req, res, next) => {
  const mall_id = req.query.mall_id;
  if (mall_id) {
    const callback = `${REDIRECT_URI}?mall_id=${mall_id}`;
    const authorizeUrl =
      `https://${mall_id}.cafe24api.com/api/v2/oauth/authorize` +
      `?response_type=code` +
      `&client_id=${CAFE24_CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(callback)}` +
      `&scope=mall.read_category,mall.read_product,mall.read_analytics` +
      `&state=app_install`;
    return res.redirect(authorizeUrl);
  }
  next();
});

// 2) React 정적 파일 서빙
const staticDir = path.join(__dirname, 'public');
app.use(express.static(staticDir));

// 3) OAuth 콜백
app.get('/redirect', async (req, res) => {
  const code    = req.query.code;
  const mall_id = req.query.mall_id;
  if (!code || !mall_id) {
    return res.status(400).send('<h1>잘못된 접근입니다</h1><p>code 또는 mall_id 누락</p>');
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
        'Content-Type':'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`
      }
    });

    await saveTokens(
      mall_id,
      tokenResp.data.access_token,
      tokenResp.data.refresh_token
    );
    console.log(`✔️ [${mall_id}] OAuth 성공, 토큰 저장 완료`);

    // React 관리자 페이지로
    res.send(`
      <!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="text-align:center;padding:2rem">
        <h1>🛠️ 인증 완료!</h1>
        <p>1.5초 후 관리자 페이지로 이동합니다...</p>
        <script>setTimeout(()=>location.href='/admin',1500)</script>
      </body></html>
    `);
  } catch (err) {
    console.error('❌ REDIRECT ERROR', err.response?.data||err);
    res.status(500).send('<h1>OAuth 인증 실패</h1><p>서버 로그 확인</p>');
  }
});

// 4) API 엔드포인트
app.get('/api/:mallId/categories/all', async (req, res) => {
  const mallId = req.params.mallId;
  try {
    let all = [], offset=0, limit=100;
    while(true){
      const { categories } = await apiRequest(mallId,'GET','/api/v2/admin/categories',{},{limit,offset});
      if (!categories.length) break;
      all.push(...categories);
      offset += categories.length;
    }
    res.json(all);
  } catch (err) {
    console.error('[CATEGORIES ERROR]', err.message||err);
    res.status(500).json({ error:'카테고리 조회 실패' });
  }
});

app.get('/api/:mallId/coupons', async (req, res) => {
  const mallId = req.params.mallId;
  try {
    let all = [], offset=0, limit=100;
    while(true){
      const { coupons } = await apiRequest(mallId,'GET','/api/v2/admin/coupons',{},{shop_no:1,limit,offset});
      if (!coupons.length) break;
      all.push(...coupons);
      offset += coupons.length;
    }
    res.json(all);
  } catch (err) {
    console.error('[COUPONS ERROR]', err.message||err);
    res.status(500).json({ error:'쿠폰 조회 실패' });
  }
});

// … 추가로 이벤트 CRUD, analytics, track 등 API 핸들러를 뒤에 이어 붙이세요 …

// 5) SPA 라우팅 지원: /admin 및 그 외 React 라우트 → index.html
app.get(['/admin','/admin/*'], (req, res) => {
  res.sendFile(path.join(staticDir,'index.html'));
});

// 6) 그 외 나머지도 React로
app.get('*', (req, res) => {
  // API 라우트가 아닐 때
  if (!req.path.startsWith('/api') && req.path !== '/redirect') {
    res.sendFile(path.join(staticDir,'index.html'));
  }
});

(async()=>{
  try {
    await initDb();
    await initIndexes();
    app.listen(PORT,()=>console.log(`▶️ Server running on ${PORT}`));
  } catch(err){
    console.error('❌ 초기화 실패', err);
    process.exit(1);
  }
})();
