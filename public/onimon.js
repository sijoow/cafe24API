// app.js (완전본)
require('dotenv').config();
process.env.TZ = 'Asia/Seoul';
const cron = require('node-cron');
const express = require('express');
//데이터수정

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

// ===== ENV =====
const {
  MONGODB_URI,
  DB_NAME,
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  CAFE24_API_VERSION,
  FRONTEND_URL,
  BACKEND_URL,
  CAFE24_SCOPES,
  UNINSTALL_TOKEN,
  PORT = 5000,
  R2_ACCESS_KEY,
  R2_SECRET_KEY,
  R2_BUCKET_NAME,
  R2_ENDPOINT,
  R2_REGION = 'us-east-1',
  R2_PUBLIC_BASE,
} = process.env;

// ENV 체크 (필수값이 없으면 프로세스 종료)
function ensureEnv(key) {
  if (!process.env[key]) {
    console.error(`❌ Missing ENV: ${key}`);
    process.exit(1);
  }
}
['MONGODB_URI','DB_NAME','CAFE24_CLIENT_ID','CAFE24_CLIENT_SECRET','FRONTEND_URL','BACKEND_URL','CAFE24_SCOPES','CAFE24_API_VERSION'].forEach(ensureEnv);

const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 요청 로거
app.use((req, _res, next) => {
  console.log(new Date().toISOString(), req.method, req.originalUrl, Object.keys(req.query || {}).length ? req.query : '');
  next();
});

// ===== MongoDB 연결 =====
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  await client.connect();
  db = client.db(DB_NAME);
  await db.collection('token').createIndex({ mallId: 1 }, { unique: true });
  console.log('▶️ MongoDB connected to', DB_NAME);
}

// ===== Multer (파일 업로드 임시저장) =====
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// ===== R2 (S3 호환) 클라이언트 =====
const s3Client = new S3Client({
  region: R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
  forcePathStyle: true,
});

// ===== OAuth URL 빌더 =====
function buildAuthorizeUrl(mallId) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CAFE24_CLIENT_ID,
    redirect_uri:  `${BACKEND_URL}/auth/callback`,
    scope:         CAFE24_SCOPES,
    state:         mallId,
  });
  return `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params.toString()}`;
}

// ===== 토큰 리프레시 (최종 수정본) =====
async function refreshAccessToken(mallId, refreshToken) {
  const url = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
  const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  }).toString();

  const { data } = await axios.post(url, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`
    }
  });

  const newExpiresAt = new Date(data.expires_at);
  const newExpiresIn = Math.round((newExpiresAt.getTime() - Date.now()) / 1000);

  await db.collection('token').updateOne(
    { mallId },
    { $set: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        obtainedAt: new Date(),
        expiresIn: newExpiresIn,
        expiresAt: newExpiresAt,
        raw_refresh_response: data
      }
    }
  );

  console.log(`[TOKEN REFRESH] mallId=${mallId}`);
  console.log(`✅ [DB UPDATED] mallId=${mallId}, new expiry: ${newExpiresAt.toISOString()}`);

  return data.access_token;
}

// ===== 에러/재설치 헬퍼 =====
function installRequired(mallId) {
  const err = new Error('INSTALL_REQUIRED');
  err.installRequired = true;
  err.payload = { installed: false, mallId, installUrl: buildAuthorizeUrl(mallId) };
  return err;
}

function replyInstallGuard(res, err, fallbackMsg, statusWhenUnknown = 500) {
  if (err?.installRequired) {
    return res.status(409).json(err.payload);
  }
  const code = err.response?.status || statusWhenUnknown;
  return res.status(code).json({
    message: fallbackMsg,
    error: err.message,
    provider: err.response?.data || null
  });
}

// ===== Cafe24 API 요청 헬퍼 (토큰 자동 리프레시, 실패 시 token 정리) =====
async function apiRequest(mallId, method, url, data = {}, params = {}) {
  const doc = await db.collection('token').findOne({ mallId });
  if (!doc) throw installRequired(mallId);

  try {
    const resp = await axios({
      method, url, data, params,
      headers: {
        Authorization: `Bearer ${doc.accessToken}`,
        'Content-Type': 'application/json',
        'X-Cafe24-Api-Version': CAFE24_API_VERSION
      }
    });
    return resp.data;
  } catch (err) {
    const status = err.response?.status;

    if (status === 401 && doc.refreshToken) {
      try {
        const newAccess = await refreshAccessToken(mallId, doc.refreshToken);
        const retry = await axios({
          method, url, data, params,
          headers: {
            Authorization: `Bearer ${newAccess}`,
            'Content-Type': 'application/json',
            'X-Cafe24-Api-Version': CAFE24_API_VERSION
          }
        });
        return retry.data;
      } catch (_e) {
        await db.collection('token').deleteOne({ mallId });
        throw installRequired(mallId);
      }
    }

    if (status === 401 || status === 403) {
      await db.collection('token').deleteOne({ mallId });
      throw installRequired(mallId);
    }

    throw err;
  }
}

// ================================================================
// 1) 설치 시작 (프론트/외부에서 호출 가능)
// ================================================================
app.get('/install/:mallId', (req, res) => {
  const { mallId } = req.params;
  const url = buildAuthorizeUrl(mallId);
  console.log('[INSTALL REDIRECT]', url);
  res.redirect(url);
});

// ================================================================
// 2) OAuth 콜백 (code -> token 저장) 및 프론트 리다이렉트
// ================================================================
app.get('/auth/callback', async (req, res) => {
    const { code, state: mallId, error, error_description } = req.query; 
    if (error) {
      console.error('[AUTH CALLBACK ERROR FROM PROVIDER]', error, error_description);
      return res.redirect(`${FRONTEND_URL}/?auth_error=${encodeURIComponent(error)}&mall_id=${encodeURIComponent(mallId || '')}`);
    }
    if (!code || !mallId) {
     return res.status(400).send('code 또는 mallId가 없습니다.');
    }   
    try {
      const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
      const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${BACKEND_URL}/auth/callback`
      }).toString(); 
      const { data } = await axios.post(tokenUrl, body, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${creds}`
        }
      });   
      const expiresIn = data.expires_in;
      const expiresAt = new Date(Date.now() + expiresIn * 1000); 
      await db.collection('token').updateOne(
        { mallId },
        { $set: {
            mallId,
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            obtainedAt: new Date(),
            expiresIn: expiresIn,
            expiresAt: expiresAt,
            raw: data
          }
        },
        { upsert: true }
      );
      console.log(`[AUTH CALLBACK] installed mallId=${mallId}`);
      return res.redirect(`${FRONTEND_URL}/?mall_id=${encodeURIComponent(mallId)}`);
    } catch (err) {
      console.error('[AUTH CALLBACK ERROR]', err.response?.data || err.message || err);
      return res.status(500).send('토큰 교환 중 오류가 발생했습니다.');
    }
});

// ================================================================
// 3) 앱 삭제(언인스톨) 웹훅 엔드포인트
// ================================================================
app.post('/cafe24/uninstalled', async (req, res) => {
  try {
    if (UNINSTALL_TOKEN && req.query.token !== UNINSTALL_TOKEN) {
      return res.status(401).json({ ok: false, error: 'invalid token' });
    }
    const mallId = req.body?.mall_id || req.body?.mallId || req.query.mall_id || req.query.mallId;
    if (!mallId) return res.status(400).json({ ok: false, error: 'mall_id required' });

    const result = await db.collection('token').deleteOne({ mallId });
    console.log(`[UNINSTALL] token deletedCount=${result.deletedCount} for mallId=${mallId}`);

    try { await db.collection(`visits_${mallId}`).drop(); } catch (e) { /* ignore */ }
    try { await db.collection(`clicks_${mallId}`).drop(); } catch (e) { /* ignore */ }
    try { await db.collection(`prdClick_${mallId}`).drop(); } catch (e) { /* ignore */ }
    try { await db.collection('events').deleteMany({ mallId }); } catch (e) { /* ignore */ }

    console.log(`[UNINSTALL CLEANUP] mallId=${mallId} done`);
    return res.json({ ok: true, deletedCount: result.deletedCount });
  } catch (e) {
    console.error('[UNINSTALL ERROR]', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ================================================================
// 4) 공용/디버그 API
// ================================================================
app.get('/api/:mallId/ping', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/:mallId/mall', async (req, res) => {
  const { mallId } = req.params;
  try {
    const doc = await db.collection('token').findOne({ mallId });
    if (doc?.accessToken) {
      return res.json({
        installed: true,
        mallId,
        userId: doc.userId || null,
        userName: doc.userName || null
      });
    }
    const installUrl = buildAuthorizeUrl(mallId);
    console.log(`[INSTALL NEEDED] mallId=${mallId} -> ${installUrl}`);
    return res.json({ installed: false, mallId, installUrl });
  } catch (err) {
    console.error('[MALL INFO ERROR]', err);
    return res.status(500).json({ error: 'mall info fetch failed' });
  }
});

// ================================================================
// 5) 기능 엔드포인트들
// ================================================================

// 이미지 업로드 (Multer -> R2/S3)
app.post('/api/:mallId/uploads/image', upload.single('file'), async (req, res) => {
  try {
    const { mallId } = req.params;
    const { filename, path: localPath, mimetype } = req.file;
    const key = `uploads/${mallId}/${filename}`;

    await s3Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: fs.createReadStream(localPath),
      ContentType: mimetype,
      ACL: 'public-read'
    }));

    fs.unlink(localPath, () => {});
    const url = `${R2_PUBLIC_BASE}/${key}`;
    res.json({ url });
  } catch (err) {
    console.error('[IMAGE UPLOAD ERROR]', err);
    res.status(500).json({ error: '이미지 업로드 실패' });
  }
});

// Events - 생성
app.post('/api/:mallId/events', async (req, res) => {
  const { mallId } = req.params;
  const payload = req.body;

  if (!payload.title || typeof payload.title !== 'string') {
    return res.status(400).json({ error: '제목(title)을 입력해주세요.' });
  }
  
  try {
    const now = new Date();
    const doc = {
      mallId,
      title: payload.title.trim(),
      content: payload.content || {},
      images: payload.images || [],
      createdAt: now,
      updatedAt: now
    };

    const result = await db.collection('events').insertOne(doc);
    res.json({ _id: result.insertedId, ...doc });
  } catch (err) {
    console.error('[CREATE EVENT ERROR]', err);
    res.status(500).json({ error: '이벤트 생성에 실패했습니다.' });
  }
});

// Events - 목록
app.get('/api/:mallId/events', async (req, res) => {
  const { mallId } = req.params;
  try {
    const list = await db.collection('events').find({ mallId }).sort({ createdAt: -1 }).toArray();
    res.json(list);
  } catch (err) {
    console.error('[GET EVENTS ERROR]', err);
    res.status(500).json({ error: '이벤트 목록 조회에 실패했습니다.' });
  }
});

// Events - 단건
app.get('/api/:mallId/events/:id', async (req, res) => {
  const { mallId, id } = req.params;
  if (!ObjectId.isValid(id)) return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
  try {
    const ev = await db.collection('events').findOne({ _id: new ObjectId(id), mallId });
    if (!ev) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    res.json(ev);
  } catch (err) {
    console.error('[GET EVENT ERROR]', err);
    res.status(500).json({ error: '이벤트 조회에 실패했습니다.' });
  }
});

// Events - 수정
app.put('/api/:mallId/events/:id', async (req, res) => {
  const { mallId, id } = req.params;
  const payload = req.body;
  if (!ObjectId.isValid(id)) return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
  
  const update = { updatedAt: new Date() };
  if (payload.title) update.title = payload.title.trim();
  if (payload.content) update.content = payload.content;
  if (Array.isArray(payload.images)) update.images = payload.images;

  try {
    const result = await db.collection('events').updateOne({ _id: new ObjectId(id), mallId }, { $set: update });
    if (result.matchedCount === 0) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    const updated = await db.collection('events').findOne({ _id: new ObjectId(id) });
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[UPDATE EVENT ERROR]', err);
    res.status(500).json({ error: '이벤트 수정에 실패했습니다.' });
  }
});

// Events - 삭제
app.delete('/api/:mallId/events/:id', async (req, res) => {
  const { mallId, id } = req.params;
  if (!ObjectId.isValid(id)) return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
  try {
    const { deletedCount } = await db.collection('events').deleteOne({ _id: new ObjectId(id), mallId });
    if (!deletedCount) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE EVENT ERROR]', err);
    res.status(500).json({ error: '이벤트 삭제에 실패했습니다.' });
  }
});

// Categories - all
app.get('/api/:mallId/categories/all', async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/categories`;
      const { categories = [] } = await apiRequest(mallId, 'GET', url, {}, { limit, offset });
      if (!categories.length) break;
      all.push(...categories);
      offset += categories.length;
    }
    res.json(all);
  } catch (err) {
    console.error('[CATEGORIES ERROR]', err);
    return replyInstallGuard(res, err, '전체 카테고리 조회 실패');
  }
});

// Coupons - all
app.get('/api/:mallId/coupons', async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons = [] } = await apiRequest(mallId, 'GET', url, {}, { shop_no: 1, limit, offset });
      if (!coupons.length) break;
      all.push(...coupons);
      offset += coupons.length;
    }
    res.json(all);
  } catch (err) {
    console.error('[COUPONS ERROR]', err);
    return replyInstallGuard(res, err, '쿠폰 조회 실패');
  }
});

// Products - 전체
app.get('/api/:mallId/products', async (req, res) => {
  const { mallId } = req.params;
  try {
    const { limit = 100, offset = 0, product_name } = req.query;
    const url = `https://${mallId}.cafe24api.com/api/v2/admin/products`;
    const params = { shop_no: 1, limit, offset };
    if (product_name) params.product_name = product_name;
    
    const data = await apiRequest(mallId, 'GET', url, {}, params);
    const slim = (data.products || []).map(p => ({
      product_no: p.product_no,
      product_name: p.product_name,
      price: p.price,
      list_image: p.list_image
    }));
    res.json({ products: slim });
  } catch (err) {
    console.error('[GET PRODUCTS ERROR]', err.response?.data || err.message);
    return replyInstallGuard(res, err, '전체 상품 조회 실패');
  }
});

// Product - 단건
app.get('/api/:mallId/products/:product_no', async (req, res) => {
  const { mallId, product_no } = req.params;
  try {
    const shop_no = 1;
    const productFields = 'product_no,product_name,price,list_image,medium_image,small_image,tiny_image,decoration_icon_url';
    const prodUrl = `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}`;
    const prodData = await apiRequest(mallId, 'GET', prodUrl, {}, { shop_no, fields: productFields });
    const p = prodData.product;
    if (!p) return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });

    res.json({
      product_no: p.product_no,
      product_name: p.product_name,
      price: p.price,
      list_image: p.list_image,
      image_medium: p.medium_image,
      image_small: p.small_image,
      tiny_image: p.tiny_image,
      decoration_icon_url: p.decoration_icon_url || null,
    });
  } catch (err) {
    console.error('[GET PRODUCT ERROR]', err.response?.data || err.message);
    return replyInstallGuard(res, err, '단일 상품 조회 실패');
  }
});

// ================================================================
// 6) 서버 시작
// ================================================================
initDb()
  .then(async () => {
    console.log('▶️ Server starting... Running initial token refresh for all malls.');
    await forceRefreshAllTokens();

    cron.schedule('*/30 * * * *', runTokenRefreshScheduler);
    console.log('▶️ 30분마다 토큰 리프레시 스케줄러가 실행됩니다.');

    app.listen(PORT, () => {
      console.log(`▶️ Server running at ${BACKEND_URL} (port ${PORT})`);
    });
  })
  .catch(err => {
    console.error('❌ Initialization failed:', err);
    process.exit(1);
  });
