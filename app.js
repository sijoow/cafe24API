require('dotenv').config();
process.env.TZ = 'Asia/Seoul';

const express = require('express');
const axios   = require('axios');
const { MongoClient } = require('mongodb');

const { MONGODB_URI, DB_NAME, CAFE24_CLIENT_ID, CAFE24_CLIENT_SECRET, APP_URL, PORT = 5000 } = process.env;

const app = express();

// (A) 권한 요청
app.get('/install/:mallId', (req, res) => {
  const { mallId } = req.params;
  const redirectUri = `${APP_URL}/auth/callback`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CAFE24_CLIENT_ID,
    redirect_uri:  redirectUri,
    scope:         'mall.read_application,mall.write_application',
    state:         Date.now().toString(),
  });
  console.log('🔍 redirect_uri →', redirectUri);
  res.redirect(`https://${mallId}.cafe24.com/api/v2/oauth/authorize?${params}`);
});

// MongoDB 연결 (토큰 저장용)
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('▶️ MongoDB connected');
}

// (B) OAuth 콜백
app.get('/auth/callback', async (req, res) => {
  const { code, mall_id: mallId } = req.query;
  const redirectUri = `${APP_URL}/auth/callback`;
  if (!code || !mallId) return res.status(400).send('code 또는 mall_id가 없습니다.');
  try {
    const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
    const creds    = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const body     = new URLSearchParams({ grant_type:'authorization_code', code, redirect_uri:redirectUri });
    const { data } = await axios.post(tokenUrl, body.toString(), {
      headers: { 'Content-Type':'application/x-www-form-urlencoded', 'Authorization':`Basic ${creds}` }
    });
    await db.collection('token').updateOne(
      { mallId },
      { $set: {
          mallId,
          accessToken:  data.access_token,
          refreshToken: data.refresh_token,
          obtainedAt:   new Date(),
          expiresIn:    data.expires_in
        }
      },
      { upsert:true }
    );
    console.log(`✅ [${mallId}] 토큰 저장 완료`);
    res.send('앱 설치·권한 부여 완료!');
  } catch (err) {
    console.error('❌ 토큰 교환 실패', err.response?.data || err);
    res.status(500).send('토큰 교환 중 오류');
  }
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`▶️ Server running on ${PORT}`));
});
