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
  ACCESS_TOKEN,
  REFRESH_TOKEN,
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  CAFE24_API_VERSION,
  CAFE24_MALLID: DEFAULT_MALL,
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
let globalTokens = {};

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


async function loadTokens(mallId) {
  // 없으면 DB 확인 → 없으면 설치 요청 에러
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


async function initIndexes() {
  console.log('🔧 Setting up indexes');
  const tokensCol = db.collection('tokens');
  // drop old auto‐created mallId_1 index if present
  try {
    await tokensCol.dropIndex('mallId_1');
    console.log('🗑  Dropped old index mallId_1');
  } catch {}
  await tokensCol.createIndex({ mallId: 1 }, { unique: true, name: 'idx_tokens_mallId' });
  console.log('✔️ Created idx_tokens_mallId on tokens');
}

// ─── OAuth 토큰 헬퍼 ────────────────────────────────────────────────
async function saveTokens(mallId, at, rt) {
  globalTokens[mallId] = { accessToken: at, refreshToken: rt };
}

 async function loadTokens(mallId) {
   // DB 에도 없고 메모리에도 없으면, "설치→/redirect" 를 먼저 진행하라는 에러를 던집니다.
   if (!globalTokens[mallId]) {
     const doc = await db.collection('tokens').findOne({ mallId });
     if (!doc) throw new Error(`토큰 없음. 먼저 앱을 설치해주세요 (mallId=${mallId})`);
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
        'Authorization': `Basic ${creds}`,
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


// 2) root("/") 로 App 관리 진입 시
app.get('/', (req, res, next) => {
  const { mall_id } = req.query;

  const authorizeUrl =
    `https://${mall_id}.cafe24api.com/api/v2/oauth/authorize` +
    `?response_type=code` +
    `&client_id=${CAFE24_CLIENT_ID}` +
    `&state=app_install` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=mall.read_category,mall.read_product,mall.read_analytics` +
    `&shop_no=1`;
     return res.redirect(authorizeUrl);
  
  // mall_id 없으면 일반 정적파일 서빙
  next();
});

// 3) 정적 파일(React build) 서빙
app.use(express.static(path.join(__dirname, 'public')));

// ─── OAuth 인증 콜백 라우트 ────────────────────────────────────────
app.get('/redirect', async (req, res) => {
const { code, shop: shopParam, mall_id } = req.query;
const shop = shopParam || mall_id;
  console.log('📲 [REDIRECT ROUTE] 호출됨', { code, shop });

  if (!code || !shop) {
    console.warn('⚠️ [REDIRECT ROUTE] code/shop 누락');
    return res
      .status(400)
      .send(`
        <h1>잘못된 접근입니다</h1>
        <p>code 또는 shop 파라미터가 필요합니다.</p>
      `);
  }

  try {
    const tokenUrl = `https://${shop}.cafe24api.com/api/v2/oauth/token`;
    const creds    = Buffer.from(
      `${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`
    ).toString('base64');

    console.log(`🔑 [${shop}] 토큰 교환 시작: ${tokenUrl}`);

    const params = new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      client_id:     CAFE24_CLIENT_ID,
      client_secret: CAFE24_CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
      shop
    }).toString();

    const tokenResp = await axios.post(tokenUrl, params, {
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`,
      }
    });

    const { access_token, refresh_token } = tokenResp.data;
    await db.collection('tokens').updateOne(
      { mallId: shop },
      {
        $set: {
          accessToken:  access_token,
          refreshToken: refresh_token,
          updatedAt:    new Date()
        }
      },
      { upsert: true }
    );

    console.log(`✔️ [${shop}] OAuth 인증 성공 — 토큰 저장 완료`);
    console.log(`   • access (20자): ${access_token.slice(0,20)}…`);
    console.log(`   • refresh (20자): ${refresh_token.slice(0,20)}…`);

    // 사용자에게 간단한 완료 화면을 보여주고 /admin 으로 리다이렉트
    return res.send(`
      <!DOCTYPE html>
      <html lang="ko">
      <head><meta charset="utf-8"/><title>인증 완료</title></head>
      <body style="text-align:center; padding:2rem;">
        <h1>🛠️ OAuth 인증 완료!</h1>
        <p>앱 설치가 완료되었습니다. 1.5초 후 관리자 페이지로 이동합니다…</p>
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
      .send('<h1>OAuth 인증에 실패했습니다.</h1><p>로그를 확인해주세요.</p>');
  }
});


// ─── 핸들러 분리 ──────────────────────────────────────────────────
async function handleGetAllCategories(req, res) {
  const mallId = req.params.mallId || DEFAULT_MALL;
  try {
    let all = [], offset = 0, limit = 100;
    while (true) {
      const { categories } = await apiRequest(
        mallId, 'GET', '/api/v2/admin/categories', {}, { limit, offset }
      );
      if (!categories.length) break;
      all.push(...categories);
      offset += categories.length;
    }
    res.json(all);
  } catch (err) {
    console.error('[CATEGORIES ERROR]', err.response?.data || err);
    res.status(500).json({ error: '전체 카테고리 조회 실패' });
  }
}

async function handleGetAllCoupons(req, res) {
  const mallId = req.params.mallId || DEFAULT_MALL;
  try {
    let all = [], offset = 0, limit = 100;
    while (true) {
      const { coupons } = await apiRequest(
        mallId, 'GET', '/api/v2/admin/coupons', {}, { shop_no: 1, limit, offset }
      );
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
    console.error('[COUPONS ERROR]', err.response?.data || err);
    res.status(500).json({ error: '쿠폰 조회 실패' });
  }
}

async function preloadTokensFromDb() {
  const docs = await db.collection('tokens').find().toArray();
  docs.forEach(({ mallId, accessToken, refreshToken }) => {
    globalTokens[mallId] = { accessToken, refreshToken };
  });
  console.log('▶️ Preloaded tokens for', Object.keys(globalTokens));
}
// ─── 서버 시작 전 초기화 ─────────────────────────────────────────────
;(async () => {
  try {
    await initDb();
    await initIndexes();
    await preloadTokensFromDb();      // ← 여기 추가
    app.listen(PORT, () => console.log(`▶️ Server running on port ${PORT}`));
  } catch (err) {
    console.error('❌ 초기화 실패', err);
    process.exit(1);
  }
})();

// ─── 공통 라우트 ────────────────────────────────────────────────────
// Ping
app.get('/api/ping', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Categories
app.get('/api/categories/all',         handleGetAllCategories);
app.get('/api/:mallId/categories/all', handleGetAllCategories);

// Coupons
app.get('/api/coupons',         handleGetAllCoupons);
app.get('/api/:mallId/coupons', handleGetAllCoupons);

// ─── 이벤트 CRUD (MongoDB) ─────────────────────────────────────────
function eventsCol(mallId = DEFAULT_MALL) {
  return db.collection('events');
}

app.get('/api/events', async (req, res) => {
  try {
    const list = await eventsCol().find().sort({ createdAt: -1 }).toArray();
    res.json(list);
  } catch {
    res.status(500).json({ error: '이벤트 목록 조회 실패' });
  }
});

app.get('/api/events/:id', async (req, res) => {
  try {
    const ev = await eventsCol().findOne({ _id: new ObjectId(req.params.id) });
    if (!ev) return res.status(404).json({ error: '이벤트가 없습니다' });
    res.json(ev);
  } catch {
    res.status(500).json({ error: '이벤트 조회 실패' });
  }
});

app.post('/api/events', async (req, res) => {
  try {
    const nowKst = dayjs().tz('Asia/Seoul').toDate();
    const doc = {
      ...req.body,
      createdAt: nowKst,
      updatedAt: nowKst,
      images: (req.body.images || []).map(img => ({
        _id: new ObjectId(), ...img,
        regions: (img.regions || []).map(r => ({ _id: new ObjectId(), ...r }))
      }))
    };
    const result = await eventsCol().insertOne(doc);
    res.json({ _id: result.insertedId, ...doc });
  } catch {
    res.status(400).json({ error: '이벤트 생성 실패' });
  }
});

app.put('/api/events/:id', async (req, res) => {
  try {
    const objId = new ObjectId(req.params.id);
    const nowKst = dayjs().tz('Asia/Seoul').toDate();
    const result = await eventsCol().updateOne(
      { _id: objId },
      { $set: { ...req.body, updatedAt: nowKst } }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: '이벤트가 없습니다' });
    }
    const updated = await eventsCol().findOne({ _id: objId });
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('이벤트 수정 실패', err);
    res.status(500).json({ error: '이벤트 수정 실패' });
  }
});

// ─── visitors-by-date ─────────────────────────────────────────────
function visitsCol(mallId = DEFAULT_MALL) {
  return db.collection(`visits_${mallId}`);
}

app.get('/api/analytics/:pageId/visitors-by-date', async (req, res) => {
  const { pageId }   = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });
  }
  const startKey = start_date.slice(0,10);
  const endKey   = end_date  .slice(0,10);
  const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
  if (url) match.pageUrl = url;
  const pipeline = [
    { $match: match },
    { $group: {
        _id: { date:'$dateKey', visitorId:'$visitorId' },
        viewCount:    { $sum: { $ifNull: ['$viewCount',   0] } },
        revisitCount: { $sum: { $ifNull: ['$revisitCount', 0] } }
    }},
    { $group: {
        _id: '$_id.date',
        totalVisitors:     { $sum: 1 },
        newVisitors:       { $sum: { $cond: [ { $gt: ['$viewCount', 0] }, 1, 0 ] } },
        returningVisitors: { $sum: { $cond: [ { $gt: ['$revisitCount', 0] }, 1, 0 ] } }
    }},
    { $project: {
        _id: 0,
        date: '$_id',
        totalVisitors: 1,
        newVisitors: 1,
        returningVisitors: 1,
        revisitRate: {
          $concat: [
            {
              $toString: {
                $round: [
                  { $multiply: [
                      { $cond: [
                          { $gt: ['$totalVisitors', 0] },
                          { $divide: ['$returningVisitors', '$totalVisitors'] },
                          0
                        ] },
                      100
                  ] },
                  0
                ]
              }
            },
            ' %'
          ]
        }
    }},
    { $sort: { date: 1 } }
  ];
  try {
    const stats = await visitsCol().aggregate(pipeline).toArray();
    res.json(stats);
  } catch (err) {
    console.error('[VISITORS-BY-DATE ERROR]', err);
    res.status(500).json({ error: '집계 중 오류가 발생했습니다.' });
  }
});

// ─── clicks-by-date ────────────────────────────────────────────────
app.get('/api/analytics/:pageId/clicks-by-date', async (req, res) => {
  const { pageId }   = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });
  }
  const startKey = start_date.slice(0,10);
  const endKey   = end_date  .slice(0,10);
  const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
  if (url) match.pageUrl = url;
  const pipeline = [
    { $match: match },
    { $group: {
        _id: '$dateKey',
        product: { $sum: { $ifNull: ['$urlClickCount', 0] } },
        coupon:  { $sum: { $ifNull: ['$couponClickCount', 0] } }
    }},
    { $project: { _id:0, date:'$_id', product:1, coupon:1 } },
    { $sort: { date:1 } }
  ];
  try {
    const data = await visitsCol().aggregate(pipeline).toArray();
    res.json(data);
  } catch (err) {
    console.error('[ANALYTICS CLICKS-BY-DATE ERROR]', err);
    res.status(500).json({ error: '클릭 집계에 실패했습니다.' });
  }
});

// ─── URL 클릭 수 조회 ───────────────────────────────────────────────
app.get('/api/analytics/:pageId/url-clicks', async (req, res) => {
  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });
  }
  const match = { pageId, type: 'click', element: 'product', timestamp: { $gte: new Date(start_date), $lte: new Date(end_date) } };
  if (url) match.pageUrl = url;
  try {
    const count = await visitsCol().countDocuments(match);
    res.json({ count });
  } catch (err) {
    console.error('[URL CLICKS COUNT ERROR]', err);
    res.status(500).json({ error: 'URL 클릭 수 조회 실패' });
  }
});

// ─── 쿠폰 클릭 수 조회 ───────────────────────────────────────────────
app.get('/api/analytics/:pageId/coupon-clicks', async (req, res) => {
  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });
  }
  const match = { pageId, type: 'click', element: 'coupon', timestamp: { $gte: new Date(start_date), $lte: new Date(end_date) } };
  if (url) match.pageUrl = url;
  try {
    const count = await visitsCol().countDocuments(match);
    res.json({ count });
  } catch (err) {
    console.error('[COUPON CLICKS COUNT ERROR]', err);
    res.status(500).json({ error: '쿠폰 클릭 수 조회 실패' });
  }
});

// ─── URL 목록 조회 ───────────────────────────────────────────────
app.get('/api/analytics/:pageId/urls', async (req, res) => {
  try {
    const pageId = req.params.pageId;
    const urls = await visitsCol().distinct('pageUrl', { pageId });
    res.json(urls);
  } catch (err) {
    console.error('[URLS DISTINCT ERROR]', err);
    res.status(500).json({ error: 'URL 목록 조회 실패' });
  }
});

// ─── analytics: 디바이스 분포 ────────────────────────────────────
app.get('/api/analytics/:pageId/devices', async (req, res) => {
  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });
  }
  const startKey = start_date.slice(0,10);
  const endKey   = end_date  .slice(0,10);
  const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
  if (url) match.pageUrl = url;
  const pipeline = [
    { $match: match },
    { $group: {
        _id: '$device',
        count: { $sum: { $add: [
          { $ifNull: ['$viewCount',   0] },
          { $ifNull: ['$revisitCount',0] }
        ]}}
    }},
    { $project: { _id:0, device_type:'$_id', count:1 } }
  ];
  try {
    const data = await visitsCol().aggregate(pipeline).toArray();
    res.json(data);
  } catch (err) {
    console.error('[ANALYTICS DEVICES ERROR]', err);
    res.status(500).json({ error: '디바이스 분포 집계 실패' });
  }
});

// ─── analytics: 날짜별 고유 디바이스 수 ────────────────────────────────────
app.get('/api/analytics/:pageId/devices-by-date', async (req, res) => {
  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });
  }
  const startKey = start_date.slice(0,10);
  const endKey   = end_date  .slice(0,10);
  const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
  if (url) match.pageUrl = url;
  const pipeline = [
    { $match: match },
    { $group: {
        _id: { date:'$dateKey', device:'$device', visitor:'$visitorId' }
    }},
    { $group: {
        _id: { date:'$_id.date', device:'$_id.device' },
        count: { $sum: 1 }
    }},
    { $project: { _id:0, date:'$_id.date', device:'$_id.device', count:1 } },
    { $sort: { date:1, device:1 } }
  ];
  try {
    const data = await visitsCol().aggregate(pipeline).toArray();
    res.json(data);
  } catch (err) {
    console.error('[ANALYTICS DEVICES-BY-DATE ERROR]', err);
    res.status(500).json({ error: '날짜별 고유 디바이스 집계 실패' });
  }
});

// ─── 방문·클릭 트래킹 ────────────────────────────────────────────────────
app.post('/api/track', async (req, res) => {
  try {
    const { pageId, pageUrl, visitorId, referrer, device, type, element, timestamp } = req.body;
    if (!pageId || !visitorId || !type || !timestamp) {
      return res.status(400).json({ error: '필수 필드 누락' });
    }
    if (!ObjectId.isValid(pageId)) return res.sendStatus(204);
    const ev = await db.collection('events').findOne({ _id: new ObjectId(pageId) }, { projection:{_id:1} });
    if (!ev) return res.sendStatus(204);
    const kstTs = dayjs(timestamp).tz('Asia/Seoul').toDate();
    const dateKey = dayjs(timestamp).tz('Asia/Seoul').format('YYYY-MM-DD');
    const path = (() => { try { return new URL(pageUrl).pathname; } catch { return pageUrl; } })();
    const filter = { pageId, visitorId, dateKey };
    const update = {
      $set: { lastVisit:kstTs, pageUrl:path, referrer:referrer||null, device:device||null },
      $setOnInsert: { firstVisit:kstTs },
      $inc: {}
    };
    if (type==='view')       update.$inc.viewCount = 1;
    else if (type==='revisit') update.$inc.revisitCount = 1;
    else if (type==='click') {
      update.$inc.clickCount = 1;
      if (element==='product') update.$inc.urlClickCount = 1;
      if (element==='coupon')  update.$inc.couponClickCount = 1;
    }
    await visitsCol().updateOne(filter, update, { upsert:true });
    res.sendStatus(204);
  } catch (err) {
    console.error('❌ TRACK ERROR', err);
    res.status(500).json({ error: '트래킹 실패' });
  }
});

// ─── 카테고리 내 상품 + 다중 쿠폰 조회 ───────────────────────────────
app.get('/api/:mallId/categories/:category_no/products', async (req, res) => {
  try {
    const { mallId, category_no } = req.params;
    const coupon_query = req.query.coupon_no || '';
    const coupon_nos   = coupon_query.split(',').filter(Boolean);
    const limit        = parseInt(req.query.limit, 10)  || 100;
    const offset       = parseInt(req.query.offset, 10) || 0;
    const shop_no      = 1;
    const display_group= 1;

    // 1) 쿠폰 정보
    const coupons = await Promise.all(coupon_nos.map(async no => {
      const d = await apiRequest(mallId, 'GET', '/api/v2/admin/coupons', {}, {
        shop_no,
        coupon_no: no,
        fields:[
          'coupon_no','available_product','available_product_list',
          'available_category','available_category_list',
          'benefit_amount','benefit_percentage'
        ].join(',')
      });
      return d.coupons?.[0] || null;
    }));
    const validCoupons = coupons.filter(c => c);

    // 2) 카테고리-상품 매핑
    const catRes = await apiRequest(mallId, 'GET',
      `/api/v2/admin/categories/${category_no}/products`,
      {}, { shop_no, display_group, limit, offset }
    );
    const sorted = (catRes.products || []).sort((a,b)=>a.sequence_no-b.sequence_no);
    const productNos = sorted.map(p=>p.product_no);
    if (!productNos.length) return res.json([]);

    // 3) 상품 상세
    const detailRes = await apiRequest(mallId, 'GET', '/api/v2/admin/products', {}, {
      shop_no, product_no: productNos.join(','), limit:productNos.length
    });
    const details = detailRes.products || [];
    const detailMap = details.reduce((m,p)=>{ m[p.product_no]=p; return m; }, {});

    // 4) 즉시할인가
    const discountMap = {};
    await Promise.all(productNos.map(async no => {
      const d = await apiRequest(mallId, 'GET',
        `/api/v2/admin/products/${no}/discountprice`,
        {}, { shop_no }
      );
      discountMap[no] = d.discountprice?.pc_discount_price!=null
        ? parseFloat(d.discountprice.pc_discount_price)
        : null;
    }));

    // 5) 결과 조립
    function formatKRW(n){ return n!=null?Number(n).toLocaleString('ko-KR')+'원':null; }
    function calcCouponInfos(prodNo){
      return validCoupons.map(coupon=>{
        const orig = parseFloat(detailMap[prodNo].price||0);
        const pct  = parseFloat(coupon.benefit_percentage||0);
        const amt  = parseFloat(coupon.benefit_amount||0);
        let bPrice = null;
        if (pct>0) bPrice = +(orig*(100-pct)/100).toFixed(2);
        else if (amt>0) bPrice = +(orig-amt).toFixed(2);
        if (!bPrice) return null;
        return { coupon_no:coupon.coupon_no, benefit_percentage:pct, benefit_price:bPrice };
      })
      .filter(x=>x)
      .sort((a,b)=>b.benefit_percentage-a.benefit_percentage);
    }

    const full = sorted.map(item=>{
      const p = detailMap[item.product_no];
      if (!p) return null;
      return {
        product_no:          item.product_no,
        product_name:        p.product_name,
        price:               p.price,
        summary_description: p.summary_description,
        list_image:          p.list_image,
        sale_price:          discountMap[item.product_no],
        couponInfos:         calcCouponInfos(item.product_no)
      };
    }).filter(Boolean);

    const slim = full.map(p=>{
      const first = p.couponInfos?.[0] || null;
      return {
        product_no:         p.product_no,
        product_name:       p.product_name,
        price:              formatKRW(parseFloat(p.price)),
        summary_description:p.summary_description,
        list_image:         p.list_image,
        sale_price:         p.sale_price!=null && +p.sale_price!==+p.price
                              ? formatKRW(p.sale_price)
                              : null,
        benefit_price:      first?formatKRW(first.benefit_price):null,
        benefit_percentage: first?first.benefit_percentage:null,
        couponInfos:        p.couponInfos.length? p.couponInfos : null
      };
    });

    res.json(slim);

  } catch (err) {
    console.error('카테고리 상품 + 다중 쿠폰 조회 실패', err);
    res.status(err.response?.status || 500).json({
      message:'카테고리 내 상품 조회 실패',
      error: err.message
    });
  }
});

;(async () => {
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



