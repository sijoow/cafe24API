// app.js
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

// ─── MongoDB ─────────────────────────────────────────────────────
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('▶️ MongoDB connected to', DB_NAME);
}

// mallId 별 토큰 로드/저장 헬퍼
async function loadTokens(mallId) {
  const doc = await db.collection('tokens').findOne({ mallId });
  if (!doc) throw new Error(`토큰이 없습니다 for ${mallId}`);
  return { accessToken: doc.accessToken, refreshToken: doc.refreshToken };
}
async function saveTokens(mallId, accessToken, refreshToken) {
  await db.collection('tokens').updateOne(
    { mallId },
    { $set: { accessToken, refreshToken, updatedAt: new Date() } },
    { upsert: true }
  );
}
// 리프레시 토큰으로 재발급
async function refreshAccessToken(mallId, oldRefreshToken) {
  const url = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
  const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: oldRefreshToken
  });
  const { data } = await axios.post(url, params.toString(), {
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`
    }
  });
  // DB 저장
  await saveTokens(mallId, data.access_token, data.refresh_token);
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

// Caf24 API 요청 헬퍼
async function apiRequest(mallId, method, path, data = {}, params = {}) {
  let { accessToken, refreshToken } = await loadTokens(mallId);
  const url = `https://${mallId}.cafe24api.com${path}`;
  try {
    const resp = await axios({
      method, url, data, params,
      headers: {
        Authorization:           `Bearer ${accessToken}`,
        'X-Cafe24-Api-Version':  CAFE24_API_VERSION
      }
    });
    return resp.data;
  } catch (err) {
    if (err.response?.status === 401) {
      // 토큰 만료 → 재발급 후 재시도
      ({ accessToken, refreshToken } = await refreshAccessToken(mallId, refreshToken));
      return apiRequest(mallId, method, path, data, params);
    }
    throw err;
  }
}

// ─── Express 앱 설정 ─────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer (파일 업로드)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// R2 클라이언트 (이미지 저장)
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const s3Client = new S3Client({
  region:   R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
  forcePathStyle: true,
});

// ─── OAuth 콜백 (카페24에서 code, shop 받아서 토큰 교환) ────────────
app.get('/redirect', async (req, res) => {
  try {
    const { code, shop } = req.query;
    if (!code || !shop) return res.status(400).send('code 또는 shop 파라미터 누락');
    const tokenUrl = `https://${shop}.cafe24api.com/api/v2/oauth/token`;
    const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const params = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      client_id:    CAFE24_CLIENT_ID,
      redirect_uri: REDIRECT_URI
    });
    const { data } = await axios.post(tokenUrl, params.toString(), {
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`
      }
    });
    // DB 저장
    await saveTokens(shop, data.access_token, data.refresh_token);
    res.send('카페24 인증 및 토큰 저장 완료!');
  } catch (err) {
    console.error('[OAuth 콜백 에러]', err.response?.data || err);
    res.status(500).send('토큰 교환 중 오류가 발생했습니다.');
  }
});

// ─── 기본 Ping ─────────────────────────────────────────────────────
app.get('/api/ping', (_, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ─── 동적 MallId 카테고리 전체 조회 ─────────────────────────────────
app.get('/api/:mallId/categories/all', async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const { categories } = await apiRequest(
        mallId, 'GET',
        '/api/v2/admin/categories',
        {}, { limit, offset }
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
});

// ─── 동적 MallId 쿠폰 전체 조회 ─────────────────────────────────────
app.get('/api/:mallId/coupons', async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const { coupons } = await apiRequest(
        mallId, 'GET',
        '/api/v2/admin/coupons',
        {}, { shop_no: 1, limit, offset }
      );
      if (!coupons.length) break;
      all.push(...coupons);
      offset += coupons.length;
    }
    res.json(all);
  } catch (err) {
    console.error('[COUPONS ERROR]', err.response?.data || err);
    res.status(500).json({ error: '쿠폰 조회 실패' });
  }
});


// ─── 이벤트 CRUD (MongoDB) ─────────────────────────────────────────
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
      images: (req.body.images||[]).map(img => ({
        _id: new ObjectId(), ...img,
        regions: (img.regions||[]).map(r => ({ _id: new ObjectId(), ...r }))
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
    if (result.matchedCount === 0) return res.status(404).json({ error: '이벤트가 없습니다' });
    const updated = await eventsCol().findOne({ _id: objId });
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('이벤트 수정 실패', err);
    res.status(500).json({ error: '이벤트 수정 실패' });
  }
});

// ─── visitors-by-date ─────────────────────────────────────────────
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

// ─── clicks-데이터 확인코드────────────────────────────────────────────────

app.get('/api/analytics/:pageId/clicks-by-date', async (req, res) => {
  const { pageId }   = req.params;
  const { start_date, end_date, url } = req.query;

  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });
  }

  // YYYY-MM-DD 키만 추출
  const startKey = start_date.slice(0, 10);
  const endKey   = end_date.slice(0, 10);

  // pageId + dateKey 범위 매치
  const match = {
    pageId,
    dateKey: { $gte: startKey, $lte: endKey }
  };
  if (url) {
    match.pageUrl = url;
  }

  const pipeline = [
    // 1) 매치된 문서 필터링
    { $match: match },
    // 2) 날짜별로 urlClickCount, couponClickCount 합산
    { $group: {
        _id: '$dateKey',
        product: { 
          $sum: { $ifNull: ['$urlClickCount', 0] }
        },
        coupon:  {
          $sum: { $ifNull: ['$couponClickCount', 0] }
        }
    }},
    // 3) 출력 형태로 바꾸기
    { $project: {
        _id:    0,
        date:   '$_id',
        product: 1,
        coupon:  1
    }},
    // 4) 날짜순 정렬
    { $sort: { date: 1 } }
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

  // YYYY-MM-DD 키로 자르기
  const startKey = start_date.slice(0,10);
  const endKey   = end_date.slice(0,10);

  // match 조건
  const match = {
    pageId,
    dateKey: { $gte: startKey, $lte: endKey }
  };
  if (url) match.pageUrl = url;

  // viewCount + revisitCount 합산해서 device별로 묶기
  const pipeline = [
    { $match: match },
    { $group: {
        _id: '$device',
        count: { $sum: {
          $add: [
            { $ifNull: ['$viewCount',   0] },
            { $ifNull: ['$revisitCount',0] }
          ]
        }}
    }},
    { $project: {
        _id:         0,
        device_type: '$_id',
        count:       1
    }}
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

  const match = {
    pageId,
    dateKey: { $gte: startKey, $lte: endKey }
  };
  if (url) match.pageUrl = url;

  const pipeline = [
    { $match: match },
    // 1) date + device + visitorId로 묶어서 unique set 생성
    { $group: {
        _id: {
          date:    '$dateKey',
          device:  '$device',
          visitor: '$visitorId'
        }
    }},
    // 2) 다시 date + device별로 고유 visitorId 개수 집계
    { $group: {
        _id: {
          date:   '$_id.date',
          device: '$_id.device'
        },
        count: { $sum: 1 }
    }},
    // 3) 포맷 맞추기
    { $project: {
        _id:    0,
        date:   '$_id.date',
        device: '$_id.device',
        count:  1
    }},
    { $sort: { date: 1, device: 1 } }
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

    // 삭제된 이벤트 무시
    if (!ObjectId.isValid(pageId)) return res.sendStatus(204);
    const ev = await db.collection('events').findOne(
      { _id: new ObjectId(pageId) },
      { projection: { _id: 1 } }
    );
    if (!ev) return res.sendStatus(204);

    // KST 변환 & dateKey
     const kstTs = dayjs(timestamp).tz('Asia/Seoul').toDate();
     const dateKey = dayjs(timestamp).tz('Asia/Seoul').format('YYYY-MM-DD');

    // pageUrl 에서 pathname만 뽑아내는 안전 함수
    const getPathname = (urlStr) => {
      try {
        return new URL(urlStr).pathname;
      } catch {
        // urlStr 이 이미 "/some/path.html" 형태라면 그대로 반환
        return urlStr;
      }
    };
    const path = getPathname(pageUrl);

    // 콘솔 로그
    switch (type) {
      case 'view':
        console.log(`[DB][방문] visitor=${visitorId} page=${pageId} url=${path} date=${dateKey}`);
        break;
      case 'revisit':
        console.log(`[DB][재방문] visitor=${visitorId} page=${pageId} url=${path} date=${dateKey}`);
        break;
      case 'click':
        if (element === 'product') {
          console.log(`[DB][URL클릭] visitor=${visitorId} page=${pageId} url=${path}`);
        } else if (element === 'coupon') {
          console.log(`[DB][쿠폰클릭] visitor=${visitorId} page=${pageId} coupon=${element}`);
        } else {
          console.log(`[DB][CLICK] visitor=${visitorId} page=${pageId} element=${element}`);
        }
        break;
      default:
        console.log(`[DB][UNKNOWN] type=${type} visitor=${visitorId}`);
    }

    // 한 문서에 카운트 누적
    const filter = { pageId, visitorId, dateKey };
    const update = {
      $set: {
        lastVisit: kstTs,
        pageUrl:   path,
        referrer:  referrer || null,
        device:    device   || null,
      },
      $setOnInsert: { firstVisit: kstTs },
      $inc: {}
    };
    if (type === 'view') {
      update.$inc.viewCount = 1;
    } else if (type === 'revisit') {
      update.$inc.revisitCount = 1;
    } else if (type === 'click') {
      update.$inc.clickCount     = 1;
      if (element === 'product') update.$inc.urlClickCount    = 1;
      if (element === 'coupon')  update.$inc.couponClickCount = 1;
    }

    await visitsCol().updateOne(filter, update, { upsert: true });
    return res.sendStatus(204);

  } catch (err) {
    console.error('❌ TRACK ERROR', err);
    return res.status(500).json({ error: '트래킹 실패' });
  }
});

// ─── 카테고리 내 상품 + 다중 쿠폰 조회 ───────────────────────────────
app.get('/api/:mallId/categories/:category_no/products', async (req, res) => {
  try {
    const { mallId, category_no } = req.params;
    const coupon_query   = req.query.coupon_no || '';
    const coupon_nos     = coupon_query ? coupon_query.split(',') : [];
    const limit          = parseInt(req.query.limit, 10)  || 100;
    const offset         = parseInt(req.query.offset, 10) || 0;
    const shop_no        = 1;
    const display_group  = 1;

    // ─── 0) 복수 쿠폰 정보 조회 ───────────────────────────────────────
    const coupons = await Promise.all(coupon_nos.map(async no => {
      const urlCoupon = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const resCoupon = await apiRequest('GET', urlCoupon, {}, {
        shop_no,
        coupon_no: no,
        fields: [
          'coupon_no',
          'available_product',
          'available_product_list',
          'available_category',
          'available_category_list',
          'benefit_amount',
          'benefit_percentage'
        ].join(',')
      });
      return resCoupon.coupons?.[0] || null;
    }));
    const validCoupons = coupons.filter(c => c);

    // ─── 1) 카테고리-상품 매핑 조회 ─────────────────────────────────
    const urlCats = `https://${mallId}.cafe24api.com/api/v2/admin/categories/${category_no}/products`;
    const catRes  = await apiRequest('GET', urlCats, {}, {
      shop_no,
      display_group,
      limit,
      offset
    });

    // ─── 2) sequence_no 순 정렬 ─────────────────────────────────────
    const sorted = (catRes.products || [])
      .slice()
      .sort((a, b) => a.sequence_no - b.sequence_no);

    const productNos = sorted.map(p => p.product_no);
    if (!productNos.length) return res.json([]);

    // ─── 3) 상품 상세 정보 조회 ──────────────────────────────────────
    const urlProds  = `https://${mallId}.cafe24api.com/api/v2/admin/products`;
    const detailRes = await apiRequest('GET', urlProds, {}, {
      shop_no,
      product_no: productNos.join(','),
      limit:      productNos.length
    });
    const details = detailRes.products || [];

    // ─── 4) 할인 가격 일괄 조회 ───────────────────────────────────────
    const discountMap = {};
    await Promise.all(productNos.map(async no => {
      const urlDis = `https://${mallId}.cafe24api.com/api/v2/admin/products/${no}/discountprice`;
      const disRes = await apiRequest('GET', urlDis, {}, { shop_no });
      const rawPrice = disRes.discountprice?.pc_discount_price;
      discountMap[no] = rawPrice != null ? parseFloat(rawPrice) : null;
    }));

    // ─── 5) 상세 객체 맵핑 ─────────────────────────────────────────
    const detailMap = details.reduce((m, p) => {
      m[p.product_no] = p;
      return m;
    }, {});

    // ─── 가격 포맷 헬퍼 ──────────────────────────────────────────────
    const formatKRW = num => num != null
      ? Number(num).toLocaleString('ko-KR') + '원'
      : null;

    // ─── 6) 쿠폰 적용 여부 + 할인가 계산 함수 ───────────────────────
    function calcCouponInfos(prodNo) {
      return validCoupons
        .map(coupon => {
          const pMode = coupon.available_product;
          const pList = coupon.available_product_list || [];
          const prodOk = pMode === 'U'
            || (pMode === 'I' && pList.includes(prodNo))
            || (pMode === 'E' && !pList.includes(prodNo));

          const cMode = coupon.available_category;
          const cList = coupon.available_category_list || [];
          const catOk = cMode === 'U'
            || (cMode === 'I' && cList.includes(parseInt(category_no, 10)))
            || (cMode === 'E' && !cList.includes(parseInt(category_no, 10)));

          if (!prodOk || !catOk) return null;

          const origPrice = parseFloat(detailMap[prodNo].price || '0');
          const pct   = parseFloat(coupon.benefit_percentage || '0');
          const amt   = parseFloat(coupon.benefit_amount     || '0');
          let benefit_price = null;
          if (pct > 0)      benefit_price = +(origPrice * (100 - pct) / 100).toFixed(2);
          else if (amt > 0) benefit_price = +(origPrice - amt).toFixed(2);
          if (benefit_price == null) return null;

          return {
            coupon_no:          coupon.coupon_no,
            benefit_percentage: pct,
            benefit_price
          };
        })
        .filter(x => x)
        .sort((a, b) => b.benefit_percentage - a.benefit_percentage);
    }

    // ─── 7) full 배열 구성 + null 제거 ─────────────────────────────
    const full = sorted.map(item => {
      const prod = detailMap[item.product_no];
      if (!prod) return null;
      return {
        product_no:          item.product_no,
        product_name:        prod.product_name,
        price:               prod.price,
        summary_description: prod.summary_description,
        list_image:          prod.list_image,
        sale_price:          discountMap[item.product_no],
        couponInfos:         calcCouponInfos(item.product_no)
      };
    }).filter(Boolean);

    // ─── 8) slim 배열(필요한 필드만 & 포맷팅) ───────────────────────
    const slim = full.map(p => {
      const infos = p.couponInfos || [];
      const first = infos[0] || null;
      return {
        product_no:          p.product_no,
        product_name:        p.product_name,
        price:               formatKRW(parseFloat(p.price)),
        summary_description: p.summary_description,
        list_image:          p.list_image,
        sale_price:          p.sale_price != null && +p.sale_price !== +p.price
                              ? formatKRW(p.sale_price)
                              : null,
        benefit_price:       first ? formatKRW(first.benefit_price) : null,
        benefit_percentage:  first ? first.benefit_percentage : null,
        couponInfos:         infos.length ? infos : null
      };
    });

    return res.json(slim);

  } catch (err) {
    console.error('카테고리 상품 + 다중 쿠폰 조회 실패', err);
    return res.status(err.response?.status || 500).json({
      message: '카테고리 내 상품 조회 실패',
      error:   err.message
    });
  }
});
// ─── 서버 시작 ───────────────────────────────────────────────────────
;(async () => {
  try {
    await initDb();
    console.log(`▶️ Server running on port ${PORT}`);
    app.listen(PORT);
  } catch (err) {
    console.error('❌ 초기화 실패', err);
    process.exit(1);
  }
})();