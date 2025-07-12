// server.js
require('dotenv').config();
process.env.TZ = 'Asia/Seoul';

const express    = require('express');
const path       = require('path');
const cors       = require('cors');
const compression= require('compression');
const bodyParser = require('body-parser');
// … 그 외 axios, MongoClient, multer, dayjs 등 require …

const {
  MONGODB_URI,
  DB_NAME,
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  CAFE24_API_VERSION,
  REDIRECT_URI,
  PORT = 5000,
  // … 나머지 env …
} = process.env;

const app = express();

// ─── 미들웨어 ─────────────────────────────────────────────────────
app.use(cors());
app.use(compression());
app.use(bodyParser.json({     limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// React 빌드물이 있는 폴더 (index.html 포함)
const root         = path.join(__dirname, 'public');
// .env 의 REDIRECT_URI 에서 "/redirect" 만 뽑아냄
const redirectPath = new URL(REDIRECT_URI).pathname;  // → "/redirect"

// 1) React 정적 파일 서빙
app.use(express.static(root));

// 2) OAuth 콜백 경로: React index.html 반환
app.get(redirectPath, (req, res) => {
  res.sendFile(path.join(root, 'index.html'));
});

// ─── 여기에 /api 로 시작하는 모든 핸들러를 붙여넣으세요 ───────────────
// (아래는 예시)
app.get('/api/redirect', async (req, res) => {
  // … your existing authorization_code → token 교환 로직 …
});

app.get('/api/categories/all', async (req, res) => {
  // … your existing categories 조회 로직 …
});

// … 나머지 /api/* 핸들러들 전부 …



// 3) 이 외의 모든 GET 요청은 SPA 라우팅
//    (단, "/api" 로 시작하는 건 404)
app.get('/*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.sendStatus(404);
  }
  res.sendFile(path.join(root, 'index.html'));
});


// ─── MongoDB 초기화 & 서버 기동 ──────────────────────────────────────
let db;
async function initDb() {
  const client = new (require('mongodb').MongoClient)(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('▶️ MongoDB connected');
  // … indexes 설정 등 …
}

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`▶️ Server running on ${PORT}`));
  })
  .catch(err => {
    console.error('❌ 초기화 실패', err);
    process.exit(1);
  });
