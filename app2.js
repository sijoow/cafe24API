// back/app.js

require('dotenv').config();
const express         = require('express');
const bodyParser      = require('body-parser');
const path            = require('path');
const fs              = require('fs');
const cors            = require('cors');
const compression     = require('compression');
const axios           = require('axios');
const AWS             = require('aws-sdk');
const { MongoClient, ObjectId } = require('mongodb');
const multer          = require('multer');

const {
  MONGODB_URI,
  DB_NAME,
  ACCESS_TOKEN,
  REFRESH_TOKEN,
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  CAFE24_API_VERSION,
  CAFE24_MALLID,
  PORT = 5000,
  R2_ACCESS_KEY,
  R2_SECRET_KEY,
  R2_BUCKET_NAME,
  R2_ENDPOINT,
  R2_REGION = 'auto',
  // R2_PUBLIC_BASE (업로드된 뒤 퍼블릭 URL 접두어)
  R2_PUBLIC_BASE,
} = process.env;

// ─── Express 앱 생성 & 전역 미들웨어 ───────────────────────────────

const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
// ─── MongoDB 연결 ───────────────────────────────────────────────────

let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI, { useUnifiedTopology: true });
  await client.connect();
  db = client.db(DB_NAME);
  console.log('▶️ MongoDB connected');
}
initDb().catch(err => {
  console.error('❌ MongoDB 연결 실패', err);
  process.exit(1);
});

// ─── Café24 OAuth 토큰 헬퍼 ─────────────────────────────────────────

let accessToken  = ACCESS_TOKEN;
let refreshToken = REFRESH_TOKEN;

async function saveTokensToDB(newAT, newRT) {
  await db.collection('token').updateOne(
    {},
    { $set: { accessToken: newAT, refreshToken: newRT, updatedAt: new Date() } },
    { upsert: true }
  );
  console.log('▶️ 토큰 저장 완료');
}

async function getTokenFromDB() {
  const doc = await db.collection('token').findOne({});
  if (doc) {
    accessToken  = doc.accessToken;
    refreshToken = doc.refreshToken;
    console.log('▶️ 토큰 로드 완료');
  } else {
    console.log('▶️ 토큰 문서 없음 → 초기 저장');
    await saveTokensToDB(accessToken, refreshToken);
  }
}
initDb().then(getTokenFromDB).catch(console.error);

async function refreshAccessToken() {
  const url   = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/oauth/token`;
  const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
  });
  const r = await axios.post(url, params.toString(), {
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`,
    },
  });
  accessToken  = r.data.access_token;
  refreshToken = r.data.refresh_token;
  await saveTokensToDB(accessToken, refreshToken);
  console.log('▶️ 토큰 갱신 성공');
}

async function apiRequest(method, url, data = {}, params = {}) {
  try {
    const resp = await axios({ method, url, data, params, headers: {
      Authorization:         `Bearer ${accessToken}`,
      'Content-Type':        'application/json',
      'X-Cafe24-Api-Version': CAFE24_API_VERSION,
    }});
    return resp.data;
  } catch (err) {
    if (err.response?.status === 401) {
      console.log('▶️ Access Token 만료, 갱신 중...');
      await refreshAccessToken();
      return apiRequest(method, url, data, params);
    }
    console.error('❗️ API 요청 오류:', err.response?.data || err.message);
    throw err;
  }
}

// ─── Multer 설정 (임시 디스크 저장) ───────────────────────────────

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  },
});
const upload = multer({ storage });

// ─── Cloudflare R2 S3-호환 클라이언트 ─────────────────────────────

const r2 = new AWS.S3({
  endpoint:          new AWS.Endpoint(R2_ENDPOINT),
  region:            R2_REGION,
  credentials: {
    accessKeyId:     R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
  signatureVersion:  'v4',
  s3ForcePathStyle:  true,
});

// ─── 이미지 업로드 엔드포인트 (R2) ─────────────────────────────────

app.post('/api/uploads/image', upload.single('file'), async (req, res) => {
  const localPath  = req.file.path;
  const key        = req.file.filename;
  const fileStream = fs.createReadStream(localPath);

  try {
    await r2.putObject({
      Bucket:      R2_BUCKET_NAME,
      Key:         key,
      Body:        fileStream,
      ContentType: req.file.mimetype,
      ACL:         'public-read',
    }).promise();

    const publicUrl = `${R2_PUBLIC_BASE}/${key}`;
    res.json({ url: publicUrl });
  } catch (err) {
    console.error('❌ R2 업로드 실패', err.stack);
    res.status(500).json({ error: '파일 업로드 실패' });
  } finally {
    fs.unlink(localPath, () => {});
  }
});

// ─── MongoDB 이벤트 컬렉션 헬퍼 ────────────────────────────────────

const eventsCol = () => db.collection('events');

// ─── 이미지 → 이벤트 통째 삭제 엔드포인트 ────────────────────────────
// back/app.js 에서 기존 delete 핸들러를 이걸로 교체
app.delete('/api/events/:id', async (req, res) => {
  const eventId = req.params.id;
  console.log(`▶️ DELETE 요청 /api/events/${eventId}`);

  try {
    const ev = await eventsCol().findOne({ _id: new ObjectId(eventId) });
    if (!ev) return res.status(404).json({ error: '이벤트가 없습니다' });

    // 1) R2_PUBLIC_BASE 로 시작하는 URL만 골라 key 추출
    const publicBase = R2_PUBLIC_BASE.replace(/\/$/, ''); // 끝 슬래시 제거
    const keys = (ev.images || [])
      .map(img => {
        if (typeof img.src !== 'string' || !img.src.startsWith(publicBase)) {
          return null;
        }
        // 쿼리 제거
        const noQuery = img.src.split('?')[0];
        // 마지막 경로 조각 가져오기
        const pathname = new URL(noQuery).pathname; // "/abcd1234.png"
        return pathname.replace(/^\//, '');         // "abcd1234.png"
      })
      .filter(k => !!k);

    console.log('▶️ R2에서 삭제할 객체 키들:', keys);

    // 2) R2에서 삭제
    await Promise.all(
      keys.map(key =>
        r2.deleteObject({ Bucket: R2_BUCKET_NAME, Key: key }).promise()
      )
    );
    console.log('▶️ R2 객체 삭제 완료');

    // 3) MongoDB에서 문서 삭제
    const { deletedCount } = await eventsCol().deleteOne({ _id: new ObjectId(eventId) });
    if (!deletedCount) return res.status(404).json({ error: '이벤트가 없습니다' });

    res.json({ success: true });
  } catch (err) {
    console.error('❌ 이벤트 삭제 중 에러 발생:', err);
    res.status(500).json({ error: '이벤트 삭제 실패' });
  }
});

// ─── 기본 Ping ───────────────────────────────────────────────────────

app.get('/api/ping', (_, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ─── Café24 상품/카테고리/쿠폰 API ──────────────────────────────────

app.get('/api/products', async (req, res) => {
  try {
    const limit  = parseInt(req.query.limit ,10) || 50;
    const offset = parseInt(req.query.offset,10) || 0;
    const apiUrl = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products`;
    const result = await apiRequest('GET', apiUrl, {}, { limit, offset });
    res.json(result.products || result);
  } catch (err) {
    res.status(err.response?.status || 500).json({ message: '상품 조회 실패', error: err.message });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const limit  = parseInt(req.query.limit ,10) || 100;
    const offset = parseInt(req.query.offset,10) || 0;
    const params = { limit, offset };
    if (req.query.parent_category_no) {
      params.parent_category_no = parseInt(req.query.parent_category_no, 10);
    }
    const apiUrl = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/categories`;
    const result = await apiRequest('GET', apiUrl, {}, params);
    res.json(result.categories || result);
  } catch (err) {
    res.status(err.response?.status || 500).json({ message: '카테고리 조회 실패', error: err.message });
  }
});

app.get('/api/categories/all', async (req, res) => {
  try {
    const parentNo = req.query.parent_category_no
      ? parseInt(req.query.parent_category_no,10)
      : undefined;
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const p = { limit, offset };
      if (parentNo != null) p.parent_category_no = parentNo;
      const apiUrl = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/categories`;
      const { categories } = await apiRequest('GET', apiUrl, {}, p);
      if (!categories.length) break;
      all.push(...categories);
      offset += categories.length;
      if (categories.length < limit) break;
    }
    res.json(all);
  } catch (err) {
    res.status(500).json({ message: '전체 카테고리 수집 실패', error: err.message });
  }
});

app.get('/api/coupons', async (req, res) => {
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const params = { shop_no: 1, limit, offset };
      const apiUrl = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons } = await apiRequest('GET', apiUrl, {}, params);
      if (!coupons.length) break;
      all.push(...coupons);
      offset += coupons.length;
      if (coupons.length < limit) break;
    }
    const view = req.query.view;
    const now  = new Date();
    let filtered = all;
    if (view === 'active') {
      filtered = all.filter(c => {
        const b = new Date(c.available_begin_datetime);
        const e = new Date(c.available_end_datetime);
        return b <= now && now <= e;
      });
    } else if (view === 'upcoming') {
      filtered = all.filter(c => new Date(c.available_begin_datetime) > now);
    }
    const slim = filtered.map(c => ({
      coupon_no:          c.coupon_no,
      coupon_name:        c.coupon_name,
      benefit_text:       c.benefit_text,
      benefit_percentage: c.benefit_percentage,
      issued_count:       c.issued_count,
      issue_type:         c.issue_type,
      available_begin:    c.available_begin_datetime,
      available_end:      c.available_end_datetime,
    }));
    res.json(slim);
  } catch (err) {
    res.status(500).json({ message: '쿠폰 조회 실패', error: err.message });
  }
});

app.get('/api/coupons/all', async (req, res) => {
  try {
    const shopNo = req.query.shop_no ? parseInt(req.query.shop_no,10) : 1;
    const all    = [];
    let offset = 0, limit = 100;
    while (true) {
      const params = { shop_no: shopNo, limit, offset };
      const apiUrl = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons } = await apiRequest('GET', apiUrl, {}, params);
      if (!coupons.length) break;
      all.push(...coupons);
      offset += coupons.length;
      if (coupons.length < limit) break;
    }
    res.json(all);
  } catch (err) {
    res.status(500).json({ message: '전체 쿠폰 수집 실패', error: err.message });
  }
});

// ─── 이벤트 CRUD (MongoDB) ───────────────────────────────────────────

// 1) 목록 조회
app.get('/api/events', async (req, res) => {
  try {
    const list = await eventsCol().find().sort({ createdAt: -1 }).toArray();
    res.json(list);
  } catch {
    res.status(500).json({ error: '이벤트 목록 조회 실패' });
  }
});

// 2) 단건 조회
app.get('/api/events/:id', async (req, res) => {
  try {
    const ev = await eventsCol().findOne({ _id: new ObjectId(req.params.id) });
    if (!ev) return res.status(404).json({ error: '이벤트가 없습니다' });
    res.json(ev);
  } catch {
    res.status(500).json({ error: '이벤트 조회 실패' });
  }
});

// 3) 생성
app.post('/api/events', async (req, res) => {
  try {
    const now = new Date();
    const doc = {
      ...req.body,
      createdAt: now,
      updatedAt: now,
      images: (req.body.images||[]).map(img => ({
        _id: new ObjectId(),
        ...img,
        regions: (img.regions||[]).map(r => ({ _id: new ObjectId(), ...r }))
      })),
    };
    const result = await eventsCol().insertOne(doc);
    res.json({ _id: result.insertedId, ...doc });
  } catch {
    res.status(400).json({ error: '이벤트 생성 실패' });
  }
});

// 4) 수정
app.put('/api/events/:id', async (req, res) => {
  try {
    const now = new Date();
    const { value } = await eventsCol().findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: { ...req.body, updatedAt: now } },
      { returnDocument: 'after' }
    );
    if (!value) return res.status(404).json({ error: '이벤트가 없습니다' });
    res.json(value);
  } catch {
    res.status(400).json({ error: '이벤트 수정 실패' });
  }
});

// ─── SPA 서빙 ─────────────────────────────────────────────────────────

const frontBuildPath = path.join(__dirname, '../front/build');
if (fs.existsSync(path.join(frontBuildPath, 'index.html'))) {
  app.use(express.static(frontBuildPath));
  app.get(/^(?!\/api).*/, (_, res) => {
    res.sendFile(path.join(frontBuildPath, 'index.html'));
  });
}

// ─── 서버 시작 ───────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`▶️ Server running on port ${PORT}`);
});
