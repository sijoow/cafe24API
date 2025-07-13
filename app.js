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
  APP_URL,    // ex) https://port-0-xxx.sel5.cloudtype.app
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

// ─── 1) MongoDB 연결 ───────────────────────────────────────────────────
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('▶️ MongoDB connected to', DB_NAME);
}

// ─── 2) OAuth: 설치 시작 → 권한 요청 ────────────────────────────────────
app.get('/install/:mallId', (req, res) => {
  const mallId = req.params.mallId;
  const redirectUri = `${APP_URL}/auth/callback`;
  // state 에 mallId 담아서 콜백 시 전달받음
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CAFE24_CLIENT_ID,
    redirect_uri:  redirectUri,
    scope:         'mall.read_category,mall.read_product,mall.read_analytics',
    state:         mallId,
  });
  console.log('👉 [INSTALL] authorize →', 
    `https://${mallId}.cafe24.com/api/v2/oauth/authorize?${params}`
  );
  res.redirect(`https://${mallId}.cafe24.com/api/v2/oauth/authorize?${params}`);
});

// ─── 3) OAuth 콜백 → code→token 교환→DB 저장 ─────────────────────────────
app.get('/auth/callback', async (req, res) => {
  console.log('--- /auth/callback called ---', req.query);
  const { code, state: mallId } = req.query;
  if (!code || !mallId) {
    return res.status(400).send('❌ code 또는 mallId(state)가 없습니다.');
  }

  try {
    const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
    const creds = Buffer.from(
      `${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`
    ).toString('base64');
    const body = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: `${APP_URL}/auth/callback`
    }).toString();

    console.log('▶️ [TOKEN] POST to', tokenUrl);
    const { data } = await axios.post(tokenUrl, body, {
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`
      }
    });
    console.log('✅ [TOKEN] got', {
      access:  data.access_token.slice(0,8)+'…',
      refresh: data.refresh_token.slice(0,8)+'…',
      expires: data.expires_in
    });

    // DB에 저장
    const result = await db.collection('token').updateOne(
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
    console.log('✅ [DB] token.upsert →', result.upsertedId || result.modifiedCount);
    res.send('앱 설치 완료! 토큰이 DB에 저장되었습니다.');
  }
  catch (err) {
    console.error('❌ [ERROR] token exchange failed:', err.response?.data || err);
    res.status(500).send('토큰 교환 중 오류가 발생했습니다.');
  }
});

// ─── 4) 토큰 관리 헬퍼 ─────────────────────────────────────────────────
let accessTokenCache, refreshTokenCache;
async function loadTokens(mallId) {
  const doc = await db.collection('token').findOne({ mallId });
  if (!doc) throw new Error(`No tokens for mallId=${mallId}`);
  accessTokenCache  = doc.accessToken;
  refreshTokenCache = doc.refreshToken;
}
async function refreshAccessToken(mallId) {
  const url   = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
  const creds = Buffer.from(
    `${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`
  ).toString('base64');
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshTokenCache
  }).toString();

  const { data } = await axios.post(url, params, {
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`
    }
  });
  accessTokenCache  = data.access_token;
  refreshTokenCache = data.refresh_token;
  await db.collection('token').updateOne(
    { mallId },
    { $set: {
        accessToken:  accessTokenCache,
        refreshToken: refreshTokenCache,
        obtainedAt:   new Date()
      }
    }
  );
}

// 공통 API 호출
async function cafeApi(mallId, method, url, data={}, params={}) {
  if (!accessTokenCache) await loadTokens(mallId);
  try {
    return (await axios({
      method, url, data, params,
      headers: {
        Authorization:        `Bearer ${accessTokenCache}`,
        'X-Cafe24-Api-Version': CAFE24_API_VERSION,
        'Content-Type':       'application/json'
      }
    })).data;
  } catch (err) {
    if (err.response?.status === 401) {
      await refreshAccessToken(mallId);
      return cafeApi(mallId, method, url, data, params);
    }
    throw err;
  }
}

// ─── 5) visits 컬렉션 헬퍼 & 인덱스 세팅 ─────────────────────────────
function visitsCol(mallId) {
  return db.collection(`visits_${mallId}`);
}
async function initIndexesFor(mallId) {
  const col = visitsCol(mallId);
  try { await col.dropIndex('unique_per_user_day'); } catch {}
  await col.createIndex(
    { pageId:1, visitorId:1, dateKey:1 },
    { unique: true, name: 'unique_per_user_day' }
  );
}

// ─── 6) Multer, R2 세팅 (변경 없음) ─────────────────────────────────
const uploadDir = path.join(__dirname,'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination:(r,f,cb)=>cb(null,uploadDir),
  filename:   (r,f,cb)=>cb(null,Date.now()+path.extname(f.originalname))
});
const upload = multer({ storage });
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const s3Client = new S3Client({
  region:   R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials:{ accessKeyId:R2_ACCESS_KEY, secretAccessKey:R2_SECRET_KEY },
  forcePathStyle:true
});
app.post('/api/:mallId/uploads/image', upload.single('file'), async (req,res)=>{
  const { mallId } = req.params;
  const local = req.file.path, key = req.file.filename;
  const stream = fs.createReadStream(local);
  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME, Key: key, Body: stream,
      ContentType: req.file.mimetype, ACL:'public-read'
    }));
    res.json({ url:`${R2_PUBLIC_BASE}/${key}` });
  } catch { res.status(500).json({ error:'파일 업로드 실패' }) }
  finally{ fs.unlink(local,()=>{}) }
});

// ─── 7) Tracking & Analytics & CRUD 등 모든 기존 라우트들… ─────────
app.post('/api/:mallId/track', async (req,res)=>{
  const { mallId } = req.params;
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

  await visitsCol(mallId).updateOne(filter,update,{upsert:true});
  res.sendStatus(204);
});

// ─── visitors-by-date ───────────────────────────────────────────────
app.get('/api/:mallId/analytics/:pageId/visitors-by-date', async (req,res)=>{
  const { mallId, pageId } = req.params;
  await initIndexesFor(mallId);

  const { start_date,end_date,url } = req.query;
  if(!start_date||!end_date) return res.status(400).json({error:'start_date,end_date 필수'});
  const match = {
    pageId,
    dateKey:{ $gte:start_date.slice(0,10), $lte:end_date.slice(0,10) }
  };
  if(url) match.pageUrl=url;

  const pipeline = [
    {$match:match},
    {$group:{
      _id:{date:'$dateKey',visitorId:'$visitorId'},
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

// ─── 카테고리 전체 조회 ─────────────────────────────────────────────
app.get('/api/:mallId/categories/all', async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/categories`;
      const { categories } = await cafeApi(mallId, 'GET', url, {}, { limit, offset });
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

// ─── 쿠폰 전체 조회 ─────────────────────────────────────────────────
app.get('/api/:mallId/coupons', async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons } = await cafeApi(mallId, 'GET', url, {}, { shop_no:1, limit, offset });
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

// ─── 이벤트 CRUD ────────────────────────────────────────────────────
const eventsCol = (mallId) => db.collection(`events_${mallId}`);
app.get('/api/:mallId/events', async (req, res) => {
  const { mallId } = req.params;
  try {
    const list = await eventsCol(mallId).find().sort({ createdAt:-1 }).toArray();
    res.json(list);
  } catch (err) {
    console.error('이벤트 목록 조회 실패', err);
    res.status(500).json({ error:'이벤트 목록 조회 실패' });
  }
});
app.get('/api/:mallId/events/:id', async (req, res) => {
  const { mallId, id } = req.params;
  try {
    const ev = await eventsCol(mallId).findOne({ _id:new ObjectId(id) });
    if (!ev) return res.status(404).json({ error:'이벤트가 없습니다' });
    res.json(ev);
  } catch (err) {
    console.error('이벤트 조회 실패', err);
    res.status(500).json({ error:'이벤트 조회 실패' });
  }
});
app.post('/api/:mallId/events', async (req, res) => {
  const { mallId } = req.params;
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
app.put('/api/:mallId/events/:id', async (req, res) => {
  const { mallId, id } = req.params;
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
app.delete('/api/:mallId/events/:id', async (req, res) => {
  const { mallId, id } = req.params;
  try {
    // (이미지 삭제 로직 포함)
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

// ─── Analytics: clicks-by-date ───────────────────────────────────────
app.get('/api/:mallId/analytics/:pageId/clicks-by-date', async (req,res)=>{
  const { mallId, pageId } = req.params;
  await initIndexesFor(mallId);
  const { start_date,end_date,url } = req.query;
  if(!start_date||!end_date) return res.status(400).json({error:'start/end 필수'});
  const match = { pageId, dateKey:{ $gte:start_date.slice(0,10), $lte:end_date.slice(0,10) } };
  if(url) match.pageUrl=url;
  const pipeline = [
    { $match:match },
    { $group:{
        _id:'$dateKey',
        product:{$sum:{$ifNull:['$urlClickCount',0]}},
        coupon:{$sum:{$ifNull:['$couponClickCount',0]}}
    }},
    { $project:{ _id:0, date:'$_id', product:1, coupon:1 }},
    { $sort:{ date:1 }}
  ];
  const data = await visitsCol(mallId).aggregate(pipeline).toArray();
  res.json(data);
});

// ─── Analytics: url-clicks ───────────────────────────────────────────
app.get('/api/:mallId/analytics/:pageId/url-clicks', async (req,res)=>{
  const { mallId, pageId } = req.params;
  await initIndexesFor(mallId);
  const { start_date,end_date,url } = req.query;
  if(!start_date||!end_date) return res.status(400).json({error:'start/end 필수'});
  const filter = {
    pageId, type:'click', element:'product',
    timestamp:{ $gte:new Date(start_date), $lte:new Date(end_date) }
  };
  if(url) filter.pageUrl=url;
  const count = await visitsCol(mallId).countDocuments(filter);
  res.json({ count });
});

// ─── Analytics: coupon-clicks ────────────────────────────────────────
app.get('/api/:mallId/analytics/:pageId/coupon-clicks', async (req,res)=>{
  const { mallId, pageId } = req.params;
  await initIndexesFor(mallId);
  const { start_date,end_date,url } = req.query;
  if(!start_date||!end_date) return res.status(400).json({error:'start/end 필수'});
  const filter = {
    pageId, type:'click', element:'coupon',
    timestamp:{ $gte:new Date(start_date), $lte:new Date(end_date) }
  };
  if(url) filter.pageUrl=url;
  const count = await visitsCol(mallId).countDocuments(filter);
  res.json({ count });
});

// ─── Analytics: urls distinct ─────────────────────────────────────────
app.get('/api/:mallId/analytics/:pageId/urls', async (req,res)=>{
  const { mallId, pageId } = req.params;
  await initIndexesFor(mallId);
  const urls = await visitsCol(mallId).distinct('pageUrl',{ pageId });
  res.json(urls);
});

// ─── Analytics: devices ──────────────────────────────────────────────
app.get('/api/:mallId/analytics/:pageId/devices', async (req,res)=>{
  const { mallId, pageId } = req.params;
  await initIndexesFor(mallId);
  const { start_date,end_date,url } = req.query;
  if(!start_date||!end_date) return res.status(400).json({error:'start/end 필수'});
  const match = {
    pageId,
    dateKey:{ $gte:start_date.slice(0,10), $lte:end_date.slice(0,10) }
  };
  if(url) match.pageUrl=url;
  const pipeline = [
    { $match:match },
    { $group:{
        _id:'$device',
        count:{$sum:{$add:[{$ifNull:['$viewCount',0]},{$ifNull:['$revisitCount',0]}]}}
    }},
    { $project:{ _id:0, device_type:'$_id', count:1 }}
  ];
  const data = await visitsCol(mallId).aggregate(pipeline).toArray();
  res.json(data);
});

// ─── Analytics: devices-by-date ──────────────────────────────────────
app.get('/api/:mallId/analytics/:pageId/devices-by-date', async (req,res)=>{
  const { mallId, pageId } = req.params;
  await initIndexesFor(mallId);
  const { start_date,end_date,url } = req.query;
  if(!start_date||!end_date) return res.status(400).json({error:'start/end 필수'});
  const match = {
    pageId, dateKey:{ $gte:start_date.slice(0,10), $lte:end_date.slice(0,10) }
  };
  if(url) match.pageUrl=url;
  const pipeline = [
    { $match:match },
    { $group:{ _id:{ date:'$dateKey', device:'$device', visitor:'$visitorId' } } },
    { $group:{ _id:{ date:'$_id.date', device:'$_id.device' }, count:{ $sum:1 } } },
    { $project:{ _id:0, date:'$_id.date', device:'$_id.device', count:1 } },
    { $sort:{ date:1, device:1 } }
  ];
  const data = await visitsCol(mallId).aggregate(pipeline).toArray();
  res.json(data);
});

// ─── 카테고리 내 상품 조회 (+다중 쿠폰) ─────────────────────────────────
app.get('/api/:mallId/categories/:category_no/products', async (req,res)=>{
  const { mallId, category_no } = req.params;
  try {
    const coupon_q = req.query.coupon_no||'';
    const coupon_nos = coupon_q?coupon_q.split(','):[];

    // 쿠폰 상세 조회
    const coupons = await Promise.all(coupon_nos.map(async no=>{
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons } = await cafeApi(mallId,'GET',url,{},{
        shop_no:1, coupon_no:no,
        fields:[
          'coupon_no','available_product','available_product_list',
          'available_category','available_category_list',
          'benefit_amount','benefit_percentage'
        ].join(',')
      });
      return coupons?.[0]||null;
    }));
    const validCoupons = coupons.filter(c=>c);

    // 매핑 조회
    const url1 = `https://${mallId}.cafe24api.com/api/v2/admin/categories/${category_no}/products`;
    const { products:mapProducts } = await cafeApi(mallId,'GET',url1,{},{
      shop_no:1, display_group:1,
      limit:parseInt(req.query.limit,10)||100,
      offset:parseInt(req.query.offset,10)||0
    });
    const sorted = (mapProducts||[]).sort((a,b)=>a.sequence_no-b.sequence_no);
    const productNos = sorted.map(p=>p.product_no);
    if(!productNos.length) return res.json([]);

    // 상세 조회
    const url2 = `https://${mallId}.cafe24api.com/api/v2/admin/products`;
    const { products:details } = await cafeApi(mallId,'GET',url2,{},{
      shop_no:1, product_no:productNos.join(','), limit:productNos.length
    });
    const detailMap = (details||[]).reduce((m,p)=>{m[p.product_no]=p;return m},{});

    // 즉시할인가 조회
    const discountMap = {};
    await Promise.all(productNos.map(async no=>{
      const url3 = `https://${mallId}.cafe24api.com/api/v2/admin/products/${no}/discountprice`;
      const { discountprice } = await cafeApi(mallId,'GET',url3,{}, { shop_no:1 });
      discountMap[no] = discountprice?.pc_discount_price!=null
        ? parseFloat(discountprice.pc_discount_price)
        : null;
    }));

    // 결과 포맷팅
    const formatKRW = n=>n!=null?Number(n).toLocaleString('ko-KR')+'원':null;
    const full = sorted.map(item=>{
      const p = detailMap[item.product_no];
      if(!p) return null;
      const infos = validCoupons.map(c=>{
        // …쿠폰 적용 로직 동일…
        const orig = parseFloat(p.price||'0');
        const pct  = parseFloat(c.benefit_percentage||0);
        const amt  = parseFloat(c.benefit_amount||0);
        let benefit_price = pct>0
          ? +(orig*(100-pct)/100).toFixed(2)
          : amt>0
            ? +(orig-amt).toFixed(2)
            : null;
        if(benefit_price==null) return null;
        return { coupon_no:c.coupon_no, benefit_percentage:pct, benefit_price };
      }).filter(x=>x).sort((a,b)=>b.benefit_percentage-a.benefit_percentage);

      const sale = discountMap[item.product_no];
      const first = infos[0]||null;
      return {
        product_no:item.product_no,
        product_name:p.product_name,
        summary_description:p.summary_description,
        list_image:p.list_image,
        price:formatKRW(parseFloat(p.price)),
        sale_price: sale!=null&&sale!==+p.price?formatKRW(sale):null,
        benefit_price:first?formatKRW(first.benefit_price):null,
        benefit_percentage:first?first.benefit_percentage:null,
        couponInfos: infos.length?infos:null
      };
    }).filter(Boolean);

    res.json(full);
  } catch(err){
    console.error('카테고리 상품 조회 실패',err);
    res.status(500).json({ error:'카테고리 내 상품 조회 실패' });
  }
});

// ─── 전체 상품 조회 ─────────────────────────────────────────────────
app.get('/api/:mallId/products', async (req,res)=>{
  const { mallId } = req.params;
  try {
    const limit  = parseInt(req.query.limit,10)||1000;
    const offset = parseInt(req.query.offset,10)||0;
    const q      = (req.query.q||'').trim();
    const url    = `https://${mallId}.cafe24api.com/api/v2/admin/products`;
    const params = { shop_no:1, limit, offset };
    if(q) params['search[product_name]'] = q;

    const { products, total_count } = await cafeApi(mallId,'GET',url,{},params);
    const slim = (products||[]).map(p=>({
      product_no:p.product_no,
      product_code:p.product_code,
      product_name:p.product_name,
      price:p.price,
      list_image:p.list_image
    }));

    res.json({ products:slim, total:total_count });
  } catch(err){
    console.error('전체 상품 조회 실패',err);
    res.status(500).json({ error:'전체 상품 조회 실패' });
  }
});

// ─── 단일 상품 상세 조회 ─────────────────────────────────────────────
app.get('/api/:mallId/products/:product_no', async (req,res)=>{
  const { mallId, product_no } = req.params;
  try {
    const coupon_q = req.query.coupon_no||'';
    const coupon_nos = coupon_q.split(',').filter(Boolean);

    // 기본 정보
    const url1 = `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}`;
    const { product:p0, products:plist } = await cafeApi(mallId,'GET',url1,{}, { shop_no:1 });
    const p = p0||plist?.[0];
    if(!p) return res.status(404).json({ error:'상품을 찾을 수 없습니다.' });

    // 즉시할인가
    const url2 = `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}/discountprice`;
    const { discountprice } = await cafeApi(mallId,'GET',url2,{}, { shop_no:1 });
    const sale_price = discountprice?.pc_discount_price!=null
      ? parseFloat(discountprice.pc_discount_price)
      : null;

    // 쿠폰별 계산
    let benefit_price = null, benefit_percentage = null;
    await Promise.all(coupon_nos.map(async no=>{
      const urlC = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons } = await cafeApi(mallId,'GET',urlC,{},{
        shop_no:1, coupon_no:no,
        fields:[
          'coupon_no','available_product','available_product_list',
          'available_category','available_category_list',
          'benefit_amount','benefit_percentage'
        ].join(',')
      });
      const c = coupons?.[0];
      if(!c) return;
      const orig = parseFloat(p.price||'0');
      const pct  = parseFloat(c.benefit_percentage||0);
      const amt  = parseFloat(c.benefit_amount||0);
      let bPrice = pct>0
        ? +(orig*(100-pct)/100).toFixed(2)
        : amt>0
          ? +(orig-amt).toFixed(2)
          : null;
      if(bPrice!=null && pct>(benefit_percentage||0)) {
        benefit_price = bPrice;
        benefit_percentage = pct;
      }
    }));

    res.json({
      product_no,
      product_code:p.product_code,
      product_name:p.product_name,
      price:p.price,
      summary_description:p.summary_description||'',
      sale_price,
      benefit_price,
      benefit_percentage,
      list_image:p.list_image
    });
  } catch(err){
    console.error('단일 상품 조회 실패',err);
    res.status(500).json({ error:'단일 상품 조회 실패' });
  }
});


initDb()
  .then(() => {
    app.listen(PORT, ()=>console.log(`▶️ Server running at ${APP_URL} (port ${PORT})`));
  })
  .catch(err=>{
    console.error('❌ 초기화 실패', err);
    process.exit(1);
  });
