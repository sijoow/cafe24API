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

async function main() {
  // 1) MongoDB 연결
  const client = new MongoClient(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  await client.connect();
  const tokenCol = client.db('LSH').collection('shopTokens');
  await tokenCol.createIndex({ shop: 1 }, { unique: true });

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

  // (1) 승인 시작용
  app.get('/authorize', (req, res) => {
    const { shop } = req.query;
    if (!shop) return res.status(400).send('Missing shop parameter');
    const state = crypto.randomBytes(16).toString('hex');
    // TODO: state 저장
    const redirectUri = encodeURIComponent(process.env.REDIRECT_URI);
    const scope       = encodeURIComponent('mall.read_category,mall.read_product,mall.read_analytics');
    const url =
      `https://${shop}.cafe24api.com/api/${CAFE24_API_VERSION}/oauth/authorize` +
      `?response_type=code` +
      `&client_id=${CAFE24_CLIENT_ID}` +
      `&redirect_uri=${redirectUri}` +
      `&scope=${scope}` +
      `&state=${state}`;
    res.redirect(url);
  });

  // (2) 콜백 처리
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
          redirect_uri:  process.env.REDIRECT_URI,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const { access_token, refresh_token, expires_in } = r.data;
      await saveTokens(shop, access_token, refresh_token, expires_in);
      res.redirect(`https://onimon.shop/?installed=true&shop=${shop}&state=${state}`);
    } catch (err) {
      next(err);
    }
  });

  // (3) API 프록시 예시
  app.get('/api/:shop/products', async (req, res, next) => {
    try {
      const token = await ensureValidToken(req.params.shop);
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
