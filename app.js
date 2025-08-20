// app.js (전체 - /auth/callback + /redirect 처리 모두 포함)
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
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

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
  CAFE24_SCOPES,
  DEBUG_MODE
} = process.env;

const DEFAULT_SCOPES = CAFE24_SCOPES || [
  'mall.read_promotion',
  'mall.write_promotion',
  'mall.read_category',
  'mall.write_category',
  'mall.read_product',
  'mall.write_product',
  'mall.read_collection',
  'mall.read_application',
  'mall.write_application',
  'mall.read_analytics',
  'mall.read_salesreport',
  'mall.read_store'
].join(',');

if (!APP_URL) console.warn('⚠️ APP_URL not set');
if (!CAFE24_CLIENT_ID || !CAFE24_CLIENT_SECRET) console.warn('⚠️ CAFE24 client id/secret missing');
if (!MONGODB_URI || !DB_NAME) console.warn('⚠️ MONGODB_URI/DB_NAME missing');

const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// request logger
app.use((req, res, next) => {
  console.log(new Date().toISOString(), '--- INCOMING REQUEST ---', req.method, req.originalUrl);
  if (Object.keys(req.query || {}).length) console.log(' query:', req.query);
  next();
});

// MongoDB init
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  await db.collection('token').createIndex({ mallId: 1 }, { unique: true });
  console.log('▶️ MongoDB connected to', DB_NAME);
}

// multer upload
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// S3/R2 client
const s3Client = new S3Client({
  region: R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
  forcePathStyle: true
});

// ----------------- INSTALL (start OAuth) -----------------
app.get('/install/:mallId', (req, res) => {
  const { mallId } = req.params;
  if (!mallId) return res.status(400).send('mallId required');
  const redirectUri = `${APP_URL}/auth/callback`; // this is what our /auth/callback expects
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CAFE24_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: DEFAULT_SCOPES,
    state: mallId
  });
  const url = `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params.toString()}`;
  console.log('[INSTALL] redirect to', url);
  res.redirect(url);
});

// ----------------- TOKEN EXCHANGE + SAVE (shared fn) -----------------
async function exchangeAndSaveToken(mallId, code, redirectUri) {
  if (!mallId || !code) throw new Error('mallId or code missing');
  const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
  const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  }).toString();

  const resp = await axios.post(tokenUrl, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
    timeout: 10000
  });

  const data = resp.data;
  if (!data || !data.access_token) throw new Error('token response missing access_token');

  const doc = {
    mallId,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    obtainedAt: new Date(),
    expiresIn: data.expires_in || null,
    raw: data
  };

  const result = await db.collection('token').updateOne({ mallId }, { $set: doc }, { upsert: true });
  const saved = await db.collection('token').findOne({ mallId });
  return { result, saved };
}

// ----------------- /auth/callback (primary) -----------------
app.get('/auth/callback', async (req, res) => {
  console.log('[AUTH CALLBACK ARRIVED] query=', req.query);
  const { error, error_description, code, state: mallId } = req.query;
  if (error) {
    console.error('[AUTH CALLBACK][PROVIDER ERROR]', error, error_description);
    if (DEBUG_MODE === '1') return res.status(400).send(`<pre>${error} ${error_description}</pre>`);
    return res.redirect(`${APP_URL}/redirect?auth_error=${encodeURIComponent(error)}&mall_id=${encodeURIComponent(mallId||'')}`);
  }
  if (!code || !mallId) return res.status(400).send('code or mallId missing');

  try {
    const { result, saved } = await exchangeAndSaveToken(mallId, code, `${APP_URL}/auth/callback`);
    console.log('[AUTH CALLBACK] token upsert result:', result);
    console.log('[AUTH CALLBACK] saved doc present:', !!saved);
    if (DEBUG_MODE === '1') {
      return res.send(`<html><body><h3>Installed (debug)</h3><pre>${JSON.stringify(saved, null, 2)}</pre></body></html>`);
    }
    return res.redirect(`${APP_URL}/redirect?mall_id=${encodeURIComponent(mallId)}&installed=1`);
  } catch (err) {
    console.error('[AUTH CALLBACK ERROR]', err.response?.data || err.message || err);
    if (DEBUG_MODE === '1') return res.status(500).send(`<pre>${JSON.stringify(err.response?.data || err.message || err, null, 2)}</pre>`);
    return res.redirect(`${APP_URL}/redirect?mall_id=${encodeURIComponent(req.query.state||'')}&auth_error=${encodeURIComponent(err.response?.data?.error_description || err.message || 'token_error')}`);
  }
});

// ----------------- /redirect (can be used as registered redirect URI) -----------------
// If cafe24 calls /redirect with code & state, we do token exchange on server and save.
// Otherwise, we forward query to frontend at APP_URL/redirect.
app.get('/redirect', async (req, res) => {
  console.log('[REDIRECT ENDPOINT] query=', req.query);
  const qs = new URLSearchParams(req.query).toString();
  const { code, state: mallId } = req.query;

  // If code+state exist, attempt to exchange & save here (handles case where developer center registered /redirect)
  if (code && mallId) {
    try {
      const { result, saved } = await exchangeAndSaveToken(mallId, code, `${APP_URL}/redirect`);
      console.log('[REDIRECT] token upsert result:', result);
      console.log('[REDIRECT] saved doc present:', !!saved);
      if (DEBUG_MODE === '1') {
        return res.send(`<html><body><h3>Installed via /redirect (debug)</h3><pre>${JSON.stringify(saved, null, 2)}</pre></body></html>`);
      }
      // Forward to frontend redirect route so frontend can show success
      const target = `${APP_URL}/redirect?mall_id=${encodeURIComponent(mallId)}&installed=1`;
      return res.redirect(target);
    } catch (err) {
      console.error('[REDIRECT][TOKEN ERR]', err.response?.data || err.message || err);
      if (DEBUG_MODE === '1') return res.status(500).send(`<pre>${JSON.stringify(err.response?.data || err.message || err, null, 2)}</pre>`);
      // Forward to frontend and include error info
      const target = `${APP_URL}/redirect?mall_id=${encodeURIComponent(mallId||'')}&auth_error=${encodeURIComponent(err.response?.data?.error_description || err.message || 'token_error')}`;
      return res.redirect(target);
    }
  }

  // otherwise just forward to frontend redirect route (no server-side exchange)
  const target = `${APP_URL}/redirect${qs ? ('?' + qs) : ''}`;
  console.log('[REDIRECT FORWARD] ->', target);
  return res.redirect(target);
});

// ----------------- helper: refresh / apiRequest -----------------
async function refreshAccessToken(mallId, refreshToken) {
  if (!refreshToken) throw new Error('refreshToken missing');
  const url = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
  const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString();
  const { data } = await axios.post(url, params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` } });
  await db.collection('token').updateOne({ mallId }, { $set: {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    obtainedAt: new Date(),
    expiresIn: data.expires_in,
    raw_refresh_response: data
  }});
  console.log(`[TOKEN REFRESH] mallId=${mallId}`);
  return data.access_token;
}

async function apiRequest(mallId, method, url, data = {}, params = {}) {
  const doc = await db.collection('token').findOne({ mallId });
  if (!doc) {
    const redirectUri = `${APP_URL}/auth/callback`;
    const paramsQ = new URLSearchParams({ response_type: 'code', client_id: CAFE24_CLIENT_ID, redirect_uri: redirectUri, scope: DEFAULT_SCOPES, state: mallId }).toString();
    const installUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${paramsQ}`;
    console.warn(`[API BLOCK] not installed: mallId=${mallId} -> ${installUrl}`);
    const e = new Error(`NOT_INSTALLED:${installUrl}`); e.code = 'NOT_INSTALLED'; e.installUrl = installUrl;
    throw e;
  }

  try {
    const resp = await axios({ method, url, data, params, headers: { Authorization: `Bearer ${doc.accessToken}`, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': CAFE24_API_VERSION }});
    return resp.data;
  } catch (err) {
    if (err.response?.status === 401 && doc.refreshToken) {
      const newAccess = await refreshAccessToken(mallId, doc.refreshToken);
      const retry = await axios({ method, url, data, params, headers: { Authorization: `Bearer ${newAccess}`, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': CAFE24_API_VERSION }});
      return retry.data;
    }
    throw err;
  }
}

// ----------------- example endpoints (images/events/track/categories/coupons etc) -----------------

// image upload
app.post('/api/:mallId/uploads/image', upload.single('file'), async (req, res) => {
  try {
    const { mallId } = req.params;
    const { filename, path: localPath, mimetype } = req.file;
    const key = `uploads/${mallId}/${filename}`;
    await s3Client.send(new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key, Body: fs.createReadStream(localPath), ContentType: mimetype, ACL: 'public-read' }));
    fs.unlink(localPath, () => {});
    const url = `${R2_PUBLIC_BASE}/${key}`;
    res.json({ url });
  } catch (err) {
    console.error('[IMAGE UPLOAD ERROR]', err);
    res.status(500).json({ error: '이미지 업로드 실패' });
  }
});

// events CRUD, track, categories, coupons, analytics...
// (여기에 기존에 사용하시던 모든 엔드포인트 그대로 붙여넣으시면 됩니다.)
// For brevity, include the ones you need from your original file.

app.get('/api/:mallId/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// debug token endpoints (remove in production)
app.get('/debug/token/:mallId', async (req, res) => {
  try {
    const doc = await db.collection('token').findOne({ mallId: req.params.mallId });
    if (!doc) return res.status(404).json({ error: 'not found' });
    // Do not expose tokens in production
    res.json({ mallId: doc.mallId, obtainedAt: doc.obtainedAt, hasAccessToken: !!doc.accessToken, hasRefreshToken: !!doc.refreshToken });
  } catch (err) {
    console.error('[DEBUG TOKEN ERROR]', err);
    res.status(500).json({ error: 'failed' });
  }
});

// start server after DB init
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`▶️ Server running at ${APP_URL} (port ${PORT})`);
  });
}).catch(err => {
  console.error('❌ initDb failed', err);
  process.exit(1);
});
