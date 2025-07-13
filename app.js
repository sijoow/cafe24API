// app.js
require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const qs           = require('querystring');
const axios        = require('axios');
const crypto       = require('crypto');
const { MongoClient } = require('mongodb');

const {
  MONGODB_URI,
  DB_NAME     = 'LSH',
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  CAFE24_API_VERSION,
  REDIRECT_URI,
  PORT        = 5000,
} = process.env;

async function main() {
  // 1) MongoDB 연결 & 컬렉션 세팅
  const client = new MongoClient(MONGODB_URI, {
    useNewUrlParser:    true,
    useUnifiedTopology: true,
  });
  await client.connect();
  console.log('✅ MongoDB connected');

  const db        = client.db(DB_NAME);
  const tokenCol  = db.collection('shopTokens');
  const stateCol  = db.collection('installStates');

  // 인덱스 세팅
  await tokenCol.createIndex({ shop: 1 }, { unique: true });
  await tokenCol.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await stateCol.createIndex({ state: 1 }, { unique: true });
  console.log('✅ Indexes ensured');

  // 2) 토큰 관리 함수
  async function saveTokens(shop, accessToken, refreshToken, expiresIn) {
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    console.log(`💾 saveTokens: shop=${shop}, expiresIn=${expiresIn}`);
    await tokenCol.updateOne(
      { shop },
      {
        $set: { accessToken, refreshToken, expiresAt, updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );
    console.log(`💾 Token saved for ${shop}, expiresAt=${expiresAt}`);
  }
  async function loadTokens(shop) {
    console.log(`🔍 loadTokens: shop=${shop}`);
    const doc = await tokenCol.findOne({ shop });
    console.log(`🔍 loadTokens result:`, doc);
    return doc;
  }
  async function ensureValidToken(shop) {
    const doc = await loadTokens(shop);
    if (!doc) throw new Error(`No tokens for shop ${shop}`);

    // 만료 5분 전이면 갱신
    if (Date.now() > doc.expiresAt.getTime() - 5*60*1000) {
      console.log(`♻️ Refreshing token for ${shop}`);
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

  // 3) Express 셋업
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());

  // [1] 승인 시작
  app.get('/authorize', async (req, res, next) => {
    try {
      const { shop } = req.query;
      console.log('🔔 /authorize called with shop=', shop);
      if (!shop) return res.status(400).send('Missing shop parameter');

      const state = crypto.randomBytes(16).toString('hex');
      console.log(`🔐 Generated state=${state} for shop=${shop}`);
      // 서버에 state 저장
      const insertResult = await stateCol.insertOne({ state, shop, createdAt: new Date() });
      console.log('🗄  stateCol.insertOne result:', insertResult.insertedId);

      const url =
        `https://${shop}.cafe24api.com/api/${CAFE24_API_VERSION}/oauth/authorize` +
        `?response_type=code` +
        `&client_id=${CAFE24_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&scope=${encodeURIComponent('mall.read_category,mall.read_product,mall.read_analytics')}` +
        `&state=${state}`;

      console.log('➡️ Redirecting to:', url);
      res.redirect(url);
    } catch (err) {
      console.error(err);
      next(err);
    }
  });

  // [2] 콜백 처리
  app.get('/redirect', async (req, res, next) => {
    try {
      console.log('🔔 /redirect called with query=', req.query);
      const { code, shop, state } = req.query;

      // 서버에서 state 검증
      const rec = await stateCol.findOneAndDelete({ state, shop });
      console.log('🗄  stateCol.findOneAndDelete result:', rec.value);
      if (!rec.value) {
        console.warn('❌ Invalid state or shop mismatch');
        return res.status(400).send('Invalid state');
      }

      // 토큰 요청
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
      console.log('🔑 Token response data:', tokenRes.data);

      const { access_token, refresh_token, expires_in } = tokenRes.data;
      await saveTokens(shop, access_token, refresh_token, expires_in);

      // React로 콜백
      const forwardUrl = `https://onimon.shop/redirect?installed=true&shop=${shop}`;
      console.log('➡️ Forwarding user to:', forwardUrl);
      res.redirect(forwardUrl);
    } catch (err) {
      console.error(err);
      next(err);
    }
  });

  // [3] API 프록시 예시
  app.get('/api/:shop/products', async (req, res, next) => {
    try {
      console.log('🔔 /api/:shop/products called, shop=', req.params.shop);
      const token  = await ensureValidToken(req.params.shop);
      const apiRes = await axios.get(
        `https://${req.params.shop}.cafe24api.com/api/${CAFE24_API_VERSION}/admin/products`,
        {
          params: { shop_no: 1 },
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      console.log('📦 /api/:shop/products result:', apiRes.data);
      res.json(apiRes.data);
    } catch (err) {
      console.error(err);
      next(err);
    }
  });

  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
