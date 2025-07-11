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

// ─── Café24 API: 쿠폰 전체 ─────────────────────────────────────────
app.get('/api/:mallId/coupons', async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = [], limit = 100;
    let offset = 0;
    while (1) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons } = await apiRequest(mallId,'GET',url,{}, { shop_no:1, limit, offset });
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
      available_end: c.available_end_datetime
    })));
  } catch (err) {
    console.error('쿠폰 조회 실패', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Café24 API: 카테고리별 상품 ────────────────────────────────────
app.get('/api/:mallId/categories/:category_no/products', async (req, res) => {
  const { mallId, category_no } = req.params;
  const coupon_query = req.query.coupon_no||'';
  const coupon_nos   = coupon_query? coupon_query.split(','): [];
  const limit  = parseInt(req.query.limit,10)||100;
  const offset = parseInt(req.query.offset,10)||0;
  try {
    // 쿠폰 정보
    const coupons = await Promise.all(coupon_nos.map(async no=>{
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons } = await apiRequest(mallId,'GET',url,{},{
        shop_no:1, coupon_no: no,
        fields: [
          'coupon_no',
          'available_product','available_product_list',
          'available_category','available_category_list',
          'benefit_amount','benefit_percentage'
        ].join(',')
      });
      return coupons?.[0]||null;
    }));
    const validCoupons = coupons.filter(Boolean);

    // 매핑 조회
    const url1 = `https://${mallId}.cafe24api.com/api/v2/admin/categories/${category_no}/products`;
    const { products: mapped } = await apiRequest(mallId,'GET',url1,{},{
      shop_no:1, display_group:1, limit, offset
    });
    const sorted = (mapped||[]).sort((a,b)=>a.sequence_no-b.sequence_no);
    const productNos = sorted.map(p=>p.product_no);
    if (!productNos.length) return res.json([]);

    // 상세 & 할인가
    const url2 = `https://${mallId}.cafe24api.com/api/v2/admin/products`;
    const { products: details } = await apiRequest(mallId,'GET',url2,{},{
      shop_no:1, product_no: productNos.join(','), limit: productNos.length
    });
    const detailMap = (details||[]).reduce((o,p)=>((o[p.product_no]=p),o), {});
    const discountMap = {};
    await Promise.all(productNos.map(async no=>{
      const url3 = `https://${mallId}.cafe24api.com/api/v2/admin/products/${no}/discountprice`;
      const { discountprice } = await apiRequest(mallId,'GET',url3,{}, { shop_no:1 });
      discountMap[no] = discountprice?.pc_discount_price ?? null;
    }));

    // 결과 포맷
    const formatKRW = n=> n!=null? Number(n).toLocaleString('ko-KR')+'원':null;
    const calcCouponInfos = prodNo=> validCoupons.map(c=> {
      const orig = parseFloat(detailMap[prodNo].price||0);
      const pct  = parseFloat(c.benefit_percentage||0);
      const amt  = parseFloat(c.benefit_amount||0);
      let bPrice=null;
      if(pct>0) bPrice=+(orig*(100-pct)/100).toFixed(2);
      else if(amt>0) bPrice=+(orig-amt).toFixed(2);
      return bPrice!=null? {
        coupon_no: c.coupon_no,
        benefit_percentage: pct,
        benefit_price: bPrice
      } : null;
    }).filter(Boolean).sort((a,b)=>b.benefit_percentage-a.benefit_percentage);

    const full = sorted.map(item=>{
      const p = detailMap[item.product_no]; if(!p) return null;
      const infos = calcCouponInfos(item.product_no);
      const first = infos[0]||null;
      return {
        product_no: item.product_no,
        product_name: p.product_name,
        price: p.price,
        summary_description: p.summary_description,
        list_image: p.list_image,
        sale_price: discountMap[item.product_no],
        couponInfos: infos,
        benefit_price: first? first.benefit_price:null,
        benefit_percentage: first? first.benefit_percentage:null
      };
    }).filter(Boolean);

    res.json(full.map(p=>({
      product_no: p.product_no,
      product_name: p.product_name,
      price: formatKRW(parseFloat(p.price)),
      summary_description: p.summary_description,
      list_image: p.list_image,
      sale_price: (p.sale_price!=null&&p.sale_price!=p.price)? formatKRW(p.sale_price):null,
      benefit_price: p.benefit_price!=null? formatKRW(p.benefit_price):null,
      benefit_percentage: p.benefit_percentage,
      couponInfos: p.couponInfos.length? p.couponInfos:null
    })));
  } catch(err) {
    console.error('카테고리 상품 조회 실패', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Café24 API: 전체 상품 ─────────────────────────────────────────
app.get('/api/:mallId/products', async (req, res) => {
  const { mallId } = req.params;
  const limit  = parseInt(req.query.limit,10)||1000;
  const offset = parseInt(req.query.offset,10)||0;
  const q      = (req.query.q||'').trim();
  try {
    const url    = `https://${mallId}.cafe24api.com/api/v2/admin/products`;
    const params = { shop_no:1, limit, offset };
    if(q) params['search[product_name]']=q;
    const { products, total_count } = await apiRequest(mallId,'GET',url,{},params);
    res.json({
      products: (products||[]).map(p=>({
        product_no:p.product_no,
        product_code:p.product_code,
        product_name:p.product_name,
        price:p.price,
        list_image:p.list_image
      })),
      total: total_count
    });
  } catch(err) {
    console.error('전체 상품 조회 실패', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Café24 API: 단일 상품 ─────────────────────────────────────────
app.get('/api/:mallId/products/:product_no', async (req, res) => {
  const { mallId, product_no } = req.params;
  const coupon_nos = (req.query.coupon_no||'').split(',').filter(Boolean);
  try {
    const prodUrl  = `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}`;
    const { product, products } = await apiRequest(mallId,'GET',prodUrl,{}, { shop_no:1 });
    const p = product||products?.[0];
    if(!p) return res.status(404).json({ error:'상품 없음' });

    const disUrl = `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}/discountprice`;
    const { discountprice } = await apiRequest(mallId,'GET',disUrl,{}, { shop_no:1 });
    const sale_price = discountprice?.pc_discount_price ?? null;

    let benefit_price=null, benefit_percentage=null;
    await Promise.all(coupon_nos.map(async no=>{
      const urlC = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons } = await apiRequest(mallId,'GET',urlC,{}, {
        shop_no:1, coupon_no:no,
        fields:[
          'coupon_no','available_product','available_product_list',
          'available_category','available_category_list',
          'benefit_amount','benefit_percentage'
        ].join(',')
      });
      const c = coupons?.[0]; if(!c) return;
      const orig = parseFloat(p.price);
      const pct  = parseFloat(c.benefit_percentage||0);
      const amt  = parseFloat(c.benefit_amount||0);
      let bPrice=null;
      if(pct>0) bPrice=+(orig*(100-pct)/100).toFixed(2);
      else if(amt>0) bPrice=+(orig-amt).toFixed(2);
      if(bPrice!=null && pct>(benefit_percentage||0)) {
        benefit_price=bPrice; benefit_percentage=pct;
      }
    }));

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
  } catch(err) {
    console.error('단일 상품 실패', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── 이벤트 CRUD ────────────────────────────────────────────────────
app.get('/api/events', async (req, res) => {
  try {
    const list = await db.collection('events').find().sort({ createdAt: -1 }).toArray();
    res.json(list);
  } catch {
    res.status(500).json({ error: '이벤트 조회 실패' });
  }
});
app.get('/api/events/:id', async (req, res) => {
  try {
    const ev = await db.collection('events').findOne({ _id:new ObjectId(req.params.id) });
    if(!ev) return res.status(404).json({ error:'이벤트 없음' });
    res.json(ev);
  } catch {
    res.status(500).json({ error:'이벤트 조회 실패' });
  }
});
app.post('/api/events', async (req, res) => {
  try {
    const now = dayjs().tz('Asia/Seoul').toDate();
    const doc = {
      ...req.body,
      createdAt: now,
      updatedAt: now,
      images: (req.body.images||[]).map(img=>({
        _id: new ObjectId(), ...img,
        regions: (img.regions||[]).map(r=>({ _id:new ObjectId(), ...r }))
      }))
    };
    const result = await db.collection('events').insertOne(doc);
    res.json({ _id: result.insertedId, ...doc });
  } catch {
    res.status(400).json({ error:'이벤트 생성 실패' });
  }
});
app.put('/api/events/:id', async (req, res) => {
  try {
    const now = dayjs().tz('Asia/Seoul').toDate();
    const objId = new ObjectId(req.params.id);
    const result = await db.collection('events').updateOne(
      { _id: objId },
      { $set: { ...req.body, updatedAt: now } }
    );
    if(result.matchedCount===0) return res.status(404).json({ error:'이벤트 없음' });
    const updated = await db.collection('events').findOne({ _id: objId });
    res.json({ success:true, data:updated });
  } catch(err) {
    console.error('이벤트 수정 실패', err);
    res.status(500).json({ error:'이벤트 수정 실패' });
  }
});

// ─── Analytics ──────────────────────────────────────────────────────
app.get('/api/analytics/:pageId/visitors-by-date', async (req, res) => {
  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if(!start_date||!end_date) return res.status(400).json({ error:'start_date,end_date 필수' });
  const startKey = start_date.slice(0,10), endKey = end_date.slice(0,10);
  const match = { pageId, dateKey:{ $gte:startKey,$lte:endKey } };
  if(url) match.pageUrl=url;
  const pipeline = [
    { $match: match },
    { $group:{
        _id:{ date:'$dateKey', visitorId:'$visitorId' },
        viewCount:{ $sum:{ $ifNull:['$viewCount',0] }},
        revisitCount:{ $sum:{ $ifNull:['$revisitCount',0] }}
    }},
    { $group:{
        _id:'$_id.date',
        totalVisitors:{ $sum:1 },
        newVisitors:{ $sum:{ $cond:[ {$gt:['$viewCount',0]},1,0 ] }},
        returningVisitors:{ $sum:{ $cond:[ {$gt:['$revisitCount',0]},1,0 ] }}
    }},
    { $project:{
        _id:0,
        date:'$_id',
        totalVisitors:1,
        newVisitors:1,
        returningVisitors:1,
        revisitRate:{
          $concat:[
            { $toString:{ $round:[{ $multiply:[{ $cond:[{$gt:['$returningVisitors','$totalVisitors']}, {$divide:['$returningVisitors','$totalVisitors']},0 ]},100]},0] }},
            ' %'
          ]
        }
    }},
    { $sort:{ date:1 }}
  ];
  try {
    const stats = await visitsCol().aggregate(pipeline).toArray();
    res.json(stats);
  } catch(err) {
    console.error(err);
    res.status(500).json({ error:'집계 실패' });
  }
});
app.get('/api/analytics/:pageId/clicks-by-date', async (req, res) => {
  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if(!start_date||!end_date) return res.status(400).json({ error:'start_date,end_date 필수' });
  const startKey = start_date.slice(0,10), endKey = end_date.slice(0,10);
  const match = { pageId, dateKey:{ $gte:startKey,$lte:endKey } };
  if(url) match.pageUrl=url;
  const pipeline = [
    { $match: match },
    { $group:{ _id:'$dateKey',
        product:{ $sum:{ $ifNull:['$urlClickCount',0] }},
        coupon:{ $sum:{ $ifNull:['$couponClickCount',0] }}
    }},
    { $project:{ _id:0, date:'$_id', product:1, coupon:1 }},
    { $sort:{ date:1 }}
  ];
  try {
    const data = await visitsCol().aggregate(pipeline).toArray();
    res.json(data);
  } catch(err) {
    console.error(err);
    res.status(500).json({ error:'클릭 집계 실패' });
  }
});
app.get('/api/analytics/:pageId/url-clicks', async (req, res) => {
  const { pageId } = req.params;
  const { start_date,end_date,url } = req.query;
  if(!start_date||!end_date) return res.status(400).json({ error:'start_date,end_date 필수' });
  const match = {
    pageId, type:'click', element:'product',
    timestamp:{ $gte:new Date(start_date), $lte:new Date(end_date) }
  };
  if(url) match.pageUrl=url;
  try {
    const count = await visitsCol().countDocuments(match);
    res.json({ count });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error:'URL 클릭 실패' });
  }
});
app.get('/api/analytics/:pageId/coupon-clicks', async (req, res) => {
  const { pageId } = req.params;
  const { start_date,end_date,url } = req.query;
  if(!start_date||!end_date) return res.status(400).json({ error:'start_date,end_date 필수' });
  const match = {
    pageId, type:'click', element:'coupon',
    timestamp:{ $gte:new Date(start_date), $lte:new Date(end_date) }
  };
  if(url) match.pageUrl=url;
  try {
    const count = await visitsCol().countDocuments(match);
    res.json({ count });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error:'쿠폰 클릭 실패' });
  }
});
app.get('/api/analytics/:pageId/urls', async (req, res) => {
  try {
    const urls = await visitsCol().distinct('pageUrl',{ pageId:req.params.pageId });
    res.json(urls);
  } catch(err) {
    console.error(err);
    res.status(500).json({ error:'URL 목록 실패' });
  }
});
app.get('/api/analytics/:pageId/devices', async (req, res) => {
  const { pageId } = req.params;
  const { start_date,end_date,url } = req.query;
  if(!start_date||!end_date) return res.status(400).json({ error:'start_date,end_date 필수' });
  const startKey=start_date.slice(0,10), endKey=end_date.slice(0,10);
  const match = { pageId, dateKey:{ $gte:startKey,$lte:endKey } };
  if(url) match.pageUrl=url;
  const pipeline = [
    { $match: match },
    { $group:{ _id:'$device', count:{ $sum:{ $add:[{ $ifNull:['$viewCount',0]},{ $ifNull:['$revisitCount',0]}] } } } },
    { $project:{ _id:0, device_type:'$_id', count:1 } }
  ];
  try {
    const data = await visitsCol().aggregate(pipeline).toArray();
    res.json(data);
  } catch(err) {
    console.error(err);
    res.status(500).json({ error:'디바이스 분포 실패' });
  }
});
app.get('/api/analytics/:pageId/devices-by-date', async (req, res) => {
  const { pageId } = req.params;
  const { start_date,end_date,url } = req.query;
  if(!start_date||!end_date) return res.status(400).json({ error:'start_date,end_date 필수' });
  const startKey=start_date.slice(0,10), endKey=end_date.slice(0,10);
  const match = { pageId, dateKey:{ $gte:startKey,$lte:endKey } };
  if(url) match.pageUrl=url;
  const pipeline = [
    { $match: match },
    { $group:{ _id:{ date:'$dateKey', device:'$device', visitor:'$visitorId' } } },
    { $group:{ _id:{ date:'$_id.date', device:'$_id.device' }, count:{ $sum:1 } } },
    { $project:{ _id:0, date:'$_id.date', device:'$_id.device', count:1 } },
    { $sort:{ date:1, device:1 } }
  ];
  try {
    const data = await visitsCol().aggregate(pipeline).toArray();
    res.json(data);
  } catch(err) {
    console.error(err);
    res.status(500).json({ error:'디바이스-날짜 실패' });
  }
});

// ─── 트래킹 ─────────────────────────────────────────────────────────
app.post('/api/track', async (req, res) => {
  try {
    const { pageId, pageUrl, visitorId, referrer, device, type, element, timestamp } = req.body;
    if(!pageId||!visitorId||!type||!timestamp)
      return res.status(400).json({ error:'필수 필드 누락' });
    if(!ObjectId.isValid(pageId)) return res.sendStatus(204);
    const ev = await db.collection('events').findOne({ _id:new ObjectId(pageId) },{ projection:{_id:1} });
    if(!ev) return res.sendStatus(204);

    const kstTs = dayjs(timestamp).tz('Asia/Seoul').toDate();
    const dateKey = dayjs(timestamp).tz('Asia/Seoul').format('YYYY-MM-DD');
    const getPathname = str=>{ try{ return new URL(str).pathname }catch{return str} };
    const path = getPathname(pageUrl);

    const filter = { pageId, visitorId, dateKey };
    const update = {
      $set:{ lastVisit:kstTs, pageUrl:path, referrer:referrer||null, device:device||null },
      $setOnInsert:{ firstVisit:kstTs },
      $inc:{}
    };
    if(type==='view') update.$inc.viewCount=1;
    else if(type==='revisit') update.$inc.revisitCount=1;
    else if(type==='click'){
      update.$inc.clickCount=1;
      if(element==='product') update.$inc.urlClickCount=1;
      if(element==='coupon')  update.$inc.couponClickCount=1;
    }
    await visitsCol().updateOne(filter, update, { upsert:true });
    res.sendStatus(204);
  } catch(err) {
    console.error('TRACK ERROR', err);
    res.status(500).json({ error:'트래킹 실패' });
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
