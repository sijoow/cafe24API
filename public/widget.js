;(function(){
  // ─── 0) 스크립트 엘리먼트 찾기 & 설정값 가져오기 ─────────────────────────
  let script = document.currentScript;
  if (!script || !script.dataset.pageId) {
    script = Array.from(document.getElementsByTagName('script')).find(s =>
      /widget\.js/.test(s.src) && s.dataset.pageId
    );
  }
  if (!script || !script.dataset.pageId || !script.dataset.mallId) {
    console.warn('⚠️ Widget 스크립트를 찾을 수 없거나 mallId/pageId가 누락되었습니다.');
    return;
  }

  const API_BASE       = script.dataset.apiBase;
  const pageId         = script.dataset.pageId;
  const mallId         = script.dataset.mallId;
  const tabCount       = parseInt(script.dataset.tabCount, 10) || 0;
  const activeColor    = script.dataset.activeColor || '#1890ff';
  const couponNos      = script.dataset.couponNos || '';
  const couponQSStart  = couponNos ? `?coupon_no=${couponNos}` : '';
  const couponQSAppend = couponNos ? `&coupon_no=${couponNos}` : '';
  const directNos      = script.dataset.directNos || '';
  const inlineBlocksId = script.dataset.inlineBlocks || ''; // NEW: 인라인 blocks JSON id

  // ─── 0.1) API 도메인 preconnect ───────────────────────────────────
  if (API_BASE) {
    const preconnect = document.createElement('link');
    preconnect.rel = 'preconnect';
    preconnect.href = API_BASE;
    preconnect.crossOrigin = 'anonymous';
    document.head.appendChild(preconnect);
  }

  // ─── visitorId 관리 ───────────────────────────────────────────────
  const visitorId = (() => {
    const key = 'appVisitorId';
    let id = localStorage.getItem(key);
    if (!id) {
      id = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2);
      localStorage.setItem(key, id);
    }
    return id;
  })();

  // ─── 중복뷰 방지 헬퍼 ──────────────────────────────────────────────
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

  // ─── Device 감지 ────────────────────────────────────────────────
  const ua = navigator.userAgent;
  const device = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua)
    ? 'iOS'
    : 'PC';

  // ─── 공통 트랙 함수 ───────────────────────────────────────────────
  function track(payload) {
    fetch(`${API_BASE}/api/${mallId}/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(e => console.error('TRACK ERROR', e));
  }

  // ─── 페이지뷰/재방문 트래킹 ─────────────────────────────────────
  if (shouldTrack()) {
    track({ pageId, pageUrl: location.pathname, visitorId, type: 'view', device, referrer: document.referrer || 'direct', timestamp: new Date().toISOString() });
  } else {
    track({ pageId, pageUrl: location.pathname, visitorId, type: 'revisit', device, referrer: document.referrer || 'direct', timestamp: new Date().toISOString() });
  }

  // ─── 클릭 트래킹 (URL / 쿠폰 / 상품) ─────────────────────────────────────
  document.body.addEventListener('click', e => {
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

  // ─── 캐시 & 재시도 헬퍼 ─────────────────────────────────────────
  const productsCache = {};
  const storagePrefix = `widgetCache_${pageId}_`;

  function fetchWithRetry(url, opts = {}, retries = 3, backoff = 1000) {
    return fetch(url, opts).then(res => {
      if (res.status === 429 && retries > 0) {
        return new Promise(r => setTimeout(r, backoff))
          .then(() => fetchWithRetry(url, opts, retries - 1, backoff * 2));
      }
      if (!res.ok) throw res;
      return res;
    });
  }

  function loadPanel(ul) {
    const cols     = parseInt(ul.dataset.gridSize, 10) || 1;
    const limit    = ul.dataset.count || 300;
    const category = ul.dataset.cate;
    const ulDirect = ul.dataset.directNos || directNos;
    const cacheKey = ulDirect ? `direct_${ulDirect}` : (category ? `cat_${category}` : null);
    const storageKey = cacheKey ? storagePrefix + cacheKey : null;

    // 로컬스토리지 캐시가 있으면 즉시 렌더
    if (storageKey) {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        try {
          const prods = JSON.parse(stored);
          renderProducts(ul, prods, cols);
          return;
        } catch (e) {
          console.warn('캐시 파싱 실패', e);
        }
      }
    }

    // 스피너 표시
    const spinner = document.createElement('div');
    spinner.className = 'grid-spinner';
    ul.parentNode.insertBefore(spinner, ul);

    // 메모리 캐시 확인
    if (cacheKey && productsCache[cacheKey]) {
      renderProducts(ul, productsCache[cacheKey], cols);
      spinner.remove();
      return;
    }

    // 에러 처리 및 재시도 버튼
    const showError = err => {
      console.error(err);
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
        fetchWithRetry(`${API_BASE}/api/${mallId}/products/${no}${couponQSStart}`)
          .then(r => r.json())
      ))
      .then(raw => raw.map(p => ({
        product_no:          p.product_no,
        product_name:        p.product_name,
        summary_description: p.summary_description || '',
        price:               p.price,
        list_image:          p.list_image,
        sale_price:          p.sale_price    || null,
        benefit_price:       p.benefit_price || null,
        benefit_percentage:  p.benefit_percentage || null
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
          product_no:         p.product_no,
          product_name:       p.product_name,
          summary_description: p.summary_description || '',
          price:              p.price,
          list_image:         p.list_image,
          sale_price:         p.sale_price    || null,
          benefit_price:      p.benefit_price || null,
          benefit_percentage: p.benefit_percentage || null,
          clicks:             clickMap[p.product_no] || 0
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

  // ─── 1) blocks 렌더링 (인라인 JSON 우선) + 상품 그리드 생성 ─────────────
  (function bootstrapMedia(){
    let usedInline = false;
    if (inlineBlocksId) {
      const holder = document.getElementById(inlineBlocksId);
      if (holder && holder.textContent) {
        try {
          const blocks = JSON.parse(holder.textContent);
          renderBlocks(blocks);
          usedInline = true;
        } catch (e) {
          console.warn('Inline blocks JSON 파싱 실패', e);
        }
      }
    }

    if (usedInline) {
      document.querySelectorAll(`ul.main_Grid_${pageId}`).forEach(ul => loadPanel(ul));
      return;
    }

    // 인라인이 없으면 API에서 이벤트 조회
    fetch(`${API_BASE}/api/${mallId}/events/${pageId}`)
      .then(res => res.json())
      .then(ev => {
        const blocks = Array.isArray(ev?.content?.blocks)
          ? ev.content.blocks
          : (ev.images || []).map(img => ({
              id: img._id || img.id, type: 'image', src: img.src, regions: img.regions || []
            }));
        renderBlocks(blocks);
        document.querySelectorAll(`ul.main_Grid_${pageId}`).forEach(ul => loadPanel(ul));
      })
      .catch(err => console.error('EVENT LOAD ERROR', err));
  })();

  // ─── blocks(이미지/영상) 렌더링 ───────────────────────────────────
  function renderBlocks(blocks){
    const wrap = document.getElementById('evt-images');
    if (!wrap) return;

    const html = (blocks || []).map(b => {
      if (b.type === 'video' && b.youtubeId) {
        const w = (b.ratio && b.ratio.w) ? b.ratio.w : 16;
        const h = (b.ratio && b.ratio.h) ? b.ratio.h : 9;
        return `
<div style="position:relative;margin:0 auto;width:100%;max-width:800px;">
  <div style="position:relative;width:100%;aspect-ratio:${w} / ${h};">
    <iframe
      src="https://www.youtube.com/embed/${b.youtubeId}"
      title="YouTube video"
      style="position:absolute;inset:0;width:100%;height:100%;border:0;"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      referrerpolicy="strict-origin-when-cross-origin"
      allowfullscreen
    ></iframe>
  </div>
</div>`;
      }
      // image + 매핑
      const overlays = (b.regions||[]).map(r => {
        const l=(r.xRatio*100).toFixed(2), t=(r.yRatio*100).toFixed(2),
              w=(r.wRatio*100).toFixed(2), h=(r.hRatio*100).toFixed(2);
        if (r.coupon) {
          return `<button
            data-track-click="coupon"
            style="position:absolute;left:${l}%;top:${t}%;width:${w}%;height:${h}%;border:none;cursor:pointer;opacity:0"
            onclick="downloadCoupon('${r.coupon}')"></button>`;
        } else {
          const href = /^https?:\/\//.test(r.href||'') ? r.href : ('https://' + (r.href||''));
          return `<a
            data-track-click="url"
            style="position:absolute;left:${l}%;top:${t}%;width:${w}%;height:${h}%"
            href="${href}" target="_blank" rel="noreferrer"></a>`;
        }
      }).join('');
      return `
<div style="position:relative;margin:0 auto;width:100%;max-width:800px;">
  <img src="${b.src}"
       style="max-width:100%;height:auto;display:block;margin:0 auto;"
       alt="">
  ${overlays}
</div>`;
    }).join('\n');

    wrap.innerHTML = html;
  }

  // ─── 제품 목록 렌더링 헬퍼 ───────────────────────────────────────
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
        const num = parseFloat(t.replace(/,/g,'')) || 0;
        return `${num.toLocaleString('ko-KR')}원`;
      }
      return '-';
    }

    const items = products.map(p => {
      const origPrice   = p.price;
      const priceText   = formatKRW(origPrice);
      const saleText    = p.sale_price    != null ? formatKRW(p.sale_price)    : null;
      const couponText  = p.benefit_price != null ? formatKRW(p.benefit_price) : null;
      const salePercent = saleText
        ? Math.round((origPrice - p.sale_price) / origPrice * 100)
        : null;

      return `
        <li style="list-style:none;">
          <a href="/product/detail.html?product_no=${p.product_no}"
             class="prd_link"
             style="text-decoration:none;color:inherit;"
             data-track-click="product"
             data-product-no="${p.product_no}"
             target="_blank" rel="noopener noreferrer">
            <img src="${p.list_image}" alt="${p.product_name}"
                 style="width:100%;display:block;" />
            <div class="prd_desc"
                 style="font-size:14px;color:#666;padding:4px 0;">
              ${p.summary_description||''}
            </div>
            <div class="prd_name"
                 style="font-weight:500;padding-bottom:4px;
                        display:-webkit-box;-webkit-line-clamp:2;
                        -webkit-box-orient:vertical;
                        overflow:hidden;text-overflow:ellipsis;">
              ${p.product_name}
            </div>
          </a>
          <div class="prd_price"${couponText ? ' style="display:none;"' : ''} style="font-size:16px;font-weight:500;">
            ${saleText
              ? `<span class="sale_price">${saleText}</span>
                 ${salePercent>0
                    ? `<div class="sale_wrapper" style="display:inline-block;margin-right:4px;">
                         <span class="sale_percent" style="color:#ff4d4f;">${salePercent}%</span>
                       </div>`
                    : ``}`
              : `<span>${priceText}</span>`}
          </div>
          ${couponText
            ? `<div class="coupon_wrapper" style="margin-top:4px;display:flex;align-items:center;">
                 <span class="prd_coupon_percent" style="color:#ff4d4f;font-weight:500;margin-right:4px;">${p.benefit_percentage}%</span>
                 <span class="prd_coupon" style="font-weight:500;">${couponText}</span>
               </div>`
            : ``}
        </li>`;
    }).join('');

    ul.innerHTML = items;
  }

  // ─── 2) CSS 동적 주입 ─────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
  /* 그리드 스피너 */
  .grid-spinner {
    width: 40px;
    height: 40px;
    border: 4px solid #f3f3f3;
    border-top: 4px solid ${activeColor};
    border-radius: 50%;
    animation: spin_${pageId} 1s linear infinite;
    margin: 20px auto;
  }
  @keyframes spin_${pageId} {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
  .main_Grid_${pageId}{padding-top:10px;padding-bottom:30px}
  .main_Grid_${pageId} .prd_name {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .product_list_widget{padding:20px 0;}
  .tabs_${pageId} {
    display: grid;
    gap: 8px;
    max-width: 800px;
    margin: 16px auto;
    grid-template-columns: repeat(${tabCount},1fr);
  }
  .tabs_${pageId} button {
    padding: 8px;
    font-size: 16px;
    border: none;
    background: #f5f5f5;
    color: #333;
    cursor: pointer;
    border-radius: 4px;

    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tabs_${pageId} button.active {
    background-color:${activeColor}; color:#fff;
  }
  .main_Grid_${pageId} img { padding-bottom:10px; }
  .main_Grid_${pageId} { row-gap:50px!important; }
  .main_Grid_${pageId} li { color:#000; }
  .main_Grid_${pageId} .prd_desc {
    padding-bottom:3px; font-size:14px; color:#666;
  }
  .main_Grid_${pageId} .prd_price { font-size:16px;float:left;}

  .main_Grid_${pageId} .coupon_wrapper,
  .main_Grid_${pageId} .sale_wrapper {
    display:flex; align-items:center;
  }
  .main_Grid_${pageId} .prd_coupon_percent,
  .main_Grid_${pageId} .sale_percent {
    color:#ff4d4f; font-weight:500; margin-right:4px;
  }

  .main_Grid_${pageId} .sale_price{float:right;}
  .main_Grid_${pageId} .sale_price,
  .main_Grid_${pageId} .prd_coupon { font-weight:500; }
  @media (max-width: 400px) {
    .tabs_${pageId}{ width:95%; margin:0 auto;margin-top:20px; font-weight:bold; }
    .tabs_${pageId} button{ font-size:14px; }
    .main_Grid_${pageId}{ width:95%; margin:0 auto; row-gap:30px!important; }
    .main_Grid_${pageId} .prd_desc{ font-size:12px; padding-bottom:5px; }
    .main_Grid_${pageId} .prd_price{ font-size:15px; }
    .main_Grid_${pageId} .sale_percent,
    .main_Grid_${pageId} .prd_coupon_percent{ font-size:15px; }
  }`;
  document.head.appendChild(style);

  // ─── 탭 전환 & 쿠폰 다운로드 헬퍼 ─────────────────────────────────
  window.showTab = (id, btn) => {
    document.querySelectorAll(`.tab-content_${pageId}`).forEach(el => el.style.display = 'none');
    document.querySelectorAll(`.tabs_${pageId} button`).forEach(b => b.classList.remove('active'));
    const panel = document.getElementById(id);
    if (panel) panel.style.display = 'block';
    btn.classList.add('active');
  };
  window.downloadCoupon = coupons => {
    const list = Array.isArray(coupons) ? coupons : [coupons];
    list.forEach(cpn => {
      const url = `/exec/front/newcoupon/IssueDownload?coupon_no=${cpn}`;
      window.open(
        url + `&opener_url=${encodeURIComponent(location.href)}`,
        '_blank'
      );
    });
  };

})();
