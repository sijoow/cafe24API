// app.js
require('dotenv').config();
process.env.TZ = 'Asia/Seoul';

const express       = require('express');
const path          = require('path');
const bodyParser    = require('body-parser');
const fs            = require('fs');
const cors          = require('cors');
const compression   = require('compression');
const axios         = require('axios');
const { MongoClient, ObjectId } = require('mongodb');
const multer        = require('multer');
const dayjs         = require('dayjs');
const utc           = require('dayjs/plugin/utc');
const tz            = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

const {
  MONGODB_URI,
  DB_NAME,
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  CAFE24_API_VERSION,
  APP_URL,
  FRONTEND_URL,
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

// ─── 1) MongoDB 연결 ─────────────────────────────────────────────────
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('▶️ MongoDB connected to', DB_NAME);
}

// ─── 2) OAuth 설치 시작 → 권한 요청 ─────────────────────────────────────
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
  res.redirect(`https://${mallId}.cafe24.com/api/v2/oauth/authorize?${params}`);
});

// ─── 3) OAuth 콜백 → code→token 교환→DB 저장 → 프론트 리다이렉트 ────────────
app.get('/auth/callback', async (req, res) => {
  const { code, state: mallId, user_id: userId, user_name: userName } = req.query;
  if (!code || !mallId) {
    return res.status(400).send('❌ code 또는 mallId(state)가 없습니다.');
  }

  try {
    // 토큰 교환
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

    // DB에 mallId + userId 조합으로 저장
    await db.collection('token').updateOne(
      { mallId, userId },
      { $set: {
          mallId,
          userId,
          userName,
          accessToken:  data.access_token,
          refreshToken: data.refresh_token,
          obtainedAt:   new Date(),
          expiresIn:    data.expires_in
        }
      },
      { upsert: true }
    );

    // 프론트로 mallId, userId, userName 함께 리다이렉트
    const redirectTo = new URL(`${FRONTEND_URL}/auth/callback`);
    redirectTo.searchParams.set('mallId',   mallId);
    redirectTo.searchParams.set('user_id',  userId);
    redirectTo.searchParams.set('user_name',userName);
    return res.redirect(redirectTo.toString());
  }
  catch (err) {
    console.error('❌ [ERROR] token exchange failed:', err.response?.data || err);
    return res.status(500).send('토큰 교환 중 오류가 발생했습니다.');
  }
});

// ─── 4) 토큰 캐싱 & 갱신 헬퍼 ───────────────────────────────────
const tokenCache = {};  // { [mallId_userId]: { accessToken, refreshToken, expiresAt } }

async function loadTokens(mallId, userId) {
  const doc = await db.collection('token').findOne({ mallId, userId });
  if (!doc) throw new Error(`No tokens for mallId=${mallId} & userId=${userId}`);
  tokenCache[`${mallId}_${userId}`] = {
    accessToken: doc.accessToken,
    refreshToken: doc.refreshToken,
    expiresAt:   new Date(doc.obtainedAt).getTime() + doc.expiresIn * 1000
  };
}

async function refreshAccessToken(mallId, userId) {
  const key = `${mallId}_${userId}`;
  if (!tokenCache[key]?.refreshToken) {
    await loadTokens(mallId, userId);
  }
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: tokenCache[key].refreshToken
  }).toString();
  const credsHeader = Buffer.from(
    `${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`
  ).toString('base64');

  const { data } = await axios.post(
    `https://${mallId}.cafe24api.com/api/v2/oauth/token`,
    params,
    { headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credsHeader}`
      }
    }
  );

  tokenCache[key] = {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,
    expiresAt:    new Date().getTime() + data.expires_in * 1000
  };

  // DB에도 갱신
  await db.collection('token').updateOne(
    { mallId, userId },
    { $set: {
        accessToken:  data.access_token,
        refreshToken: data.refresh_token,
        obtainedAt:   new Date()
      }
    }
  );
}

async function cafeApi(mallId, userId, method, url, data = {}, params = {}) {
  const key = `${mallId}_${userId}`;
  if (!tokenCache[key]?.accessToken || Date.now() >= tokenCache[key].expiresAt) {
    await loadTokens(mallId, userId);
  }
  try {
    const resp = await axios({
      method, url, data, params,
      headers: {
        Authorization:         `Bearer ${tokenCache[key].accessToken}`,
        'X-Cafe24-Api-Version': CAFE24_API_VERSION,
        'Content-Type':        'application/json'
      }
    });
    return resp.data;
  } catch (err) {
    if (err.response?.status === 401) {
      await refreshAccessToken(mallId, userId);
      return cafeApi(mallId, userId, method, url, data, params);
    }
    throw err;
  }
}
// ─── MallId 결정 & 액세스 로그 기록 ─────────────────────────────
app.use('/api', async (req, res, next) => {
  // 1) 우선 클라이언트가 보낸 X-Mall-Id 헤더를 사용
  let mallId = req.get('X-Mall-Id');

  // 2) 없으면 Origin 또는 Referer 헤더에서 도메인 파싱
  if (!mallId) {
    const origin = req.get('Origin') || req.get('Referer') || '';
    try {
      mallId = new URL(origin).hostname.split('.')[0];  // e.g. onimon.shop → 'onimon'
    } catch {
      return res.status(400).json({ error: 'Cannot detect mallId' });
    }
  }

  req.mallId = mallId;

  // 3) 액세스 로그 남기기
  try {
    await db.collection('access_logs').insertOne({
      mallId,
      path:      req.originalUrl,
      method:    req.method,
      timestamp: new Date(),
      userAgent: req.get('User-Agent'),
      ip:        req.ip
    });
  } catch (e) {
    console.error('⚠️ 액세스 로그 실패', e);
  }

  next();
});

// ─── 6) Visits 컬렉션 헬퍼 ────────────────────────────────────────
const visitsCol = mallId => db.collection(`visits_${mallId}`);

// ─── 7) Multer & R2 업로드 세팅 ────────────────────────────────────
const uploadDir = path.join(__dirname,'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (req,file,cb) => cb(null,uploadDir),
  filename:    (req,file,cb) => cb(null,Date.now()+path.extname(file.originalname))
});
const upload = multer({ storage });
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const s3Client = new S3Client({
  region:     R2_REGION,
  endpoint:   R2_ENDPOINT,
  credentials:{ accessKeyId:R2_ACCESS_KEY, secretAccessKey:R2_SECRET_KEY },
  forcePathStyle:true
});

// ─── 8) API: 이미지 업로드 ─────────────────────────────────────
app.post('/api/uploads/image', upload.single('file'), async (req, res) => {
  const mallId = req.mallId;
  const local = req.file.path, key = req.file.filename;
  const stream = fs.createReadStream(local);
  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME, Key: key, Body: stream,
      ContentType: req.file.mimetype, ACL:'public-read'
    }));
    res.json({ url:`${R2_PUBLIC_BASE}/${key}` });
  } catch {
    res.status(500).json({ error:'파일 업로드 실패' });
  } finally {
    fs.unlink(local, ()=>{});
  }
});

// ─── 9) API: 트래킹 ─────────────────────────────────────────────
app.post('/api/track', async (req, res) => {
  const mallId = req.mallId;
  await initIndexesFor(mallId);

  const { pageId, pageUrl, visitorId, referrer, device, type, element, timestamp } = req.body;
  if (!pageId||!visitorId||!type||!timestamp) return res.status(400).json({error:'필수 필드 누락'});
  if (!ObjectId.isValid(pageId)) return res.sendStatus(204);

  const ev = await db.collection('events').findOne(
    {_id:new ObjectId(pageId)},
    {projection:{_id:1}}
  );
  if (!ev) return res.sendStatus(204);

  const kst = dayjs(timestamp).tz('Asia/Seoul').toDate();
  const dateKey = dayjs(timestamp).tz('Asia/Seoul').format('YYYY-MM-DD');
  const path = (()=>{ try{return new URL(pageUrl).pathname}catch{return pageUrl}})();

  const filter = { pageId, visitorId, dateKey };
  const update = {
    $set:{ lastVisit:kst, pageUrl:path, referrer:referrer||null, device:device||null },
    $setOnInsert:{ firstVisit:kst },
    $inc:{}
  };
  if (type==='view')    update.$inc.viewCount=1;
  if (type==='revisit') update.$inc.revisitCount=1;
  if (type==='click'){
    update.$inc.clickCount=1;
    if(element==='product') update.$inc.urlClickCount=1;
    if(element==='coupon')  update.$inc.couponClickCount=1;
  }

  await visitsCol(mallId).updateOne(filter, update, { upsert:true });
  res.sendStatus(204);
});

// ─── 10) API: visitors-by-date ───────────────────────────────────
app.get('/api/analytics/:pageId/visitors-by-date', async (req, res) => {
  const mallId = req.mallId;
  await initIndexesFor(mallId);

  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) return res.status(400).json({error:'start_date,end_date 필수'});

  const match = {
    pageId,
    dateKey:{ $gte:start_date.slice(0,10), $lte:end_date.slice(0,10) }
  };
  if (url) match.pageUrl = url;

  const pipeline = [
    {$match:match},
    {$group:{
      _id:{date:'$dateKey', visitorId:'$visitorId'},
      viewCount:{$sum:{$ifNull:['$viewCount',0]}},
      revisitCount:{$sum:{$ifNull:['$revisitCount',0]}}
    }},
    {$group:{
      _id:'$_id.date',
      totalVisitors:{$sum:1},
      newVisitors:{$sum:{$cond:[{$gt:['$viewCount',0]},1,0]}},
      returningVisitors:{$sum:{$cond:[{$gt:['$revisitCount',0]},1,0]}}
    }},
    {$project:{
      _id:0,
      date:'$_id',
      totalVisitors:1,
      newVisitors:1,
      returningVisitors:1,
      revisitRate:{
        $concat:[
          {$toString:{$round:[{$multiply:[{$cond:[{$gt:['$totalVisitors',0]},{$divide:['$returningVisitors','$totalVisitors']},0]},100]},0]}},
          ' %'
        ]
      }
    }},
    {$sort:{date:1}}
  ];

  const stats = await visitsCol(mallId).aggregate(pipeline).toArray();
  res.json(stats);
});

// ─── 11) API: clicks-by-date ─────────────────────────────────────
app.get('/api/analytics/:pageId/clicks-by-date', async (req, res) => {
  const mallId = req.mallId;
  await initIndexesFor(mallId);

  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) return res.status(400).json({error:'start/end 필수'});

  const match = {
    pageId,
    dateKey:{ $gte:start_date.slice(0,10), $lte:end_date.slice(0,10) }
  };
  if (url) match.pageUrl = url;

  const pipeline = [
    {$match:match},
    {$group:{
      _id:'$dateKey',
      product:{$sum:{$ifNull:['$urlClickCount',0]}},
      coupon:{$sum:{$ifNull:['$couponClickCount',0]}}
    }},
    {$project:{ _id:0, date:'$_id', product:1, coupon:1 }},
    {$sort:{ date:1 }}
  ];

  const data = await visitsCol(mallId).aggregate(pipeline).toArray();
  res.json(data);
});

// ─── 12) API: url-clicks ─────────────────────────────────────────
app.get('/api/analytics/:pageId/url-clicks', async (req, res) => {
  const mallId = req.mallId;
  await initIndexesFor(mallId);

  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) return res.status(400).json({error:'start/end 필수'});

  const filter = {
    pageId, type:'click', element:'product',
    timestamp:{ $gte:new Date(start_date), $lte:new Date(end_date) }
  };
  if (url) filter.pageUrl = url;

  const count = await visitsCol(mallId).countDocuments(filter);
  res.json({ count });
});

// ─── 13) API: coupon-clicks ────────────────────────────────────────
app.get('/api/analytics/:pageId/coupon-clicks', async (req, res) => {
  const mallId = req.mallId;
  await initIndexesFor(mallId);

  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) return res.status(400).json({error:'start/end 필수'});

  const filter = {
    pageId, type:'click', element:'coupon',
    timestamp:{ $gte:new Date(start_date), $lte:new Date(end_date) }
  };
  if (url) filter.pageUrl = url;

  const count = await visitsCol(mallId).countDocuments(filter);
  res.json({ count });
});

// ─── 14) API: distinct URLs ───────────────────────────────────────
app.get('/api/analytics/:pageId/urls', async (req, res) => {
  const mallId = req.mallId;
  await initIndexesFor(mallId);

  const { pageId } = req.params;
  const urls = await visitsCol(mallId).distinct('pageUrl',{ pageId });
  res.json(urls);
});

// ─── 15) API: devices-by-date ─────────────────────────────────────
app.get('/api/analytics/:pageId/devices-by-date', async (req, res) => {
  const mallId = req.mallId;
  await initIndexesFor(mallId);

  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) return res.status(400).json({error:'start/end 필수'});

  const match = {
    pageId,
    dateKey:{ $gte:start_date.slice(0,10), $lte:end_date.slice(0,10) }
  };
  if (url) match.pageUrl = url;

  const pipeline = [
    {$match:match},
    {$group:{ _id:{ date:'$dateKey', device:'$device', visitor:'$visitorId' } }},
    {$group:{ _id:{ date:'$_id.date', device:'$_id.device' }, count:{ $sum:1 } }},
    {$project:{ _id:0, date:'$_id.date', device:'$_id.device', count:1 }},
    {$sort:{ date:1, device:1 }}
  ];

  const data = await visitsCol(mallId).aggregate(pipeline).toArray();
  res.json(data);
});

// ─── 16) API: categories/products ─────────────────────────────────
app.get('/api/categories/all', async (req, res) => {
  const mallId = req.mallId;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/categories`;
      const { categories } = await cafeApi(mallId, req.mallUserId, 'GET', url, {}, { limit, offset });
      if (!categories.length) break;
      all.push(...categories);
      offset += categories.length;
    }
    res.json(all);
  } catch (err) {
    console.error('카테고리 전체 조회 실패', err);
    res.status(500).json({ error: '전체 카테고리 조회 실패' });
  }
});

app.get('/api/categories/:category_no/products', async (req, res) => {
  const mallId = req.mallId;
  const { category_no } = req.params;
  // …기존 로직 그대로, cafeApi(mallId, …) 호출…
});

// ─── 17) API: coupons ─────────────────────────────────────────────
app.get('/api/coupons', async (req, res) => {
  const mallId = req.mallId;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons } = await cafeApi(mallId, req.mallUserId, 'GET', url, {}, { shop_no:1, limit, offset });
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
    console.error('쿠폰 조회 실패', err);
    res.status(500).json({ error: '쿠폰 조회 실패' });
  }
});

// ─── 18) API: events CRUD ──────────────────────────────────────────
const eventsCol = mallId => db.collection(`events_${mallId}`);

app.get('/api/events', async (req, res) => {
  const mallId = req.mallId;
  try {
    const list = await eventsCol(mallId).find().sort({ createdAt:-1 }).toArray();
    res.json(list);
  } catch (err) {
    console.error('이벤트 목록 조회 실패', err);
    res.status(500).json({ error:'이벤트 목록 조회 실패' });
  }
});

app.get('/api/events/:id', async (req, res) => {
  const mallId = req.mallId;
  const { id } = req.params;
  try {
    const ev = await eventsCol(mallId).findOne({ _id:new ObjectId(id) });
    if (!ev) return res.status(404).json({ error:'이벤트가 없습니다' });
    res.json(ev);
  } catch (err) {
    console.error('이벤트 조회 실패', err);
    res.status(500).json({ error:'이벤트 조회 실패' });
  }
});

app.post('/api/events', async (req, res) => {
  const mallId = req.mallId;
  try {
    const now = dayjs().tz('Asia/Seoul').toDate();
    const doc = {
      ...req.body,
      createdAt: now,
      updatedAt: now,
      images: (req.body.images||[]).map(img=>({
        _id:new ObjectId(), ...img,
        regions:(img.regions||[]).map(r=>({ _id:new ObjectId(), ...r }))
      }))
    };
    const { insertedId } = await eventsCol(mallId).insertOne(doc);
    res.json({ _id: insertedId, ...doc });
  } catch (err) {
    console.error('이벤트 생성 실패', err);
    res.status(400).json({ error:'이벤트 생성 실패' });
  }
});

app.put('/api/events/:id', async (req, res) => {
  const mallId = req.mallId;
  const { id } = req.params;
  try {
    const now = dayjs().tz('Asia/Seoul').toDate();
    const result = await eventsCol(mallId).updateOne(
      { _id:new ObjectId(id) },
      { $set:{ ...req.body, updatedAt: now } }
    );
    if (result.matchedCount===0) return res.status(404).json({ error:'이벤트가 없습니다' });
    const updated = await eventsCol(mallId).findOne({ _id:new ObjectId(id) });
    res.json({ success:true, data:updated });
  } catch (err) {
    console.error('이벤트 수정 실패', err);
    res.status(500).json({ error:'이벤트 수정 실패' });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  const mallId = req.mallId;
  const { id } = req.params;
  try {
    const ev = await eventsCol(mallId).findOne({ _id:new ObjectId(id) });
    if (!ev) return res.status(404).json({ error:'이벤트가 없습니다' });
    const keys = (ev.images||[]).map(img=>
      new URL(img.src).pathname.replace(/^\//,'')
    );
    await Promise.all(keys.map(k=>
      s3Client.send(new DeleteObjectCommand({ Bucket:R2_BUCKET_NAME, Key:k }))
    ));
    await eventsCol(mallId).deleteOne({ _id:new ObjectId(id) });
    await visitsCol(mallId).deleteMany({ pageId:id });
    res.json({ success:true });
  } catch (err) {
    console.error('이벤트 삭제 실패', err);
    res.status(500).json({ error:'삭제 실패' });
  }
});

// ─── 카테고리 전체 조회 ─────────────────────────────────────────────
app.get('/api/categories/all', async (req, res) => {
  const mallId = req.mallId;
  const userId = req.userId;  // OAuth 시 저장된 userId
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/categories`;
      const { categories } = await cafeApi(mallId, userId, 'GET', url, {}, { limit, offset });
      if (!categories.length) break;
      all.push(...categories);
      offset += categories.length;
    }
    res.json(all);
  } catch (err) {
    console.error('카테고리 전체 조회 실패', err);
    res.status(500).json({ error: '전체 카테고리 조회 실패' });
  }
});

// ─── 특정 카테고리 내 상품 조회 ───────────────────────────────────────
app.get('/api/categories/:category_no/products', async (req, res) => {
  const mallId     = req.mallId;
  const userId     = req.userId;
  const { category_no } = req.params;
  try {
    // 1) 매핑 리스트
    const mapUrl = `https://${mallId}.cafe24api.com/api/v2/admin/categories/${category_no}/products`;
    const { products: mappings } = await cafeApi(mallId, userId, 'GET', mapUrl, {}, {
      shop_no:1,
      limit:  parseInt(req.query.limit,10)  || 100,
      offset: parseInt(req.query.offset,10) || 0
    });
    const productNos = (mappings || []).map(m => m.product_no);
    if (!productNos.length) return res.json([]);

    // 2) 상세 정보
    const detailUrl = `https://${mallId}.cafe24api.com/api/v2/admin/products`;
    const { products: details } = await cafeApi(mallId, userId, 'GET', detailUrl, {}, {
      shop_no:     1,
      product_no:  productNos.join(','),
      limit:       productNos.length
    });

    // 3) 응답
    const detailMap = details.reduce((acc, p) => {
      acc[p.product_no] = p;
      return acc;
    }, {});
    const result = productNos.map(no => {
      const p = detailMap[no];
      return p ? {
        product_no:         p.product_no,
        product_name:       p.product_name,
        summary_description:p.summary_description,
        price:              p.price,
        list_image:         p.list_image
      } : null;
    }).filter(Boolean);

    res.json(result);
  } catch (err) {
    console.error('카테고리 내 상품 조회 실패', err);
    res.status(500).json({ error: '카테고리 내 상품 조회 실패' });
  }
});

// ─── 전체 상품 조회 ─────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  const mallId = req.mallId;
  const userId = req.userId;
  try {
    const limit  = parseInt(req.query.limit,10)  || 100;
    const offset = parseInt(req.query.offset,10) || 0;
    const q      = (req.query.q || '').trim();
    const url    = `https://${mallId}.cafe24api.com/api/v2/admin/products`;
    const params = { shop_no:1, limit, offset };
    if (q) params['search[product_name]'] = q;

    const { products, total_count } = await cafeApi(mallId, userId, 'GET', url, {}, params);
    res.json({
      total: total_count,
      products: products.map(p => ({
        product_no:  p.product_no,
        product_name:p.product_name,
        price:       p.price,
        list_image:  p.list_image
      }))
    });
  } catch (err) {
    console.error('전체 상품 조회 실패', err);
    res.status(500).json({ error: '전체 상품 조회 실패' });
  }
});

// ─── 단일 상품 상세 조회 ─────────────────────────────────────────────
app.get('/api/products/:product_no', async (req, res) => {
  const mallId     = req.mallId;
  const userId     = req.userId;
  const { product_no } = req.params;
  try {
    const url = `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}`;
    const { product:p0, products:plist } = await cafeApi(mallId, userId, 'GET', url, {}, { shop_no:1 });
    const p = p0 || plist?.[0];
    if (!p) return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });

    // 즉시할인가 조회 (선택)
    const dpUrl = `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}/discountprice`;
    const { discountprice } = await cafeApi(mallId, userId, 'GET', dpUrl, {}, { shop_no:1 });

    res.json({
      product_no,
      product_name:       p.product_name,
      summary_description:p.summary_description || '',
      price:              p.price,
      sale_price:         discountprice?.pc_discount_price || null,
      list_image:         p.list_image
    });
  } catch (err) {
    console.error('단일 상품 조회 실패', err);
    res.status(500).json({ error: '단일 상품 조회 실패' });
  }
});


// 서버 시작dsfsdfsd
initDb()
  .then(() => {
    app.listen(PORT, ()=>console.log(`▶️ Server running at ${APP_URL} (port ${PORT})`));
  })
  .catch(err=>{
    console.error('❌ 초기화 실패', err);
    process.exit(1);
  });