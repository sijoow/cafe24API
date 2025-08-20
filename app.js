// app.js — 전체 파일 (교체해서 사용)
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
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

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
  CAFE24_SCOPES // ex: "mall.read_category,mall.read_product,..." (must match dev center)
} = process.env;

if (!APP_URL) console.warn('⚠️ APP_URL is not set in env');
if (!CAFE24_CLIENT_ID || !CAFE24_CLIENT_SECRET) console.warn('⚠️ CAFE24 client id/secret missing');
if (!MONGODB_URI || !DB_NAME) console.warn('⚠️ MongoDB config missing');

const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// simple request logger
app.use((req, res, next) => {
  console.log(new Date().toISOString(), '--- INCOMING REQUEST ---', req.method, req.originalUrl);
  if (Object.keys(req.query || {}).length) console.log(' query:', req.query);
  next();
});

// MongoDB
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  await db.collection('token').createIndex({ mallId: 1 }, { unique: true });
  console.log('▶️ MongoDB connected to', DB_NAME);
}

// Multer for uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// R2 / S3 client (if needed)
const s3Client = new S3Client({
  region:   R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId:     R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
  forcePathStyle: true,
});

// ========================
// OAuth 설치 흐름
// ========================

// build scopes (from env or fallback; but env recommended)
const SCOPES = (typeof CAFE24_SCOPES === 'string' && CAFE24_SCOPES.trim().length)
  ? CAFE24_SCOPES
  : [
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

// /install/:mallId -> redirect to Cafe24 authorize URL
app.get('/install/:mallId', (req, res) => {
  const { mallId } = req.params;
  const redirectUri = `${APP_URL.replace(/\/$/, '')}/auth/callback`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CAFE24_CLIENT_ID,
    redirect_uri:  redirectUri,
    scope:         SCOPES,
    state:         mallId,
  }).toString();
  const url = `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params}`;
  console.log('[INSTALL] redirecting to:', url);
  res.redirect(url);
});

// auth callback: exchange code -> save token to DB -> redirect to frontend /redirect
app.get('/auth/callback', async (req, res) => {
  // If Cafe24 returned error like invalid_scope, include it in logs and show helpful message
  const { error, error_description, code, state: mallId } = req.query;
  if (error) {
    console.warn('[AUTH CALLBACK] provider returned error:', error, error_description, 'state=', mallId);
    // Show helpful HTML so you can see error_description directly in browser
    return res.status(400).send(`
      <html><body style="font-family:Arial,Helvetica,sans-serif">
        <h3>OAuth 오류 발생</h3>
        <p><strong>error:</strong> ${error}</p>
        <p><strong>description:</strong> ${decodeURIComponent(error_description || '')}</p>
        <p>대응: 개발자센터에 등록된 scope와 요청한 scope가 정확히 일치하는지, Redirect URI가 정확한지 확인하세요.</p>
        <p><a href="/">대시보드로</a></p>
      </body></html>
    `);
  }

  if (!code || !mallId) {
    console.error('[AUTH CALLBACK] missing code or state(mallId):', { code, mallId });
    return res.status(400).send('code 또는 mallId가 없습니다.');
  }

  try {
    const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
    const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const body = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: `${APP_URL.replace(/\/$/, '')}/auth/callback`
    }).toString();

    console.log('[AUTH CALLBACK] exchanging token at', tokenUrl);
    const tokenResp = await axios.post(tokenUrl, body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`
      },
      validateStatus: s => true,
      timeout: 15000
    });

    console.log('[AUTH CALLBACK] token exchange status:', tokenResp.status);
    console.log('[AUTH CALLBACK] token exchange data:', tokenResp.data);

    if (tokenResp.status !== 200) {
      // show the full provider error for debugging
      return res.status(502).send(`
        <html><body style="font-family:Arial,Helvetica,sans-serif">
          <h3>토큰 교환 실패 (provider error)</h3>
          <pre>${JSON.stringify(tokenResp.data, null, 2)}</pre>
          <p>개발자센터의 client_id/secret, redirect_uri, scopes를 재확인하세요.</p>
        </body></html>
      `);
    }

    const data = tokenResp.data;
    const doc = {
      mallId,
      accessToken:  data.access_token,
      refreshToken: data.refresh_token,
      obtainedAt:   new Date(),
      expiresIn:    data.expires_in || null,
      raw: data
    };

    console.log('[AUTH CALLBACK] upserting token to DB for mallId=', mallId);
    const upsert = await db.collection('token').updateOne(
      { mallId },
      { $set: doc },
      { upsert: true }
    );
    console.log('[AUTH CALLBACK] upsert result:', upsert);

    // redirect to frontend redirect route so client can pick up mall_id and continue
    const redirectTo = `${APP_URL.replace(/\/$/, '')}/redirect?mall_id=${encodeURIComponent(mallId)}&installed=1`;
    console.log('[AUTH CALLBACK] redirecting to frontend:', redirectTo);
    return res.redirect(redirectTo);
  } catch (err) {
    console.error('[AUTH CALLBACK ERROR]', err.response?.data || err.message || err);
    return res.status(500).send('토큰 교환 중 오류가 발생했습니다. 서버 로그 확인 필요.');
  }
});

// helper: refresh access token
async function refreshAccessToken(mallId, refreshToken) {
  const url = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
  const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken
  }).toString();

  const resp = await axios.post(url, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`
    }
  });

  const data = resp.data;
  await db.collection('token').updateOne(
    { mallId },
    { $set: {
        accessToken:  data.access_token,
        refreshToken: data.refresh_token,
        obtainedAt:   new Date(),
        expiresIn:    data.expires_in,
        raw_refresh_response: data
      }
    }
  );
  console.log('[TOKEN REFRESH] mallId=', mallId);
  return data.access_token;
}

// apiRequest: uses stored token, refresh on 401
async function apiRequest(mallId, method, url, data = {}, params = {}) {
  const doc = await db.collection('token').findOne({ mallId });
  if (!doc) {
    // not installed: create an install URL and throw structured error
    const redirectUri = `${APP_URL.replace(/\/$/, '')}/auth/callback`;
    const paramsQ = new URLSearchParams({
      response_type: 'code',
      client_id:     CAFE24_CLIENT_ID,
      redirect_uri:  redirectUri,
      scope:         SCOPES,
      state:         mallId,
    }).toString();
    const installUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${paramsQ}`;
    const e = new Error(`NOT_INSTALLED:${installUrl}`);
    e.code = 'NOT_INSTALLED';
    e.installUrl = installUrl;
    throw e;
  }

  try {
    const resp = await axios({
      method, url, data, params,
      headers: {
        Authorization:         `Bearer ${doc.accessToken}`,
        'Content-Type':        'application/json',
        'X-Cafe24-Api-Version': CAFE24_API_VERSION,
      },
      timeout: 15000
    });
    return resp.data;
  } catch (err) {
    if (err.response?.status === 401 && doc.refreshToken) {
      const newAccess = await refreshAccessToken(mallId, doc.refreshToken);
      const retry = await axios({
        method, url, data, params,
        headers: {
          Authorization:         `Bearer ${newAccess}`,
          'Content-Type':        'application/json',
          'X-Cafe24-Api-Version': CAFE24_API_VERSION,
        }
      });
      return retry.data;
    }
    throw err;
  }
}

// ========================
// API: mall install check (used by front Redirect.jsx)
// ========================
app.get('/api/:mallId/mall', async (req, res) => {
  const { mallId } = req.params;
  try {
    const doc = await db.collection('token').findOne({ mallId });
    if (doc && doc.accessToken) {
      return res.json({
        installed: true,
        mallId,
        userId: doc.userId || null,
        userName: doc.userName || null
      });
    }

    const redirectUri = `${APP_URL.replace(/\/$/, '')}/auth/callback`;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     CAFE24_CLIENT_ID,
      redirect_uri:  redirectUri,
      scope:         SCOPES,
      state:         mallId,
    }).toString();
    const installUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params}`;

    console.log(`[API BLOCK] API request blocked because not installed: mallId=${mallId} -> ${installUrl}`);

    return res.json({ installed: false, mallId, installUrl });
  } catch (err) {
    console.error('[MALL CHECK ERROR]', err);
    return res.status(500).json({ error: 'mall check failed' });
  }
});

// ------- remaining endpoints (events, track, categories etc) -------
// Insert your existing endpoints (events CRUD, track, coupons, analytics, uploads...) here.
// For brevity I'll include the core upload and event examples — but you should paste all your prior handlers
// (Exactly as in your working code) under this section so nothing is lost.

// Image upload example
app.post('/api/:mallId/uploads/image', upload.single('file'), async (req, res) => {
  try {
    const { mallId } = req.params;
    const { filename, path: localPath, mimetype } = req.file;
    const key = `uploads/${mallId}/${filename}`;

    await s3Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key:    key,
      Body:   fs.createReadStream(localPath),
      ContentType: mimetype,
      ACL:    'public-read'
    }));
    fs.unlink(localPath, () => {});
    const url = `${R2_PUBLIC_BASE}/${key}`;
    res.json({ url });
  } catch (err) {
    console.error('[IMAGE UPLOAD ERROR]', err);
    res.status(500).json({ error: '이미지 업로드 실패' });
  }
});

// Example events endpoints (you already had full implementations — paste them here)
app.post('/api/:mallId/events', async (req, res) => {
  // ... your full events create logic here (copy from your working code)
  // For safety: ensure you didn't accidentally remove any of these endpoints in your current file.
  res.status(501).json({ error: 'events create placeholder - paste your original code here' });
});

// ===================================================================
// start
// ===================================================================
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`▶️ Server running at ${APP_URL} (port ${PORT})`);
    });
  })
  .catch(err => {
    console.error('❌ 초기화 실패:', err);
    process.exit(1);
  });
