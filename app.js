// app.js
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
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
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
  region: R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY,
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
// - Cafe24에서 전달한 쿼리(예: mall_id, user_id, timestamp, ...)에서 hmac 파라미터를 제외한
//   나머지 쿼리 문자열을 사전식 키 정렬 후 "key=value&..." 형태로 연결하여
//   CAFE24_CLIENT_SECRET 으로 HMAC-SHA256(base64) 계산 후 비교합니다.
// - (사양이 바뀔 수 있으니 실패 시 Cafe24 문서의 HMAC 생성 규칙을 확인하세요)
function verifyCafe24Hmac(query) {
  if (!CAFE24_CLIENT_SECRET) return false;
  const providedRaw = query.hmac || query.signature || '';
  if (!providedRaw) return false;
  // provided may be URL-encoded (like %3D), decode it
  const provided = decodeURIComponent(providedRaw);

  // copy and remove hmac/signature
  const q = { ...query };
  delete q.hmac;
  delete q.signature;

  // sort keys lexicographically
  const keys = Object.keys(q).sort();
  // build message string: key=value&key2=value2 ...
  // Use the raw values as received (not re-encoded) - this matches many HMAC schemes.
  const pieces = keys.map(k => `${k}=${q[k]}`);
  const message = pieces.join('&');

  const digest = crypto.createHmac('sha256', CAFE24_CLIENT_SECRET).update(message).digest('base64');

  // timing-safe compare
  try {
    const a = Buffer.from(digest);
    const b = Buffer.from(provided);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
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
  // try origin/referrer parsing (if contains {mallId}.cafe24api.com)
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
// ENTRY: 루트(또는 onimon.shop로 Cafe24가 호출했을 때) -> HMAC 검증 -> 설치/대시보드 분기
// ===================================================================
app.get('/', async (req, res) => {
  try {
    // 1) 로그(디버그용)
    console.log('[ENTRY] query:', req.query);

    // 2) HMAC 검증: 실패하면 400 (or 설치 플로우 생략하고 대시보드 열어줄지 결정)
    const ok = verifyCafe24Hmac(req.query);
    if (!ok) {
      console.warn('[ENTRY] HMAC verification failed for query:', req.query);
      // 보안 상 검증 실패하면 기본적으로 거부.
      return res.status(400).send('Invalid request signature (hmac).');
    }

    // 3) mall_id 추출 (sample uses mall_id)
    const mallId = req.query.mall_id || req.query.mallId;
    if (!mallId) {
      console.warn('[ENTRY] mall_id not found in query');
      return res.status(400).send('mall_id is required.');
    }

    // 4) 토큰 존재 확인 -> 없으면 설치 플로우로 리다이렉트(권한동의)
    const tokenDoc = await db.collection('token').findOne({ mallId });
    if (!tokenDoc || !tokenDoc.accessToken) {
      // 설치되지 않음 -> 설치 시작
      return res.redirect(`/install/${mallId}`);
    }

    // 5) 이미 설치되어 있으면 대시보드(또는 앱 진입)으로 보냄
    const forward = `${APP_URL}/dashboard?mall_id=${encodeURIComponent(mallId)}&installed=1`;
    return res.redirect(forward);
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

  // redirect_uri must exactly match the value registered in Cafe24 dev console
  const redirectUri = `${APP_URL}/auth/callback`;

  // scope should be space-separated (not comma)
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

  // create signed state token (contains mallId + nonce + expiry)
  let state;
  try {
    state = createStateToken(mallId);
  } catch (err) {
    console.error('[STATE CREATE ERROR]', err);
    return res.status(500).send('Server misconfiguration: cannot create state token');
  }

  // store state in HttpOnly cookie (bind browser) — expires short
  const secureFlag = APP_URL && APP_URL.startsWith('https');
  res.cookie('oauth_state', state, {
    httpOnly: true,
    secure: secureFlag,
    sameSite: 'lax',
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
// POST /api/:mallId/uploads/image
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
    const key = `uploads/${mallId}/${randomId}${ext}`;

    await s3Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ACL: 'public-read',
    }));

    fs.unlink(localPath, () => { }); // 임시 파일 삭제

    const url = `${R2_PUBLIC_BASE}/${key}`;
    res.json({ url });

  } catch (err) {
    console.error('[IMAGE UPLOAD ERROR]', err);
    res.status(500).json({ error: '이미지 업로드 실패' });
  }
});

// 콜백 핸들러: code → 토큰 발급 → DB에 mallId별 저장 → onimon.shop 으로 리다이렉트
app.get('/auth/callback', async (req, res) => {
  const { code, state: returnedState } = req.query;
  const cookieState = req.cookies['oauth_state'];

  if (!code || !returnedState) {
    return res.status(400).send('code 또는 state가 없습니다.');
  }

  // 1) cookie 존재 및 일치 확인 (bind to browser/session)
  if (!cookieState || cookieState !== returnedState) {
    console.warn('[AUTH CALLBACK] state cookie mismatch or missing');
    return res.status(400).send('Invalid OAuth state (cookie mismatch).');
  }

  // 2) verify signature + expiry and extract mallId
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
    const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${APP_URL}/auth/callback`
    }).toString();

    const { data } = await axios.post(tokenUrl, body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`
      }
    });

    // ==== 추가: 설치 시점에 상점(Shop) 정보 조회하여 token 문서에 저장 ====
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
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          obtainedAt: new Date(),
          expiresIn: data.expires_in,
          installedAt: new Date(),
          shopInfo,
          active: true
        }
      },
      { upsert: true }
    );

    // clear oauth_state cookie
    res.clearCookie('oauth_state');

    // ==== (옵션) 설치 직후에 웹훅 등록 ====
    try {
      await registerWebhooksForMall(mallId);
    } catch (err) {
      console.warn('[WEBHOOK REGISTER WARN]', err.message || err);
    }

    console.log(`[AUTH CALLBACK] App installed for mallId: ${mallId}`);

    // redirect to frontend/onboarding page
    return res.redirect(`${APP_URL}/dashboard?mall_id=${encodeURIComponent(mallId)}&installed=1`);
  } catch (err) {
    console.error('[AUTH CALLBACK ERROR]', err.response?.data || err.message || err);
    return res.status(500).send('토큰 교환 중 오류가 발생했습니다.');
  }
});

// ===================================================================
// ② mallId-aware API 요청 헬퍼
// ===================================================================

// refresh token → access token 갱신
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

  await db.collection('token').updateOne(
    { mallId },
    {
      $set: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        obtainedAt: new Date(),
        expiresIn: data.expires_in
      }
    }
  );

  return data.access_token;
}

// mallId 기준으로 토큰 조회 → API 호출 → 401시 refresh → 재시도
async function apiRequest(mallId, method, url, data = {}, params = {}) {
  const doc = await db.collection('token').findOne({ mallId });
  if (!doc) throw new Error(`토큰 정보 없음: mallId=${mallId}`);

  try {
    const resp = await axios({
      method, url, data, params,
      headers: {
        Authorization: `Bearer ${doc.accessToken}`,
        'Content-Type': 'application/json',
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
          Authorization: `Bearer ${newAccess}`,
          'Content-Type': 'application/json',
          'X-Cafe24-Api-Version': CAFE24_API_VERSION,
        }
      });
      return retry.data;
    }
    throw err;
  }
}

// ===================================================================
// ③ mallId-aware 전용 엔드포인트 모음
// ===================================================================

// (Launch) 앱 진입점: 설치 확인 후 대시보드로 이동
app.get('/app/launch', ensureInstalled, (req, res) => {
  const mallId = req.mallId;
  return res.redirect(`${APP_URL}/dashboard?mall_id=${encodeURIComponent(mallId)}`);
});

// (0) 기본 Ping
app.get('/api/:mallId/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

//게시판 생성 갯수 
const MAX_BOARDS_PER_MALL = 10;  // 최대 10개까지만 생성 허용

// ─── 생성
app.post('/api/:mallId/events', async (req, res) => {
  const { mallId } = req.params;
  const payload = req.body;
  //게시판 생성제한
  try {
    const existingCount = await db
      .collection('events')
      .countDocuments({ mallId });
    if (existingCount >= MAX_BOARDS_PER_MALL) {
      return res
        .status(400)
        .json({ error: `최대 ${MAX_BOARDS_PER_MALL}개의 게시물만 등록할 수 있습니다.` });
    }
  } catch (err) {
    console.error('[COUNT CHECK ERROR]', err);
    return res
      .status(500)
      .json({ error: '생성 가능 개수 확인 중 오류가 발생했습니다.' });
  }

  // 필수: 제목
  if (!payload.title || typeof payload.title !== 'string') {
    return res.status(400).json({ error: '제목(title)을 입력해주세요.' });
  }
  // 필수: images
  if (!Array.isArray(payload.images)) {
    return res.status(400).json({ error: 'images를 배열로 보내주세요.' });
  }

  try {
    const now = new Date();
    const doc = {
      mallId,
      title: payload.title.trim(),
      content: payload.content || '',
      images: payload.images,
      gridSize: payload.gridSize || null,
      layoutType: payload.layoutType || 'none',
      classification: payload.classification || {},
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection('events').insertOne(doc);
    res.json({ _id: result.insertedId, ...doc });
  } catch (err) {
    console.error('[CREATE EVENT ERROR]', err);
    res.status(500).json({ error: '이벤트 생성에 실패했습니다.' });
  }
});

// ─── 목록 조회
app.get('/api/:mallId/events', async (req, res) => {
  const { mallId } = req.params;
  try {
    const list = await db
      .collection('events')
      .find({ mallId })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(list);
  } catch (err) {
    console.error('[GET EVENTS ERROR]', err);
    res.status(500).json({ error: '이벤트 목록 조회에 실패했습니다.' });
  }
});

// ─── 단건 조회
app.get('/api/:mallId/events/:id', async (req, res) => {
  const { mallId, id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
  }
  try {
    const ev = await db.collection('events').findOne({
      _id: new ObjectId(id),
      mallId
    });
    if (!ev) {
      return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    }
    res.json(ev);
  } catch (err) {
    console.error('[GET EVENT ERROR]', err);
    res.status(500).json({ error: '이벤트 조회에 실패했습니다.' });
  }
});

// ─── 수정
app.put('/api/:mallId/events/:id', async (req, res) => {
  const { mallId, id } = req.params;
  const payload = req.body;

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
  }
  if (!payload.title && !payload.content && !payload.images) {
    return res.status(400).json({ error: '수정할 내용을 하나 이상 보내주세요.' });
  }

  const update = { updatedAt: new Date() };
  if (payload.title) update.title = payload.title.trim();
  if (payload.content) update.content = payload.content;
  if (Array.isArray(payload.images)) update.images = payload.images;
  if (payload.gridSize !== undefined) update.gridSize = payload.gridSize;
  if (payload.layoutType) update.layoutType = payload.layoutType;
  if (payload.classification) update.classification = payload.classification;

  try {
    const result = await db.collection('events').updateOne(
      { _id: new ObjectId(id), mallId },
      { $set: update }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
    }
    const updated = await db.collection('events').findOne({ _id: new ObjectId(id) });
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[UPDATE EVENT ERROR]', err);
    res.status(500).json({ error: '이벤트 수정에 실패했습니다.' });
  }
});

// ─── 삭제 (cascade delete + 이미지 삭제) ──────────────────────────────
app.delete('/api/:mallId/events/:id', async (req, res) => {
  const { mallId, id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
  }

  try {
    // 1. 이벤트 문서 조회
    const eventDoc = await db.collection('events').findOne({ _id: new ObjectId(id), mallId });
    if (!eventDoc) return res.status(404).json({ error: '이벤트 없음' });

    // 2. R2 이미지 Key 추출 함수
    const extractR2Key = (urlStr) => {
      try {
        const url = new URL(urlStr);
        const key = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
        return decodeURIComponent(key);
      } catch (err) {
        console.warn('[URL PARSE ERROR]', urlStr, err.message);
        return null;
      }
    };

    // 3. 이미지 Key 목록 추출
    const imageKeys = (eventDoc.images || [])
      .map(img => extractR2Key(img.src || img.url))
      .filter(Boolean);

    console.log('🧹 삭제 대상 이미지 Key:', imageKeys);

    // 4. R2에서 이미지 삭제
    if (imageKeys.length > 0) {
      await Promise.all(
        imageKeys.map(key =>
          s3Client.send(new DeleteObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
          })).catch(err => {
            console.warn(`[R2 DELETE ERROR] ${key}:`, err.message);
          })
        )
      );
    }

    // 5. 이벤트 문서 삭제
    await db.collection('events').deleteOne({ _id: new ObjectId(id), mallId });

    res.json({ success: true });

  } catch (err) {
    console.error('[DELETE EVENT ERROR]', err);
    res.status(500).json({ error: '삭제 중 오류 발생' });
  }
});

// (8) 트래킹 저장중
app.post('/api/:mallId/track', async (req, res) => {
  try {
    const { mallId } = req.params;
    const {
      pageId, pageUrl, visitorId, referrer,
      device, type, element, timestamp,
      productNo
    } = req.body;

    // 1) 필수 필드 체크
    if (!pageId || !visitorId || !type || !timestamp) {
      return res.status(400).json({ error: '필수 필드 누락' });
    }
    if (!ObjectId.isValid(pageId)) {
      return res.sendStatus(204);
    }

    // 2) 이벤트 존재 여부 확인
    const ev = await db.collection('events')
      .findOne({ _id: new ObjectId(pageId) }, { projection: { _id: 1 } });
    if (!ev) {
      return res.sendStatus(204);
    }

    // 3) 시간 처리 (KST) 및 dateKey 생성
    const kstTs = dayjs(timestamp).tz('Asia/Seoul').toDate();
    const dateKey = dayjs(timestamp).tz('Asia/Seoul').format('YYYY-MM-DD');

    // 4) URL path 분리
    let pathOnly;
    try {
      pathOnly = new URL(pageUrl).pathname;
    } catch {
      pathOnly = pageUrl;
    }

    // 5) 상품 클릭: prdClick_{mallId} 컬렉션에 upsert (상품명 포함)
    if (type === 'click' && element === 'product' && productNo) {
      let productName = null;
      try {
        const productRes = await apiRequest(
          mallId,
          'GET',
          `https://${mallId}.cafe24api.com/api/v2/admin/products/${productNo}`,
          {},
          { shop_no: 1 }
        );
        const prod = productRes.product || productRes.products?.[0];
        productName = prod?.product_name || null;
      } catch (err) {
        console.error('[PRODUCT NAME FETCH ERROR]', err);
      }

      const filter = { pageId, productNo };
      const update = {
        $inc: { clickCount: 1 },
        $setOnInsert: {
          productName,
          firstClickAt: kstTs,
          pageUrl: pathOnly,
          referrer: referrer || null,
          device: device || null
        },
        $set: { lastClickAt: kstTs }
      };
      await db
        .collection(`prdClick_${mallId}`)
        .updateOne(filter, update, { upsert: true });
      return res.sendStatus(204);
    }

    // 6) 기타 클릭 (URL, 쿠폰 등): clicks_{mallId} 컬렉션에 insert
    if (type === 'click') {
      // 6-1) 쿠폰 클릭: productNo가 배열일 수 있으므로 배열/단일 처리
      if (element === 'coupon') {
        const coupons = Array.isArray(productNo) ? productNo : [productNo];
        await Promise.all(coupons.map(cpn => {
          const clickDoc = {
            pageId,
            visitorId,
            dateKey,
            pageUrl: pathOnly,
            referrer: referrer || null,
            device: device || null,
            type,
            element,
            timestamp: kstTs,
            couponNo: cpn
          };
          return db.collection(`clicks_${mallId}`).insertOne(clickDoc);
        }));
        return res.sendStatus(204);
      }

      // 6-2) URL 클릭 전용 처리
      if (element === 'url') {
        const clickDoc = {
          pageId,
          visitorId,
          dateKey,
          pageUrl: pathOnly,
          referrer: referrer || null,
          device: device || null,
          type,
          element,
          timestamp: kstTs
        };
        await db.collection(`clicks_${mallId}`).insertOne(clickDoc);
        return res.sendStatus(204);
      }

      // 6-3) 그 외 기타 클릭
      const clickDoc = {
        pageId,
        visitorId,
        dateKey,
        pageUrl: pathOnly,
        referrer: referrer || null,
        device: device || null,
        type,
        element,
        timestamp: kstTs
      };
      await db.collection(`clicks_${mallId}`).insertOne(clickDoc);
      return res.sendStatus(204);
    }

    // 7) view/revisit: visits_{mallId} 컬렉션에 upsert
    const filter2 = { pageId, visitorId, dateKey };
    const update2 = {
      $set: {
        lastVisit: kstTs,
        pageUrl: pathOnly,
        referrer: referrer || null,
        device: device || null
      },
      $setOnInsert: { firstVisit: kstTs },
      $inc: {}
    };
    if (type === 'view') update2.$inc.viewCount = 1;
    if (type === 'revisit') update2.$inc.revisitCount = 1;

    await db
      .collection(`visits_${mallId}`)
      .updateOne(filter2, update2, { upsert: true });

    return res.sendStatus(204);
  } catch (err) {
    console.error('[TRACK ERROR]', err);
    return res.status(500).json({ error: '트래킹 실패' });
  }
});

// (9) 카테고리 전체 조회
app.get('/api/:mallId/categories/all', async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/categories`;
      const { categories } = await apiRequest(mallId, 'GET', url, {}, { limit, offset });
      if (!categories.length) break;
      all.push(...categories);
      offset += categories.length;
    }
    res.json(all);
  } catch (err) {
    console.error('[CATEGORIES ERROR]', err);
    res.status(500).json({ message: '전체 카테고리 조회 실패', error: err.message });
  }
});

// (10) 쿠폰 전체 조회
app.get('/api/:mallId/coupons', async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons } = await apiRequest(mallId, 'GET', url, {}, { shop_no: 1, limit, offset });
      if (!coupons.length) break;
      all.push(...coupons);
      offset += coupons.length;
    }
    res.json(all);
  } catch (err) {
    console.error('[COUPONS ERROR]', err);
    res.status(500).json({ message: '쿠폰 조회 실패', error: err.message });
  }
});

// ─── 쿠폰 통계 조회 (발급·사용·미사용·자동삭제 + 절대 이름 확보) ─────────────────────────
app.get('/api/:mallId/analytics/:pageId/coupon-stats', async (req, res) => {
  const { mallId } = req.params;
  const { coupon_no, start_date, end_date } = req.query;
  if (!coupon_no) {
    return res.status(400).json({ error: 'coupon_no is required' });
  }

  const shop_no = 1;
  const couponNos = coupon_no.split(',');
  const now = new Date();
  const results = [];

  try {
    for (const no of couponNos) {
      // 1) 무조건 singular 리스트 API로 쿠폰명 조회
      let couponName = '(이름없음)';
      try {
        const nameRes = await apiRequest(
          mallId, 'GET',
          `https://${mallId}.cafe24api.com/api/v2/admin/coupons`,
          {},
          {
            shop_no,
            coupon_no: no,
            coupon_status: 'ALL',
            fields: 'coupon_no,coupon_name',
            limit: 1
          }
        );
        couponName = nameRes.coupons?.[0]?.coupon_name || couponName;
      } catch {
        // fallback 그대로 '(이름없음)'
      }

      // 2) issue 이력 페이지네이션 돌며 발급/사용/미사용/자동삭제 집계
      let issued = 0, used = 0, unused = 0, autoDel = 0;
      const pageSize = 500;
      for (let offset = 0; ; offset += pageSize) {
        const issuesRes = await apiRequest(
          mallId, 'GET',
          `https://${mallId}.cafe24api.com/api/v2/admin/coupons/${no}/issues`,
          {},
          {
            shop_no,
            limit: pageSize,
            offset,
            issued_start_date: start_date,
            issued_end_date: end_date
          }
        );
        const issues = issuesRes.issues || [];
        if (issues.length === 0) break;

        for (const item of issues) {
          issued++;
          if (item.used_coupon === 'T') {
            used++;
          } else {
            const exp = item.expiration_date ? new Date(item.expiration_date) : null;
            if (exp && exp < now) autoDel++;
            else unused++;
          }
        }
      }

      results.push({
        couponNo: no,
        couponName,
        issuedCount: issued,
        usedCount: used,
        unusedCount: unused,
        autoDeletedCount: autoDel
      });
    }

    return res.json(results);
  } catch (err) {
    console.error('[COUPON-STATS ERROR]', err);
    return res.status(500).json({
      error: '쿠폰 통계 조회 실패',
      message: err.response?.data?.message || err.message
    });
  }
});

// (11) 카테고리별 상품 조회 + 다중 쿠폰 로직
app.get('/api/:mallId/categories/:category_no/products', async (req, res) => {
  const { mallId, category_no } = req.params;
  try {
    const coupon_query = req.query.coupon_no || '';
    const coupon_nos = coupon_query ? coupon_query.split(',') : [];
    const limit = parseInt(req.query.limit, 10) || 100;
    const offset = parseInt(req.query.offset, 10) || 0;
    const shop_no = 1;
    const display_group = 1;

    // 0) 쿠폰 정보 조회
    const coupons = await Promise.all(coupon_nos.map(async no => {
      const urlCoupon = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons: arr } = await apiRequest(mallId, 'GET', urlCoupon, {}, {
        shop_no,
        coupon_no: no,
        fields: [
          'coupon_no',
          'available_product', 'available_product_list',
          'available_category', 'available_category_list',
          'benefit_amount', 'benefit_percentage'
        ].join(',')
      });
      return arr?.[0] || null;
    }));
    const validCoupons = coupons.filter(c => c);

    // 1) 카테고리-상품 매핑
    const urlCats = `https://${mallId}.cafe24api.com/api/v2/admin/categories/${category_no}/products`;
    const catRes = await apiRequest(mallId, 'GET', urlCats, {}, { shop_no, display_group, limit, offset });
    const sorted = (catRes.products || []).slice().sort((a, b) => a.sequence_no - b.sequence_no);
    const productNos = sorted.map(p => p.product_no);
    if (!productNos.length) return res.json([]);

    // 2) 상품 상세 조회
    const urlProds = `https://${mallId}.cafe24api.com/api/v2/admin/products`;
    const detailRes = await apiRequest(mallId, 'GET', urlProds, {}, {
      shop_no,
      product_no: productNos.join(','),
      limit: productNos.length
    });
    const details = detailRes.products || [];
    const detailMap = details.reduce((m, p) => { m[p.product_no] = p; return m; }, {});

    // 3) 즉시할인가 조회
    const discountMap = {};
    await Promise.all(productNos.map(async no => {
      const urlDis = `https://${mallId}.cafe24api.com/api/v2/admin/products/${no}/discountprice`;
      const { discountprice } = await apiRequest(mallId, 'GET', urlDis, {}, { shop_no });
      discountMap[no] = discountprice?.pc_discount_price != null
        ? parseFloat(discountprice.pc_discount_price)
        : null;
    }));

    const formatKRW = num => num != null
      ? Number(num).toLocaleString('ko-KR') + '원'
      : null;

    function calcCouponInfos(prodNo) {
      return validCoupons.map(coupon => {
        const pList = coupon.available_product_list || [];
        const prodOk = coupon.available_product === 'U'
          || (coupon.available_product === 'I' && pList.includes(prodNo))
          || (coupon.available_product === 'E' && !pList.includes(prodNo));
        const cList = coupon.available_category_list || [];
        const catOk = coupon.available_category === 'U'
          || (coupon.available_category === 'I' && cList.includes(parseInt(category_no, 10)))
          || (coupon.available_category === 'E' && !cList.includes(parseInt(category_no, 10)));
        if (!prodOk || !catOk) return null;
        const orig = parseFloat(detailMap[prodNo].price || 0);
        const pct = parseFloat(coupon.benefit_percentage || 0);
        const amt = parseFloat(coupon.benefit_amount || 0);
        let benefit_price = null;
        if (pct > 0) benefit_price = +(orig * (100 - pct) / 100).toFixed(2);
        else if (amt > 0) benefit_price = +(orig - amt).toFixed(2);
        if (benefit_price == null) return null;
        return { coupon_no: coupon.coupon_no, benefit_percentage: pct, benefit_price };
      }).filter(x => x).sort((a, b) => b.benefit_percentage - a.benefit_percentage);
    }

    const full = sorted.map(item => {
      const prod = detailMap[item.product_no];
      if (!prod) return null;
      return {
        product_no: item.product_no,
        product_name: prod.product_name,
        price: prod.price,
        summary_description: prod.summary_description,
        list_image: prod.list_image,
        sale_price: discountMap[item.product_no],
        couponInfos: calcCouponInfos(item.product_no)
      };
    }).filter(Boolean);

    const slim = full.map(p => {
      const infos = p.couponInfos || [];
      const first = infos.length ? infos[0] : null;
      return {
        product_no: p.product_no,
        product_name: p.product_name,
        price: formatKRW(parseFloat(p.price)),
        summary_description: p.summary_description,
        list_image: p.list_image,
        sale_price: (p.sale_price != null && +p.sale_price !== +p.price) ? formatKRW(p.sale_price) : null,
        benefit_price: first ? formatKRW(first.benefit_price) : null,
        benefit_percentage: first ? first.benefit_percentage : null,
        couponInfos: infos.length ? infos : null
      };
    });

    res.json(slim);
  } catch (err) {
    console.error('[CATEGORY PRODUCTS ERROR]', err);
    res.status(err.response?.status || 500).json({ message: '카테고리 상품 조회 실패', error: err.message });
  }
});

// (12) 전체 상품 조회 (페이징 + 검색)
app.get('/api/:mallId/products', async (req, res) => {
  const { mallId } = req.params;
  try {
    const shop_no = 1;
    const limit = parseInt(req.query.limit, 10) || 1000;
    const offset = parseInt(req.query.offset, 10) || 0;
    const q = (req.query.q || '').trim();
    const url = `https://${mallId}.cafe24api.com/api/v2/admin/products`;

    const params = { shop_no, limit, offset };
    if (q) params['search[product_name]'] = q;

    const data = await apiRequest(mallId, 'GET', url, {}, params);
    const slim = (data.products || []).map(p => ({
      product_no: p.product_no,
      product_code: p.product_code,
      product_name: p.product_name,
      price: p.price,
      list_image: p.list_image
    }));

    res.json({ products: slim, total: data.total_count });
  } catch (err) {
    console.error('[GET PRODUCTS ERROR]', err);
    res.status(500).json({ error: '전체 상품 조회 실패' });
  }
});

// (13) 단일 상품 조회 + 쿠폰할인가
app.get('/api/:mallId/products/:product_no', async (req, res) => {
  const { mallId, product_no } = req.params;
  try {
    const shop_no = 1;
    const coupon_query = req.query.coupon_no || '';
    const coupon_nos = coupon_query.split(',').filter(Boolean);

    // 기본 상품 정보
    const prodUrl = `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}`;
    const prodData = await apiRequest(mallId, 'GET', prodUrl, {}, { shop_no });
    const p = prodData.product || prodData.products?.[0];
    if (!p) return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });

    // 즉시할인가
    const disUrl = `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}/discountprice`;
    const disData = await apiRequest(mallId, 'GET', disUrl, {}, { shop_no });
    const rawSale = disData.discountprice?.pc_discount_price;
    const sale_price = rawSale != null ? parseFloat(rawSale) : null;

    // 쿠폰별 benefit 계산
    const coupons = await Promise.all(coupon_nos.map(async no => {
      const urlCoupon = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons: arr } = await apiRequest(mallId, 'GET', urlCoupon, {}, {
        shop_no,
        coupon_no: no,
        fields: [
          'coupon_no',
          'available_product', 'available_product_list',
          'available_category', 'available_category_list',
          'benefit_amount', 'benefit_percentage'
        ].join(',')
      });
      return arr?.[0] || null;
    }));
    const validCoupons = coupons.filter(c => c);
    let benefit_price = null, benefit_percentage = null;
    validCoupons.forEach(coupon => {
      const pList = coupon.available_product_list || [];
      const ok = coupon.available_product === 'U'
        || (coupon.available_product === 'I' && pList.includes(parseInt(product_no, 10)))
        || (coupon.available_product === 'E' && !pList.includes(parseInt(product_no, 10)));
      if (!ok) return;
      const orig = parseFloat(p.price);
      const pct = parseFloat(coupon.benefit_percentage || 0);
      const amt = parseFloat(coupon.benefit_amount || 0);
      let bPrice = null;
      if (pct > 0) bPrice = +(orig * (100 - pct) / 100).toFixed(2);
      else if (amt > 0) bPrice = +(orig - amt).toFixed(2);
      if (bPrice != null && pct > (benefit_percentage || 0)) {
        benefit_price = bPrice;
        benefit_percentage = pct;
      }
    });

    res.json({
      product_no,
      product_code: p.product_code,
      product_name: p.product_name,
      price: p.price,
      summary_description: p.summary_description || '',
      sale_price,
      benefit_price,
      benefit_percentage,
      list_image: p.list_image
    });
  } catch (err) {
    console.error('[GET PRODUCT ERROR]', err);
    res.status(500).json({ error: '단일 상품 조회 실패' });
  }
});

// (14) analytics: visitors-by-date 방문자 재방문자 Data
app.get('/api/:mallId/analytics/:pageId/visitors-by-date', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });
  }

  const startKey = start_date.slice(0, 10);
  const endKey = end_date.slice(0, 10);
  const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
  if (url) match.pageUrl = url;

  const pipeline = [
    { $match: match },
    { $group: {
      _id: { date: '$dateKey', visitorId: '$visitorId' },
      viewCount: { $sum: { $ifNull: ['$viewCount', 0] } },
      revisitCount: { $sum: { $ifNull: ['$revisitCount', 0] } }
    } },
    { $group: {
      _id: '$_id.date',
      totalVisitors: { $sum: 1 },
      newVisitors: { $sum: { $cond: [{ $gt: ['$viewCount', 0] }, 1, 0] } },
      returningVisitors: { $sum: { $cond: [{ $gt: ['$revisitCount', 0] }, 1, 0] } }
    } },
    { $project: {
      _id: 0,
      date: '$_id',
      totalVisitors: 1,
      newVisitors: 1,
      returningVisitors: 1,
      revisitRate: {
        $concat: [
          { $toString: {
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
          } },
          ' %'
        ]
      }
    } },
    { $sort: { date: 1 } }
  ];

  try {
    const stats = await db.collection(`visits_${mallId}`).aggregate(pipeline).toArray();
    res.json(stats);
  } catch (err) {
    console.error('[VISITORS-BY-DATE ERROR]', err);
    res.status(500).json({ error: '집계 중 오류가 발생했습니다.' });
  }
});

// ─── analytics: clicks-by-date (url / coupon 클릭 집계) ─────────────────────────────────────
app.get('/api/:mallId/analytics/:pageId/clicks-by-date', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });
  }

  const startKey = start_date.slice(0, 10);
  const endKey = end_date.slice(0, 10);

  const match = {
    pageId,
    dateKey: { $gte: startKey, $lte: endKey }
  };
  if (url) match.pageUrl = url;

  const pipeline = [
    { $match: match },
    { $group: {
      _id: { date: '$dateKey', element: '$element' },
      count: { $sum: 1 }
    } },
    { $group: {
      _id: '$_id.date',
      url: { $sum: { $cond: [{ $eq: ['$_id.element', 'url'] }, '$count', 0] } },
      product: { $sum: { $cond: [{ $eq: ['$_id.element', 'product'] }, '$count', 0] } },
      coupon: { $sum: { $cond: [{ $eq: ['$_id.element', 'coupon'] }, '$count', 0] } }
    } },
    { $project: {
      _id: 0,
      date: '$_id',
      'URL 클릭': '$url',
      'URL 클릭(기존 product)': '$product',
      '쿠폰 클릭': '$coupon'
    } },
    { $sort: { date: 1 } }
  ];
  try {
    const data = await db
      .collection(`clicks_${mallId}`)
      .aggregate(pipeline)
      .toArray();
    res.json(data);
  } catch (err) {
    console.error('[CLICKS-BY-DATE ERROR]', err);
    res.status(500).json({ error: '클릭 집계에 실패했습니다.' });
  }
});

// (16) analytics: url-clicks count
app.get('/api/:mallId/analytics/:pageId/url-clicks', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });

  const match = {
    pageId, type: 'click', element: 'product',
    timestamp: { $gte: new Date(start_date), $lte: new Date(end_date) }
  };
  if (url) match.pageUrl = url;

  try {
    const count = await db.collection(`visits_${mallId}`).countDocuments(match);
    res.json({ count });
  } catch (err) {
    console.error('[URL CLICKS COUNT ERROR]', err);
    res.status(500).json({ error: 'URL 클릭 수 조회 실패' });
  }
});

// (17) analytics: coupon-clicks count
app.get('/api/:mallId/analytics/:pageId/coupon-clicks', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });

  const match = {
    pageId, type: 'click', element: 'coupon',
    timestamp: { $gte: new Date(start_date), $lte: new Date(end_date) }
  };
  if (url) match.pageUrl = url;

  try {
    const count = await db.collection(`visits_${mallId}`).countDocuments(match);
    res.json({ count });
  } catch (err) {
    console.error('[COUPON CLICKS COUNT ERROR]', err);
    res.status(500).json({ error: '쿠폰 클릭 수 조회 실패' });
  }
});

// (18) analytics: distinct urls
app.get('/api/:mallId/analytics/:pageId/urls', async (req, res) => {
  const { mallId, pageId } = req.params;
  try {
    const urls = await db.collection(`visits_${mallId}`).distinct('pageUrl', { pageId });
    res.json(urls);
  } catch (err) {
    console.error('[URLS DISTINCT ERROR]', err);
    res.status(500).json({ error: 'URL 목록 조회 실패' });
  }
});

// (18-1) analytics: distinct couponNos for this page
app.get('/api/:mallId/analytics/:pageId/coupons-distinct', async (req, res) => {
  const { mallId, pageId } = req.params;
  try {
    const couponNos = await db
      .collection(`clicks_${mallId}`)
      .distinct('couponNo', { pageId, element: 'coupon' });
    res.json(couponNos);
  } catch (err) {
    console.error('[COUPONS-DISTINCT ERROR]', err);
    res.status(500).json({ error: '쿠폰 목록 조회 실패' });
  }
});

// (19) analytics: devices distribution
app.get('/api/:mallId/analytics/:pageId/devices', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });

  const startKey = start_date.slice(0, 10), endKey = end_date.slice(0, 10);
  const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
  if (url) match.pageUrl = url;

  const pipeline = [
    { $match: match },
    { $group: {
      _id: '$device',
      count: { $sum: { $add: [{ $ifNull: ['$viewCount', 0] }, { $ifNull: ['$revisitCount', 0] }] } }
    } },
    { $project: { _id: 0, device_type: '$_id', count: 1 } }
  ];

  try {
    const data = await db.collection(`visits_${mallId}`).aggregate(pipeline).toArray();
    res.json(data);
  } catch (err) {
    console.error('[ANALYTICS DEVICES ERROR]', err);
    res.status(500).json({ error: '디바이스 분포 집계 실패' });
  }
});

// (20) analytics: devices by date
app.get('/api/:mallId/analytics/:pageId/devices-by-date', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });

  const startKey = start_date.slice(0, 10), endKey = end_date.slice(0, 10);
  const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
  if (url) match.pageUrl = url;

  const pipeline = [
    { $match: match },
    { $group: {
      _id: { date: '$dateKey', device: '$device', visitor: '$visitorId' }
    } },
    { $group: {
      _id: { date: '$_id.date', device: '$_id.device' },
      count: { $sum: 1 }
    } },
    { $project: { _id: 0, date: '$_id.date', device: '$_id.device', count: 1 } },
    { $sort: { date: 1, device: 1 } }
  ];

  try {
    const data = await db.collection(`visits_${mallId}`).aggregate(pipeline).toArray();
    res.json(data);
  } catch (err) {
    console.error('[ANALYTICS DEVICES-BY-DATE ERROR]', err);
    res.status(500).json({ error: '날짜별 고유 디바이스 집계 실패' });
  }
});

// ─── analytics: product-clicks (게시판별 상품 클릭 랭킹)
app.get('/api/:mallId/analytics/:pageId/product-clicks', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date } = req.query;

  const filter = { pageId };

  if (start_date && end_date) {
    filter.lastClickAt = {
      $gte: new Date(start_date),
      $lte: new Date(end_date)
    };
  }

  const docs = await db
    .collection(`prdClick_${mallId}`)
    .find(filter)
    .sort({ clickCount: -1 })
    .toArray();

  const results = docs.map(d => ({
    productNo: d.productNo,
    clicks: d.clickCount
  }));

  res.json(results);
});

// (22) analytics: product-performance (클릭된 상품만 + 상품명 포함)
app.get('/api/:mallId/analytics/:pageId/product-performance', async (req, res) => {
  const { mallId, pageId } = req.params;
  try {
    const clicks = await db
      .collection(`prdClick_${mallId}`)
      .aggregate([
        { $match: { pageId } },
        { $group: { _id: '$productNo', clicks: { $sum: '$clickCount' } } }
      ])
      .toArray();

    if (clicks.length === 0) {
      return res.json([]);
    }

    const productNos = clicks.map(c => c._id);

    const urlProds = `https://${mallId}.cafe24api.com/api/v2/admin/products`;
    const prodRes = await apiRequest(mallId, 'GET', urlProds, {}, {
      shop_no: 1,
      product_no: productNos.join(','),
      limit: productNos.length,
      fields: 'product_no,product_name'
    });
    const detailMap = (prodRes.products || []).reduce((m, p) => {
      m[p.product_no] = p.product_name;
      return m;
    }, {});

    const performance = clicks
      .map(c => ({
        productNo: c._id,
        productName: detailMap[c._id] || '이름없음',
        clicks: c.clicks
      }))
      .sort((a, b) => b.clicks - a.clicks);

    res.json(performance);

  } catch (err) {
    console.error('[PRODUCT PERFORMANCE ERROR]', err);
    res.status(500).json({ error: '상품 퍼포먼스 집계 실패' });
  }
});

// ===================================================================
// 웹훅 등록 헬퍼 (선택) - 설치 직후 호출
// - 실제 이벤트명/엔드포인트/페이로드는 Cafe24 문서에 맞춰 조정하세요.
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
    });
  })
  .catch(err => {
    console.error('❌ 초기화 실패:', err);
    process.exit(1);
  });
