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

// ─── 1. MongoDB 연결 ────────────────────────────────────────────────
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI, { useUnifiedTopology: true });
  await client.connect();
  db = client.db(DB_NAME);
  console.log('▶️ MongoDB connected to', DB_NAME);
}

// ─── 2. 설치 시작: 권한 요청 라우트 ─────────────────────────────────
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

  console.log('🔍 [INSTALL] redirect_uri →', redirectUri);
  console.log('👉 [INSTALL] authorize URL →', `https://${mallId}.cafe24.com/api/v2/oauth/authorize?${params}`);
  res.redirect(`https://${mallId}.cafe24.com/api/v2/oauth/authorize?${params}`);
});

// ─── 3. 콜백 핸들러: 코드 → 토큰 발급 → DB 저장 ───────────────────────
app.get('/auth/callback', async (req, res) => {
  console.log('--- /auth/callback called ---');
  console.log('⚡ req.query →', req.query);

  const { code, mall_id: mallId } = req.query;
  const redirectUri = `${APP_URL}/auth/callback`;
  console.log('⚡ expected redirectUri →', redirectUri);

  if (!code || !mallId) {
    console.warn('⚠️ Missing code or mallId in query');
    return res.status(400).send('code 또는 mall_id가 없습니다.');
  }

  try {
    // 3.1) 토큰 교환 요청
    const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
    const creds    = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
    const body     = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: redirectUri
    }).toString();

    console.log('▶️ [TOKEN] POST to', tokenUrl);
    console.log('   headers:', {
      'Content-Type': 'application/x-www-form-urlencoded',
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

    // 3.3) 완료 응답
    res.send('앱 설치 및 토큰 교환 완료! DB에 저장되었습니다.');
  }
  catch (err) {
    console.error('❌ [ERROR] Token exchange or DB save failed:', err.response?.data || err);
    res.status(500).send('토큰 교환 중 오류가 발생했습니다.');
  }
});
// app.js 맨 아래에 추가하세요
app.get('/api/admin/dbdump', async (req, res) => {
  try {
    // 1) 모든 컬렉션 이름 가져오기
    const cols = await db.listCollections().toArray();
    const dump = {};

    // 2) 각 컬렉션의 전체 문서 조회
    for (const { name } of cols) {
      dump[name] = await db.collection(name).find().toArray();
    }

    // 3) JSON으로 응답
    res.json(dump);
  } catch (err) {
    console.error('❌ DB 덤프 실패', err);
    res.status(500).send('DB 덤프 실패');
  }
});

// ─── 4. 서버 시작 ───────────────────────────────────────────────────
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`▶️ Server running at http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ DB 연결 실패:', err);
    process.exit(1);
  });
