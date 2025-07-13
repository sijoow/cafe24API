// app.js
require('dotenv').config();
const express         = require('express');
const cors            = require('cors');
const qs              = require('querystring');
const axios           = require('axios');
const crypto          = require('crypto');
const { MongoClient } = require('mongodb');
const path            = require('path');

const {
  MONGODB_URI,
  DB_NAME               = 'LSH',
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  CAFE24_API_VERSION,
  REDIRECT_URI,         // e.g. "https://onimon.shop/redirect"
  PORT                  = 5000,
} = process.env;

// 필수 env 체크
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI is not defined');
  process.exit(1);
}
if (!CAFE24_CLIENT_ID || !CAFE24_CLIENT_SECRET) {
  console.error('❌ CAFE24_CLIENT_ID or CAFE24_CLIENT_SECRET is not defined');
  process.exit(1);
}
if (!REDIRECT_URI) {
  console.error('❌ REDIRECT_URI is not defined');
  process.exit(1);
}

async function main() {
  // 1) MongoDB 연결
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  console.log('✅ MongoDB connected');

  const db        = client.db(DB_NAME);
  const tokenCol  = db.collection('shopTokens');
  const stateCol  = db.collection('installStates');

  // 인덱스 설정
  await tokenCol.createIndex({ shop: 1 }, { unique: true });
  await tokenCol.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await stateCol.createIndex({ state: 1 }, { unique: true });
  console.log('✅ Indexes ensured');

  // 2) 토큰 관리 함수
  async function saveTokens(shop, accessToken, refreshToken, expiresIn) {
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    await tokenCol.updateOne(
      { shop },
      {
        $set: { accessToken, refreshToken, expiresAt, updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );
  }

  async function loadTokens(shop) {
    return tokenCol.findOne({ shop });
  }

  async function ensureValidToken(shop) {
    const doc = await loadTokens(shop);
    if (!doc) throw new Error(`No tokens for shop ${shop}`);

    // 만료 5분 전이면 갱신
    if (Date.now() > doc.expiresAt.getTime() - 5 * 60 * 1000) {
      const r = await axios.post(
        `https://${shop}.cafe24api.com/api/${CAFE24_CLIENT_SECRET}/oauth/token`,
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

  // 3) Express 설정
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());

  // [A] OAuth 승인 시작
  app.get('/authorize', async (req, res, next) => {
    try {
      const { shop } = req.query;
      if (!shop) return res.status(400).send('Missing shop parameter');

      const state = crypto.randomBytes(16).toString('hex');
      await stateCol.insertOne({ state, shop, createdAt: new Date() });

      const authorizeUrl =
        `https://${shop}.cafe24api.com/api/${CAFE24_API_VERSION}/oauth/authorize` +
        `?response_type=code` +
        `&client_id=${CAFE24_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&scope=${encodeURIComponent('mall.read_category,mall.read_product,mall.read_analytics')}` +
        `&state=${state}`;

      res.redirect(authorizeUrl);
    } catch (err) {
      next(err);
    }
  });

  // [B] OAuth 콜백 처리
  app.get('/redirect', async (req, res, next) => {
    try {
      const { code, shop, state } = req.query;
      const rec = await stateCol.findOneAndDelete({ state, shop });
      if (!rec.value) {
        return res.status(400).send('Invalid state');
      }

      const tokenRes = await axios.post(
        `https://${shop}.cafe24api.com/api/${CAFE24_API_VERSION}/oauth/token`,
        qs.stringify({
          grant_type:    'authorization_code',
          client_id:     CAFE24_CLIENT_ID,
          client_secret: CAFE24_CLIENT_SECRET,
          code,
          redirect_uri:  REDIRECT_URI,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      const { access_token, refresh_token, expires_in } = tokenRes.data;
      await saveTokens(shop, access_token, refresh_token, expires_in);

      // React로 설치 완료 알림
      res.redirect(`${REDIRECT_URI}?installed=true&shop=${shop}`);
    } catch (err) {
      next(err);
    }
  });

  // [C] API 프록시 예시
  app.get('/api/:shop/products', async (req, res, next) => {
    try {
      const token = await ensureValidToken(req.params.shop);
      const apiRes = await axios.get(
        `https://${req.params.shop}.cafe24api.com/api/${CAFE24_API_VERSION}/admin/products`,
        {
          params: { shop_no: 1 },
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      res.json(apiRes.data);
    } catch (err) {
      next(err);
    }
  });

  // [D] 디버그 조회
  app.get('/debug/states', async (req, res, next) => {
    try {
      const docs = await stateCol.find().toArray();
      res.json(docs);
    } catch (err) {
      next(err);
    }
  });
  app.get('/debug/tokens', async (req, res, next) => {
    try {
      const docs = await tokenCol.find().toArray();
      res.json(docs);
    } catch (err) {
      next(err);
    }
  });

  // [E] React 정적 파일 + SPA 캐치올
  app.use(express.static(path.join(__dirname, 'build')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
  });

  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
