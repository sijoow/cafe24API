// app.js
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
  APP_URL,              // ex) https://port-0-cafe24api-am952nltee6yr6.sel5.cloudtype.app
  PORT = 5000
} = process.env;

const app = express();

// ─── 1) MongoDB 연결 ───────────────────────────────────────────────
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log('▶️ MongoDB connected to', DB_NAME);
}

// ─── 2) 설치 시작: 권한 요청 라우트 ─────────────────────────────────
app.get('/install/:mallId', (req, res) => {
  const mallId = req.params.mallId;
  const redirectUri = `${APP_URL}/auth/callback`;
  const state       = mallId;   // state에 mallId 담기

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CAFE24_CLIENT_ID,
    redirect_uri:  redirectUri,
    scope:         'mall.read_category,mall.read_product,mall.read_analytics',
    state,
  });

  console.log('🔍 [INSTALL] redirect_uri →', redirectUri);
  console.log('👉 [INSTALL] authorize URL →',
    `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params}`
  );
  res.redirect(
    `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params}`
  );
});

// ─── 3) 콜백 핸들러: code → 토큰 발급 → DB 저장 ───────────────────────
app.get('/auth/callback', async (req, res) => {
  console.log('--- /auth/callback called ---');
  console.log('⚡ req.query →', req.query);

  const code   = req.query.code;
  const mallId = req.query.state;   // state에서 mallId 가져오기

  if (!code || !mallId) {
    console.warn('⚠️ Missing code or mallId (state)', req.query);
    return res.status(400).send('code 또는 mallId가 없습니다.');
  }

  try {
    // 3.1) 토큰 교환 요청
    const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
    const creds    = Buffer.from(
      `${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`
    ).toString('base64');
    const body = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: `${APP_URL}/auth/callback`
    }).toString();

    console.log('▶️ [TOKEN] POST to', tokenUrl);
    console.log('   headers:', {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`
    });
    console.log('   body   :', body);

    const { data } = await axios.post(tokenUrl, body, {
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${creds}`
      }
    });
    console.log('✅ [TOKEN] Response →', {
      access_token:  data.access_token.slice(0,8) + '…',
      refresh_token: data.refresh_token.slice(0,8) + '…',
      expires_in:    data.expires_in
    });

    // 3.2) DB에 토큰 저장
    console.log(`▶️ [DB] Saving tokens for mallId=${mallId}`);
    const result = await db.collection('token').updateOne(
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
    console.log('✅ [DB] token.updateOne result →', result);

    // 3.3) 완료 응답 (원한다면 다른 페이지로 리다이렉트 가능)
    res.send('앱 설치 및 토큰 교환 완료! DB에 저장되었습니다.');
  }
  catch (err) {
    console.error('❌ [ERROR] Token exchange or DB save failed:', err.response?.data || err);
    res.status(500).send('토큰 교환 중 오류가 발생했습니다.');
  }
});

// ─── 4) 서버 시작 ───────────────────────────────────────────────────
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`▶️ Server running at ${APP_URL} (port ${PORT})`);
    });
  })
  .catch(err => {
    console.error('❌ DB 연결 실패:', err);
    process.exit(1);
  });
