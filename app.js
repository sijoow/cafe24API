// app.js (빠른 적용용 전체 파일)
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
const sharp = require('sharp');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

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
  DEBUG_HMAC = 'false',
  DEBUG_ALLOW_INSTALL = 'false'
} = process.env;

if (!CAFE24_CLIENT_ID || !CAFE24_CLIENT_SECRET) {
  console.warn('⚠️ CAFE24_CLIENT_ID or CAFE24_CLIENT_SECRET is missing. OAuth/HMAC will fail without them.');
}
if (!APP_URL) {
  console.warn('⚠️ APP_URL is not set. redirect_uri must match the registered value in Cafe24 developers.');
}

const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ─── MongoDB 연결 ───────────────────────────────────────────────
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  await db.collection('token').createIndex({ mallId: 1 }, { unique: true });
  console.log('▶️ MongoDB connected to', DB_NAME);
}

// ─── Multer (파일 업로드 임시저장) ─────────────────────────────────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('jpg, png, gif, webp만 업로드 가능합니다.'));
    }
    cb(null, true);
  }
});

// ─── R2 (AWS S3 호환) 클라이언트 ─────────────────────────────────
const s3Client = new S3Client({
  region:   R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId:     R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
  forcePathStyle: true,
});

// ──────────────────────────────────────────────────────────────────
// Helper: base64url encode/decode & state create/verify (HMAC signed)
// ──────────────────────────────────────────────────────────────────
function base64urlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function createStateToken(mallId) {
  if (!CAFE24_CLIENT_SECRET) throw new Error('CAFE24_CLIENT_SECRET required to create state token');
  const payload = {
    mallId,
    nonce: crypto.randomBytes(12).toString('hex'),
    exp: Date.now() + 10 * 60 * 1000 // 10 minutes
  };
  const encoded = base64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', CAFE24_CLIENT_SECRET).update(encoded).digest('hex');
  return `${encoded}.${sig}`;
}

function verifyStateToken(state) {
  if (!state) return null;
  if (!CAFE24_CLIENT_SECRET) throw new Error('CAFE24_CLIENT_SECRET required to verify state token');
  const parts = String(state).split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expected = crypto.createHmac('sha256', CAFE24_CLIENT_SECRET).update(encoded).digest('hex');
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(sig, 'hex');
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
  } catch (err) {
    return null;
  }
  try {
    const payload = JSON.parse(base64urlDecode(encoded));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────
// Cafe24 HMAC 검증 헬퍼
// ──────────────────────────────────────────────────────────────────
function computeHmacBase64(message) {
  return crypto.createHmac('sha256', String(CAFE24_CLIENT_SECRET)).update(message).digest('base64');
}
function safeBufferCompare(aStr, bStr) {
  try {
    const a = Buffer.from(aStr);
    const b = Buffer.from(bStr);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}
function verifyCafe24Hmac(query) {
  if (!CAFE24_CLIENT_SECRET) return { ok: false, reason: 'no_secret' };
  let providedRaw = query.hmac || query.signature || '';
  if (!providedRaw) return { ok: false, reason: 'no_hmac' };
  try { providedRaw = decodeURIComponent(providedRaw); } catch (e) { /* ignore */ }
  const q = { ...query };
  delete q.hmac;
  delete q.signature;
  const keys = Object.keys(q).sort();
  const candidates = [];
  candidates.push(keys.map(k => `${k}=${q[k]}`).join('&'));
  candidates.push(keys.map(k => `${k}=${encodeURIComponent(String(q[k]))}`).join('&'));
  candidates.push(keys.map(k => {
    try { return `${k}=${decodeURIComponent(String(q[k]))}`; } catch (e) { return `${k}=${q[k]}`; }
  }).join('&'));
  candidates.push(keys.map(k => `${k}=${String(q[k]).trim()}`).join('&'));
  for (let i = 0; i < candidates.length; i++) {
    const msg = candidates[i];
    const digest = computeHmacBase64(msg);
    if (safeBufferCompare(digest, providedRaw)) {
      return { ok: true, method: `candidate_${i}`, message: msg, digest };
    }
    const urlsafe = digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (safeBufferCompare(urlsafe, providedRaw)) {
      return { ok: true, method: `candidate_${i}_urlsafe`, message: msg, digest };
    }
  }
  return { ok: false, reason: 'no_match', candidates };
}

// ──────────────────────────────────────────────────────────────────
// Helper: mallId resolution & ensureInstalled middleware
// ──────────────────────────────────────────────────────────────────
function resolveMallIdFromReq(req) {
  const params = req.query || {};
  if (params.mall_id) return params.mall_id;
  if (params.mallId) return params.mallId;
  if (req.params && req.params.mallId) return req.params.mallId;
  if (req.headers['x-mall-id']) return req.headers['x-mall-id'];
  const ref = req.get('referer') || req.get('origin') || '';
  try {
    const u = new URL(ref);
    const host = u.hostname || '';
    const match = host.match(/^([^.]+)\.cafe24api\.com$/);
    if (match) return match[1];
  } catch (e) { }
  return null;
}

async function ensureInstalled(req, res, next) {
  try {
    const mallId = resolveMallIdFromReq(req);
    if (!mallId) {
      return res.status(400).send('mallId required (query param or header).');
    }
    const tokenDoc = await db.collection('token').findOne({ mallId });
    if (!tokenDoc || !tokenDoc.accessToken) {
      return res.redirect(`/install/${mallId}`);
    }
    req.mallId = mallId;
    req.mallTokenDoc = tokenDoc;
    return next();
  } catch (err) {
    console.error('[ENSURE INSTALLED ERROR]', err);
    return res.status(500).send('Server error checking installation.');
  }
}

// ===================================================================
// DEBUG: HMAC 검사용 엔드포인트 (개발)
// ===================================================================
if (String(DEBUG_HMAC) === 'true') {
  app.post('/debug/hmac', express.json(), (req, res) => {
    const q = req.body.query || {};
    const result = verifyCafe24Hmac(q);
    if (result.ok) {
      return res.json({ ok: true, method: result.method, message: result.message, digest: result.digest });
    }
    return res.json({ ok: false, reason: result.reason || 'no_match', candidates: result.candidates || [] });
  });
  console.log('⚠️ DEBUG_HMAC enabled: POST /debug/hmac');
}

// ===================================================================
// ENTRY: 카페24가 APP_URL로 호출했을 때 -> HMAC 검증 -> 설치/대시보드 분기
// ===================================================================
app.get('/', async (req, res) => {
  try {
    console.log('[ENTRY] query:', req.query);

    const v = verifyCafe24Hmac(req.query);
    if (!v.ok) {
      console.warn('[ENTRY] HMAC verification failed for query:', req.query, v);
      if (String(DEBUG_ALLOW_INSTALL) === 'true') {
        const mallId = req.query.mall_id || req.query.mallId;
        if (mallId) {
          console.log('[ENTRY] DEBUG_ALLOW_INSTALL enabled — redirecting to /install/:mallId');
          return res.redirect(`/install/${mallId}`);
        }
      }
      return res.status(400).send('Invalid request signature (hmac).');
    }

    const mallId = req.query.mall_id || req.query.mallId;
    if (!mallId) {
      console.warn('[ENTRY] mall_id not found in query');
      return res.status(400).send('mall_id is required.');
    }

    const tokenDoc = await db.collection('token').findOne({ mallId });
    if (!tokenDoc || !tokenDoc.accessToken) {
      return res.redirect(`/install/${mallId}`);
    }

    return res.redirect(`${APP_URL}/?mall_id=${encodeURIComponent(mallId)}&installed=1`);
  } catch (err) {
    console.error('[ENTRY ERROR]', err);
    return res.status(500).send('Server error on entry.');
  }
});

// ===================================================================
// ① 설치 → 권한요청 → 콜백 (code → 토큰) → DB 저장
// ===================================================================

// 설치 시작: mallId 기반 OAuth 권한 요청
app.get('/install/:mallId', (req, res) => {
  const { mallId } = req.params;
  if (!mallId) return res.status(400).send('mallId required');

  // MUST match exactly the Redirect URI registered in Cafe24 dev console
  const redirectUri = `${APP_URL}/auth/callback`;

  // scope must be space-separated
  const scope = [
    'mall.read_application',
    'mall.write_application',
    'mall.read_category',
    'mall.read_product',
    'mall.write_product',
    'mall.read_order',
    'mall.read_promotion',
    'mall.read_salesreport',
    'mall.read_analytics'
  ].join(' ');

  let state;
  try {
    state = createStateToken(mallId);
  } catch (err) {
    console.error('[STATE CREATE ERROR]', err);
    return res.status(500).send('Server misconfiguration: cannot create state token');
  }

  const secureFlag = APP_URL && APP_URL.startsWith('https');
  res.cookie('oauth_state', state, {
    httpOnly: true,
    secure: secureFlag,
    sameSite: 'none',
    maxAge: 10 * 60 * 1000
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CAFE24_CLIENT_ID,
    redirect_uri: redirectUri,
    scope,
    state
  });

  return res.redirect(`https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params.toString()}`);
});

// ─── 이미지 업로드 (Multer + R2/S3) ─────────────────────────────────
app.post('/api/:mallId/uploads/image', upload.single('file'), async (req, res) => {
  try {
    const { mallId } = req.params;
    const { path: localPath, originalname, mimetype } = req.file;

    let buffer;
    let ext;
    let contentType;

    if (mimetype === 'image/gif') {
      buffer = fs.readFileSync(localPath);
      ext = '.gif';
      contentType = 'image/gif';
    } else {
      buffer = await sharp(localPath)
        .resize({ width: 1600, withoutEnlargement: true })
        .toFormat('webp', { quality: 80 })
        .toBuffer();
      ext = '.webp';
      contentType = 'image/webp';
    }

    const randomId = Date.now().toString() + '_' + crypto.randomBytes(8).toString('hex');
    const key      = `uploads/${mallId}/${randomId}${ext}`;

    await s3Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ACL: 'public-read',
    }));

    fs.unlink(localPath, () => {});

    const url = `${R2_PUBLIC_BASE}/${key}`;
    res.json({ url });

  } catch (err) {
    console.error('[IMAGE UPLOAD ERROR]', err);
    res.status(500).json({ error: '이미지 업로드 실패' });
  }
});

// 콜백 핸들러: code → 토큰 발급 → DB에 mallId별 저장 → 프런트로 리다이렉트
app.get('/auth/callback', async (req, res) => {
  const { code, state: returnedState } = req.query;
  const cookieState = req.cookies['oauth_state'];

  if (!code || !returnedState) {
    return res.status(400).send('code 또는 state가 없습니다.');
  }

  // cookie 존재 및 일치 확인
  if (!cookieState || cookieState !== returnedState) {
    console.warn('[AUTH CALLBACK] state cookie mismatch or missing');
    return res.status(400).send('Invalid OAuth state (cookie mismatch).');
  }

  let payload;
  try {
    payload = verifyStateToken(returnedState);
  } catch (err) {
    console.error('[STATE VERIFY ERROR]', err);
    return res.status(400).send('Invalid OAuth state (verification failed).');
  }
  if (!payload || !payload.mallId) {
    return res.status(400).send('Invalid or expired state token.');
  }
  const mallId = payload.mallId;

  try {
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

    // shop info fetch (optional, helpful for front)
    let shopInfo = null;
    try {
      const shopRes = await apiRequest(mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/shops`, {}, { shop_no: 1 });
      shopInfo = shopRes.shop || shopRes.shops?.[0] || null;
    } catch (err) {
      console.warn('[SHOP INFO FETCH WARN]', err.message || err);
    }

    await db.collection('token').updateOne(
      { mallId },
      {
        $set: {
          mallId,
          accessToken:  data.access_token,
          refreshToken: data.refresh_token,
          obtainedAt:   new Date(),
          expiresIn:    data.expires_in,
          installedAt:  new Date(),
          shopInfo,
          active: true
        }
      },
      { upsert: true }
    );

    res.clearCookie('oauth_state');

    try {
      await registerWebhooksForMall(mallId);
    } catch (err) {
      console.warn('[WEBHOOK REGISTER WARN]', err.message || err);
    }

    console.log(`[AUTH CALLBACK] App installed for mallId: ${mallId}`);

    // <-- 중요: 프런트의 Redirect.jsx가 mall_id 파라미터를 기대하므로 아래로 리다이렉트
    return res.redirect(`${APP_URL}/?mall_id=${encodeURIComponent(mallId)}&installed=1`);
  } catch (err) {
    console.error('[AUTH CALLBACK ERROR]', err.response?.data || err);
    return res.status(500).send('토큰 교환 중 오류가 발생했습니다.');
  }
});

// ===================================================================
// ② mallId-aware API 요청 헬퍼
// ===================================================================
async function refreshAccessToken(mallId, refreshToken) {
  const url = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
  const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken
  }).toString();

  const { data } = await axios.post(url, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`
    }
  });

  await db.collection('token').updateOne(
    { mallId },
    { $set: {
        accessToken:  data.access_token,
        refreshToken: data.refresh_token,
        obtainedAt:   new Date(),
        expiresIn:    data.expires_in
      }
    }
  );

  return data.access_token;
}

async function apiRequest(mallId, method, url, data = {}, params = {}) {
  const doc = await db.collection('token').findOne({ mallId });
  if (!doc) {
    const err = new Error(`토큰 정보 없음: mallId=${mallId}`);
    err.code = 'NO_TOKEN';
    err.status = 401;
    throw err;
  }

  try {
    const resp = await axios({
      method, url, data, params,
      headers: {
        Authorization:         `Bearer ${doc.accessToken}`,
        'Content-Type':        'application/json',
        'X-Cafe24-Api-Version': CAFE24_API_VERSION,
      }
    });
    return resp.data;
  } catch (err) {
    if (err.response?.status === 401) {
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

// ===================================================================
// ③ mallId-aware 전용 엔드포인트: (추가) /api/:mallId/mall
//    프런트 Redirect.jsx가 설치 직후 호출하므로 간단한 설치/상점 정보 제공
// ===================================================================
app.get('/api/:mallId/mall', async (req, res) => {
  const { mallId } = req.params;
  try {
    const tokenDoc = await db.collection('token').findOne({ mallId });
    if (!tokenDoc) {
      // 미설치 상태라도 mallId 응답 (프런트는 이걸 저장하고 설치 유도 가능)
      return res.json({ mallId });
    }
    const shopInfo = tokenDoc.shopInfo || {};
    // 가능한 필드: shop_no, shop_name, owner_name, seller_id 등 (API 응답마다 다름)
    return res.json({
      mallId,
      userId: shopInfo.user_id || shopInfo.seller_id || tokenDoc.shopInfo?.shop_no || null,
      userName: shopInfo.shop_name || shopInfo.owner_name || null,
      installed: true
    });
  } catch (err) {
    console.error('[GET MALL INFO ERROR]', err);
    res.status(500).json({ error: '상점 정보 조회 실패' });
  }
});

// (0) 기본 Ping
app.get('/api/:mallId/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// --- (나머지 기존 엔드포인트들) ---
// (생략하지 않고 전체 앱을 이미 제공했으므로 필요하시면 기존 엔드포인트들을 그대로 붙여넣으세요.)
// ... (events, analytics, products 등 기존 라우트가 이 파일 전체에 포함되어야 합니다)
// 위 예제에서는 이미 앞서 제공된 전체 코드에 변경된 부분(install/auth/callback/api/:mallId/mall)만 반영했습니다.

// ===================================================================
// 웹훅 등록 헬퍼 (선택)
// ===================================================================
async function registerWebhooksForMall(mallId) {
  const exist = await db.collection('webhooks').findOne({ mallId, service: 'order_created' });
  if (exist) return;

  const webhookPayload = {
    webhook: {
      topic: 'order.created',
      address: `${APP_URL}/webhook/order`,
      format: 'json',
      active: true
    }
  };

  try {
    const url = `https://${mallId}.cafe24api.com/api/v2/admin/webhooks`;
    const res = await apiRequest(mallId, 'POST', url, webhookPayload);
    await db.collection('webhooks').insertOne({ mallId, service: 'order_created', createdAt: new Date(), meta: res });
    console.log('[WEBHOOK REGISTERED]', mallId);
  } catch (err) {
    console.warn('[WEBHOOK REGISTER ERROR]', err.response?.data || err.message || err);
  }
}

// ===================================================================
// 서버 시작
// ===================================================================
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`▶️ Server running at ${APP_URL} (port ${PORT})`);
      if (String(DEBUG_HMAC) === 'true') console.log('⚠️ HMAC debug endpoint enabled: POST /debug/hmac');
      if (String(DEBUG_ALLOW_INSTALL) === 'true') console.log('⚠️ DEBUG_ALLOW_INSTALL enabled');
    });
  })
  .catch(err => {
    console.error('❌ 초기화 실패:', err);
    process.exit(1);
  });
