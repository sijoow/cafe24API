// app.js
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const qs      = require('querystring');
const axios   = require('axios');
const crypto  = require('crypto');
const { MongoClient } = require('mongodb');

const {
  MONGODB_URI,
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  CAFE24_API_VERSION,
  PORT = 5000,
} = process.env;

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// --- MongoDB & Token Store 초기화 ---
let tokenCol;
(async () => {
  const client = new MongoClient(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  await client.connect();
  tokenCol = client.db('LSH').collection('shopTokens');
  await tokenCol.createIndex({ shop: 1 }, { unique: true });
})();

// 토큰 저장/갱신 (upsert)
async function saveTokens(shop, accessToken, refreshToken, expiresIn) {
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  await tokenCol.updateOne(
    { shop },
    {
      $set: { accessToken, refreshToken, expiresAt, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}

// shop별 토큰 조회
async function loadTokens(shop) {
  return tokenCol.findOne({ shop });
}

// 만료 전 자동 갱신 및 반환
async function ensureValidToken(shop) {
  const doc = await loadTokens(shop);
  if (!doc) throw new Error(`No tokens for shop ${shop}`);
  if (Date.now() > doc.expiresAt.getTime() - 5 * 60 * 1000) {
    const r = await axios.post(
      `https://${shop}.cafe24api.com/api/${CAFE24_API_VERSION}/oauth/token`,
      qs.stringify({
        grant_type:    'refresh_token',
        client_id:     CAFE24_CLIENT_ID,
        client_secret: CAFE24_CLIENT_SECRET,
        refresh_token: doc.refreshToken,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token, refresh_token, expires_in } = r.data;
    await saveTokens(shop, access_token, refresh_token, expires_in);
    return access_token;
  }
  return doc.accessToken;
}

// --- OAuth 설치 흐름 ---
// 1) 설치 유도
app.get('/install', (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send('Missing shop parameter');
  const state = crypto.randomBytes(8).toString('hex');
  // TODO: state를 DB/세션에 저장해 CSRF 검증
  const redirectUri = encodeURIComponent('https://onimon.shop/redirect');
  const url =
    `https://${shop}.cafe24api.com/api/${CAFE24_API_VERSION}/oauth/authorize` +
    `?response_type=code` +
    `&client_id=${CAFE24_CLIENT_ID}` +
    `&redirect_uri=${redirectUri}` +
    `&state=${state}`;
  res.redirect(url);
});

// 2) 콜백 처리
app.get('/redirect', async (req, res, next) => {
  try {
    const { code, shop, state } = req.query;
    // TODO: state 검증
    const r = await axios.post(
      `https://${shop}.cafe24api.com/api/${CAFE24_API_VERSION}/oauth/token`,
      qs.stringify({
        grant_type:    'authorization_code',
        client_id:     CAFE24_CLIENT_ID,
        client_secret: CAFE24_CLIENT_SECRET,
        code,
        redirect_uri:  'https://onimon.shop/redirect',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token, refresh_token, expires_in } = r.data;
    await saveTokens(shop, access_token, refresh_token, expires_in);
    res.redirect(`https://onimon.shop/?installed=true&shop=${shop}`);
  } catch (err) {
    next(err);
  }
});

// --- API 프록시 예시 ---
app.get('/api/:shop/products', async (req, res, next) => {
  try {
    const { shop } = req.params;
    const token = await ensureValidToken(shop);
    const apiRes = await axios.get(
      `https://${shop}.cafe24api.com/api/${CAFE24_API_VERSION}/admin/products`,
      {
        params: { shop_no: 1 },
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    res.json(apiRes.data);
  } catch (err) {
    next(err);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
