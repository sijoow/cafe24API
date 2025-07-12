// server.js
require('dotenv').config();
process.env.TZ = 'Asia/Seoul';

const express    = require('express');
const path       = require('path');
const cors       = require('cors');
const compression= require('compression');
const bodyParser = require('body-parser');
// … (axios, MongoClient, multer, dayjs 등 require) …

const { REDIRECT_URI, PORT = 5000 /*, …기타 env…*/ } = process.env;

const app = express();

// ─── 미들웨어 ─────────────────────────────────────────────────────
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// React 빌드물이 위치한 폴더
const root         = path.join(__dirname, 'public');
// "/redirect" 만 뽑아낸다
const redirectPath = new URL(REDIRECT_URI).pathname;  // → "/redirect"

// 1) 정적 파일 서빙
app.use(express.static(root));

// 2) OAuth 콜백 경로: SPA index.html 반환
app.get(redirectPath, (req, res) => {
  res.sendFile(path.join(root, 'index.html'));
});

// 3) /api 로 시작하는 모든 핸들러
app.get('/api/redirect', /* …토큰 교환 로직… */);
app.get('/api/categories/all', /* …기존 로직… */);
// …이하 /api/* 전부…

// 4) 그 외 모든 GET 요청 → SPA index.html (클라이언트 라우팅)
app.get('/*', (req, res) => {
  // API 경로는 이 아래로 오면 404
  if (req.path.startsWith('/api/')) {
    return res.sendStatus(404);
  }
  res.sendFile(path.join(root, 'index.html'));
});

// ─── MongoDB 초기화 & 서버 기동 ─────────────────────────────────────
let db;
async function initDb() {
  const client = new (require('mongodb').MongoClient)(process.env.MONGODB_URI);
  await client.connect();
  db = client.db(process.env.DB_NAME);
  console.log('▶️ MongoDB connected');
  // …인덱스 설정 등…
}

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`▶️ Server listening on ${PORT}`));
  })
  .catch(err => {
    console.error('❌ 초기화 실패', err);
    process.exit(1);
  });
