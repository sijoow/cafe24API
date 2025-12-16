// app.js (보안 강화 전체 코드)
require('dotenv').config();
process.env.TZ = 'Asia/Seoul';
const cron = require('node-cron');
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
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

dayjs.extend(utc);
dayjs.extend(tz);

// ===== ENV 변수 로드 및 체크 =====
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

function ensureEnv(key) {
  if (!process.env[key]) {
    console.error(`❌ Missing ENV: ${key}`);
    process.exit(1);
  }
}
['MONGODB_URI','DB_NAME','CAFE24_CLIENT_ID','CAFE24_CLIENT_SECRET','FRONTEND_URL','BACKEND_URL','CAFE24_SCOPES','CAFE24_API_VERSION'].forEach(ensureEnv);

// ===== Express 설정 =====
const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 요청 로깅 미들웨어
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

// ===== Multer (파일 임시 저장) =====
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// ===== AWS S3 (R2) 클라이언트 =====
const s3Client = new S3Client({
  region: R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
  forcePathStyle: true,
});

// ===== 헬퍼 함수들 =====
function buildAuthorizeUrl(mallId) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CAFE24_CLIENT_ID,
    redirect_uri: `${BACKEND_URL}/auth/callback`,
    scope: CAFE24_SCOPES,
    state: mallId,
  });
  return `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params.toString()}`;
}

async function refreshAccessToken(mallId, refreshToken) {
  const url = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
  const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString();

  const { data } = await axios.post(url, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${creds}` }
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
  console.log(`✅ [TOKEN REFRESH] mallId=${mallId}, new expiry: ${newExpiresAt.toISOString()}`);
  return data.access_token;
}

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

// Cafe24 API 호출 래퍼
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
        console.warn(`[REFRESH FAIL] Removing token for ${mallId}`);
        await db.collection('token').deleteOne({ mallId });
        throw installRequired(mallId);
      }
    }
    if (status === 401 || status === 403) {
      console.warn(`[API FAIL ${status}] Removing token for ${mallId}`);
      await db.collection('token').deleteOne({ mallId });
      throw installRequired(mallId);
    }
    throw err;
  }
}

// ────────────────────────────────────────────────────────────────
// ★ [보안 핵심] 설치 상태 확인 미들웨어
// DB에 토큰이 없으면(삭제/만료) 409 에러를 뱉어서 프론트엔드가 종료 화면을 띄우게 함
// ────────────────────────────────────────────────────────────────
async function checkMallInstallation(req, res, next) {
  const { mallId } = req.params;
  if (!mallId) return next();

  try {
    const tokenDoc = await db.collection('token').findOne({ mallId });
    
    // 토큰이 없거나, accessToken 필드가 없는 경우 -> 차단
    if (!tokenDoc || !tokenDoc.accessToken) {
      console.warn(`⛔ [BLOCK] Access denied for uninstalled/expired mall: ${mallId}`);
      return res.status(409).json({
        installRequired: true,
        payload: {
          installed: false,
          mallId,
          installUrl: buildAuthorizeUrl(mallId)
        }
      });
    }
    
    // 정상 설치 상태면 통과
    next();
  } catch (err) {
    console.error('[INSTALL CHECK ERROR]', err);
    res.status(500).json({ error: 'Server check failed' });
  }
}

// ================================================================
// 1) 설치 및 인증 라우트 (미들웨어 미적용)
// ================================================================
app.get('/install/:mallId', (req, res) => {
  const { mallId } = req.params;
  res.redirect(buildAuthorizeUrl(mallId));
});

app.get('/auth/callback', async (req, res) => {
  const { code, state: mallId, error } = req.query; 
  if (error) return res.redirect(`${FRONTEND_URL}/?auth_error=${encodeURIComponent(error)}`);
  if (!code || !mallId) return res.status(400).send('Missing params');

  try {
    const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
    const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${BACKEND_URL}/auth/callback`
    }).toString(); 

    const { data } = await axios.post(tokenUrl, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${creds}` }
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
    console.log(`[AUTH CALLBACK] Installed: ${mallId}`);
    return res.redirect(`${FRONTEND_URL}/redirect?mall_id=${encodeURIComponent(mallId)}`);
  } catch (err) {
    console.error('[AUTH ERROR]', err.response?.data || err.message);
    return res.status(500).send('Auth Error');
  }
});

// 설치 여부 확인용 (프론트 진입 시 사용)
app.get('/api/:mallId/mall', async (req, res) => {
  const { mallId } = req.params;
  try {
    const doc = await db.collection('token').findOne({ mallId });
    if (doc?.accessToken) {
      return res.json({ installed: true, mallId, userId: doc.userId, userName: doc.userName });
    }
    return res.json({ installed: false, mallId, installUrl: buildAuthorizeUrl(mallId) });
  } catch (err) {
    return res.status(500).json({ error: 'Check failed' });
  }
});

// 앱 삭제 웹훅
app.post('/cafe24/uninstalled', async (req, res) => {
  try {
    if (UNINSTALL_TOKEN && req.query.token !== UNINSTALL_TOKEN) return res.status(401).json({ error: 'Token fail' });
    const mallId = req.body?.mall_id || req.query.mall_id;
    if (!mallId) return res.status(400).json({ error: 'mall_id missing' });

    const result = await db.collection('token').deleteOne({ mallId });
    console.log(`🗑️ [UNINSTALL] Token deleted for ${mallId}. Deleted: ${result.deletedCount}`);

    try { await db.collection(`visits_${mallId}`).drop(); } catch (e) {}
    try { await db.collection(`clicks_${mallId}`).drop(); } catch (e) {}
    try { await db.collection(`prdClick_${mallId}`).drop(); } catch (e) {}
    try { await db.collection('events').deleteMany({ mallId }); } catch (e) {}

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

// ================================================================
// 2) 기능 API (★ checkMallInstallation 미들웨어 적용 ★)
// ================================================================

// 이미지 업로드
app.post('/api/:mallId/uploads/image', checkMallInstallation, upload.single('file'), async (req, res) => {
  try {
    const { mallId } = req.params;
    const { filename, path: localPath, mimetype } = req.file;
    const key = `uploads/${mallId}/${filename}`;

    await s3Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME, Key: key, Body: fs.createReadStream(localPath), ContentType: mimetype, ACL: 'public-read'
    }));
    fs.unlink(localPath, () => {});
    res.json({ url: `${R2_PUBLIC_BASE}/${key}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Events CRUD
app.post('/api/:mallId/events', checkMallInstallation, async (req, res) => {
  const { mallId } = req.params;
  const payload = req.body;
  try {
    const doc = {
      mallId,
      title: payload.title,
      content: payload.content || '',
      images: payload.images || [],
      gridSize: payload.gridSize,
      layoutType: payload.layoutType || 'none',
      classification: payload.classification || {},
      createdAt: new Date(), updatedAt: new Date()
    };
    const result = await db.collection('events').insertOne(doc);
    res.json({ _id: result.insertedId, ...doc });
  } catch (err) { res.status(500).json({ error: 'Create failed' }); }
});

app.get('/api/:mallId/events', checkMallInstallation, async (req, res) => {
  const { mallId } = req.params;
  try {
    const list = await db.collection('events').find({ mallId }).sort({ createdAt: -1 }).toArray();
    res.json(list);
  } catch (err) { res.status(500).json({ error: 'List failed' }); }
});

app.get('/api/:mallId/events/:id', checkMallInstallation, async (req, res) => {
  const { mallId, id } = req.params;
  try {
    const ev = await db.collection('events').findOne({ _id: new ObjectId(id), mallId });
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    res.json(ev);
  } catch (err) { res.status(500).json({ error: 'Fetch failed' }); }
});

app.put('/api/:mallId/events/:id', checkMallInstallation, async (req, res) => {
  const { mallId, id } = req.params;
  const payload = req.body;
  const update = { updatedAt: new Date(), ...payload };
  delete update._id; 
  try {
    await db.collection('events').updateOne({ _id: new ObjectId(id), mallId }, { $set: update });
    const updated = await db.collection('events').findOne({ _id: new ObjectId(id) });
    res.json({ success: true, data: updated });
  } catch (err) { res.status(500).json({ error: 'Update failed' }); }
});

app.delete('/api/:mallId/events/:id', checkMallInstallation, async (req, res) => {
  const { mallId, id } = req.params;
  try {
    await db.collection('events').deleteOne({ _id: new ObjectId(id), mallId });
    await db.collection(`visits_${mallId}`).deleteMany({ pageId: id });
    await db.collection(`clicks_${mallId}`).deleteMany({ pageId: id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
});

// Settings
app.get('/api/:mallId/settings', checkMallInstallation, async (req, res) => {
  const { mallId } = req.params;
  try {
    const settings = await db.collection('settings').findOne({ mallId });
    res.json(settings || { mallId, siteBaseUrl: '' });
  } catch (err) { res.status(500).json({ error: 'Settings failed' }); }
});

app.put('/api/:mallId/settings', checkMallInstallation, async (req, res) => {
  const { mallId } = req.params;
  const { siteBaseUrl } = req.body;
  try {
    const r = await db.collection('settings').findOneAndUpdate(
      { mallId },
      { $set: { siteBaseUrl, updatedAt: new Date() }, $setOnInsert: { mallId, createdAt: new Date() } },
      { upsert: true, returnDocument: 'after' }
    );
    res.json(r.value);
  } catch (err) { res.status(500).json({ error: 'Save failed' }); }
});

// Tracking
app.post('/api/:mallId/track', checkMallInstallation, async (req, res) => {
  try {
    const { mallId } = req.params;
    const { pageId, visitorId, type, element, timestamp, productNo, pageUrl, referrer, device } = req.body;
    if (!pageId) return res.sendStatus(204);

    const kstTs = dayjs(timestamp).tz('Asia/Seoul').toDate();
    const dateKey = dayjs(timestamp).tz('Asia/Seoul').format('YYYY-MM-DD');
    let pathOnly; try { pathOnly = new URL(pageUrl).pathname; } catch { pathOnly = pageUrl; }

    // 상품 클릭 통계 (prdClick_)
    if (type === 'click' && element === 'product' && productNo) {
       // 상품명 가져오기 (만료 시 409 에러 발생 -> catch로 빠짐)
       let productName = null;
       try {
         const pRes = await apiRequest(mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/products/${productNo}`, {}, {shop_no:1});
         productName = (pRes.product || pRes.products?.[0])?.product_name;
       } catch (e) { /* ignore API error for tracking speed */ }
       
       await db.collection(`prdClick_${mallId}`).updateOne(
         { pageId, productNo },
         { $inc: { clickCount: 1 }, $setOnInsert: { productName, firstClickAt: kstTs }, $set: { lastClickAt: kstTs } },
         { upsert: true }
       );
       return res.sendStatus(204);
    }

    // 일반 클릭 통계 (clicks_)
    if (type === 'click') {
        const doc = { pageId, visitorId, dateKey, type, element, timestamp: kstTs, pageUrl: pathOnly, couponNo: productNo }; 
        if (element === 'coupon' && Array.isArray(productNo)) {
            await Promise.all(productNo.map(c => db.collection(`clicks_${mallId}`).insertOne({ ...doc, couponNo: c })));
        } else {
            await db.collection(`clicks_${mallId}`).insertOne(doc);
        }
        return res.sendStatus(204);
    }

    // 방문 통계 (visits_)
    const up = { $set: { lastVisit: kstTs, pageUrl: pathOnly, referrer, device }, $setOnInsert: { firstVisit: kstTs } };
    if (type === 'view') up.$inc = { viewCount: 1 };
    if (type === 'revisit') up.$inc = { revisitCount: 1 };
    await db.collection(`visits_${mallId}`).updateOne({ pageId, visitorId, dateKey }, up, { upsert: true });
    res.sendStatus(204);
  } catch (err) {
    console.error(err);
    // 409 에러(설치안됨)면 프론트로 전달
    if (err?.installRequired) return res.status(409).json(err.payload);
    res.status(500).json({ error: 'Track failed' });
  }
});

// Analytics (모든 분석 라우트에 보안 적용)
app.get('/api/:mallId/analytics/:pageId/visitors-by-date', checkMallInstallation, async (req, res) => {
    const { mallId, pageId } = req.params;
    const { start_date, end_date, url } = req.query;
    if (!start_date || !end_date) return res.status(400).json({ error: 'dates required' });
    const startKey = start_date.slice(0, 10);
    const endKey = end_date.slice(0, 10);
    const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
    if (url) match.pageUrl = url;
    const pipeline = [
        { $match: match },
        { $group: { _id: { date: '$dateKey', visitorId: '$visitorId' }, viewCount: { $sum: { $ifNull: ['$viewCount', 0] } }, revisitCount: { $sum: { $ifNull: ['$revisitCount', 0] } } } },
        { $group: { _id: '$_id.date', totalVisitors: { $sum: 1 }, newVisitors: { $sum: { $cond: [{ $gt: ['$viewCount', 0] }, 1, 0] } }, returningVisitors: { $sum: { $cond: [{ $gt: ['$revisitCount', 0] }, 1, 0] } } } },
        { $project: { _id: 0, date: '$_id', totalVisitors: 1, newVisitors: 1, returningVisitors: 1, revisitRate: { $concat: [ { $toString: { $round: [ { $multiply: [ { $cond: [{ $gt: ['$totalVisitors', 0] }, { $divide: ['$returningVisitors', '$totalVisitors'] }, 0] }, 100 ] }, 0 ] }}, ' %' ] } } },
        { $sort: { date: 1 } }
    ];
    try {
        const stats = await db.collection(`visits_${mallId}`).aggregate(pipeline).toArray();
        res.json(stats);
    } catch(e) { res.status(500).json({error: 'Analytics error'}); }
});

app.get('/api/:mallId/analytics/:pageId/clicks-by-date', checkMallInstallation, async (req, res) => {
    const { mallId, pageId } = req.params;
    const { start_date, end_date, url } = req.query;
    const startKey = start_date.slice(0,10); const endKey = end_date.slice(0,10);
    const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
    if (url) match.pageUrl = url;
    const pipeline = [
        { $match: match },
        { $group: { _id: { date: '$dateKey', element: '$element' }, count: { $sum: 1 } } },
        { $group: { _id: '$_id.date', url: { $sum: { $cond: [{ $eq: ['$_id.element', 'url'] }, '$count', 0] } }, product: { $sum: { $cond: [{ $eq: ['$_id.element', 'product'] }, '$count', 0] } }, coupon: { $sum: { $cond: [{ $eq: ['$_id.element', 'coupon'] }, '$count', 0] } } } },
        { $project: { _id:0, date: '$_id', 'URL 클릭': '$url', 'URL 클릭(기존 product)': '$product', '쿠폰 클릭': '$coupon' } },
        { $sort: { date: 1 } }
    ];
    try {
        const data = await db.collection(`clicks_${mallId}`).aggregate(pipeline).toArray();
        res.json(data);
    } catch(e) { res.status(500).json({error: 'Analytics error'}); }
});

app.get('/api/:mallId/analytics/:pageId/url-clicks', checkMallInstallation, async (req, res) => {
    const { mallId, pageId } = req.params;
    const { start_date, end_date, url } = req.query;
    const match = { pageId, type: 'click', element: 'url', timestamp: { $gte: new Date(start_date), $lte: new Date(end_date) } };
    if (url) match.pageUrl = url;
    try {
        const count = await db.collection(`clicks_${mallId}`).countDocuments(match);
        res.json({ count });
    } catch(e) { res.status(500).json({error: 'Analytics error'}); }
});

app.get('/api/:mallId/analytics/:pageId/coupon-clicks', checkMallInstallation, async (req, res) => {
    const { mallId, pageId } = req.params;
    const { start_date, end_date, url } = req.query;
    const match = { pageId, type: 'click', element: 'coupon', timestamp: { $gte: new Date(start_date), $lte: new Date(end_date) } };
    if (url) match.pageUrl = url;
    try {
        const count = await db.collection(`clicks_${mallId}`).countDocuments(match);
        res.json({ count });
    } catch(e) { res.status(500).json({error: 'Analytics error'}); }
});

app.get('/api/:mallId/analytics/:pageId/urls', checkMallInstallation, async (req, res) => {
    const { mallId, pageId } = req.params;
    try {
        const urls = await db.collection(`visits_${mallId}`).distinct('pageUrl', { pageId });
        res.json(urls);
    } catch(e) { res.status(500).json({error: 'Analytics error'}); }
});

app.get('/api/:mallId/analytics/:pageId/coupons-distinct', checkMallInstallation, async (req, res) => {
    const { mallId, pageId } = req.params;
    try {
        const couponNos = await db.collection(`clicks_${mallId}`).distinct('couponNo', { pageId, element: 'coupon' });
        res.json(couponNos);
    } catch(e) { res.status(500).json({error: 'Analytics error'}); }
});

app.get('/api/:mallId/analytics/:pageId/devices', checkMallInstallation, async (req, res) => {
    const { mallId, pageId } = req.params;
    const { start_date, end_date, url } = req.query;
    const startKey = start_date.slice(0,10), endKey = end_date.slice(0,10);
    const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
    if (url) match.pageUrl = url;
    const pipeline = [ { $match: match }, { $group: { _id: '$device', count: { $sum: { $add: [ { $ifNull: ['$viewCount',0] }, { $ifNull: ['$revisitCount',0] } ] } } } }, { $project: { _id:0, device_type: '$_id', count: 1 } } ];
    try {
        const data = await db.collection(`visits_${mallId}`).aggregate(pipeline).toArray();
        res.json(data);
    } catch(e) { res.status(500).json({error: 'Analytics error'}); }
});

app.get('/api/:mallId/analytics/:pageId/devices-by-date', checkMallInstallation, async (req, res) => {
    const { mallId, pageId } = req.params;
    const { start_date, end_date, url } = req.query;
    const startKey = start_date.slice(0,10), endKey = end_date.slice(0,10);
    const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
    if (url) match.pageUrl = url;
    const pipeline = [ { $match: match }, { $group: { _id: { date:'$dateKey', device:'$device', visitor:'$visitorId' } } }, { $group: { _id: { date:'$_id.date', device:'$_id.device' }, count: { $sum: 1 } } }, { $project: { _id: 0, date: '$_id.date', device: '$_id.device', count:1 } }, { $sort: { date: 1, device: 1 } } ];
    try {
        const data = await db.collection(`visits_${mallId}`).aggregate(pipeline).toArray();
        res.json(data);
    } catch(e) { res.status(500).json({error: 'Analytics error'}); }
});

app.get('/api/:mallId/analytics/:pageId/product-clicks', checkMallInstallation, async (req, res) => {
    const { mallId, pageId } = req.params;
    const { start_date, end_date } = req.query;
    const filter = { pageId };
    if (start_date && end_date) filter.lastClickAt = { $gte: new Date(start_date), $lte: new Date(end_date) };
    try {
        const docs = await db.collection(`prdClick_${mallId}`).find(filter).sort({ clickCount: -1 }).toArray();
        res.json(docs.map(d => ({ productNo: d.productNo, clicks: d.clickCount })));
    } catch(e) { res.status(500).json({error: 'Analytics error'}); }
});

app.get('/api/:mallId/analytics/:pageId/product-performance', checkMallInstallation, async (req, res) => {
    const { mallId, pageId } = req.params;
    try {
        const clicks = await db.collection(`prdClick_${mallId}`).aggregate([ { $match: { pageId } }, { $group: { _id: '$productNo', clicks: { $sum: '$clickCount' } } } ]).toArray();
        if (clicks.length === 0) return res.json([]);
        const productNos = clicks.map(c => c._id);
        const prodRes = await apiRequest(mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/products`, {}, { shop_no: 1, product_no: productNos.join(','), limit: productNos.length, fields: 'product_no,product_name' });
        const detailMap = (prodRes.products || []).reduce((m, p) => { m[p.product_no] = p.product_name; return m; }, {});
        res.json(clicks.map(c => ({ productNo: c._id, productName: detailMap[c._id] || '이름없음', clicks: c.clicks })).sort((a,b) => b.clicks - a.clicks));
    } catch(e) {
        if(e.installRequired) return res.status(409).json(e.payload);
        res.status(500).json({error: 'Performance error'});
    }
});

app.get('/api/:mallId/analytics/:pageId/coupon-stats', checkMallInstallation, async (req, res) => {
    const { mallId } = req.params;
    const { coupon_no, start_date, end_date } = req.query;
    if (!coupon_no) return res.status(400).json({ error: 'coupon_no required' });
    const couponNos = coupon_no.split(',');
    const results = [];
    try {
        for (const no of couponNos) {
            let couponName = '(이름없음)';
            try {
                const nameRes = await apiRequest(mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/coupons`, {}, { shop_no: 1, coupon_no: no, coupon_status: 'ALL', fields: 'coupon_no,coupon_name', limit: 1 });
                couponName = nameRes.coupons?.[0]?.coupon_name || couponName;
            } catch (e) {}
            let issued = 0, used = 0, unused = 0, autoDel = 0;
            const pageSize = 500;
            for (let offset = 0; ; offset += pageSize) {
                const issuesRes = await apiRequest(mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/coupons/${no}/issues`, {}, { shop_no: 1, limit: pageSize, offset, issued_start_date: start_date, issued_end_date: end_date });
                const issues = issuesRes.issues || [];
                if (issues.length === 0) break;
                for (const item of issues) {
                    issued++;
                    if (item.used_coupon === 'T') used++;
                    else {
                        const exp = item.expiration_date ? new Date(item.expiration_date) : null;
                        if (exp && exp < new Date()) autoDel++; else unused++;
                    }
                }
            }
            results.push({ couponNo: no, couponName, issuedCount: issued, usedCount: used, unusedCount: unused, autoDeletedCount: autoDel });
        }
        res.json(results);
    } catch (err) { return replyInstallGuard(res, err, 'Coupon stats failed'); }
});

// Categories & Products & Coupons (Cafe24 API 호출 포함)
app.get('/api/:mallId/categories/all', checkMallInstallation, async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = []; let offset=0;
    while(true) {
        const { categories=[] } = await apiRequest(mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/categories`, {}, { limit:100, offset });
        if(!categories.length) break;
        all.push(...categories); offset+=categories.length;
    }
    res.json(all);
  } catch (err) { replyInstallGuard(res, err, 'Fail'); }
});

app.get('/api/:mallId/coupons', checkMallInstallation, async (req, res) => {
    const { mallId } = req.params;
    try {
        const all=[]; let offset=0;
        while(true) {
            const { coupons=[] } = await apiRequest(mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/coupons`, {}, {shop_no:1, limit:100, offset});
            if(!coupons.length) break;
            all.push(...coupons); offset+=coupons.length;
        }
        res.json(all);
    } catch(err) { replyInstallGuard(res, err, 'Fail'); }
});

app.get('/api/:mallId/products', checkMallInstallation, async (req, res) => {
    const { mallId } = req.params;
    try {
        const { limit=100, offset=0, q } = req.query;
        const params = { shop_no:1, limit, offset, fields: 'product_no,product_code,product_name,price,list_image,decoration_icon_url,icons,product_tags' };
        if(q) params.product_name = q;
        const data = await apiRequest(mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/products`, {}, params);
        res.json({ products: data.products });
    } catch(err) { replyInstallGuard(res, err, 'Fail'); }
});

app.get('/api/:mallId/categories/:category_no/products', checkMallInstallation, async (req, res) => {
    const { mallId, category_no } = req.params;
    try {
      const { coupon_no, limit=100, offset=0 } = req.query;
      const coupon_nos = coupon_no ? coupon_no.split(',') : [];
      const shop_no = 1;

      const coupons = await Promise.all(coupon_nos.map(async no => {
        const urlC = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
        const { coupons: arr } = await apiRequest(mallId, 'GET', urlC, {}, { shop_no, coupon_no: no, fields: 'coupon_no,available_product,available_product_list,available_category,available_category_list,benefit_amount,benefit_percentage' });
        return arr?.[0];
      }));
      const validCoupons = coupons.filter(Boolean);

      const catRes = await apiRequest(mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/categories/${category_no}/products`, {}, { shop_no, display_group:1, limit, offset });
      const sorted = (catRes.products || []).slice().sort((a,b)=>a.sequence_no - b.sequence_no);
      const productNos = sorted.map(p => p.product_no);
      if (!productNos.length) return res.json([]);

      const detailRes = await apiRequest(mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/products`, {}, { shop_no, product_no: productNos.join(','), limit: productNos.length, fields: 'product_no,product_name,price,summary_description,list_image,medium_image,small_image,tiny_image,decoration_icon_url,icons,product_tags' });
      const details = detailRes.products || [];
      const detailMap = details.reduce((m,p) => { m[p.product_no] = p; return m; }, {});

      const iconPromises = productNos.map(async (no) => {
        try {
          const iconsRes = await apiRequest(mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/products/${no}/icons`, {}, { shop_no });
          const iconsData = iconsRes?.icons;
          let imageList = [];
          if (iconsData) {
            if (iconsData.use_show_date !== 'T') imageList = iconsData.image_list || [];
            else {
              const now = new Date();
              if (now >= new Date(iconsData.show_start_date) && now < new Date(iconsData.show_end_date)) imageList = iconsData.image_list || [];
            }
          }
          return { product_no: no, customIcons: imageList.map(icon => ({ icon_url: icon.path, icon_alt: icon.code })) };
        } catch (e) { return { product_no: no, customIcons: [] }; }
      });
      const iconResults = await Promise.all(iconPromises);
      const iconsMap = iconResults.reduce((m, item) => { m[item.product_no] = item.customIcons; return m; }, {});

      const discountMap = {};
      await Promise.all(productNos.map(async no => {
        try {
            const { discountprice } = await apiRequest(mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/products/${no}/discountprice`, {}, { shop_no });
            discountMap[no] = discountprice?.pc_discount_price != null ? parseFloat(discountprice.pc_discount_price) : null;
        } catch(e){}
      }));

      const result = sorted.map(item => {
        const p = detailMap[item.product_no];
        if (!p) return null;
        
        // 쿠폰 계산
        const couponInfos = validCoupons.map(coupon => {
            const pList = coupon.available_product_list || [];
            const cList = coupon.available_category_list || [];
            const prodOk = coupon.available_product==='U' || (coupon.available_product==='I'&&pList.includes(p.product_no)) || (coupon.available_product==='E'&&!pList.includes(p.product_no));
            const catOk = coupon.available_category==='U' || (coupon.available_category==='I'&&cList.includes(parseInt(category_no))) || (coupon.available_category==='E'&&!cList.includes(parseInt(category_no)));
            if (!prodOk || !catOk) return null;
            const orig = parseFloat(p.price);
            const pct = parseFloat(coupon.benefit_percentage||0);
            const amt = parseFloat(coupon.benefit_amount||0);
            let bp = null;
            if(pct>0) bp = +(orig*(100-pct)/100).toFixed(2);
            else if(amt>0) bp = +(orig-amt).toFixed(2);
            if(bp==null) return null;
            return { coupon_no: coupon.coupon_no, benefit_percentage: pct, benefit_price: bp };
        }).filter(Boolean).sort((a,b)=>b.benefit_percentage - a.benefit_percentage);

        const first = couponInfos[0];
        const saleP = discountMap[p.product_no];
        
        return {
            product_no: p.product_no,
            product_name: p.product_name,
            price: p.price,
            summary_description: p.summary_description,
            list_image: p.list_image, image_medium: p.medium_image, image_small: p.small_image, image_thumbnail: p.tiny_image,
            decoration_icon_url: p.decoration_icon_url || null,
            icons: p.icons,
            additional_icons: iconsMap[p.product_no] || [],
            product_tags: p.product_tags,
            sale_price: saleP,
            benefit_price: first ? first.benefit_price : null,
            benefit_percentage: first ? first.benefit_percentage : null,
            couponInfos: couponInfos.length ? couponInfos : null
        };
      }).filter(Boolean);

      res.json(result);
    } catch(err) { replyInstallGuard(res, err, 'Fail'); }
});

app.get('/api/:mallId/products/:product_no', checkMallInstallation, async (req, res) => {
    const { mallId, product_no } = req.params;
    try {
        const shop_no = 1;
        const coupon_nos = (req.query.coupon_no || '').split(',').filter(Boolean);
        const prodData = await apiRequest(mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}`, {}, { shop_no, fields: 'product_no,product_code,product_name,price,summary_description,list_image,medium_image,small_image,tiny_image,decoration_icon_url,icons,product_tags' });
        const p = prodData.product || prodData.products?.[0];
        if(!p) return res.status(404).json({error:'Not found'});

        // 아이콘 로직
        let customIcons = [];
        try {
            const iconsRes = await apiRequest(mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}/icons`, {}, { shop_no });
            const iconsData = iconsRes?.icons;
            if (iconsData) {
                let imageList = [];
                if (iconsData.use_show_date !== 'T') imageList = iconsData.image_list || [];
                else {
                    const now = new Date();
                    if (now >= new Date(iconsData.show_start_date) && now < new Date(iconsData.show_end_date)) imageList = iconsData.image_list || [];
                }
                customIcons = imageList.map(icon => ({ icon_url: icon.path, icon_alt: icon.code }));
            }
        } catch(e) {}

        // 할인가
        const disData = await apiRequest(mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}/discountprice`, {}, { shop_no });
        const sale_price = disData.discountprice?.pc_discount_price != null ? parseFloat(disData.discountprice.pc_discount_price) : null;

        // 쿠폰가
        const coupons = await Promise.all(coupon_nos.map(async no => {
            const { coupons: arr } = await apiRequest(mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/coupons`, {}, { shop_no, coupon_no: no, fields: 'coupon_no,available_product,available_product_list,available_category,available_category_list,benefit_amount,benefit_percentage' });
            return arr?.[0];
        }));
        const validCoupons = coupons.filter(Boolean);
        let benefit_price = null, benefit_percentage = null;
        validCoupons.forEach(coupon => {
            const pList = coupon.available_product_list || [];
            const ok = coupon.available_product==='U' || (coupon.available_product==='I'&&pList.includes(parseInt(product_no))) || (coupon.available_product==='E'&&!pList.includes(parseInt(product_no)));
            if(!ok) return;
            const orig = parseFloat(p.price);
            const pct = parseFloat(coupon.benefit_percentage||0);
            const amt = parseFloat(coupon.benefit_amount||0);
            let bp = null;
            if(pct>0) bp = +(orig*(100-pct)/100).toFixed(2);
            else if(amt>0) bp = +(orig-amt).toFixed(2);
            if(bp!=null && pct > (benefit_percentage||0)) {
                benefit_price = bp; benefit_percentage = pct;
            }
        });

        res.json({
            product_no, product_code: p.product_code, product_name: p.product_name, price: p.price, summary_description: p.summary_description,
            list_image: p.list_image, image_medium: p.medium_image, image_small: p.small_image, image_thumbnail: p.tiny_image,
            decoration_icon_url: p.decoration_icon_url || null, icons: p.icons, additional_icons: customIcons, product_tags: p.product_tags,
            sale_price, benefit_price, benefit_percentage
        });
    } catch(err) { replyInstallGuard(res, err, 'Fail'); }
});


// ===== 백그라운드 작업 (토큰 갱신) =====
async function runTokenRefreshScheduler() {
  const soon = new Date(Date.now() + 60*60*1000);
  const tokens = await db.collection('token').find({ expiresAt: { $lt: soon } }).toArray();
  for (const t of tokens) {
    try { await refreshAccessToken(t.mallId, t.refreshToken); } 
    catch (e) { console.error(`Failed refresh ${t.mallId}`, e.message); }
  }
}

async function forceRefreshAllTokens() {
  const tokens = await db.collection('token').find({ refreshToken: {$ne:null} }).toArray();
  for (const t of tokens) {
    try { await refreshAccessToken(t.mallId, t.refreshToken); } catch(e){}
  }
}

// ===== Start =====
initDb().then(async () => {
  await forceRefreshAllTokens();
  cron.schedule('*/30 * * * *', runTokenRefreshScheduler);
  app.listen(PORT, () => console.log(`Server on ${PORT}`));
}).catch(e => { console.error(e); process.exit(1); });
