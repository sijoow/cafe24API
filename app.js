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
app.use(express.static(path.join(__dirname, 'public')));

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
// ① 설치 → 권한요청 → 콜백 (code → 토큰) → DB 저장
// ===================================================================

// 설치 시작: mallId 기반 OAuth 권한 요청
app.get('/install/:mallId', (req, res) => {
  const { mallId } = req.params;
  const redirectUri = `${APP_URL}/auth/callback`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CAFE24_CLIENT_ID,
    redirect_uri:  redirectUri,
    scope:         'mall.read_category,mall.read_product,mall.read_analytics',
    state:         mallId,
  });
  res.redirect(`https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params}`);
});
// (1) 이미지 업로드
app.post(
  '/api/:mallId/uploads/image',
  upload.single('file'),
  async (req, res) => {
    const { mallId } = req.params;
    const localPath = req.file.path;
    const key       = req.file.filename;
    const fileStream = fs.createReadStream(localPath);

    try {
      await s3Client.send(
        new PutObjectCommand({
          Bucket:      R2_BUCKET_NAME,
          Key:         key,
          Body:        fileStream,
          ContentType: req.file.mimetype,
          ACL:         'public-read',
        })
      );
      res.json({ url: `${R2_PUBLIC_BASE}/${key}` });
    } catch (err) {
      console.error('[UPLOAD IMAGE ERROR]', err);
      res.status(500).json({ error: '파일 업로드 실패' });
    } finally {
      // 로컬에 임시 저장된 파일은 지워줍니다
      fs.unlink(localPath, () => {});
    }
  }
);

// 콜백 핸들러: code → 토큰 발급 → DB에 mallId별 저장
app.get('/auth/callback', async (req, res) => {
  const { code, state: mallId } = req.query;
  if (!code || !mallId) return res.status(400).send('code 또는 mallId가 없습니다.');

  try {
    const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
    const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const body = new URLSearchParams({
      grant_type:   'authorization_code',
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
      { $set: {
          mallId,
          accessToken:  data.access_token,
          refreshToken: data.refresh_token,
          obtainedAt:   new Date(),
          expiresIn:    data.expires_in
        }
      },
      { upsert: true }
    );

    res.send('앱 설치 및 토큰 교환 완료! DB에 저장되었습니다.');
  } catch (err) {
    console.error('[AUTH CALLBACK ERROR]', err.response?.data || err);
    res.status(500).send('토큰 교환 중 오류가 발생했습니다.');
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

// (0) 기본 Ping
app.get('/api/:mallId/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ─── (2) 게시판: POSTS CRUD ────────────────────────────────────────────
// ─── 게시판 CRUD (events 컬렉션 재활용) ─────────────────────────────

// 생성
app.post('/api/:mallId/events', async (req, res) => {
  const { mallId } = req.params;
  const { title, content } = req.body;
  if (!title || !content) {
    return res.status(400).json({ error: '제목과 내용을 입력해주세요.' });
  }
  try {
    const now = new Date();
    const doc = { mallId, title, content, createdAt: now, updatedAt: now };
    const result = await db.collection('events').insertOne(doc);
    res.json({ _id: result.insertedId, ...doc });
  } catch (err) {
    console.error('[CREATE EVENT ERROR]', err);
    res.status(500).json({ error: '게시물 생성 실패' });
  }
});

// 목록 조회
app.get('/api/:mallId/events', async (req, res) => {
  const { mallId } = req.params;
  try {
    const list = await db.collection('events')
                         .find({ mallId })
                         .sort({ createdAt: -1 })
                         .toArray();
    res.json(list);
  } catch (err) {
    console.error('[GET EVENTS ERROR]', err);
    res.status(500).json({ error: '게시물 조회 실패' });
  }
});

// 단건 조회
app.get('/api/:mallId/events/:id', async (req, res) => {
  const { mallId, id } = req.params;
  try {
    const ev = await db.collection('events').findOne({
      _id: new ObjectId(id),
      mallId
    });
    if (!ev) return res.status(404).json({ error: '게시물을 찾을 수 없습니다.' });
    res.json(ev);
  } catch (err) {
    console.error('[GET EVENT ERROR]', err);
    res.status(500).json({ error: '게시물 조회 실패' });
  }
});

// 수정
app.put('/api/:mallId/events/:id', async (req, res) => {
  const { mallId, id } = req.params;
  const { title, content } = req.body;
  if (!title && !content) {
    return res.status(400).json({ error: '수정할 제목 또는 내용을 입력해주세요.' });
  }
  try {
    const update = { updatedAt: new Date() };
    if (title)   update.title   = title;
    if (content) update.content = content;
    const result = await db.collection('events').updateOne(
      { _id: new ObjectId(id), mallId },
      { $set: update }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: '게시물을 찾을 수 없습니다.' });
    }
    const updated = await db.collection('events').findOne({ _id: new ObjectId(id) });
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[UPDATE EVENT ERROR]', err);
    res.status(500).json({ error: '게시물 수정 실패' });
  }
});

// 삭제
app.delete('/api/:mallId/events/:id', async (req, res) => {
  const { mallId, id } = req.params;
  try {
    const result = await db.collection('events').deleteOne({
      _id: new ObjectId(id),
      mallId
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: '게시물을 찾을 수 없습니다.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE EVENT ERROR]', err);
    res.status(500).json({ error: '게시물 삭제 실패' });
  }
});

// (8) 트래킹 저장
app.post('/api/:mallId/track', async (req, res) => {
  try {
    const { pageId, pageUrl, visitorId, referrer, device, type, element, timestamp } = req.body;
    if (!pageId || !visitorId || !type || !timestamp) {
      return res.status(400).json({ error: '필수 필드 누락' });
    }

    // 이벤트 유효성 검사
    if (!ObjectId.isValid(pageId)) return res.sendStatus(204);
    const ev = await db.collection('events').findOne({ _id: new ObjectId(pageId) }, { projection: { _id:1 } });
    if (!ev) return res.sendStatus(204);

    const kstTs = dayjs(timestamp).tz('Asia/Seoul').toDate();
    const dateKey = dayjs(timestamp).tz('Asia/Seoul').format('YYYY-MM-DD');

    // URL path만 추출
    let pathOnly;
    try { pathOnly = new URL(pageUrl).pathname; }
    catch { pathOnly = pageUrl; }

    const filter = { pageId, visitorId, dateKey };
    const update = {
      $set: {
        lastVisit: kstTs,
        pageUrl:   pathOnly,
        referrer:  referrer || null,
        device:    device   || null,
      },
      $setOnInsert: { firstVisit: kstTs },
      $inc: {}
    };
    if (type === 'view')    update.$inc.viewCount    = 1;
    if (type === 'revisit') update.$inc.revisitCount = 1;
    if (type === 'click') {
      update.$inc.clickCount     = 1;
      if (element === 'product') update.$inc.urlClickCount    = 1;
      if (element === 'coupon')  update.$inc.couponClickCount = 1;
    }

    await db.collection(`visits_${req.params.mallId}`)
            .updateOne(filter, update, { upsert: true });
    res.sendStatus(204);
  } catch (err) {
    console.error('[TRACK ERROR]', err);
    res.status(500).json({ error: '트래킹 실패' });
  }
});

// (9) 카테고리 전체 조회
app.get('/api/:mallId/categories/all', async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/categories`;
      const { categories } = await apiRequest(mallId, 'GET', url, {}, { limit, offset });
      if (!categories.length) break;
      all.push(...categories);
      offset += categories.length;
    }
    res.json(all);
  } catch (err) {
    console.error('[CATEGORIES ERROR]', err);
    res.status(500).json({ message: '전체 카테고리 조회 실패', error: err.message });
  }
});

// (10) 쿠폰 전체 조회
app.get('/api/:mallId/coupons', async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons } = await apiRequest(mallId, 'GET', url, {}, { shop_no:1, limit, offset });
      if (!coupons.length) break;
      all.push(...coupons);
      offset += coupons.length;
    }
    res.json(all);
  } catch (err) {
    console.error('[COUPONS ERROR]', err);
    res.status(500).json({ message: '쿠폰 조회 실패', error: err.message });
  }
});

// (11) 카테고리별 상품 조회 + 다중 쿠폰 로직
app.get('/api/:mallId/categories/:category_no/products', async (req, res) => {
  const { mallId, category_no } = req.params;
  try {
    const coupon_query = req.query.coupon_no || '';
    const coupon_nos   = coupon_query ? coupon_query.split(',') : [];
    const limit        = parseInt(req.query.limit, 10)  || 100;
    const offset       = parseInt(req.query.offset, 10) || 0;
    const shop_no      = 1;
    const display_group = 1;

    // 0) 쿠폰 정보 조회
    const coupons = await Promise.all(coupon_nos.map(async no => {
      const urlCoupon = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons: arr } = await apiRequest(mallId, 'GET', urlCoupon, {}, {
        shop_no,
        coupon_no: no,
        fields: [
          'coupon_no',
          'available_product','available_product_list',
          'available_category','available_category_list',
          'benefit_amount','benefit_percentage'
        ].join(',')
      });
      return arr?.[0] || null;
    }));
    const validCoupons = coupons.filter(c => c);

    // 1) 카테고리-상품 매핑
    const urlCats = `https://${mallId}.cafe24api.com/api/v2/admin/categories/${category_no}/products`;
    const catRes  = await apiRequest(mallId, 'GET', urlCats, {}, { shop_no, display_group, limit, offset });
    const sorted  = (catRes.products||[]).slice().sort((a,b)=>a.sequence_no-b.sequence_no);
    const productNos = sorted.map(p=>p.product_no);
    if (!productNos.length) return res.json([]);

    // 2) 상품 상세 조회
    const urlProds = `https://${mallId}.cafe24api.com/api/v2/admin/products`;
    const detailRes = await apiRequest(mallId, 'GET', urlProds, {}, {
      shop_no,
      product_no: productNos.join(','),
      limit: productNos.length
    });
    const details = detailRes.products || [];
    const detailMap = details.reduce((m,p)=>{ m[p.product_no]=p; return m; },{});

    // 3) 즉시할인가 조회
    const discountMap = {};
    await Promise.all(productNos.map(async no => {
      const urlDis = `https://${mallId}.cafe24api.com/api/v2/admin/products/${no}/discountprice`;
      const { discountprice } = await apiRequest(mallId, 'GET', urlDis, {}, { shop_no });
      discountMap[no] = discountprice?.pc_discount_price != null
        ? parseFloat(discountprice.pc_discount_price)
        : null;
    }));

    const formatKRW = num => num!=null
      ? Number(num).toLocaleString('ko-KR') + '원'
      : null;

    function calcCouponInfos(prodNo) {
      return validCoupons.map(coupon=>{
        const pList = coupon.available_product_list||[];
        const prodOk = coupon.available_product==='U'
          || (coupon.available_product==='I' && pList.includes(prodNo))
          || (coupon.available_product==='E' && !pList.includes(prodNo));
        const cList = coupon.available_category_list||[];
        const catOk = coupon.available_category==='U'
          || (coupon.available_category==='I' && cList.includes(parseInt(category_no,10)))
          || (coupon.available_category==='E' && !cList.includes(parseInt(category_no,10)));
        if (!prodOk||!catOk) return null;
        const orig = parseFloat(detailMap[prodNo].price||0);
        const pct  = parseFloat(coupon.benefit_percentage||0);
        const amt  = parseFloat(coupon.benefit_amount||0);
        let benefit_price = null;
        if (pct>0) benefit_price = +(orig*(100-pct)/100).toFixed(2);
        else if (amt>0) benefit_price = +(orig-amt).toFixed(2);
        if (benefit_price==null) return null;
        return { coupon_no: coupon.coupon_no, benefit_percentage: pct, benefit_price };
      }).filter(x=>x).sort((a,b)=>b.benefit_percentage-a.benefit_percentage);
    }

    const full = sorted.map(item=>{
      const prod = detailMap[item.product_no];
      if (!prod) return null;
      return {
        product_no: item.product_no,
        product_name: prod.product_name,
        price: prod.price,
        summary_description: prod.summary_description,
        list_image: prod.list_image,
        sale_price: discountMap[item.product_no],
        couponInfos: calcCouponInfos(item.product_no)
      };
    }).filter(Boolean);

    const slim = full.map(p=>{
      const infos = p.couponInfos||[];
      const first = infos.length?infos[0]:null;
      return {
        product_no: p.product_no,
        product_name: p.product_name,
        price: formatKRW(parseFloat(p.price)),
        summary_description: p.summary_description,
        list_image: p.list_image,
        sale_price: (p.sale_price!=null && +p.sale_price!==+p.price)?formatKRW(p.sale_price):null,
        benefit_price: first?formatKRW(first.benefit_price):null,
        benefit_percentage: first?first.benefit_percentage:null,
        couponInfos: infos.length?infos:null
      };
    });

    res.json(slim);
  } catch (err) {
    console.error('[CATEGORY PRODUCTS ERROR]', err);
    res.status(err.response?.status||500).json({ message: '카테고리 상품 조회 실패', error: err.message });
  }
});

// (12) 전체 상품 조회 (페이징 + 검색)
app.get('/api/:mallId/products', async (req, res) => {
  const { mallId } = req.params;
  try {
    const shop_no = 1;
    const limit   = parseInt(req.query.limit, 10)||1000;
    const offset  = parseInt(req.query.offset,10)||0;
    const q       = (req.query.q||'').trim();
    const url     = `https://${mallId}.cafe24api.com/api/v2/admin/products`;

    const params = { shop_no, limit, offset };
    if (q) params['search[product_name]'] = q;

    const data = await apiRequest(mallId, 'GET', url, {}, params);
    const slim = (data.products||[]).map(p=>({
      product_no: p.product_no,
      product_code: p.product_code,
      product_name: p.product_name,
      price: p.price,
      list_image: p.list_image
    }));

    res.json({ products: slim, total: data.total_count });
  } catch (err) {
    console.error('[GET PRODUCTS ERROR]', err);
    res.status(500).json({ error: '전체 상품 조회 실패' });
  }
});

// (13) 단일 상품 조회 + 쿠폰할인가
app.get('/api/:mallId/products/:product_no', async (req, res) => {
  const { mallId, product_no } = req.params;
  try {
    const shop_no = 1;
    const coupon_query = req.query.coupon_no||'';
    const coupon_nos = coupon_query.split(',').filter(Boolean);

    // 기본 상품 정보
    const prodUrl = `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}`;
    const prodData = await apiRequest(mallId, 'GET', prodUrl, {}, { shop_no });
    const p = prodData.product||prodData.products?.[0];
    if (!p) return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });

    // 즉시할인가
    const disUrl = `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}/discountprice`;
    const disData = await apiRequest(mallId, 'GET', disUrl, {}, { shop_no });
    const rawSale = disData.discountprice?.pc_discount_price;
    const sale_price = rawSale != null ? parseFloat(rawSale) : null;

    // 쿠폰별 benefit 계산
    const coupons = await Promise.all(coupon_nos.map(async no=>{
      const urlCoupon = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons: arr } = await apiRequest(mallId, 'GET', urlCoupon, {}, {
        shop_no,
        coupon_no: no,
        fields: [
          'coupon_no',
          'available_product','available_product_list',
          'available_category','available_category_list',
          'benefit_amount','benefit_percentage'
        ].join(',')
      });
      return arr?.[0]||null;
    }));
    const validCoupons = coupons.filter(c=>c);
    let benefit_price = null, benefit_percentage = null;
    validCoupons.forEach(coupon=>{
      const pList = coupon.available_product_list||[];
      const ok = coupon.available_product==='U'
        || (coupon.available_product==='I' && pList.includes(parseInt(product_no,10)))
        || (coupon.available_product==='E' && !pList.includes(parseInt(product_no,10)));
      if (!ok) return;
      const orig = parseFloat(p.price);
      const pct  = parseFloat(coupon.benefit_percentage||0);
      const amt  = parseFloat(coupon.benefit_amount||0);
      let bPrice = null;
      if (pct>0) bPrice = +(orig*(100-pct)/100).toFixed(2);
      else if (amt>0) bPrice = +(orig-amt).toFixed(2);
      if (bPrice!=null && pct>(benefit_percentage||0)) {
        benefit_price = bPrice;
        benefit_percentage = pct;
      }
    });

    res.json({
      product_no,
      product_code: p.product_code,
      product_name: p.product_name,
      price: p.price,
      summary_description: p.summary_description||'',
      sale_price,
      benefit_price,
      benefit_percentage,
      list_image: p.list_image
    });
  } catch (err) {
    console.error('[GET PRODUCT ERROR]', err);
    res.status(500).json({ error: '단일 상품 조회 실패' });
  }
});

// (14) analytics: visitors-by-date
app.get('/api/:mallId/analytics/:pageId/visitors-by-date', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date||!end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });

  const startKey = start_date.slice(0,10), endKey = end_date.slice(0,10);
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
            { $toString: { $round: [ { $multiply: [ { $cond: [ { $gt: ['$totalVisitors', 0] }, { $divide: ['$returningVisitors', '$totalVisitors'] }, 0 ] }, 100 ] }, 0 ] }},
            ' %'
          ]
        }
    }},
    { $sort: { date: 1 } }
  ];

  try {
    const stats = await db.collection(`visits_${mallId}`).aggregate(pipeline).toArray();
    res.json(stats);
  } catch (err) {
    console.error('[VISITORS-BY-DATE ERROR]', err);
    res.status(500).json({ error: '집계 중 오류가 발생했습니다.' });
  }
});

// (15) analytics: clicks-by-date
app.get('/api/:mallId/analytics/:pageId/clicks-by-date', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date||!end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });

  const startKey = start_date.slice(0,10), endKey = end_date.slice(0,10);
  const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
  if (url) match.pageUrl = url;

  const pipeline = [
    { $match: match },
    { $group: {
        _id: '$dateKey',
        product: { $sum: { $ifNull: ['$urlClickCount', 0] }},
        coupon:  { $sum: { $ifNull: ['$couponClickCount', 0] }}
    }},
    { $project: { _id:0, date:'$_id', product:1, coupon:1 }},
    { $sort: { date:1 }}
  ];

  try {
    const data = await db.collection(`visits_${mallId}`).aggregate(pipeline).toArray();
    res.json(data);
  } catch (err) {
    console.error('[CLICKS-BY-DATE ERROR]', err);
    res.status(500).json({ error: '클릭 집계에 실패했습니다.' });
  }
});

// (16) analytics: url-clicks count
app.get('/api/:mallId/analytics/:pageId/url-clicks', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date||!end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });

  const match = {
    pageId, type:'click', element:'product',
    timestamp: { $gte: new Date(start_date), $lte: new Date(end_date) }
  };
  if (url) match.pageUrl = url;

  try {
    const count = await db.collection(`visits_${mallId}`).countDocuments(match);
    res.json({ count });
  } catch (err) {
    console.error('[URL CLICKS COUNT ERROR]', err);
    res.status(500).json({ error: 'URL 클릭 수 조회 실패' });
  }
});

// (17) analytics: coupon-clicks count
app.get('/api/:mallId/analytics/:pageId/coupon-clicks', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date||!end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });

  const match = {
    pageId, type:'click', element:'coupon',
    timestamp: { $gte: new Date(start_date), $lte: new Date(end_date) }
  };
  if (url) match.pageUrl = url;

  try {
    const count = await db.collection(`visits_${mallId}`).countDocuments(match);
    res.json({ count });
  } catch (err) {
    console.error('[COUPON CLICKS COUNT ERROR]', err);
    res.status(500).json({ error: '쿠폰 클릭 수 조회 실패' });
  }
});

// (18) analytics: distinct urls
app.get('/api/:mallId/analytics/:pageId/urls', async (req, res) => {
  const { mallId, pageId } = req.params;
  try {
    const urls = await db.collection(`visits_${mallId}`).distinct('pageUrl', { pageId });
    res.json(urls);
  } catch (err) {
    console.error('[URLS DISTINCT ERROR]', err);
    res.status(500).json({ error: 'URL 목록 조회 실패' });
  }
});

// (19) analytics: devices distribution
app.get('/api/:mallId/analytics/:pageId/devices', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date||!end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });

  const startKey = start_date.slice(0,10), endKey = end_date.slice(0,10);
  const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
  if (url) match.pageUrl = url;

  const pipeline = [
    { $match: match },
    { $group: {
        _id: '$device',
        count: { $sum: { $add: [ { $ifNull: ['$viewCount',0] }, { $ifNull: ['$revisitCount',0] } ] } }
    }},
    { $project: { _id:0, device_type:'$_id', count:1 }}
  ];

  try {
    const data = await db.collection(`visits_${mallId}`).aggregate(pipeline).toArray();
    res.json(data);
  } catch (err) {
    console.error('[ANALYTICS DEVICES ERROR]', err);
    res.status(500).json({ error: '디바이스 분포 집계 실패' });
  }
});

// (20) analytics: devices by date
app.get('/api/:mallId/analytics/:pageId/devices-by-date', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date||!end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });

  const startKey = start_date.slice(0,10), endKey = end_date.slice(0,10);
  const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
  if (url) match.pageUrl = url;

  const pipeline = [
    { $match: match },
    { $group: {
        _id: { date:'$dateKey', device:'$device', visitor:'$visitorId' }
    }},
    { $group: {
        _id: { date:'$_id.date', device:'$_id.device' },
        count: { $sum:1 }
    }},
    { $project: { _id:0, date:'$_id.date', device:'$_id.device', count:1 }},
    { $sort: { date:1, device:1 }}
  ];

  try {
    const data = await db.collection(`visits_${mallId}`).aggregate(pipeline).toArray();
    res.json(data);
  } catch (err) {
    console.error('[ANALYTICS DEVICES-BY-DATE ERROR]', err);
    res.status(500).json({ error: '날짜별 고유 디바이스 집계 실패' });
  }
});


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
