// app.js
require('dotenv').config();
process.env.TZ = 'Asia/Seoul';

const express     = require('express');
const path        = require('path');
const cors        = require('cors');
const compression = require('compression');
const bodyParser  = require('body-parser');
const axios       = require('axios');
const { MongoClient, ObjectId } = require('mongodb');
const multer      = require('multer');
const dayjs       = require('dayjs');
require('dayjs/plugin/utc');
require('dayjs/plugin/timezone');
dayjs.extend(require('dayjs/plugin/utc'));
dayjs.extend(require('dayjs/plugin/timezone'));

const {
  MONGODB_URI,
  DB_NAME,
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  CAFE24_API_VERSION,
  CAFE24_MALLID,
  REDIRECT_URI,       // ex) https://onimon.shop/redirect
  PORT = 5000,
  R2_ACCESS_KEY,
  R2_SECRET_KEY,
  R2_BUCKET_NAME,
  R2_ENDPOINT,
  R2_REGION = 'us-east-1',
  R2_PUBLIC_BASE,
} = process.env;

const app = express();

// ─── 공통 미들웨어 ───────────────────────────────────────────────
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// React 빌드 결과물이 담긴 폴더
const root = path.join(__dirname, 'public');

// 전체 URL에서 pathname(“/redirect”)만 꺼내오기
const redirectPath = new URL(REDIRECT_URI).pathname;

// ─── 1) 정적 파일 서빙 ────────────────────────────────────────────
app.use(express.static(root));

// ─── 2) OAuth 콜백 라우트 (/redirect) ─────────────────────────────
app.get(redirectPath, (req, res) => {
  // React 앱이 이 경로와 query를 읽어서
  // axios로 /api/redirect?code=...&shop=... 을 호출하도록 분기해 줍니다.
  res.sendFile(path.join(root, 'index.html'));
});

// ─── 3) 백엔드 API 라우트 (/api/...) ───────────────────────────────

// MongoDB 연결 (예시)
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('▶️ MongoDB connected');
  // 필요 index 생성 등…
}

// 토큰 교환 엔드포인트 예시
app.get('/api/redirect', async (req, res) => {
  const { code, shop, mall_id } = req.query;
  const targetShop = shop || mall_id;
  if (!code || !targetShop) {
    return res.status(400).send('code 또는 shop 파라미터가 없습니다.');
  }
  try {
    const tokenUrl = `https://${targetShop}.cafe24api.com/api/v2/oauth/token`;
    const creds    = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const params   = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    });
    const { data } = await axios.post(tokenUrl, params.toString(), {
      headers: {
        'Content-Type':         'application/x-www-form-urlencoded',
        'Authorization':        `Basic ${creds}`,
        'X-Cafe24-Api-Version': CAFE24_API_VERSION,
      }
    });
    // TODO: data.access_token, data.refresh_token 등을 DB에 저장
    res.json({ success: true });
  } catch (err) {
    console.error('❌ 토큰 교환 실패', err.response?.data || err.message);
    res.status(500).json({ error: '토큰 교환 실패' });
  }
});

// 그 외 /api/... 엔드포인트들 모두 여기에 정의하세요.
// 예: 카테고리 전체 조회
app.get('/api/categories/all', async (req, res) => {
  // …기존 로직…
  res.json([]);
});

// ─── 4) SPA Fallback ───────────────────────────────────────────────
// /api 로 시작하지 않는 모든 GET 요청을 index.html 로 포워딩
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.sendStatus(404);
  }
  res.sendFile(path.join(root, 'index.html'));
});

// ─── 5) 서버 & DB 기동 ─────────────────────────────────────────────
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`▶️ Server listening on ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ Initialization failed', err);
    process.exit(1);
  });
