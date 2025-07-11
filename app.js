require('dotenv').config();
process.env.TZ = 'Asia/Seoul';

const express             = require('express');
const path                = require('path');
const bodyParser          = require('body-parser');
const fs                  = require('fs');
const cors                = require('cors');
const compression         = require('compression');
const axios               = require('axios');
const { MongoClient, ObjectId } = require('mongodb');
const multer              = require('multer');
const dayjs               = require('dayjs');
const utc                 = require('dayjs/plugin/utc');
const tz                  = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);
const {
  MONGODB_URI,
  DB_NAME,
  CAFE24_MALLID,
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  CAFE24_API_VERSION,
  CAFE24_REDIRECT_URI,
  FRONTEND_BASE_URL,
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


// ─── 최초 접근: mall_id 쿼리가 있으면 카페24 OAuth 인증 페이지로 리다이렉트 ─────────────────
app.get('/', (req, res, next) => {
  const { mall_id: mallId, shop_no } = req.query;
  if (!mallId) {
    // mall_id 가 없으면 React 정적 파일 서빙으로 넘어갑니다.
    return next();
  }

  // state 에 mall_id + shop_no 정보만 담아서 base64 로 인코딩
  const state = Buffer.from(JSON.stringify({ mall_id: mallId, shop_no })).toString('base64');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CAFE24_CLIENT_ID,
    redirect_uri:  CAFE24_REDIRECT_URI,
    scope:         'mall.read_category,mall.read_product,mall.write_product',
    state
  });

  return res.redirect(`https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params}`);
});

let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('▶️ MongoDB connected');
}
async function initIndexes() {
  await db.collection('token').createIndex({ mall_id: 1 }, { unique: true });
  await db.collection('token').createIndex({ updatedAt: 1 });
  console.log('▶️ token 컬렉션 인덱스 설정 완료');
}
const VISITS_COLLECTION = `visits_${CAFE24_MALLID}`;
function visitsCol() {
  return db.collection(VISITS_COLLECTION);
}

// ─── 토큰 관리 ───────────────────────────────────────────────────────
async function saveTokensToDB(mallId, accessToken, refreshToken) {
  await db.collection('token').updateOne(
    { mall_id: mallId },
    { $set: { accessToken, refreshToken, updatedAt: new Date() } },
    { upsert: true }
  );
}
async function getTokensFromDB(mallId) {
  const doc = await db.collection('token').findOne({ mall_id: mallId });
  if (!doc) throw new Error(`토큰이 없습니다: mall ${mallId}`);
  return { accessToken: doc.accessToken, refreshToken: doc.refreshToken };
}
async function refreshAccessToken(mallId, refreshToken) {
  const url   = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
  const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken
  });
  const r = await axios.post(url, params.toString(), {
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`,
    },
  });
  await saveTokensToDB(mallId, r.data.access_token, r.data.refresh_token);
  return r.data.access_token;
}


async function apiRequest(mallId, method, url, data = {}, params = {}) {
  let { accessToken, refreshToken } = await getTokensFromDB(mallId);
  try {
    const resp = await axios({ method, url, data, params, headers: {
      Authorization:         `Bearer ${accessToken}`,
      'Content-Type':        'application/json',
      'X-Cafe24-Api-Version': CAFE24_API_VERSION,
    }});
    return resp.data;
  } catch (err) {
    if (err.response?.status === 401) {
      const newAT = await refreshAccessToken(mallId, refreshToken);
      const resp  = await axios({ method, url, data, params, headers: {
        Authorization:         `Bearer ${newAT}`,
        'Content-Type':        'application/json',
        'X-Cafe24-Api-Version': CAFE24_API_VERSION,
      }});
      return resp.data;
    }
    throw err;
  }
}

// ─── OAuth 콜백 처리 ─────────────────────────────────────────────────
app.get('/api/oauth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('code/state 누락');
  const { mall_id: mallId } = JSON.parse(Buffer.from(state, 'base64').toString());
  try {
    const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
    const creds    = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const params   = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: CAFE24_REDIRECT_URI
    });
    const { data } = await axios.post(tokenUrl, params.toString(), {
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`,
      }
    });
    await saveTokensToDB(mallId, data.access_token, data.refresh_token);
    res.redirect(`${FRONTEND_BASE_URL}/admin`);
  } catch (err) {
    console.error('OAuth 콜백 오류', err.response?.data || err);
    res.status(500).send('OAuth 처리 실패');
  }
});

// ─── Multer & R2 세팅 ────────────────────────────────────────────────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const s3Client = new S3Client({
  region:        R2_REGION,
  endpoint:      R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
  forcePathStyle: true,
});

// ─── 파일 업로드 ─────────────────────────────────────────────────────
app.post('/api/uploads/image', upload.single('file'), async (req, res) => {
  const localPath  = req.file.path;
  const key        = req.file.filename;
  const fileStream = fs.createReadStream(localPath);
  try {
    await s3Client.send(new PutObjectCommand({
      Bucket:      R2_BUCKET_NAME,
      Key:         key,
      Body:        fileStream,
      ContentType: req.file.mimetype,
      ACL:         'public-read',
    }));
    res.json({ url: `${R2_PUBLIC_BASE}/${key}` });
  } catch {
    res.status(500).json({ error: '업로드 실패' });
  } finally {
    fs.unlink(localPath, ()=>{});
  }
});

// ─── 이벤트 이미지 삭제 ────────────────────────────────────────────
app.delete('/api/events/:eventId/images/:imageId', async (req, res) => {
  const { eventId, imageId } = req.params;
  try {
    const ev = await db.collection('events').findOne({ _id: new ObjectId(eventId) });
    if (!ev) return res.status(404).json({ error: '이벤트 없음' });
    const img = ev.images.find(i => String(i._id) === imageId);
    if (img?.src) {
      const key = new URL(img.src).pathname.replace(/^\//,'');
      await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
    }
    await db.collection('events').updateOne(
      { _id: new ObjectId(eventId) },
      { $pull: { images: { _id: new ObjectId(imageId) } } }
    );
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: '삭제 실패' });
  }
});

// ─── 이벤트 삭제 ─────────────────────────────────────────────────────
app.delete('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const ev = await db.collection('events').findOne({ _id: new ObjectId(id) });
    if (!ev) return res.status(404).json({ error: '이벤트 없음' });
    const keys = (ev.images||[]).map(img => {
      const p = img.src.startsWith('http') ? new URL(img.src).pathname : `/${img.src}`;
      return p.replace(/^\//,'');
    });
    await Promise.all(keys.map(key =>
      s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }))
    ));
    await db.collection('events').deleteOne({ _id: new ObjectId(id) });
    await visitsCol().deleteMany({ pageId: id });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: '삭제 실패' });
  }
});

// ─── Ping ─────────────────────────────────────────────────────────────
app.get('/api/ping', (_, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ─── Café24 API: 카테고리 전체 ──────────────────────────────────────
app.get('/api/:mallId/categories/all', async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = [], limit = 100;
    let offset = 0;
    while (1) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/categories`;
      const { categories } = await apiRequest(mallId,'GET',url,{}, { limit, offset });
      if (!categories.length) break;
      all.push(...categories);
      offset += categories.length;
    }
    res.json(all);
  } catch (err) {
    console.error('카테고리 조회 실패', err);
    res.status(500).json({ error: err.message });
  }
});
// ─── Café24 API: 단일 상품 (mallId 를 URL 파라미터로) ─────────────────
app.get('/api/:mallId/products/:product_no', async (req, res) => {
  const { mallId, product_no } = req.params;
  const coupon_nos = (req.query.coupon_no || '').split(',').filter(Boolean);

  try {
    // 1) 기본 상품 정보 조회
    const prodUrl = `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}`;
    const { product, products } = await apiRequest(mallId, 'GET', prodUrl, {}, { shop_no: 1 });
    const p = product || products?.[0];
    if (!p) {
      return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });
    }

    // 2) 즉시할인가 조회
    const disUrl = `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}/discountprice`;
    const { discountprice } = await apiRequest(mallId, 'GET', disUrl, {}, { shop_no: 1 });
    const sale_price = discountprice?.pc_discount_price ?? null;

    // 3) 쿠폰별 benefit 계산
    let benefit_price = null;
    let benefit_percentage = null;
    await Promise.all(coupon_nos.map(async no => {
      const urlC = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons } = await apiRequest(mallId, 'GET', urlC, {}, {
        shop_no: 1,
        coupon_no: no,
        fields: [
          'coupon_no',
          'available_product','available_product_list',
          'available_category','available_category_list',
          'benefit_amount','benefit_percentage'
        ].join(',')
      });
      const c = coupons?.[0];
      if (!c) return;

      const orig = parseFloat(p.price);
      const pct  = parseFloat(c.benefit_percentage || 0);
      const amt  = parseFloat(c.benefit_amount     || 0);
      let bPrice = null;

      if (pct > 0)      bPrice = +(orig * (100 - pct) / 100).toFixed(2);
      else if (amt > 0) bPrice = +(orig - amt).toFixed(2);

      if (bPrice != null && pct > (benefit_percentage || 0)) {
        benefit_price      = bPrice;
        benefit_percentage = pct;
      }
    }));

    // 4) 최종 응답
    res.json({
      product_no,
      product_code:       p.product_code,
      product_name:       p.product_name,
      price:              p.price,
      summary_description: p.summary_description || '',
      sale_price,
      benefit_price,
      benefit_percentage,
      list_image:         p.list_image
    });
  } catch (err) {
    console.error('단일 상품 조회 실패', err);
    res.status(500).json({ error: err.message });
  }
});


// ─── Café24 API: 단일 상품 (기본 CAFE24_MALLID 사용) ─────────────────
app.get('/api/products/:product_no', async (req, res) => {
  const mallId = CAFE24_MALLID;
  const { product_no } = req.params;
  const coupon_nos = (req.query.coupon_no || '').split(',').filter(Boolean);

  try {
    // 1) 기본 상품 정보 조회
    const prodUrl = `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}`;
    const { product, products } = await apiRequest(mallId, 'GET', prodUrl, {}, { shop_no: 1 });
    const p = product || products?.[0];
    if (!p) {
      return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });
    }

    // 2) 즉시할인가 조회
    const disUrl = `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}/discountprice`;
    const { discountprice } = await apiRequest(mallId, 'GET', disUrl, {}, { shop_no: 1 });
    const sale_price = discountprice?.pc_discount_price ?? null;

    // 3) 쿠폰별 benefit 계산
    let benefit_price = null;
    let benefit_percentage = null;
    await Promise.all(coupon_nos.map(async no => {
      const urlC = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons } = await apiRequest(mallId, 'GET', urlC, {}, {
        shop_no: 1,
        coupon_no: no,
        fields: [
          'coupon_no',
          'available_product','available_product_list',
          'available_category','available_category_list',
          'benefit_amount','benefit_percentage'
        ].join(',')
      });
      const c = coupons?.[0];
      if (!c) return;

      const orig = parseFloat(p.price);
      const pct  = parseFloat(c.benefit_percentage || 0);
      const amt  = parseFloat(c.benefit_amount     || 0);
      let bPrice = null;

      if (pct > 0)      bPrice = +(orig * (100 - pct) / 100).toFixed(2);
      else if (amt > 0) bPrice = +(orig - amt).toFixed(2);

      if (bPrice != null && pct > (benefit_percentage || 0)) {
        benefit_price      = bPrice;
        benefit_percentage = pct;
      }
    }));

    // 4) 최종 응답
    res.json({
      product_no,
      product_code:       p.product_code,
      product_name:       p.product_name,
      price:              p.price,
      summary_description: p.summary_description || '',
      sale_price,
      benefit_price,
      benefit_percentage,
      list_image:         p.list_image
    });
  } catch (err) {
    console.error('단일 상품 조회 실패', err);
    res.status(500).json({ error: err.message });
  }
});




// ─── 서버 시작 ───────────────────────────────────────────────────────
initDb()
  .then(initIndexes)
  .then(() => {
    app.listen(PORT, () => console.log(`▶️ Server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('❌ 초기화 실패', err);
    process.exit(1);
  });
