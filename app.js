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

// ─── (A) 권한 요청 라우트 ────────────────────────────────────────────
// 테스트용: 브라우저에서 https://your-domain/install/{mallId} 호출
app.get('/install/:mallId', (req, res) => {
  const { mallId }   = req.params;
  const redirectUri  = `${APP_URL}/auth/callback`;
  const params       = new URLSearchParams({
    response_type: 'code',
    client_id:     CAFE24_CLIENT_ID,
    redirect_uri:  redirectUri,
    scope:         'mall.read_category,mall.read_product,mall.read_analytics',
    state:         Date.now().toString(),
  });
  console.log('🔍 redirect_uri →', redirectUri);
  res.redirect(`https://${mallId}.cafe24.com/api/v2/oauth/authorize?${params}`);
});

// ─── (B) OAuth 콜백 핸들러: 토큰 교환 & DB 저장 ────────────────────────
app.get('/auth/callback', async (req, res) => {
  const { code, mall_id: mallId } = req.query;
  const redirectUri = `${APP_URL}/auth/callback`;

  if (!code || !mallId) {
    return res.status(400).send('code 또는 mall_id가 없습니다.');
  }

  try {
    // 1) 카페24에 토큰 요청
    const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
    const creds    = Buffer.from(
      `${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`
    ).toString('base64');
    const body = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: redirectUri
    }).toString();

    const { data } = await axios.post(tokenUrl, body, {
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`
      }
    });

    // data.access_token, data.refresh_token, data.expires_in

    // 2) MongoDB에 mallId 기준으로 저장
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
      { upsert: true }
    );

    console.log(`✅ [${mallId}] 토큰 저장 완료`, {
      accessToken: data.access_token.slice(0,8) + '…',
      refreshToken: data.refresh_token.slice(0,8) + '…'
    });

    // 3) 완료 메시지
    res.send('앱 설치 및 토큰 교환 완료! DB에 저장되었습니다.');
  }
  catch (err) {
    console.error('❌ 토큰 교환 실패', err.response?.data || err);
    res.status(500).send('토큰 교환 중 오류가 발생했습니다.');
  }
});

// ─── 서버 시작 ───────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`▶️ Server running on port ${PORT}`);
  });
});
