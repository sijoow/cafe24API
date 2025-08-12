;(function () {
  // ─── 0) 스크립트 엘리먼트 찾기 & 설정값 ─────────────────────────────
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

  const API_BASE      = script.dataset.apiBase;
  const pageId        = script.dataset.pageId;
  const mallId        = script.dataset.mallId;
  const tabCount      = parseInt(script.dataset.tabCount, 10) || 0;
  const activeColor   = script.dataset.activeColor || '#1890ff';
  const couponNos     = script.dataset.couponNos || '';
  const couponQSStart = couponNos ? `?coupon_no=${couponNos}` : '';
  const couponQSAppend= couponNos ? `&coupon_no=${couponNos}` : '';
  const directNos     = script.dataset.directNos || '';
  const ignoreText    = script.dataset.ignoreText === '1' || script.dataset.renderText === '0'; // 옵션

  // ─── 0.1) API 도메인 preconnect ───────────────────────────────────
  if (API_BASE) {
    const pre = document.createElement('link');
    pre.rel = 'preconnect';
    pre.href = API_BASE;
    pre.crossOrigin = 'anonymous';
    document.head.appendChild(pre);
  }

  // ─── 공통 유틸 ────────────────────────────────────────────────────
  const pad = n => String(n).padStart(2, '0');
  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function escapeHtml(s = '') {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function parseYouTubeId(input) {
    if (!input) return null;
    if (/^[\w-]{11}$/.test(input)) return input;
    try {
      const url = new URL(String(input).trim());
      const host = url.hostname.replace('www.', '');
      if (host === 'youtu.be') return url.pathname.slice(1);
      if (host.includes('youtube.com')) {
        const v = url.searchParams.get('v');
        if (v) return v;
        const m = url.pathname.match(/\/(embed|shorts)\/([\w-]{11})/);
        if (m) return m[2];
      }
    } catch (_) {}
    const m = String(input).match(/src=["']([^"']+)["']/i);
    if (m) return parseYouTubeId(m[1]);
    return null;
  }

  // ─── visitorId / device / track ──────────────────────────────────
  const visitorId = (() => {
    const key = 'appVisitorId';
    let id = localStorage.getItem(key);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(key, id); }
    return id;
  })();
  const ua = navigator.userAgent;
  const device = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : 'PC';

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
      body: JSON.stringify(payload)
    }).catch(e => console.error('TRACK ERROR', e));
  }

  if (shouldTrack()) {
    track({ pageId, pageUrl: location.pathname, visitorId, type:'view', device, referrer: document.referrer || 'direct', timestamp: new Date().toISOString() });
  } else {
    track({ pageId, pageUrl: location.pathname, visitorId, type:'revisit', device, referrer: document.referrer || 'direct', timestamp: new Date().toISOString() });
  }

  document.body.addEventListener('click', e => {
    const el = e.target.closest('[data-track-click]');
    if (!el) return;
    const elementType = el.dataset.trackClick;
    const payload = { pageId, pageUrl: location.pathname, visitorId, type:'click', element: elementType, device, referrer: document.referrer || 'direct', timestamp: new Date().toISOString() };
    if (elementType === 'product') {
      const productNo = el.dataset.productNo;
      if (productNo) payload.productNo = productNo;
    }
    track(payload);
  });

  // ─── 캐시 & 재시도 ────────────────────────────────────────────────
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

  // ─── 1) 이벤트 데이터 로드 & 블록(이미지/텍스트/영상) 순서대로 렌더 ───
  fetch(`${API_BASE}/api/${mallId}/events/${pageId}`)
    .then(res => res.json())
    .then(ev => {
      // blocks 정규화 (없으면 images로 폴백)
      const rawBlocks = Array.isArray(ev?.content?.blocks)
        ? ev.content.blocks
        : (ev.images || []).map(img => ({
            _id: img._id || img.id,
            type: 'image',
            src: img.src,
            regions: img.regions || []
          }));

      const blocks = rawBlocks.map(b => {
        const type = b.type || 'image';
        if (type === 'text') {
          return {
            id: b._id || b.id,
            type: 'text',
            text: b.text || '',
            style: b.style || {} // {align,fontSize,fontWeight,color,mt,mb}
          };
        }
        if (type === 'video') {
          return {
            id: b._id || b.id,
            type: 'video',
            youtubeId: b.youtubeId || parseYouTubeId(b.src),
            ratio: b.ratio || { w:16, h:9 }
          };
        }
        return {
          id: b._id || b.id,
          type: 'image',
          src: b.src,
          regions: (b.regions || []).map(r => ({
            id: r._id || r.id,
            xRatio: r.xRatio, yRatio: r.yRatio, wRatio: r.wRatio, hRatio: r.hRatio,
            href: r.href, coupon: r.coupon
          }))
        };
      });

      // 컨테이너
      const imagesContainer =
        document.getElementById('evt-images') ||
        (function () {
          const d = document.createElement('div');
          d.id = 'evt-images';
          script.parentNode.insertBefore(d, script);
          return d;
        })();

      // 블록 순서대로 HTML
      const parts = blocks.map((b, idx) => {
        if (b.type === 'text') {
          if (ignoreText || !String(b.text || '').trim()) return '';
          const st = b.style || {};
          const align = st.align || 'center';
          const mt = st.mt ?? 16;
          const mb = st.mb ?? 16;
          const fontSize = st.fontSize || 18;
          const fontWeight = st.fontWeight || 'normal';
          const color = st.color || '#333';
          const body = escapeHtml(b.text).replace(/\n/g, '<br/>');
          return `<div style="text-align:${align};margin-top:${mt}px;margin-bottom:${mb}px;">
                    <div style="font-size:${fontSize}px;font-weight:${fontWeight};color:${color};">${body}</div>
                  </div>`;
        }

        if (b.type === 'video') {
          const yid = b.youtubeId;
          const w = b.ratio?.w || 16, h = b.ratio?.h || 9;
          const paddingTop = (h / w) * 100;
          if (!yid) {
            return `<div style="width:100%;max-width:800px;margin:0 auto;background:#eee;color:#666;display:flex;align-items:center;justify-content:center;height:${Math.round((h/w)*800)}px;">영상 블록(ID 없음)</div>`;
          }
          return `<div style="width:100%;max-width:800px;margin:0 auto;">
                    <div style="position:relative;width:100%;padding-top:${paddingTop}%;">
                      <iframe
                        src="https://www.youtube.com/embed/${yid}"
                        title="YouTube video"
                        style="position:absolute;inset:0;width:100%;height:100%;border:0;"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        referrerpolicy="strict-origin-when-cross-origin"
                        allowfullscreen
                      ></iframe>
                    </div>
                  </div>`;
        }

        // image
        const regs = (b.regions || []).map(r => {
          const l = (r.xRatio * 100).toFixed(2),
                t = (r.yRatio * 100).toFixed(2),
                w = (r.wRatio * 100).toFixed(2),
                h = (r.hRatio * 100).toFixed(2);
          if (r.coupon) {
            return `<button
              data-track-click="coupon"
              style="position:absolute;left:${l}%;top:${t}%;width:${w}%;height:${h}%;border:none;cursor:pointer;opacity:0"
              onclick="downloadCoupon('${r.coupon}')"></button>`;
          } else if (r.href) {
            const href = /^https?:\/\//.test(r.href) ? r.href : `https://${r.href}`;
            return `<a
              data-track-click="url"
              style="position:absolute;left:${l}%;top:${t}%;width:${w}%;height:${h}%"
              href="${href}" target="_blank" rel="noreferrer"></a>`;
          }
          return '';
        }).join('');

        return `<div style="position:relative;margin:0 auto;width:100%;max-width:800px;">
                  <img src="${b.src}" alt="img-${idx}"
                       style="max-width:100%;height:auto;display:block;margin:0 auto;"
                       data-img-index="${idx}" />
                  ${regs}
                </div>`;
      });

      imagesContainer.innerHTML = parts.join('\n');

      // 상품 그리드 패널 로드
      document.querySelectorAll(`ul.main_Grid_${pageId}`).forEach(ul => loadPanel(ul));
    })
    .catch(err => console.error('EVENT LOAD ERROR', err));

  // ─── 제품 목록 로드 & 렌더 ────────────────────────────────────────
  function loadPanel(ul) {
    const cols     = parseInt(ul.dataset.gridSize, 10) || 1;
    const limit    = ul.dataset.count || 300;
    const category = ul.dataset.cate;
    const ulDirect = ul.dataset.directNos || directNos;
    const cacheKey = ulDirect ? `direct_${ulDirect}` : (category ? `cat_${category}` : null);
    const storageKey = cacheKey ? storagePrefix + cacheKey : null;

    // 캐시 즉시 렌더
    if (storageKey) {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        try {
          const prods = JSON.parse(stored);
          renderProducts(ul, prods, cols);
          return;
        } catch (e) { console.warn('캐시 파싱 실패', e); }
      }
    }

    // 스피너
    const spinner = document.createElement('div');
    spinner.className = 'grid-spinner';
    ul.parentNode.insertBefore(spinner, ul);

    // 메모리 캐시
    if (cacheKey && productsCache[cacheKey]) {
      renderProducts(ul, productsCache[cacheKey], cols);
      spinner.remove();
      return;
    }

    const showError = err => {
      console.error(err);
      spinner.remove();
      const errDiv = document.createElement('div');
      errDiv.style.textAlign = 'center';
      errDiv.innerHTML = `
        <p style="color:#f00;">상품 로드에 실패했습니다.</p>
        <button style="padding:6px 12px;cursor:pointer;">다시 시도</button>
      `;
      errDiv.querySelector('button').onclick = () => { errDiv.remove(); loadPanel(ul); };
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
          product_no:          p.product_no,
          product_name:        p.product_name,
          summary_description: p.summary_description || '',
          price:               p.price,
          list_image:          p.list_image,
          sale_price:          p.sale_price    || null,
          benefit_price:       p.benefit_price || null,
          benefit_percentage:  p.benefit_percentage || null,
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
      const salePercent = saleText ? Math.round((origPrice - p.sale_price) / origPrice * 100) : null;

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
            <div class="prd_desc" style="font-size:14px;color:#666;padding:4px 0;">${p.summary_description||''}</div>
            <div class="prd_name" style="font-weight:500;padding-bottom:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-overflow:ellipsis;">
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

  // ─── 2) CSS 동적 주입 ────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
  .grid-spinner {
    width: 40px; height: 40px;
    border: 4px solid #f3f3f3; border-top: 4px solid ${activeColor};
    border-radius: 50%; animation: spin_${pageId} 1s linear infinite;
    margin: 20px auto;
  }
  @keyframes spin_${pageId} { 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }
  .main_Grid_${pageId}{padding-top:10px;padding-bottom:30px}
  .main_Grid_${pageId} .prd_name{-webkit-line-clamp:2;-webkit-box-orient:vertical;display:-webkit-box;overflow:hidden;text-overflow:ellipsis}
  .product_list_widget{padding:20px 0;}
  .tabs_${pageId}{display:grid;gap:8px;max-width:800px;margin:16px auto;grid-template-columns:repeat(${tabCount},1fr)}
  .tabs_${pageId} button{padding:8px;font-size:16px;border:none;background:#f5f5f5;color:#333;cursor:pointer;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tabs_${pageId} button.active{background-color:${activeColor};color:#fff;}
  .main_Grid_${pageId} img{padding-bottom:10px}
  .main_Grid_${pageId}{row-gap:50px!important}
  .main_Grid_${pageId} li{color:#000}
  .main_Grid_${pageId} .prd_desc{padding-bottom:3px;font-size:14px;color:#666}
  .main_Grid_${pageId} .prd_price{font-size:16px}
  .main_Grid_${pageId} .coupon_wrapper,.main_Grid_${pageId} .sale_wrapper{margin-top:4px;display:flex;align-items:center}
  .main_Grid_${pageId} .prd_coupon_percent,.main_Grid_${pageId} .sale_percent{color:#ff4d4f;font-weight:500;margin-right:4px}
  .main_Grid_${pageId} .sale_price,.main_Grid_${pageId} .prd_coupon{font-weight:500}
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

  // ─── 탭 & 쿠폰 헬퍼 ──────────────────────────────────────────────
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
      window.open(url + `&opener_url=${encodeURIComponent(location.href)}`, '_blank');
    });
  };
})();
