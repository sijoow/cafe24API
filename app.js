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

// ─── 1) 공통 미들웨어 ───────────────────────────────────────────────
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// React 빌드 산출물이 위치한 폴더
const root = path.join(__dirname, 'public');
// 전체 URL이 아닌, pathname ("/redirect") 만 뽑아서 라우트에 사용
const redirectPath = new URL(REDIRECT_URI).pathname;

// ─── 2) 정적 파일 서빙 ─────────────────────────────────────────────
app.use(express.static(root));

// ─── 3) OAuth 콜백 경로 ────────────────────────────────────────────
app.get(redirectPath, (req, res) => {
  // 카페24가 인가 코드(code)와 shop 파라미터를 들고 이 URL로 콜백합니다.
  // React 쪽 라우터가 이 경로를 잡고, query를 읽어서 token 교환 요청을 보내도록.
  res.sendFile(path.join(root, 'index.html'));
});

// ─── 4) API 핸들러 (예시) ──────────────────────────────────────────
let db;
async function initDb() {
  console.log('▶️ MONGODB_URI:', MONGODB_URI);
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('▶️ MongoDB connected');
  // …인덱스 세팅 등 필요 로직…
}

// (1) 토큰 교환
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
        'Content-Type':          'application/x-www-form-urlencoded',
        'Authorization':         `Basic ${creds}`,
        'X-Cafe24-Api-Version':  CAFE24_API_VERSION,
      }
    });
    // TODO: db에 data.access_token, data.refresh_token 을 저장
    return res.json({ success: true, data });
  } catch (err) {
    console.error('❌ 토큰 교환 실패', err.response?.data || err.message);
    return res.status(500).json({ error: '토큰 교환 실패' });
  }
});

// (2) 카테고리 전체 조회 예시
app.get('/api/categories/all', async (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).json({ error: 'shop 파라미터 필요' });
  try {
    // …기존 apiRequest를 써서 카페24 API 호출…
    return res.json([]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// …이 밖에 기존에 쓰시던 /api/* 엔드포인트들 모두 여기에 붙여넣으세요…

// ─── 5) SPA Fallback ────────────────────────────────────────────────
app.get('/*', (req, res) => {
  // `/api/` 로 시작하는 것은 위에서 처리했으니, 여기서는 404
  if (req.path.startsWith('/api/')) {
    return res.sendStatus(404);
  }
  // 나머지 요청은 모두 React index.html 로 포워딩
  res.sendFile(path.join(root, 'index.html'));
});

// ─── 6) 서버 & DB 기동 ─────────────────────────────────────────────
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`▶️ Server listening on ${PORT}`));
  })
  .catch(err => {
    console.error('❌ Initialization failed', err);
    process.exit(1);
  });
