require('dotenv').config();
// 서버 전체 타임존을 KST로 고정
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
  CAFE24_MALLID,   // 초기화 시 사용할 기본 mall
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
app.use(bodyParser.json({  limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── 1) mall_id 추출 미들웨어 ───────────────────────────────────────
app.use('/api', (req, res, next) => {
  const m = req.query.mall_id;
  if (!m) return res.status(400).json({ error: 'mall_id 쿼리스트링이 필요합니다.' });
  req.mall_id = m;
  next();
});

// ─── 2) MongoDB 연결 및 헬퍼 ───────────────────────────────────────
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('▶️ MongoDB connected');
}
function visitsCol(mall_id)  { return db.collection(`visits_${mall_id}`); }
function eventsCol()         { return db.collection('events'); }
function tokenCol()          { return db.collection('token'); }

// ─── 3) 인덱스 초기화 (몰별 visits, 토큰) ───────────────────────────
async function initIndexes(mall_id) {
  const vcol = visitsCol(mall_id);
  try { await vcol.dropIndex('unique_per_user_day'); } catch {}
  await vcol.createIndex(
    { pageId:1, visitorId:1, dateKey:1 },
    { unique: true, name: 'unique_per_user_day' }
  );
  console.log(`▶️ visits_${mall_id} 인덱스 생성 완료`);

  // token 컬렉션엔 mall_id별 unique
  await tokenCol().createIndex({ mall_id:1 }, { unique: true });
  console.log('▶️ token 인덱스 생성 완료');
}

// ─── 4) 토큰 관리 ───────────────────────────────────────────────────
let accessToken, refreshToken;

async function saveTokensToDB(mall_id, newAT, newRT, mail) {
  const upd = { mall_id, accessToken:newAT, refreshToken:newRT, updatedAt:new Date() };
  if (mail) upd.cafeMail = mail;
  await tokenCol().updateOne(
    { mall_id },
    { $set: upd },
    { upsert: true }
  );
}
async function refreshAccessToken(mall_id) {
  const url   = `https://${mall_id}.cafe24api.com/api/v2/oauth/token`;
  const creds = Buffer
    .from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`)
    .toString('base64');

  // grant_type, refresh_token, shop_no 모두 폼 데이터에 담아야 합니다
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    shop_no:       '1'           // ← 이 줄을 꼭 추가하세요
  });

  const r = await axios.post(url, params.toString(), {
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`
    }
  });

  accessToken  = r.data.access_token;
  refreshToken = r.data.refresh_token;
  await saveTokensToDB(mall_id, accessToken, refreshToken);
}


// 모든 /api 호출 전에 mall_id별 토큰 로드
app.use('/api', async (req, res, next) => {
  await loadTokensFromDB(req.mall_id);
  next();
});

// ─── 5) 공통 API 호출 헬퍼 ───────────────────────────────────────────
async function apiRequest(method, url, data = {}, params = {}, mall_id) {
  try {
    const resp = await axios({
      method, url, data, params,
      headers: {
        Authorization:         `Bearer ${accessToken}`,
        'Content-Type':        'application/json',
        'X-Cafe24-Api-Version': CAFE24_API_VERSION
      }
    });
    return resp.data;
  } catch (err) {
    if (err.response?.status === 401) {
      await refreshAccessToken(mall_id);
      return apiRequest(method, url, data, params, mall_id);
    }
    throw err;
  }
}

// ─── 6) 매장 이메일(fetch) ────────────────────────────────────────────
async function fetchCafeMail(mall_id) {
  const url = `https://${mall_id}.cafe24api.com/api/v2/admin/shops`;
  // shop_no=1 은 필수
  const data = await apiRequest('GET', url, {}, { shop_no: 1 }, mall_id);
  const shop = (data.shops && data.shops[0]) || {};
  return shop.biz_email || shop.mng_email || null;
}

// ─── 7) 초기화 순서: DB → 인덱스(기본몰) → 토큰(기본몰) → 메일 → 서버 ───
initDb()
  .then(() => initIndexes(CAFE24_MALLID))
  .then(() => loadTokensFromDB(CAFE24_MALLID))
  .then(() => fetchCafeMail(CAFE24_MALLID))
  .then(mail => mail && saveTokensToDB(CAFE24_MALLID, accessToken, refreshToken, mail))
  .then(() => {
    app.listen(PORT, () => console.log(`▶️ Server running on port ${PORT}`));
  })
  .catch(err => { console.error('❌ 초기화 실패', err); process.exit(1); });
// ─── Multer 설정 (임시 디스크 저장) ─────────────────────────────────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// ─── Cloudflare R2 (AWS S3-호환) 클라이언트 ─────────────────────────
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const s3Client = new S3Client({
  region:   R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId:     R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
  forcePathStyle: true,
});

// ─── 이미지 업로드 엔드포인트 ────────────────────────────────────────
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
    res.status(500).json({ error: '파일 업로드 실패' });
  } finally {
    fs.unlink(localPath, ()=>{});
  }
});

// ─── 이벤트 이미지 삭제 ─────────────────────────────────────────────
app.delete('/api/events/:eventId/images/:imageId', async (req, res) => {
  const { eventId, imageId } = req.params;
  try {
    const ev = await eventsCol().findOne({ _id: new ObjectId(eventId) });
    if (!ev) return res.status(404).json({ error: '이벤트가 없습니다' });
    const img = ev.images.find(i => String(i._id) === imageId);
    if (img?.src) {
      const key = new URL(img.src).pathname.replace(/^\//,'');
      await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
    }
    await eventsCol().updateOne(
      { _id: new ObjectId(eventId) },
      { $pull: { images: { _id: new ObjectId(imageId) } } }
    );
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: '이미지 삭제 실패' });
  }
});

// ─── 이벤트 삭제 & 관련 데이터 정리 ─────────────────────────────────
app.delete('/api/events/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const ev = await eventsCol().findOne({ _id: new ObjectId(id) });
    if (!ev) return res.status(404).json({ error: '이벤트가 없습니다' });

    // R2 이미지 삭제
    const keys = (ev.images || []).map(img => {
      const p = img.src.startsWith('http') ? new URL(img.src).pathname : `/${img.src}`;
      return p.replace(/^\//,'');
    });
    await Promise.all(keys.map(key =>
      s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }))
    ));

    // 이벤트 & visits 문서 삭제
    await eventsCol().deleteOne({ _id: new ObjectId(id) });
    await visitsCol().deleteMany({ pageId: id });

    res.json({ success: true });
  } catch {
    res.status(500).json({ error: '삭제 실패' });
  }
});

// ─── 기본 Ping ───────────────────────────────────────────────────────
app.get('/api/ping', (_, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});



app.get('/api/categories/all', async (req, res) => {
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${req.mall_id}.cafe24api.com/api/v2/admin/categories`;
      const { categories } = await apiRequest('GET', url, {}, { limit, offset }, req.mall_id);
      if (!categories.length) break;
      all.push(...categories);
      offset += categories.length;
    }
    res.json(all);
  } catch (err) {
    res.status(500).json({ message: '전체 카테고리 조회 실패', error: err.message });
  }
});

app.get('/api/coupons', async (req, res) => {
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${req.mall_id}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons } = await apiRequest('GET', url, {}, { shop_no: 1, limit, offset },req.mall_id);
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
    res.status(500).json({ message: '쿠폰 조회 실패', error: err.message });
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

app.get('/api/categories/:category_no/products', async (req, res) => {
  try {
    const category_no    = req.params.category_no;
    const coupon_query   = req.query.coupon_no || '';
    const coupon_nos     = coupon_query ? coupon_query.split(',') : [];
    const limit          = parseInt(req.query.limit, 10)  || 100;
    const offset         = parseInt(req.query.offset, 10) || 0;
    const shop_no        = 1;
    const display_group  = 1;
    const mall_id        = req.mall_id;      // ← 여기

    // ─── 0) 쿠폰 정보 조회 ─────────────────────────────────────────
    const coupons = await Promise.all(coupon_nos.map(async no => {
      const urlCoupon = `https://${mall_id}.cafe24api.com/api/v2/admin/coupons`;
      const resCoupon = await apiRequest(
        'GET',
        urlCoupon,
        {},
        { shop_no, coupon_no: no,
          fields: [
            'coupon_no',
            'available_product','available_product_list',
            'available_category','available_category_list',
            'benefit_amount','benefit_percentage'
          ].join(',')
        },
        mall_id                            // ← apiRequest에 mall_id 전달
      );
      return resCoupon.coupons?.[0] || null;
    }));
    const validCoupons = coupons.filter(c => c);

    // ─── 1) 카테고리-상품 매핑 조회 ─────────────────────────────────
    const urlCats = `https://${mall_id}.cafe24api.com/api/v2/admin/categories/${category_no}/products`;
    const catRes  = await apiRequest(
      'GET',
      urlCats,
      {},
      { shop_no, display_group, limit, offset },
      mall_id
    );

    // ─── 2) sequence_no 순 정렬 ─────────────────────────────────────
    const sorted = (catRes.products || [])
      .slice()
      .sort((a, b) => a.sequence_no - b.sequence_no);

    const productNos = sorted.map(p => p.product_no);
    if (!productNos.length) return res.json([]);

    // ─── 3) 상품 상세 정보 조회 ──────────────────────────────────────
    const urlProds  = `https://${mall_id}.cafe24api.com/api/v2/admin/products`;
    const detailRes = await apiRequest(
      'GET',
      urlProds,
      {},
      { shop_no, product_no: productNos.join(','), limit: productNos.length },
      mall_id
    );
    const details = detailRes.products || [];

    // ─── 4) 할인 가격 일괄 조회 ─────────────────────────────────────
    const discountMap = {};
    await Promise.all(productNos.map(async no => {
      const urlDis = `https://${mall_id}.cafe24api.com/api/v2/admin/products/${no}/discountprice`;
      const disRes = await apiRequest(
        'GET',
        urlDis,
        {},
        { shop_no },
        mall_id
      );
      const rawPrice = disRes.discountprice?.pc_discount_price;
      discountMap[no] = rawPrice != null ? parseFloat(rawPrice) : null;
    }));

    // ─── 5) 상세 객체 맵핑 ─────────────────────────────────────────
    const detailMap = details.reduce((m, p) => {
      m[p.product_no] = p;
      return m;
    }, {});

    // ─── format helper ───────────────────────────────────────────────
    const formatKRW = num =>
      num != null ? Number(num).toLocaleString('ko-KR') + '원' : null;

    // ─── 6) 쿠폰 적용 여부 + 할인가 계산 ─────────────────────────────
    function calcCouponInfos(prodNo) {
      return validCoupons
        .map(coupon => {
          const pMode = coupon.available_product;
          const pList = coupon.available_product_list || [];
          const prodOk =
            pMode === 'U' ||
            (pMode === 'I' && pList.includes(prodNo)) ||
            (pMode === 'E' && !pList.includes(prodNo));

          const cMode = coupon.available_category;
          const cList = coupon.available_category_list || [];
          const catOk =
            cMode === 'U' ||
            (cMode === 'I' && cList.includes(parseInt(category_no, 10))) ||
            (cMode === 'E' && !cList.includes(parseInt(category_no, 10)));

          if (!prodOk || !catOk) return null;

          const origPrice = parseFloat(detailMap[prodNo].price || '0');
          const pct       = parseFloat(coupon.benefit_percentage || '0');
          const amt       = parseFloat(coupon.benefit_amount     || '0');
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
        .filter(Boolean)
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

    // ─── 8) slim 배열(필요 필드 & 포맷팅) ───────────────────────────
    const slim = full.map(p => {
      const infos = p.couponInfos || [];
      const first = infos[0] || null;

      return {
        product_no:         p.product_no,
        product_name:       p.product_name,
        price:              formatKRW(parseFloat(p.price)),
        summary_description:p.summary_description,
        list_image:         p.list_image,
        sale_price:         (p.sale_price != null && +p.sale_price !== +p.price)
                              ? formatKRW(p.sale_price)
                              : null,
        benefit_price:      first ? formatKRW(first.benefit_price) : null,
        benefit_percentage: first ? first.benefit_percentage      : null,
        couponInfos:        infos.length ? infos : null
      };
    });

    return res.json(slim);
  }
  catch (err) {
    console.error('카테고리 내 상품 조회 실패', err);
    return res.status(err.response?.status || 500).json({
      message: '카테고리 상품 조회 실패',
      error:   err.message
    });
  }
});


// ─── 전체 상품 조회 (페이징 + 검색 지원) ─────────────────────────────────
app.get('/api/products', async (req, res) => {
  try {
    const mall_id = req.mall_id;
    const shop_no = 1;
    const limit   = parseInt(req.query.limit, 10)  || 1000;
    const offset  = parseInt(req.query.offset, 10) || 0;
    const q       = (req.query.q || '').trim();

    // API URL에 mall_id 적용
    const url     = `https://${mall_id}.cafe24api.com/api/v2/admin/products`;

    // 기본 파라미터
    const params = { shop_no, limit, offset };
    if (q) {
      params['search[product_name]'] = q;
    }

    // apiRequest에 mall_id 전달
    const data = await apiRequest('GET', url, {}, params, mall_id);

    const slim = (data.products || []).map(p => ({
      product_no:   p.product_no,
      product_code: p.product_code,
      product_name: p.product_name,
      price:        p.price,
      list_image:   p.list_image
    }));

    res.json({
      products: slim,
      total:    data.total_count
    });
  } catch (err) {
    console.error('전체 상품 조회 실패', err);
    res.status(500).json({ error: '전체 상품 조회 실패' });
  }
});

// ─── 단일 상품 상세 조회 (쿠폰할인가 포함) ─────────────────────────
app.get('/api/products/:product_no', async (req, res) => {
  try {
    const mall_id    = req.mall_id;
    const shop_no    = 1;
    const product_no = req.params.product_no;
    const coupon_query = req.query.coupon_no || '';
    const coupon_nos   = coupon_query.split(',').filter(Boolean);

    // 1) 기본 상품 정보
    const prodUrl  = `https://${mall_id}.cafe24api.com/api/v2/admin/products/${product_no}`;
    const prodData = await apiRequest('GET', prodUrl, {}, { shop_no }, mall_id);
    const p = prodData.product ?? prodData.products?.[0];
    if (!p) return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });

    // 2) 즉시할인가 조회
    const disUrl  = `https://${mall_id}.cafe24api.com/api/v2/admin/products/${product_no}/discountprice`;
    const disData = await apiRequest('GET', disUrl, {}, { shop_no }, mall_id);
    const rawSale = disData.discountprice?.pc_discount_price;
    const sale_price = rawSale != null ? parseFloat(rawSale) : null;

    // 3) 쿠폰별 benefit 계산
    const coupons = await Promise.all(coupon_nos.map(async no => {
      const urlCoupon = `https://${mall_id}.cafe24api.com/api/v2/admin/coupons`;
      const cRes = await apiRequest(
        'GET',
        urlCoupon,
        {},
        {
          shop_no,
          coupon_no: no,
          fields: [
            'coupon_no',
            'available_product','available_product_list',
            'available_category','available_category_list',
            'benefit_amount','benefit_percentage'
          ].join(',')
        },
        mall_id
      );
      return cRes.coupons?.[0] || null;
    }));
    const validCoupons = coupons.filter(Boolean);

    let benefit_price = null;
    let benefit_percentage = null;
    validCoupons.forEach(coupon => {
      const pList = coupon.available_product_list || [];
      const ok = coupon.available_product === 'U'
              || (coupon.available_product === 'I' && pList.includes(parseInt(product_no,10)))
              || (coupon.available_product === 'E' && !pList.includes(parseInt(product_no,10)));
      if (!ok) return;

      const orig = parseFloat(p.price);
      const pct  = parseFloat(coupon.benefit_percentage||0);
      const amt  = parseFloat(coupon.benefit_amount||0);
      let bPrice = null;
      if (pct > 0)      bPrice = +(orig * (100 - pct) / 100).toFixed(2);
      else if (amt > 0) bPrice = +(orig - amt).toFixed(2);

      if (bPrice != null && pct > (benefit_percentage||0)) {
        benefit_price      = bPrice;
        benefit_percentage = pct;
      }
    });

    // 4) 최종 응답
    res.json({
      product_no,
      product_code:      p.product_code,
      product_name:      p.product_name,
      price:             p.price,
      summary_description: p.summary_description || '',
      sale_price,
      benefit_price,
      benefit_percentage,
      list_image:        p.list_image
    });
  } catch (err) {
    console.error('단일 상품 조회 실패', err);
    res.status(500).json({ error: '단일 상품 조회 실패' });
  }
});

