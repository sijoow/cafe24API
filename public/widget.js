;(function () {
  // ────────────────────────────────────────────────────────────────
  // 0) 스크립트/설정값
  // ────────────────────────────────────────────────────────────────
  let script = document.currentScript;
  if (!script || !script.dataset.pageId) {
    script = Array.from(document.getElementsByTagName('script')).find(s =>
      /widget\.js/.test(s.src) && s.dataset.pageId
    );
  }
  if (!script || !script.dataset.pageId || !script.dataset.mallId) {
    console.warn('⚠️ widget.js: mallId/pageId 누락');
    return;
  }

  const API_BASE       = script.dataset.apiBase;
  const pageId         = script.dataset.pageId;
  const mallId         = script.dataset.mallId;
  const tabCount       = parseInt(script.dataset.tabCount || '0', 10);
  const activeColor    = script.dataset.activeColor || '#1890ff';
  const couponNos      = script.dataset.couponNos || '';
  const couponQSStart  = couponNos ? `?coupon_no=${couponNos}` : '';
  const couponQSAppend = couponNos ? `&coupon_no=${couponNos}` : '';
  const directNos      = script.dataset.directNos || '';
  const ignoreText     = script.dataset.ignoreText === '1';
  const autoplayAll    = script.dataset.autoplayAll === '1';
  const loopAll        = script.dataset.loopAll === '1'; // (선택) 모든 영상 강제 반복

  // API preconnect
  if (API_BASE) {
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = API_BASE;
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  }

  // ────────────────────────────────────────────────────────────────
  // 1) 유틸/트래킹
  // ────────────────────────────────────────────────────────────────
  const ua = navigator.userAgent;
  const device = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : 'PC';
  const visitorId = (() => {
    const key = 'appVisitorId';
    let id = localStorage.getItem(key);
    if (!id) {
      id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
      localStorage.setItem(key, id);
    }
    return id;
  })();

  const pad = n => String(n).padStart(2, '0');
  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function shouldTrack() {
    if (/[?&]track=true/.test(location.search)) return true;
    const key = `tracked_${pageId}_${visitorId}_${today()}`;
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, '1');
    return true;
  }
  function track(payload) {
    fetch(`${API_BASE}/api/${mallId}/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }
  if (shouldTrack()) {
    track({ pageId, pageUrl: location.pathname, visitorId, type: 'view', device, referrer: document.referrer || 'direct', timestamp: new Date().toISOString() });
  } else {
    track({ pageId, pageUrl: location.pathname, visitorId, type: 'revisit', device, referrer: document.referrer || 'direct', timestamp: new Date().toISOString() });
  }
  document.body.addEventListener('click', (e) => {
    const el = e.target.closest('[data-track-click]');
    if (!el) return;
    const elementType = el.dataset.trackClick;
    const payload = { pageId, pageUrl: location.pathname, visitorId, type: 'click', element: elementType, device, referrer: document.referrer || 'direct', timestamp: new Date().toISOString() };
    if (elementType === 'product') {
      const productNo = el.dataset.productNo;
      if (productNo) payload.productNo = productNo;
    }
    track(payload);
  });

  // ────────────────────────────────────────────────────────────────
  // 2) 공통 헬퍼
  // ────────────────────────────────────────────────────────────────
  function escapeHtml(s = '') {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ✅ 유튜브 ID 파서 (URL/ID/iframe src 모두 대응)
  function parseYouTubeId(input) {
    if (!input) return null;
    const str = String(input).trim();
    if (/^[\w-]{11}$/.test(str)) return str;
    try {
      const url = new URL(str);
      const host = url.hostname.replace('www.', '');
      if (host === 'youtu.be') return url.pathname.slice(1);
      if (host.includes('youtube.com')) {
        const v = url.searchParams.get('v');
        if (v) return v;
        const m = url.pathname.match(/\/(embed|shorts)\/([\w-]{11})/);
        if (m) return m[2];
      }
    } catch (_) {
      // not a URL, try to extract from iframe src
      const m = str.match(/src=["']([^"']+)["']/i);
      if (m) return parseYouTubeId(m[1]);
    }
    return null;
  }

  // truthy → boolean
  function toBool(v) {
    return v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
  }

  const productsCache = {};
  const storagePrefix = `widgetCache_${pageId}_`;

  function fetchWithRetry(url, opts = {}, retries = 3, backoff = 1000) {
    return fetch(url, opts).then(res => {
      if (res.status === 429 && retries > 0) {
        return new Promise(r => setTimeout(r, backoff)).then(() => fetchWithRetry(url, opts, retries - 1, backoff * 2));
      }
      if (!res.ok) throw res;
      return res;
    });
  }

  // ────────────────────────────────────────────────────────────────
  // 3) 블록 렌더(텍스트/이미지/영상) — “순서대로”
  // ────────────────────────────────────────────────────────────────
  function getRootContainer() {
    // 1순위: #evt-root, 2순위: #evt-images, 3순위: 동적 생성
    let root = document.getElementById('evt-root');
    if (!root) root = document.getElementById('evt-images');
    if (!root) {
      root = document.createElement('div');
      root.id = 'evt-root';
      document.body.insertBefore(root, document.body.firstChild);
    }
    // 혹시 기존 #evt-text가 있으면 비워 중복 제거
    const textDiv = document.getElementById('evt-text');
    if (textDiv) textDiv.innerHTML = '';
    // 비우고 시작
    root.innerHTML = '';
    return root;
  }

  function renderBlocks(blocks) {
    const root = getRootContainer();

    blocks.forEach((b) => {
      const type = b.type || 'image';

      // TEXT
      if (type === 'text') {
        if (ignoreText) return;
        const st = b.style || {};
        const wrapper = document.createElement('div');
        wrapper.style.textAlign = st.align || 'center';
        wrapper.style.marginTop = `${st.mt ?? 16}px`;
        wrapper.style.marginBottom = `${st.mb ?? 16}px`;

        const inner = document.createElement('div');
        inner.style.fontSize = `${st.fontSize || 18}px`;
        inner.style.fontWeight = st.fontWeight || 'normal';
        inner.style.color = st.color || '#333';
        inner.innerHTML = escapeHtml(b.text || '').replace(/\n/g, '<br/>');

        wrapper.appendChild(inner);
        root.appendChild(wrapper);
        return;
      }

      // VIDEO
      if (type === 'video') {
        const ratio = b.ratio || { w: 16, h: 9 };
        const yid = b.youtubeId || parseYouTubeId(b.src);
        if (!yid) return;

        // autoplay 및 loop 처리
        const willAutoplay = autoplayAll || toBool(b.autoplay);
        // ✅ 변경된 핵심: 자동재생이 켜졌다면 강제로 loop 적용 (개별 영상 기준)
        const willLoop     = loopAll || toBool(b.loop) || willAutoplay;

        const qs = new URLSearchParams({
          autoplay: willAutoplay ? '1' : '0',
          mute: willAutoplay ? '1' : '0',      // 모바일 자동재생 필수
          playsinline: '1',                    // iOS 인라인 재생
          rel: '0',
          modestbranding: '1'
        });

        if (willLoop) {
          // YouTube loop 규칙: loop=1 + playlist=<videoId>
          qs.set('loop', '1');
          qs.set('playlist', yid);
        }

        const src = `https://www.youtube.com/embed/${yid}?${qs.toString()}`;

        const wrap = document.createElement('div');
        wrap.style.position = 'relative';
        wrap.style.width = '100%';
        wrap.style.maxWidth = '800px';
        wrap.style.margin = '0 auto';

        // aspect-ratio 속성(미지원 브라우저 대비)
        if ('aspectRatio' in wrap.style) {
          wrap.style.aspectRatio = `${ratio.w}/${ratio.h}`;
          const iframe = document.createElement('iframe');
          iframe.src = src;
          iframe.title = `youtube-${yid}`;
          iframe.style.position = 'absolute';
          iframe.style.inset = '0';
          iframe.style.width = '100%';
          iframe.style.height = '100%';
          iframe.style.border = '0';
          iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
          iframe.setAttribute('allowfullscreen', '');
          wrap.appendChild(iframe);
          root.appendChild(wrap);
          return;
        }

        // 패딩박스 방식
        const innerBox = document.createElement('div');
        innerBox.style.position = 'relative';
        innerBox.style.width = '100%';
        innerBox.style.paddingTop = `${(ratio.h / ratio.w) * 100}%`;
        const iframe = document.createElement('iframe');
        iframe.src = src;
        iframe.title = `youtube-${yid}`;
        iframe.style.position = 'absolute';
        iframe.style.inset = '0';
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.border = '0';
        iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
        iframe.setAttribute('allowfullscreen', '');
        innerBox.appendChild(iframe);
        wrap.appendChild(innerBox);
        root.appendChild(wrap);
        return;
      }

      // IMAGE
      {
        const wrap = document.createElement('div');
        wrap.style.position = 'relative';
        wrap.style.margin = '0 auto';
        wrap.style.width = '100%';
        wrap.style.maxWidth = '800px';

        const img = document.createElement('img');
        img.src = b.src;
        img.style.maxWidth = '100%';
        img.style.height = 'auto';
        img.style.display = 'block';
        img.style.margin = '0 auto';
        wrap.appendChild(img);

        (b.regions || []).forEach(r => {
          const l = (r.xRatio * 100).toFixed(2);
          const t = (r.yRatio * 100).toFixed(2);
          const w = (r.wRatio * 100).toFixed(2);
          const h = (r.hRatio * 100).toFixed(2);

          if (r.coupon) {
            const btn = document.createElement('button');
            btn.dataset.trackClick = 'coupon';
            btn.style.position = 'absolute';
            btn.style.left = `${l}%`;
            btn.style.top = `${t}%`;
            btn.style.width = `${w}%`;
            btn.style.height = `${h}%`;
            btn.style.border = 'none';
            btn.style.cursor = 'pointer';
            btn.style.opacity = '0'; // 보이지 않게(맵핑만)
            btn.addEventListener('click', () => downloadCoupon(r.coupon));
            wrap.appendChild(btn);
          } else if (r.href) {
            const a = document.createElement('a');
            a.dataset.trackClick = 'url';
            a.style.position = 'absolute';
            a.style.left = `${l}%`;
            a.style.top = `${t}%`;
            a.style.width = `${w}%`;
            a.style.height = `${h}%`;
            a.href = /^https?:\/\//.test(r.href) ? r.href : `https://${r.href}`;
            a.target = '_blank';
            a.rel = 'noreferrer';
            wrap.appendChild(a);
          }
        });

        root.appendChild(wrap);
      }
    });
  }

  // ────────────────────────────────────────────────────────────────
  // 4) 상품 그리드
  // ────────────────────────────────────────────────────────────────
  function loadPanel(ul) {
    const cols     = parseInt(ul.dataset.gridSize, 10) || 1;
    const limit    = ul.dataset.count || 300;
    const category = ul.dataset.cate;
    const ulDirect = ul.dataset.directNos || directNos;
    const cacheKey = ulDirect ? `direct_${ulDirect}` : (category ? `cat_${category}` : null);
    const storageKey = cacheKey ? storagePrefix + cacheKey : null;

    // 캐시
    if (storageKey) {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        try {
          const prods = JSON.parse(stored);
          renderProducts(ul, prods, cols);
          return;
        } catch {}
      }
    }

    // 스피너
    const spinner = document.createElement('div');
    spinner.className = 'grid-spinner';
    ul.parentNode.insertBefore(spinner, ul);

    const showError = err => {
      spinner.remove();
      const errDiv = document.createElement('div');
      errDiv.style.textAlign = 'center';
      errDiv.innerHTML = `
        <p style="color:#f00;">상품 로드에 실패했습니다.</p>
        <button style="padding:6px 12px;cursor:pointer;">다시 시도</button>
      `;
      errDiv.querySelector('button').onclick = () => {
        errDiv.remove();
        loadPanel(ul);
      };
      ul.parentNode.insertBefore(errDiv, ul);
    };

    if (ulDirect) {
      const ids = ulDirect.split(',').map(s => s.trim()).filter(Boolean);
      Promise.all(ids.map(no =>
        fetchWithRetry(`${API_BASE}/api/${mallId}/products/${no}${couponQSStart}`).then(r => r.json())
      ))
      .then(raw => raw.map(p => ({
        product_no:          p.product_no,
        product_name:        p.product_name,
        summary_description: p.summary_description || '',
        price:               p.price,
        list_image:          p.list_image,
        sale_price:          p.sale_price    || null,
        benefit_price:       p.benefit_price || null,
        benefit_percentage:  p.benefit_percentage || null,
        decoration_icon_url: p.decoration_icon_url || null

      })))
      .then(products => {
        if (cacheKey) {
          productsCache[cacheKey] = products;
          localStorage.setItem(storageKey, JSON.stringify(products));
        }
        renderProducts(ul, products, cols);
        spinner.remove();
      })
      .catch(showError);

    } else if (category) {
      const prodUrl = `${API_BASE}/api/${mallId}/categories/${category}/products?limit=${limit}${couponQSAppend}`;
      const perfUrl = `${API_BASE}/api/${mallId}/analytics/${pageId}/product-performance?category_no=${category}`;

      Promise.all([
        fetchWithRetry(prodUrl).then(r => r.json()).then(json => Array.isArray(json) ? json : (json.products || [])),
        fetchWithRetry(perfUrl).then(r => r.json()).then(json => Array.isArray(json) ? json : (json.data || []))
      ])
      .then(([rawProducts, clicksData]) => {
        const clickMap = clicksData.reduce((m, c) => { m[c.productNo] = c.clicks; return m; }, {});
        const products = rawProducts.map(p => ({
          product_no:          p.product_no,
          product_name:        p.product_name,
          summary_description: p.summary_description || '',
          price:               p.price,
          list_image:          p.list_image,
          sale_price:          p.sale_price    || null,
          benefit_price:       p.benefit_price || null,
          benefit_percentage:  p.benefit_percentage || null,
          decoration_icon_url: p.decoration_icon_url || null,
          clicks:              clickMap[p.product_no] || 0
        }));
        if (cacheKey) {
          productsCache[cacheKey] = products;
          localStorage.setItem(storageKey, JSON.stringify(products));
        }
        renderProducts(ul, products, cols);
        spinner.remove();
      })
      .catch(showError);

    } else {
      spinner.remove();
    }
  }

function renderProducts(ul, products, cols) {
  ul.style.display = 'grid';
  ul.style.gridTemplateColumns = `repeat(${cols},1fr)`;
  ul.style.gap = '10px';
  ul.style.maxWidth = '800px';
  ul.style.margin = '0 auto';

  function formatKRW(val) {
    if (typeof val === 'number') return `${val.toLocaleString('ko-KR')}원`;
    if (typeof val === 'string') {
      const t = val.trim();
      if (t.endsWith('원')) return t;
      const num = parseFloat(t.replace(/,/g, '')) || 0;
      return `${num.toLocaleString('ko-KR')}원`;
    }
    return '-';
  }

  const items = products.map(p => {
    // [수정] 소수점이 포함된 가격(".00")도 처리할 수 있도록 parseFloat과 정규식을 변경합니다.
    const originalPriceNum = parseFloat(String(p.price || '0').replace(/[^0-9.]/g, ''));
    
    const cleanSaleString = String(p.sale_price || '0').replace(/[^0-9.]/g, '');
    const salePriceNum = parseFloat(cleanSaleString) || null;

    const cleanCouponString = String(p.benefit_price || '0').replace(/[^0-9.]/g, '');
    const couponPriceNum = parseFloat(cleanCouponString) || null;

    // 여러 할인 중 가장 저렴한 가격을 최종 가격으로 결정합니다.
    let finalPriceNum = originalPriceNum;
    if (salePriceNum != null && salePriceNum < finalPriceNum) {
      finalPriceNum = salePriceNum;
    }
    if (couponPriceNum != null && couponPriceNum < finalPriceNum) {
      finalPriceNum = couponPriceNum;
    }

    // 화면에 표시될 가격 텍스트를 미리 만듭니다.
    const originalPriceText = formatKRW(originalPriceNum);
    const finalPriceText = formatKRW(finalPriceNum);
    
    // 할인이 실제로 적용되었는지(가격이 다른지) 확인합니다.
    const hasDiscount = finalPriceNum < originalPriceNum;

    // HTML 구조를 만듭니다.
    return `
    <li style="list-style:none;">
      <a href="/product/detail.html?product_no=${p.product_no}"
         class="prd_link"
         style="text-decoration:none;color:inherit;"
         data-track-click="product"
         data-product-no="${p.product_no}"
         target="_blank" rel="noopener noreferrer">
        <div style="position:relative;">
          <img src="${p.list_image}" alt="${p.product_name}" style="width:100%;display:block;" />
          ${p.decoration_icon_url ? `<div style="position:absolute;top:0;right:0;"><img src="${p.decoration_icon_url}" alt="icon" class="prd_deco_icon" /></div>` : ''}
        </div>
        <div class="prd_desc" style="font-size:14px;color:#666;padding:4px 0;display:none">
          ${p.summary_description || ''}
        </div>
        <div class="prd_name" style="font-weight:500;padding-bottom:4px;">
          ${p.product_name}
        </div>
      </a>
      
      <div class="prd_price_area">
        ${
          // 할인이 있을 경우: 취소선 정가와 최종가를 함께 표시
          hasDiscount
          ? `
            <div style="display: flex; align-items: center; flex-wrap: wrap; margin-top: 2px;">
              <span class="original_price" style="text-decoration: line-through; color: #999; font-size: 14px;">${originalPriceText}</span>
              <span class="final_price" style="font-size: 16px; font-weight: bold; margin-left: 6px;">${finalPriceText}</span>
            </div>
          `
          // 할인이 없을 경우: 최종 가격만 표시
          : `
            <div style="font-size: 16px; font-weight: 500; margin-top: 2px;">
              <span class="final_price">${originalPriceText}</span>
            </div>
          `
        }
      </div>
    </li>`;
  }).join('');

  ul.innerHTML = items;
}

  // ────────────────────────────────────────────────────────────────
  // 5) CSS 주입
  // ────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
  .final_price{font-weight:bold}
  .grid-spinner {
    width: 40px; height: 40px; border: 4px solid #f3f3f3;
    border-top: 4px solid ${activeColor};
    border-radius: 50%; animation: spin_${pageId} 1s linear infinite; margin: 20px auto;
  }
  .prd_name{font-size:15px;}
  @keyframes spin_${pageId} { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg);} }
  .main_Grid_${pageId}{padding-top:10px;padding-bottom:30px}
  .main_Grid_${pageId} .prd_name{font-size:15px;}
  .product_list_widget{padding:20px 0;}
  .tabs_${pageId} {
    display: grid; gap: 8px; max-width: 800px; margin: 16px auto;width:95%; grid-template-columns: repeat(${tabCount},1fr);
  }
  .tabs_${pageId} button { padding: 8px; font-size: 16px; border: none; background: #f5f5f5; color: #333; cursor: pointer; border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tabs_${pageId} button.active { background-color:${activeColor}; color:#fff; }
  .main_Grid_${pageId} img { padding-bottom:10px; }
  .main_Grid_${pageId} { row-gap:50px!important; }
  .main_Grid_${pageId} li { color:#000; }
  .main_Grid_${pageId} .prd_desc { padding-bottom:3px; font-size:14px; color:#666; }
  .main_Grid_${pageId} .prd_price { font-size:16px; }
  .main_Grid_${pageId} .coupon_wrapper, .main_Grid_${pageId} .sale_wrapper { margin-top:4px; display:flex; align-items:center; }
  .main_Grid_${pageId} .prd_coupon_percent, .main_Grid_${pageId} .sale_percent { color:#ff4d4f; font-weight:500; margin-right:4px; }
  .main_Grid_${pageId} .sale_price, .main_Grid_${pageId} .prd_coupon { font-weight:500; }
  @media (max-width: 400px) {
    .tabs_${pageId}{ width:95%; margin:0 auto;margin-top:20px; font-weight:bold; }
    .tabs_${pageId} button{ font-size:14px; }
    .main_Grid_${pageId}{ width:95%; margin:0 auto; row-gap:30px!important; }
    .main_Grid_${pageId} .prd_desc{ font-size:12px; padding-bottom:5px; }
    .main_Grid_${pageId} .prd_price{ font-size:15px; }
    .main_Grid_${pageId} .sale_percent, .main_Grid_${pageId} .prd_coupon_percent{ font-size:15px; }
  }`;
  document.head.appendChild(style);

  // ────────────────────────────────────────────────────────────────
  // 6) 데이터 로드 & 실행
  // ────────────────────────────────────────────────────────────────
  fetch(`${API_BASE}/api/${mallId}/events/${pageId}`)
    .then(res => res.json())
    .then(ev => {
      // blocks 우선, 없으면 images를 image-block으로 변환
      const rawBlocks = Array.isArray(ev?.content?.blocks) && ev.content.blocks.length
        ? ev.content.blocks
        : (ev.images || []).map(img => ({
            type: 'image',
            src: img.src,
            regions: img.regions || []
          }));

      const blocks = rawBlocks.map(b => {
        const t = b.type || 'image';
        if (t === 'video') {
          // youtubeId 보정 + autoplay/loop boolean
          const yid = b.youtubeId || parseYouTubeId(b.src);
          return {
            type: 'video',
            youtubeId: yid,
            ratio: (b.ratio && typeof b.ratio.w === 'number' && typeof b.ratio.h === 'number') ? b.ratio : { w: 16, h: 9 },
            autoplay: toBool(b.autoplay),
            loop: toBool(b.loop)
          };
        }
        if (t === 'text') {
          return {
            type: 'text',
            text: b.text || '',
            style: b.style || {}
          };
        }
        return {
          type: 'image',
          src: b.src,
          regions: (b.regions || []).map(r => ({
            xRatio: r.xRatio, yRatio: r.yRatio, wRatio: r.wRatio, hRatio: r.hRatio,
            href: r.href, coupon: r.coupon
          }))
        };
      });

      // 1) 블록(텍스트/이미지/영상) 순서대로 렌더
      renderBlocks(blocks);

      // 2) 상품 그리드 로드
      document.querySelectorAll(`ul.main_Grid_${pageId}`).forEach(ul => loadPanel(ul));
    })
    .catch(err => console.error('EVENT LOAD ERROR', err));

  // ────────────────────────────────────────────────────────────────
  // 7) 탭 전환/쿠폰 다운로드
  // ────────────────────────────────────────────────────────────────
  window.showTab = (id, btn) => {
    document.querySelectorAll(`.tab-content_${pageId}`).forEach(el => el.style.display = 'none');
    document.querySelectorAll(`.tabs_${pageId} button`).forEach(b => b.classList.remove('active'));
    const panel = document.getElementById(id);
    if (panel) panel.style.display = 'block';
    if (btn) btn.classList.add('active');
  };
  window.downloadCoupon = coupons => {
    const list = Array.isArray(coupons) ? coupons : [coupons];
    list.forEach(cpn => {
      const url = `/exec/front/newcoupon/IssueDownload?coupon_no=${cpn}`;
      window.open(url + `&opener_url=${encodeURIComponent(location.href)}`, '_blank');
    });
  };
})();
