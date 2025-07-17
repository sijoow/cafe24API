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
dayjs.extend(utc);
dayjs.extend(tz);

const { MongoClient, ObjectId } = require('mongodb');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const {
  MONGODB_URI,
  DB_NAME,
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
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

// ─────────────────────────────────────────────────────────────
// 1) 미들웨어 설정
app.use(cors({
  origin: '*',
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','X-Mall-Id','X-User-Id']
}));
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
// 2) MongoDB 연결
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('▶️ MongoDB connected to', DB_NAME);
}
initDb().catch(err => {
  console.error('❌ MongoDB connection failed', err);
  process.exit(1);
});

// ─────────────────────────────────────────────────────────────
// 3) OAuth 설치 시작: 권한 요청
app.get('/install/:mallId', (req, res) => {
  const { mallId } = req.params;
  const redirectUri = `${APP_URL}/auth/callback`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CAFE24_CLIENT_ID,
    redirect_uri:  redirectUri,
    scope: [
      'mall.read_promotion','mall.write_promotion',
      'mall.read_category','mall.write_category',
      'mall.read_product','mall.write_product',
      'mall.read_collection',
      'mall.read_application','mall.write_application',
      'mall.read_analytics','mall.read_salesreport','mall.read_store'
    ].join(','),
    state: mallId,
  });
  res.redirect(`https://${mallId}.cafe24.com/api/v2/oauth/authorize?${params}`);
});

// ─────────────────────────────────────────────────────────────
// 4) OAuth 콜백: code→token 교환 → DB 저장 → 프론트 리다이렉트
app.get('/auth/callback', async (req, res) => {
  const { code, state: mallId, user_id: userId, user_name: userName } = req.query;
  if (!code || !mallId) {
    return res.status(400).send('❌ code 또는 mallId(state)가 없습니다.');
  }
  try {
    // 토큰 발행
    const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
    const creds    = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const body     = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${APP_URL}/auth/callback`
    }).toString();

    const { data } = await axios.post(tokenUrl, body, {
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`
      }
    });

    // DB에 upsert
    await db.collection('token').updateOne(
      { mallId, userId },
      { $set: {
          mallId, userId, userName,
          accessToken:  data.access_token,
          refreshToken: data.refresh_token,
          obtainedAt:   new Date(),
          expiresIn:    data.expires_in
        }
      },
      { upsert: true }
    );

    // 프론트로 리다이렉트 (mallId, user_id, user_name 포함)
    const redirectTo = new URL(`${FRONTEND_URL}/auth/callback`);
    redirectTo.searchParams.set('mallId',    mallId);
    redirectTo.searchParams.set('user_id',   userId);
    redirectTo.searchParams.set('user_name', userName);
    return res.redirect(redirectTo.toString());
  } catch (err) {
    console.error('❌ [ERROR] token exchange failed:', err.response?.data || err);
    return res.status(500).send('토큰 교환 중 오류가 발생했습니다.');
  }
});

// ─────────────────────────────────────────────────────────────
// 5) “앱 정보” 반환 라우트: /api/mall
//    → 헤더(X-Mall-Id) 또는 Origin/Referer 기반으로 mallId 감지
app.get('/api/mall', async (req, res) => {
  let mallId = req.get('X-Mall-Id');
  if (!mallId) {
    try {
      const origin = req.get('Origin') || req.get('Referer') || '';
      mallId = new URL(origin).hostname.split('.')[0];
    } catch {
      return res.status(400).json({ error: 'mallId를 찾을 수 없습니다' });
    }
  }

  // token 컬렉션에서 mallId 조회
  const doc = await db.collection('token').findOne({ mallId });
  if (!doc) {
    return res.status(404).json({ error: '해당 mall에 앱 설치 정보가 없습니다' });
  }

  return res.json({
    mallId:   doc.mallId,
    userId:   doc.userId   || null,
    userName: doc.userName || null
  });
});

// ─────────────────────────────────────────────────────────────
// 6) 공통 /api 미들웨어: mallId/userId 세팅 + 액세스 로그
app.use('/api', async (req, res, next) => {
  // mallId 결정
  let mallId = req.get('X-Mall-Id');
  if (!mallId) {
    try {
      const origin = req.get('Origin') || req.get('Referer') || '';
      mallId = new URL(origin).hostname.split('.')[0];
    } catch {
      return res.status(400).json({ error: 'Cannot detect mallId' });
    }
  }
  req.mallId = mallId;
  req.userId = req.get('X-User-Id') || null;

  // 액세스 로그
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

// ─────────────────────────────────────────────────────────────
// 7) Cloudflare R2 업로드 설정 (multer + @aws-sdk/client-s3)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req,file,cb) => cb(null, uploadDir),
  filename:    (req,file,cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload   = multer({ storage });
const s3Client = new S3Client({
  region:     R2_REGION,
  endpoint:   R2_ENDPOINT,
  credentials:{ accessKeyId:R2_ACCESS_KEY, secretAccessKey:R2_SECRET_KEY },
  forcePathStyle:true
});

// ─────────────────────────────────────────────────────────────
// 8) API: 이미지 업로드
app.post('/api/uploads/image', upload.single('file'), async (req, res) => {
  const { mallId } = req;
  const localPath = req.file.path;
  const key       = req.file.filename;
  const stream    = fs.createReadStream(localPath);

  try {
    await s3Client.send(new PutObjectCommand({
      Bucket:      R2_BUCKET_NAME,
      Key:         key,
      Body:        stream,
      ContentType: req.file.mimetype,
      ACL:         'public-read'
    }));
    res.json({ url:`${R2_PUBLIC_BASE}/${key}` });
  } catch (err) {
    console.error('파일 업로드 실패', err);
    res.status(500).json({ error:'파일 업로드 실패' });
  } finally {
    fs.unlink(localPath, ()=>{});
  }
});

// ─────────────────────────────────────────────────────────────
// 9) API: 방문 트래킹
app.post('/api/track', async (req, res) => {
  const { mallId } = req;
  const { pageId, visitorId, type, timestamp, pageUrl, referrer, device, element } = req.body;

  if (!pageId || !visitorId || !type || !timestamp) {
    return res.status(400).json({ error:'필수 필드 누락' });
  }
  if (!ObjectId.isValid(pageId)) return res.sendStatus(204);

  // visits_{mallId} 컬렉션에 upsert
  const visitsCol = db.collection(`visits_${mallId}`);
  const kst       = dayjs(timestamp).tz('Asia/Seoul').toDate();
  const dateKey   = dayjs(timestamp).tz('Asia/Seoul').format('YYYY-MM-DD');
  const pathName  = (() => {
    try { return new URL(pageUrl).pathname } catch { return pageUrl }
  })();

  const filter = { pageId, visitorId, dateKey };
  const update = {
    $set: {
      lastVisit: kst,
      pageUrl:   pathName,
      referrer:  referrer||null,
      device:    device||null
    },
    $setOnInsert:{ firstVisit:kst },
    $inc: {}
  };
  if (type==='view')    update.$inc.viewCount = 1;
  if (type==='revisit') update.$inc.revisitCount = 1;
  if (type==='click') {
    update.$inc.clickCount = 1;
    if (element==='product') update.$inc.urlClickCount = 1;
    if (element==='coupon')  update.$inc.couponClickCount = 1;
  }

  await visitsCol.updateOne(filter, update, { upsert:true });
  res.sendStatus(204);
});


// ─── 10) API: visitors-by-date ───────────────────────────────────
app.get('/api/analytics/:pageId/visitors-by-date', async (req, res) => {
  const { mallId } = req;
  await initIndexesFor(mallId);
  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) {
    return res.status(400).json({ error:'start_date,end_date 필수' });
  }

  const match = {
    pageId,
    dateKey:{ $gte:start_date.slice(0,10), $lte:end_date.slice(0,10) }
  };
  if (url) match.pageUrl = url;

  const pipeline = [
    { $match: match },
    { $group:{
        _id:{ date:'$dateKey', visitorId:'$visitorId' },
        viewCount:   { $sum: { $ifNull:['$viewCount',0]    }},
        revisitCount:{ $sum: { $ifNull:['$revisitCount',0] }}
    }},
    { $group:{
        _id:'$_id.date',
        totalVisitors:    { $sum:1 },
        newVisitors:      { $sum:{ $cond:[{$gt:['$viewCount',0]},1,0] }},
        returningVisitors:{ $sum:{ $cond:[{$gt:['$revisitCount',0]},1,0] }}
    }},
    { $project:{
        _id:0,
        date:'$_id',
        totalVisitors:1,newVisitors:1,returningVisitors:1,
        revisitRate:{
          $concat:[
            { $toString:{ $round:[{ $multiply:[
              { $cond:[{$gt:['$totalVisitors',0]},
                        { $divide:['$returningVisitors','$totalVisitors']},
                        0
                      ]},
              100
            ]},0] }},
            ' %'
          ]
        }
    }},
    { $sort:{ date:1 }}
  ];
  const stats = await visitsCol(mallId).aggregate(pipeline).toArray();
  res.json(stats);
});

// ─── 11) API: 클릭 통계 (날짜별 상품/쿠폰 클릭 합계) ─────────────────────
app.get('/api/analytics/:pageId/clicks-by-date', async (req, res) => {
  const { mallId } = req;
  await initIndexesFor(mallId);

  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start/end 필수' });
  }

  const match = {
    pageId,
    dateKey: { $gte: start_date.slice(0,10), $lte: end_date.slice(0,10) }
  };
  if (url) match.pageUrl = url;

  const pipeline = [
    { $match: match },
    { $group: {
        _id: '$dateKey',
        product: { $sum: { $ifNull:['$urlClickCount',0] }},
        coupon:  { $sum: { $ifNull:['$couponClickCount',0] }}
    }},
    { $project: { _id:0, date:'$_id', product:1, coupon:1 }},
    { $sort: { date:1 }}
  ];

  const data = await visitsCol(mallId).aggregate(pipeline).toArray();
  res.json(data);
});

// ─── 12) API: 상품(URL) 클릭 수 조회 ─────────────────────────────────
app.get('/api/analytics/:pageId/url-clicks', async (req, res) => {
  const { mallId } = req;
  await initIndexesFor(mallId);

  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start/end 필수' });
  }

  const filter = {
    pageId,
    type:    'click',
    element: 'product',
    timestamp: {
      $gte: new Date(start_date),
      $lte: new Date(end_date)
    }
  };
  if (url) filter.pageUrl = url;

  const count = await visitsCol(mallId).countDocuments(filter);
  res.json({ count });
});

// ─── 13) API: 쿠폰 클릭 수 조회 ───────────────────────────────────────
app.get('/api/analytics/:pageId/coupon-clicks', async (req, res) => {
  const { mallId } = req;
  await initIndexesFor(mallId);

  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start/end 필수' });
  }

  const filter = {
    pageId,
    type:    'click',
    element: 'coupon',
    timestamp: {
      $gte: new Date(start_date),
      $lte: new Date(end_date)
    }
  };
  if (url) filter.pageUrl = url;

  const count = await visitsCol(mallId).countDocuments(filter);
  res.json({ count });
});

// ─── 14) API: 페이지별 URL 목록 조회 ─────────────────────────────────
app.get('/api/analytics/:pageId/urls', async (req, res) => {
  const { mallId } = req;
  await initIndexesFor(mallId);

  const { pageId } = req.params;
  const urls = await visitsCol(mallId).distinct('pageUrl', { pageId });
  res.json(urls);
});

// ─── 15) API: 디바이스별 방문 합계 조회 ───────────────────────────────
app.get('/api/analytics/:pageId/devices', async (req, res) => {
  const { mallId } = req;
  await initIndexesFor(mallId);

  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start/end 필수' });
  }

  const match = {
    pageId,
    dateKey: { $gte: start_date.slice(0,10), $lte: end_date.slice(0,10) }
  };
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
    { $project: { _id:0, device_type:'$_id', count:1 }}
  ];

  const data = await visitsCol(mallId).aggregate(pipeline).toArray();
  res.json(data);
});

// ─── 16) API: 디바이스·날짜별 방문 수 조회 ────────────────────────────
app.get('/api/analytics/:pageId/devices-by-date', async (req, res) => {
  const { mallId } = req;
  await initIndexesFor(mallId);

  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start/end 필수' });
  }

  const match = {
    pageId,
    dateKey: { $gte: start_date.slice(0,10), $lte: end_date.slice(0,10) }
  };
  if (url) match.pageUrl = url;

  const pipeline = [
    // 날짜×디바이스×방문자별 유니크
    { $match: match },
    { $group:{ _id:{ date:'$dateKey', device:'$device', visitor:'$visitorId' } }},
    // 날짜×디바이스별 카운트
    { $group:{
        _id:{ date:'$_id.date', device:'$_id.device' },
        count:{ $sum:1 }
    }},
    { $project:{ _id:0, date:'$_id.date', device:'$_id.device', count:1 }},
    { $sort:{ date:1, device:1 }}
  ];

  const data = await visitsCol(mallId).aggregate(pipeline).toArray();
  res.json(data);
});

// ─── 17) API: 카페24 쿠폰 목록 조회 ─────────────────────────────────
app.get('/api/:mallId/coupons', async (req, res) => {
  const { mallId, userId } = req;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons } = await apiRequest(
        mallId,
        'GET',
        url,
        {},
        { shop_no:1, limit, offset }
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
      available_end:      c.available_end_datetime
    })));
  } catch (err) {
    console.error('쿠폰 조회 실패', err);
    res.status(500).json({ error:'쿠폰 조회 실패' });
  }
});

// ─── 18) API: 이벤트 목록 조회 ───────────────────────────────────────
app.get('/api/events', async (req, res) => {
  const { mallId } = req;
  try {
    const list = await db.collection(`events_${mallId}`).find().sort({ createdAt:-1 }).toArray();
    res.json(list);
  } catch (err) {
    console.error('이벤트 목록 조회 실패', err);
    res.status(500).json({ error:'이벤트 목록 조회 실패' });
  }
});

// ─── 19) API: 이벤트 생성 ───────────────────────────────────────────
app.post('/api/events', async (req, res) => {
  const { mallId } = req;
  try {
    const now = dayjs().tz('Asia/Seoul').toDate();
    const doc = {
      ...req.body,
      createdAt: now,
      updatedAt: now,
      images: (req.body.images || []).map(img => ({
        _id:      new ObjectId(),
        ...img,
        regions: (img.regions || []).map(r => ({ _id: new ObjectId(), ...r }))
      }))
    };
    const { insertedId } = await db.collection(`events_${mallId}`).insertOne(doc);
    res.json({ _id: insertedId, ...doc });
  } catch (err) {
    console.error('이벤트 생성 실패', err);
    res.status(400).json({ error:'이벤트 생성 실패' });
  }
});

// ─── 20) API: 이벤트 수정 ───────────────────────────────────────────
app.put('/api/events/:id', async (req, res) => {
  const { mallId } = req;
  const { id }     = req.params;
  try {
    const now = dayjs().tz('Asia/Seoul').toDate();
    const result = await db.collection(`events_${mallId}`).updateOne(
      { _id: new ObjectId(id) },
      { $set:{ ...req.body, updatedAt: now }}
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error:'이벤트가 없습니다' });
    }
    const updated = await db.collection(`events_${mallId}`).findOne({ _id:new ObjectId(id) });
    res.json({ success:true, data: updated });
  } catch (err) {
    console.error('이벤트 수정 실패', err);
    res.status(500).json({ error:'이벤트 수정 실패' });
  }
});

// ─── 21) API: 이벤트 삭제 ───────────────────────────────────────────
app.delete('/api/events/:id', async (req, res) => {
  const { mallId } = req;
  const { id }     = req.params;
  try {
    const ev = await db.collection(`events_${mallId}`).findOne({ _id:new ObjectId(id) });
    if (!ev) {
      return res.status(404).json({ error:'이벤트가 없습니다' });
    }
    // 이미지 키만 뽑아서 R2에서 삭제
    const keys = (ev.images || []).map(img =>
      new URL(img.src).pathname.replace(/^\//,'')
    );
    await Promise.all(keys.map(k =>
      s3Client.send(new DeleteObjectCommand({ Bucket:R2_BUCKET_NAME, Key:k }))
    ));

    // DB에서 문서 삭제 & 관련 방문기록도 삭제
    await db.collection(`events_${mallId}`).deleteOne({ _id:new ObjectId(id) });
    await visitsCol(mallId).deleteMany({ pageId: id });
    res.json({ success:true });
  } catch (err) {
    console.error('이벤트 삭제 실패', err);
    res.status(500).json({ error:'이벤트 삭제 실패' });
  }
});

// ─── 서버 시작 ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`▶️ Server running at ${APP_URL} (port ${PORT})`);
});
