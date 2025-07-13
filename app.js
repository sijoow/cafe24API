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

  const db        = client.db(DB_NAME);
  const tokenCol  = db.collection('shopTokens');
  const stateCol  = db.collection('installStates');

  // 고유 인덱스 & TTL 인덱스
  await tokenCol.createIndex({ shop: 1 }, { unique: true });
  await tokenCol.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await stateCol.createIndex({ state: 1 }, { unique: true });

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

    if (Date.now() > doc.expiresAt.getTime() - 5*60*1000) {
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
      if (!shop) return res.status(400).send('Missing shop parameter');

      const state = crypto.randomBytes(16).toString('hex');
      // 서버에 state 저장
      await stateCol.insertOne({ state, shop, createdAt: new Date() });

      const url =
        `https://${shop}.cafe24api.com/api/${CAFE24_API_VERSION}/oauth/authorize` +
        `?response_type=code` +
        `&client_id=${CAFE24_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&scope=${encodeURIComponent('mall.read_category,mall.read_product,mall.read_analytics')}` +
        `&state=${state}`;

      res.redirect(url);
    } catch (err) {
      next(err);
    }
  });

  // [2] 콜백 처리
  app.get('/redirect', async (req, res, next) => {
    try {
      const { code, shop, state } = req.query;
      // 서버에서 state 검증
      const rec = await stateCol.findOneAndDelete({ state, shop });
      if (!rec.value) {
        return res.status(400).send('Invalid state');
      }

      const r = await axios.post(
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
      const { access_token, refresh_token, expires_in } = r.data;
      await saveTokens(shop, access_token, refresh_token, expires_in);

      res.redirect(
  `https://onimon.shop/redirect?installed=true&shop=${shop}&state=${state}`
);
    } catch (err) {
      next(err);
    }
  });

  // [3] API 프록시 예시
  app.get('/api/:shop/products', async (req, res, next) => {
    try {
      const token  = await ensureValidToken(req.params.shop);
      const apiRes = await axios.get(
        `https://${req.params.shop}.cafe24api.com/api/${CAFE24_API_VERSION}/admin/products`,
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
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
