require('dotenv').config();
process.env.TZ = 'Asia/Seoul';

const express       = require('express');
const axios         = require('axios');
const { MongoClient } = require('mongodb');

const {
  MONGODB_URI,
  DB_NAME,
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  APP_URL,
  PORT = 5000
} = process.env;

const app = express();

// ─── MongoDB 연결 ───────────────────────────────────────────────────
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('▶️ MongoDB connected');
}

// ─── (A) 설치 시작: 권한 요청 ────────────────────────────────────────
app.get('/install/:mallId', (req, res) => {
  const { mallId }  = req.params;
  const redirectUri = `${APP_URL}/auth/callback`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CAFE24_CLIENT_ID,
    redirect_uri:  redirectUri,
    scope:         'mall.read_category,mall.read_product,mall.read_analytics',
    state:         'app_install',
  });
  console.log('🔍 redirect_uri →', redirectUri);
  console.log('👉 권한요청 URL →', `https://${mallId}.cafe24.com/api/v2/oauth/authorize?${params}`);
  res.redirect(`https://${mallId}.cafe24.com/api/v2/oauth/authorize?${params}`);
});

// ─── (B) 콜백 핸들러: code → 액세스/리프레시 토큰 교환 + DB 저장 ────────
app.get('/auth/callback', async (req, res) => {
  console.log('--- /auth/callback called ---');
  console.log('⚡ req.query:', req.query);

  const { code, mall_id: mallId } = req.query;
  const redirectUri = `${APP_URL}/auth/callback`;
  console.log('⚡ expected redirectUri:', redirectUri);

  if (!code || !mallId) {
    console.warn('⚠️ Missing code or mallId');
    return res.status(400).send('code 또는 mall_id가 없습니다.');
  }

  try {
    // 1) 토큰 교환 요청 준비
    const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
    const creds    = Buffer.from(
      `${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`
    ).toString('base64');
    const body = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: redirectUri
    }).toString();

    console.log('▶️ Token request to:', tokenUrl);
    console.log('   Headers:', {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`
    });
    console.log('   Body:', body);

    // 2) 실제 토큰 교환 요청
    const response = await axios.post(tokenUrl, body, {
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`
      }
    });
    console.log('✅ Token endpoint responded:', response.data);

    const { access_token, refresh_token, expires_in } = response.data;

    // 3) MongoDB에 mallId 별로 저장
    console.log('▶️ Saving tokens to DB for mallId:', mallId);
    await db.collection('token').updateOne(
      { mallId },
      { $set: {
          mallId,
          accessToken:  access_token,
          refreshToken: refresh_token,
          obtainedAt:   new Date(),
          expiresIn:    expires_in
        }
      },
      { upsert: true }
    );
    console.log(`✅ [${mallId}] Tokens saved successfully`);

    // 4) 완료 응답
    res.send('앱 설치·토큰 교환 완료! DB에 저장되었습니다.');
  }
  catch (err) {
    console.error('❌ Error during token exchange or DB save:', err.response?.data || err);
    res.status(500).send('토큰 교환 중 오류가 발생했습니다.');
  }
});

// ─── 서버 시작 ───────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`▶️ Server running on port ${PORT}`);
  });
});
