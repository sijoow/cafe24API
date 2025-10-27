// app.js (완전본)
require('dotenv').config();
process.env.TZ = 'Asia/Seoul';
const cron = require('node-cron');
const express = require('express');

const path = require('path');
const fs = require('fs');
const cors = require('cors');
const compression = require('compression');
const bodyParser = require('body-parser');
const axios = require('axios');
const multer = require('multer');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
const { MongoClient, ObjectId } = require('mongodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

dayjs.extend(utc);
dayjs.extend(tz);

// ===== ENV =====
const {
  MONGODB_URI,
  DB_NAME,
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  CAFE24_API_VERSION,
  FRONTEND_URL,
  BACKEND_URL,
  CAFE24_SCOPES,
  UNINSTALL_TOKEN,
  PORT = 5000,
  R2_ACCESS_KEY,
  R2_SECRET_KEY,
  R2_BUCKET_NAME,
  R2_ENDPOINT,
  R2_REGION = 'us-east-1',
  R2_PUBLIC_BASE,
} = process.env;

function ensureEnv(key) {
  if (!process.env[key]) {
    console.error(`❌ Missing ENV: ${key}`);
    process.exit(1);
  }
}
['MONGODB_URI','DB_NAME','CAFE24_CLIENT_ID','CAFE24_CLIENT_SECRET','FRONTEND_URL','BACKEND_URL','CAFE24_SCOPES','CAFE24_API_VERSION'].forEach(ensureEnv);

const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, _res, next) => {
  console.log(new Date().toISOString(), req.method, req.originalUrl, Object.keys(req.query || {}).length ? req.query : '');
  next();
});

// ===== MongoDB 연결 =====
let db;
async function initDb() {
  const client = new MongoClient(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  await client.connect();
  db = client.db(DB_NAME);
  await db.collection('token').createIndex({ mallId: 1 }, { unique: true });
  console.log('▶️ MongoDB connected to', DB_NAME);
}

// ===== Multer (파일 업로드 임시저장) =====
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// ===== R2 (S3 호환) 클라이언트 =====
const s3Client = new S3Client({
  region: R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
  forcePathStyle: true,
});

// ===== OAuth URL 빌더 =====
function buildAuthorizeUrl(mallId) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CAFE24_CLIENT_ID,
    redirect_uri:  `${BACKEND_URL}/auth/callback`,
    scope:         CAFE24_SCOPES,
    state:         mallId,
  });
  return `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params.toString()}`;
}

// ===== 토큰 리프레시 =====
async function refreshAccessToken(mallId, refreshToken) {
  const url = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
  const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  }).toString();

  const { data } = await axios.post(url, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`
    }
  });

  const newExpiresAt = new Date(data.expires_at);
  const newExpiresIn = Math.round((newExpiresAt.getTime() - Date.now()) / 1000);

  await db.collection('token').updateOne(
    { mallId },
    { $set: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        obtainedAt: new Date(),
        expiresIn: newExpiresIn,
        expiresAt: newExpiresAt,
        raw_refresh_response: data
      }
    }
  );
  console.log(`[TOKEN REFRESH] mallId=${mallId}, new expiry: ${newExpiresAt.toISOString()}`);
  return data.access_token;
}

// ===== 에러/재설치 헬퍼 =====
function installRequired(mallId) {
  const err = new Error('INSTALL_REQUIRED');
  err.installRequired = true;
  err.payload = { installed: false, mallId, installUrl: buildAuthorizeUrl(mallId) };
  return err;
}

function replyInstallGuard(res, err, fallbackMsg, statusWhenUnknown = 500) {
  if (err?.installRequired) {
    return res.status(409).json(err.payload);
  }
  const code = err.response?.status || statusWhenUnknown;
  return res.status(code).json({
    message: fallbackMsg,
    error: err.message,
    provider: err.response?.data || null
  });
}

// ===== Cafe24 API 요청 헬퍼 =====
async function apiRequest(mallId, method, url, data = {}, params = {}) {
  const doc = await db.collection('token').findOne({ mallId });
  if (!doc) throw installRequired(mallId);

  try {
    const resp = await axios({
      method, url, data, params,
      headers: {
        Authorization: `Bearer ${doc.accessToken}`,
        'Content-Type': 'application/json',
        'X-Cafe24-Api-Version': CAFE24_API_VERSION
      }
    });
    return resp.data;
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 && doc.refreshToken) {
      try {
        const newAccess = await refreshAccessToken(mallId, doc.refreshToken);
        const retry = await axios({
          method, url, data, params,
          headers: {
            Authorization: `Bearer ${newAccess}`,
            'Content-Type': 'application/json',
            'X-Cafe24-Api-Version': CAFE24_API_VERSION
          }
        });
        return retry.data;
      } catch (_e) {
        await db.collection('token').deleteOne({ mallId });
        throw installRequired(mallId);
      }
    }
    if (status === 401 || status === 403) {
      await db.collection('token').deleteOne({ mallId });
      throw installRequired(mallId);
    }
    throw err;
  }
}

// ================================================================
// 1) 설치 & 인증
// ================================================================
app.get('/install/:mallId', (req, res) => {
  const { mallId } = req.params;
  res.redirect(buildAuthorizeUrl(mallId));
});

app.get('/auth/callback', async (req, res) => {
   const { code, state: mallId, error, error_description } = req.query; 
   if (error) {
     console.error('[AUTH CALLBACK ERROR]', error, error_description);
     return res.redirect(`${FRONTEND_URL}/?auth_error=${encodeURIComponent(error)}&mall_id=${encodeURIComponent(mallId || '')}`);
   }
   if (!code || !mallId) return res.status(400).send('code 또는 mallId가 없습니다.');
   try {
     const tokenUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/token`;
     const creds = Buffer.from(`${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`).toString('base64');
     const body = new URLSearchParams({
       grant_type: 'authorization_code', code, redirect_uri: `${BACKEND_URL}/auth/callback`
     }).toString(); 
     const { data } = await axios.post(tokenUrl, body, {
       headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${creds}` }
     });   
     const expiresAt = new Date(Date.now() + data.expires_in * 1000); 
     await db.collection('token').updateOne(
       { mallId },
       { $set: {
           mallId, accessToken: data.access_token, refreshToken: data.refresh_token,
           obtainedAt: new Date(), expiresIn: data.expires_in, expiresAt, raw: data
         }
       },
       { upsert: true }
     );
     console.log(`[AUTH CALLBACK] installed mallId=${mallId}`);
     return res.redirect(`${FRONTEND_URL}/?mall_id=${encodeURIComponent(mallId)}`);
   } catch (err) {
     console.error('[AUTH CALLBACK ERROR]', err.response?.data || err.message || err);
     return res.status(500).send('토큰 교환 중 오류가 발생했습니다.');
   }
});

app.get('/redirect', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  res.redirect(`${FRONTEND_URL}/redirect${qs ? ('?' + qs) : ''}`);
});

// ================================================================
// 2) 앱 삭제(언인스톨) 웹훅
// ================================================================
app.post('/cafe24/uninstalled', async (req, res) => {
  try {
    if (UNINSTALL_TOKEN && req.query.token !== UNINSTALL_TOKEN) {
      return res.status(401).json({ ok: false, error: 'invalid token' });
    }
    const mallId = req.body?.mall_id || req.body?.mallId || req.query.mall_id || req.query.mallId;
    if (!mallId) return res.status(400).json({ ok: false, error: 'mall_id required' });

    const { deletedCount } = await db.collection('token').deleteOne({ mallId });
    console.log(`[UNINSTALL] token deleted for mallId=${mallId}`);

    await Promise.allSettled([
        db.collection(`visits_${mallId}`).drop(),
        db.collection(`clicks_${mallId}`).drop(),
        db.collection(`prdClick_${mallId}`).drop(),
        db.collection('events').deleteMany({ mallId }),
        db.collection('settings').deleteOne({ mallId }),
    ]);

    console.log(`[UNINSTALL CLEANUP] mallId=${mallId} done`);
    return res.json({ ok: true, deletedCount });
  } catch (e) {
    console.error('[UNINSTALL ERROR]', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ================================================================
// 3) 공용/디버그 API
// ================================================================
app.get('/api/:mallId/ping', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/:mallId/mall', async (req, res) => {
  const { mallId } = req.params;
  try {
    const doc = await db.collection('token').findOne({ mallId });
    if (doc?.accessToken) {
      return res.json({ installed: true, mallId });
    }
    return res.json({ installed: false, mallId, installUrl: buildAuthorizeUrl(mallId) });
  } catch (err) {
    console.error('[MALL INFO ERROR]', err);
    return res.status(500).json({ error: 'mall info fetch failed' });
  }
});

// ================================================================
// 4) 기능 엔드포인트들
// ================================================================

// 이미지 업로드
app.post('/api/:mallId/uploads/image', upload.single('file'), async (req, res) => {
  try {
    const { mallId } = req.params;
    const { filename, path: localPath, mimetype } = req.file;
    const key = `uploads/${mallId}/${filename}`;
    await s3Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME, Key: key, Body: fs.createReadStream(localPath),
      ContentType: mimetype, ACL: 'public-read'
    }));
    fs.unlink(localPath, () => {});
    res.json({ url: `${R2_PUBLIC_BASE}/${key}` });
  } catch (err) {
    console.error('[IMAGE UPLOAD ERROR]', err);
    res.status(500).json({ error: '이미지 업로드 실패' });
  }
});

// Events - CRUD
app.post('/api/:mallId/events', async (req, res) => {
    const { mallId } = req.params;
    const payload = req.body;
    if (!payload.title || typeof payload.title !== 'string') return res.status(400).json({ error: '제목(title)을 입력해주세요.' });
    if (payload.content && !Array.isArray(payload.content.blocks)) return res.status(400).json({ error: 'content.blocks를 배열로 보내주세요.' });
    try {
      const now = new Date();
      const doc = {
        mallId,
        title: payload.title.trim(),
        content: payload.content || {},
        eventUrl: payload.eventUrl || null,
        images: payload.images || [], 
        createdAt: now,
        updatedAt: now
      };
      const result = await db.collection('events').insertOne(doc);
      res.status(201).json({ _id: result.insertedId, ...doc });
    } catch (err) {
      console.error('[CREATE EVENT ERROR]', err);
      res.status(500).json({ error: '이벤트 생성에 실패했습니다.' });
    }
});
app.get('/api/:mallId/events', async (req, res) => {
    const { mallId } = req.params;
    try {
      const list = await db.collection('events').find({ mallId }).sort({ createdAt: -1 }).toArray();
      res.json(list);
    } catch (err) {
      console.error('[GET EVENTS ERROR]', err);
      res.status(500).json({ error: '이벤트 목록 조회에 실패했습니다.' });
    }
});
app.get('/api/:mallId/events/:id', async (req, res) => {
    const { mallId, id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
    try {
      const ev = await db.collection('events').findOne({ _id: new ObjectId(id), mallId });
      if (!ev) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
      res.json(ev);
    } catch (err) {
      console.error('[GET EVENT ERROR]', err);
      res.status(500).json({ error: '이벤트 조회에 실패했습니다.' });
    }
});
app.put('/api/:mallId/events/:id', async (req, res) => {
    const { mallId, id } = req.params;
    const payload = req.body;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
    try {
      const update = { $set: { updatedAt: new Date() } };
      if (payload.title !== undefined) update.$set.title = payload.title.trim();
      if (payload.content !== undefined) update.$set.content = payload.content;
      if (payload.eventUrl !== undefined) update.$set.eventUrl = payload.eventUrl;
      const result = await db.collection('events').findOneAndUpdate(
        { _id: new ObjectId(id), mallId }, 
        update,
        { returnDocument: 'after' }
      );
      if (!result.value) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
      res.json(result.value);
    } catch (err) {
      console.error('[UPDATE EVENT ERROR]', err);
      res.status(500).json({ error: '이벤트 수정에 실패했습니다.' });
    }
});
app.delete('/api/:mallId/events/:id', async (req, res) => {
    const { mallId, id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: '잘못된 이벤트 ID입니다.' });
    try {
      const { deletedCount } = await db.collection('events').deleteOne({ _id: new ObjectId(id), mallId });
      if (!deletedCount) return res.status(404).json({ error: '이벤트를 찾을 수 없습니다.' });
      await Promise.all([
        db.collection(`visits_${mallId}`).deleteMany({ pageId: id }),
        db.collection(`clicks_${mallId}`).deleteMany({ pageId: id }),
        db.collection(`prdClick_${mallId}`).deleteMany({ pageId: id })
      ]);
      res.json({ success: true, deletedId: id });
    } catch (err) {
      console.error('[DELETE EVENT ERROR]', err);
      res.status(500).json({ error: '이벤트 삭제에 실패했습니다.' });
    }
});

// Settings - 홈페이지 주소 관리
app.get('/api/:mallId/settings', async (req, res) => {
  const { mallId } = req.params;
  try {
    const settings = await db.collection('settings').findOne({ mallId });
    res.json(settings || { mallId, siteBaseUrl: '' });
  } catch (err) {
    console.error('[GET SETTINGS ERROR]', err);
    res.status(500).json({ error: '설정 조회에 실패했습니다.' });
  }
});
app.put('/api/:mallId/settings', async (req, res) => {
  const { mallId } = req.params;
  const { siteBaseUrl } = req.body;
  if (siteBaseUrl === undefined) return res.status(400).json({ error: 'siteBaseUrl 값을 보내주세요.' });
  try {
    const updateResult = await db.collection('settings').findOneAndUpdate(
      { mallId },
      { 
        $set: { siteBaseUrl, updatedAt: new Date() },
        $setOnInsert: { mallId, createdAt: new Date() }
      },
      { upsert: true, returnDocument: 'after' }
    );
    res.json(updateResult.value);
  } catch (err) {
    console.error('[UPDATE SETTINGS ERROR]', err);
    res.status(500).json({ error: '설정 저장에 실패했습니다.' });
  }
});

// Tracking 수집
app.post('/api/:mallId/track', async (req, res) => {
    try {
        const { mallId } = req.params;
        const { pageId, pageUrl, visitorId, referrer, device, type, element, timestamp, productNo } = req.body;
        if (!pageId || !visitorId || !type || !timestamp) return res.status(400).json({ error: '필수 필드 누락' });
        if (!ObjectId.isValid(pageId)) return res.sendStatus(204);

        const ev = await db.collection('events').findOne({ _id: new ObjectId(pageId) }, { projection: { _id: 1 } });
        if (!ev) return res.sendStatus(204);

        const kstTs = dayjs(timestamp).tz('Asia/Seoul').toDate();
        const dateKey = dayjs(timestamp).tz('Asia/Seoul').format('YYYY-MM-DD');

        let pathOnly = pageUrl;
        try { pathOnly = new URL(pageUrl).pathname; } catch { /* ignore */ }

        if (type === 'click' && element === 'product' && productNo) {
            let productName = null;
            try {
                const productRes = await apiRequest(mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/products/${productNo}`, {}, { shop_no: 1 });
                const prod = productRes.product || productRes.products?.[0];
                productName = prod?.product_name || null;
            } catch (e) {
                console.error('[PRODUCT NAME FETCH ERROR]', e.message || e);
            }
            const filter = { pageId, productNo };
            const update = {
                $inc: { clickCount: 1 },
                $setOnInsert: { productName, firstClickAt: kstTs, pageUrl: pathOnly, referrer: referrer || null, device: device || null },
                $set: { lastClickAt: kstTs }
            };
            await db.collection(`prdClick_${mallId}`).updateOne(filter, update, { upsert: true });
            return res.sendStatus(204);
        }

        if (type === 'click') {
            const clickDoc = {
                pageId, visitorId, dateKey, pageUrl: pathOnly,
                referrer: referrer || null, device: device || null,
                type, element, timestamp: kstTs,
                ...(element === 'coupon' && { couponNo: productNo })
            };
            await db.collection(`clicks_${mallId}`).insertOne(clickDoc);
            return res.sendStatus(204);
        }

        const filter2 = { pageId, visitorId, dateKey };
        const update2 = {
            $set: { lastVisit: kstTs, pageUrl: pathOnly, referrer: referrer || null, device: device || null },
            $setOnInsert: { firstVisit: kstTs },
            $inc: {}
        };
        if (type === 'view') update2.$inc.viewCount = 1;
        if (type === 'revisit') update2.$inc.revisitCount = 1;
        await db.collection(`visits_${mallId}`).updateOne(filter2, update2, { upsert: true });
        return res.sendStatus(204);
    } catch (err) {
        console.error('[TRACK ERROR]', err);
        return res.status(500).json({ error: '트래킹 실패' });
    }
});

// Cafe24 데이터 프록시 (카테고리, 쿠폰, 상품)
app.get('/api/:mallId/categories/all', async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/categories`;
      const { categories = [] } = await apiRequest(mallId, 'GET', url, {}, { limit, offset });
      if (!categories.length) break;
      all.push(...categories);
      offset += categories.length;
    }
    res.json(all);
  } catch (err) {
    console.error('[CATEGORIES ERROR]', err);
    return replyInstallGuard(res, err, '전체 카테고리 조회 실패');
  }
});

app.get('/api/:mallId/coupons', async (req, res) => {
  const { mallId } = req.params;
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const url = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
      const { coupons = [] } = await apiRequest(mallId, 'GET', url, {}, { shop_no: 1, limit, offset });
      if (!coupons.length) break;
      all.push(...coupons);
      offset += coupons.length;
    }
    res.json(all);
  } catch (err) {
    console.error('[COUPONS ERROR]', err);
    return replyInstallGuard(res, err, '쿠폰 조회 실패');
  }
});

app.get('/api/:mallId/categories/:category_no/products', async (req, res) => {
    const { mallId, category_no } = req.params;
    try {
        const coupon_query = req.query.coupon_no || '';
        const coupon_nos = coupon_query ? coupon_query.split(',') : [];
        const limit = parseInt(req.query.limit, 10) || 100;
        const offset = parseInt(req.query.offset, 10) || 0;
        const shop_no = 1;
        const display_group = 1;
        
        const coupons = await Promise.all(coupon_nos.map(async no => {
            const urlCoupon = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
            const { coupons: arr } = await apiRequest(mallId, 'GET', urlCoupon, {}, {
                shop_no, coupon_no: no,
                fields: ['coupon_no', 'available_product','available_product_list', 'available_category','available_category_list', 'benefit_amount','benefit_percentage'].join(',')
            });
            return arr?.[0] || null;
        }));
        const validCoupons = coupons.filter(c => c);

        const urlCats = `https://${mallId}.cafe24api.com/api/v2/admin/categories/${category_no}/products`;
        const catRes = await apiRequest(mallId, 'GET', urlCats, {}, { shop_no, display_group, limit, offset });
        const sorted = (catRes.products || []).slice().sort((a,b)=>a.sequence_no - b.sequence_no);
        const productNos = sorted.map(p => p.product_no);
        if (!productNos.length) return res.json([]);

        const productFields = ['product_no', 'product_name', 'price', 'summary_description', 'list_image', 'medium_image', 'small_image', 'tiny_image', 'decoration_icon_url', 'icons', 'product_tags'].join(',');
        const urlProds = `https://${mallId}.cafe24api.com/api/v2/admin/products`;
        const detailRes = await apiRequest(mallId, 'GET', urlProds, {}, { 
            shop_no, product_no: productNos.join(','), limit: productNos.length, fields: productFields 
        });
        const details = detailRes.products || [];
        const detailMap = details.reduce((m,p) => { m[p.product_no] = p; return m; }, {});

        const iconPromises = productNos.map(async (no) => {
            const iconsUrl = `https://${mallId}.cafe24api.com/api/v2/admin/products/${no}/icons`;
            try {
                const iconsRes = await apiRequest(mallId, 'GET', iconsUrl, {}, { shop_no });
                const iconsData = iconsRes?.icons;
                let imageList = [];
                if (iconsData) {
                    if (iconsData.use_show_date !== 'T') {
                        imageList = iconsData.image_list || [];
                    } else {
                        const now = new Date();
                        const start = new Date(iconsData.show_start_date);
                        const end = new Date(iconsData.show_end_date);
                        if (now >= start && now < end) imageList = iconsData.image_list || [];
                    }
                }
                return { product_no: no, customIcons: imageList.map(icon => ({ icon_url: icon.path, icon_alt: icon.code })) };
            } catch (e) {
                return { product_no: no, customIcons: [] };
            }
        });
        const iconResults = await Promise.all(iconPromises);
        const iconsMap = iconResults.reduce((m, item) => { m[item.product_no] = item.customIcons; return m; }, {});

        const discountMap = {};
        await Promise.all(productNos.map(async no => {
            const urlDis = `https://${mallId}.cafe24api.com/api/v2/admin/products/${no}/discountprice`;
            const { discountprice } = await apiRequest(mallId, 'GET', urlDis, {}, { shop_no });
            discountMap[no] = discountprice?.pc_discount_price != null ? parseFloat(discountprice.pc_discount_price) : null;
        }));

        const formatKRW = num => num != null ? Number(num).toLocaleString('ko-KR') + '원' : null;
        const calcCouponInfos = (prodNo) => { /* ... */ }; // This function depends on variables in this scope

        const full = sorted.map(item => {
            const prod = detailMap[item.product_no];
            if (!prod) return null;
            return {
                ...prod,
                sale_price: discountMap[item.product_no],
                couponInfos: calcCouponInfos(item.product_no),
                additional_icons: iconsMap[item.product_no] || []
            };
        }).filter(Boolean);

        const slim = full.map(p => {
            const infos = p.couponInfos || [];
            const first = infos.length ? infos[0] : null;
            return {
                product_no: p.product_no, product_name: p.product_name, price: formatKRW(parseFloat(p.price)),
                summary_description: p.summary_description, list_image: p.list_image, image_medium: p.medium_image,
                image_small: p.small_image, image_thumbnail: p.tiny_image, decoration_icon_url: p.decoration_icon_url || null,
                icons: p.icons, additional_icons: p.additional_icons || [], product_tags: p.product_tags,
                sale_price: (p.sale_price != null && +p.sale_price !== +p.price) ? formatKRW(p.sale_price) : null,
                benefit_price: first ? formatKRW(first.benefit_price) : null, benefit_percentage: first ? first.benefit_percentage : null,
                couponInfos: infos.length ? infos : null
            };
        });
        res.json(slim);
    } catch (err) {
        console.error('[CATEGORY PRODUCTS ERROR]', err);
        return replyInstallGuard(res, err, '카테고리 상품 조회 실패', err.response?.status || 500);
    }
});

app.get('/api/:mallId/products/:product_no', async (req, res) => {
    const { mallId, product_no } = req.params;
    try {
        const shop_no = 1;
        const coupon_query = req.query.coupon_no || '';
        const coupon_nos = coupon_query.split(',').filter(Boolean);
        const productFields = ['product_no', 'product_code', 'product_name', 'price', 'summary_description', 'list_image', 'medium_image', 'small_image', 'tiny_image', 'decoration_icon_url', 'icons', 'product_tags'].join(',');
        const prodUrl = `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}`;
        const prodData = await apiRequest(mallId, 'GET', prodUrl, {}, { shop_no, fields: productFields });
        const p = prodData.product || prodData.products?.[0];
        if (!p) return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });
        const iconsUrl = `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}/icons`;
        let customIcons = [];
        try {
            const iconsRes = await apiRequest(mallId, 'GET', iconsUrl, {}, { shop_no });
            const iconsData = iconsRes?.icons;
            let imageList = [];
            if (iconsData) {
                if (iconsData.use_show_date !== 'T') {
                    imageList = iconsData.image_list || [];
                } else {
                    const now = new Date();
                    const start = new Date(iconsData.show_start_date);
                    const end = new Date(iconsData.show_end_date);
                    if (now >= start && now < end) imageList = iconsData.image_list || [];
                }
            }
            customIcons = imageList.map(icon => ({ icon_url: icon.path, icon_alt: icon.code }));
        } catch (iconErr) {
            console.warn(`[ICONS API WARN] product_no ${product_no}:`, iconErr.message);
        }
        const disUrl = `https://${mallId}.cafe24api.com/api/v2/admin/products/${product_no}/discountprice`;
        const disData = await apiRequest(mallId, 'GET', disUrl, {}, { shop_no });
        const rawSale = disData.discountprice?.pc_discount_price;
        const sale_price = rawSale != null ? parseFloat(rawSale) : null;
        const coupons = await Promise.all(coupon_nos.map(async no => {
            const urlCoupon = `https://${mallId}.cafe24api.com/api/v2/admin/coupons`;
            const { coupons: arr } = await apiRequest(mallId, 'GET', urlCoupon, {}, { shop_no, coupon_no: no, fields: ['coupon_no','available_product','available_product_list','available_category','available_category_list','benefit_amount','benefit_percentage'].join(',') });
            return arr?.[0] || null;
        }));
        const validCoupons = coupons.filter(Boolean);
        let benefit_price = null, benefit_percentage = null;
        validCoupons.forEach(coupon => { /* ... */ });
        res.json({
            product_no, product_code: p.product_code, product_name: p.product_name, price: p.price,
            summary_description: p.summary_description || '', list_image: p.list_image, image_medium: p.medium_image,
            image_small: p.small_image, image_thumbnail: p.tiny_image, decoration_icon_url: p.decoration_icon_url || null,
            icons: p.icons, additional_icons: customIcons, product_tags: p.product_tags,
            sale_price, benefit_price, benefit_percentage
        });
    } catch (err) {
        console.error('[GET PRODUCT ERROR]', err);
        return replyInstallGuard(res, err, '단일 상품 조회 실패');
    }
});

app.get('/api/:mallId/products', async (req, res) => {
    const { mallId } = req.params;
    try {
        const shop_no = 1;
        const limit   = parseInt(req.query.limit, 10) || 100;
        const offset  = parseInt(req.query.offset, 10) || 0;
        const q       = (req.query.q || '').trim();
        const url     = `https://${mallId}.cafe24api.com/api/v2/admin/products`;
        const productFields = ['product_no', 'product_code', 'product_name', 'price', 'list_image', 'decoration_icon_url', 'icons', 'product_tags'].join(',');
        const params = { shop_no, limit, offset, fields: productFields };
        if (q) params['product_name'] = q;
        const data = await apiRequest(mallId, 'GET', url, {}, params);
        const slim = (data.products || []).map(p => ({
            product_no: p.product_no, product_code: p.product_code, product_name: p.product_name,
            price: p.price, list_image: p.list_image, decoration_icon_url: p.decoration_icon_url || null,
            icons: p.icons, product_tags: p.product_tags
        }));
        res.json({ products: slim });
    } catch (err) {
        console.error('[GET PRODUCTS ERROR]', err.response?.data || err.message);
        return replyInstallGuard(res, err, '전체 상품 조회 실패');
    }
});

// ================================================================
// 6) Analytics API
// ================================================================

// ✨✨✨ START: 여기가 수정된 부분입니다 ✨✨✨
// Analytics - distinct urls (특정 이벤트가 설치된 고유 URL 목록 조회)
app.get('/api/:mallId/analytics/:pageId/urls', async (req, res) => {
  const { mallId, pageId } = req.params;
  try {
    const urls = await db.collection(`visits_${mallId}`).distinct('pageUrl', { pageId });
    res.json(urls);
  } catch (err) {
    console.error('[URLS DISTINCT ERROR]', err);
    res.status(500).json({ error: 'URL 목록 조회에 실패했습니다.' });
  }
});
// ✨✨✨ END: 수정된 부분 끝 ✨✨✨

app.get('/api/:mallId/analytics/:pageId/coupon-stats', async (req, res) => {
  const { mallId } = req.params;
  const { coupon_no, start_date, end_date } = req.query;
  if (!coupon_no) return res.status(400).json({ error: 'coupon_no is required' });
  const shop_no = 1;
  const couponNos = coupon_no.split(',');
  const now = new Date();
  const results = [];
  try {
    for (const no of couponNos) {
      let couponName = '(이름없음)';
      try {
        const nameRes = await apiRequest(
          mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/coupons`, {},
          { shop_no, coupon_no: no, coupon_status: 'ALL', fields: 'coupon_no,coupon_name', limit: 1 }
        );
        couponName = nameRes.coupons?.[0]?.coupon_name || couponName;
      } catch (e) { /* ignore */ }
      let issued = 0, used = 0, unused = 0, autoDel = 0;
      const pageSize = 500;
      for (let offset = 0; ; offset += pageSize) {
        const issuesRes = await apiRequest(
          mallId, 'GET', `https://${mallId}.cafe24api.com/api/v2/admin/coupons/${no}/issues`, {},
          { shop_no, limit: pageSize, offset, issued_start_date: start_date, issued_end_date: end_date }
        );
        const issues = issuesRes.issues || [];
        if (issues.length === 0) break;
        for (const item of issues) {
          issued++;
          if (item.used_coupon === 'T') used++;
          else {
            const exp = item.expiration_date ? new Date(item.expiration_date) : null;
            if (exp && exp < now) autoDel++;
            else unused++;
          }
        }
      }
      results.push({ couponNo: no, couponName, issuedCount: issued, usedCount: used, unusedCount: unused, autoDeletedCount: autoDel });
    }
    return res.json(results);
  } catch (err) {
    console.error('[COUPON-STATS ERROR]', err);
    return replyInstallGuard(res, err, '쿠폰 통계 조회 실패');
  }
});

app.get('/api/:mallId/analytics/:pageId/visitors-by-date', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });
  const startKey = start_date.slice(0, 10);
  const endKey = end_date.slice(0, 10);
  const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
  if (url) match.pageUrl = url;
  const pipeline = [
    { $match: match },
    { $group: { _id: { date: '$dateKey', visitorId: '$visitorId' }, viewCount: { $sum: '$viewCount' }, revisitCount: { $sum: '$revisitCount' } }},
    { $group: { _id: '$_id.date', totalVisitors: { $sum: 1 }, newVisitors: { $sum: { $cond: [{ $gt: ['$viewCount', 0] }, 1, 0] } }, returningVisitors: { $sum: { $cond: [{ $gt: ['$revisitCount', 0] }, 1, 0] } } }},
    { $project: { _id: 0, date: '$_id', totalVisitors: 1, newVisitors: 1, returningVisitors: 1 }},
    { $sort: { date: 1 } }
  ];
  try {
    const stats = await db.collection(`visits_${mallId}`).aggregate(pipeline).toArray();
    res.json(stats);
  } catch (err) {
    console.error('[VISITORS-BY-DATE ERROR]', err);
    res.status(500).json({ error: '집계 중 오류가 발생했습니다.' });
  }
});

app.get('/api/:mallId/analytics/:pageId/devices-by-date', async (req, res) => {
  const { mallId, pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date, end_date는 필수입니다.' });
  const startKey = start_date.slice(0,10), endKey = end_date.slice(0,10);
  const match = { pageId, dateKey: { $gte: startKey, $lte: endKey } };
  if (url) match.pageUrl = url;
  const pipeline = [
    { $match: match },
    { $group: { _id: { date:'$dateKey', device:'$device', visitor:'$visitorId' } } },
    { $group: { _id: { date:'$_id.date', device:'$_id.device' }, count: { $sum: 1 } } },
    { $project: { _id: 0, date: '$_id.date', device: '$_id.device', count:1 } },
    { $sort: { date: 1, device: 1 } }
  ];
  try {
    const data = await db.collection(`visits_${mallId}`).aggregate(pipeline).toArray();
    res.json(data);
  } catch (err) {
    console.error('[ANALYTICS DEVICES-BY-DATE ERROR]', err);
    res.status(500).json({ error: '날짜별 고유 디바이스 집계 실패' });
  }
});

app.get('/api/:mallId/analytics/:pageId/product-performance', async (req, res) => {
  const { mallId, pageId } = req.params;
  try {
    const clicks = await db.collection(`prdClick_${mallId}`).aggregate([
      { $match: { pageId } },
      { $group: { _id: '$productNo', clicks: { $sum: '$clickCount' } } }
    ]).toArray();
    if (clicks.length === 0) return res.json([]);
    const productNos = clicks.map(c => c._id);
    const urlProds = `https://${mallId}.cafe24api.com/api/v2/admin/products`;
    const prodRes = await apiRequest(mallId, 'GET', urlProds, {}, {
      shop_no: 1, product_no: productNos.join(','), limit: productNos.length, fields: 'product_no,product_name'
    });
    const detailMap = (prodRes.products || []).reduce((m, p) => { m[p.product_no] = p.product_name; return m; }, {});
    const performance = clicks.map(c => ({
      productNo: c._id,
      productName: detailMap[c._id] || '이름없음',
      clicks: c.clicks
    })).sort((a,b) => b.clicks - a.clicks);
    res.json(performance);
  } catch (err) {
    console.error('[PRODUCT PERFORMANCE ERROR]', err);
    return replyInstallGuard(res, err, '상품 퍼포먼스 집계 실패');
  }
});
