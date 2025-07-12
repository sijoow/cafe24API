// app.js 최상단에 추가할 부분

const express = require('express')
const path    = require('path')
const app = express()

// ① React 빌드 산출물(public 폴더) 서빙
const root = path.join(__dirname, 'public')
app.use(express.static(root))

// ② OAuth 콜백용 UI 라우트 (/redirect → index.html)
const redirectPath = new URL(process.env.REDIRECT_URI).pathname
app.get(redirectPath, (req, res) => {
  res.sendFile(path.join(root, 'index.html'))
})

// ③ 실제 토큰 교환 API 라우트 (/api/redirect)
app.get('/api/redirect', async (req, res) => {
  const { code, shop, mall_id } = req.query
  const targetShop = shop || mall_id
  if (!code || !targetShop) {
    return res.status(400).send('code 또는 shop 파라미터가 필요합니다.')
  }
  try {
    const tokenUrl = `https://${targetShop}.cafe24api.com/api/v2/oauth/token`
    const creds    = Buffer.from(
      `${process.env.CAFE24_CLIENT_ID}:${process.env.CAFE24_CLIENT_SECRET}`
    ).toString('base64')
    const params = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: process.env.REDIRECT_URI,
    })
    const { data } = await axios.post(tokenUrl, params.toString(), {
      headers: {
        'Content-Type':         'application/x-www-form-urlencoded',
        'Authorization':        `Basic ${creds}`,
        'X-Cafe24-Api-Version': process.env.CAFE24_API_VERSION,
      }
    })
    // TODO: data.access_token / data.refresh_token DB 저장
    res.json({ success: true })
  } catch (err) {
    console.error('❌ 토큰 교환 실패', err.response?.data || err.message)
    res.status(500).json({ error: '토큰 교환 실패' })
  }
})

// … 여기에 나머지 /api/ 라우트들 모두 정의 …

// ④ SPA용 fallback: /api/* 가 아닌 모든 GET 요청을 React에 넘겨 줌
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.sendStatus(404)
  }
  res.sendFile(path.join(root, 'index.html'))
})

// 서버 시작
app.listen(process.env.PORT || 5000, () => {
  console.log('▶️ Server running')
})
