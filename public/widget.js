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

  const API_BASE = script.dataset.apiBase || '';
  const pageId = script.dataset.pageId;
  const mallId = script.dataset.mallId;
  const tabCount = parseInt(script.dataset.tabCount || '0', 10);
  const activeColor = script.dataset.activeColor || '#1890ff';
  const couponNos = script.dataset.couponNos || '';
  const couponQSStart = couponNos ? `?coupon_no=${couponNos}` : '';
  const couponQSAppend = couponNos ? `&coupon_no=${couponNos}` : '';
  const directNos = script.dataset.directNos || '';
  const ignoreText = script.dataset.ignoreText === '1';
  const autoplayAll = script.dataset.autoplayAll === '1';
  const loopAll = script.dataset.loopAll === '1';

  // 새 옵션 설명
  // data-clear-cookies="1" : 초기화 시 기존 쿠키 삭제 (JS에서 접근 가능한 쿠키만 가능)
  // data-clear-cookie-prefix="prefix_" : prefix로 시작하는 쿠키만 삭제
  // data-clear-storage="1" : sessionStorage/localStorage 삭제
  // data-refresh-cookies="1" : 이벤트 응답(ev)에 포함된 ev.refreshCookies를 클라이언트에서 설정
  // data-refresh-cookies-endpoint="..." : 서버 endpoint를 호출해서 서버가 Set-Cookie로 쿠키를 내려주도록 시도 (credentials: include)

  /* ------------------------------------------------------------------
     COOKIE CLEAR & REFRESH FEATURE
  ------------------------------------------------------------------ */
  function deleteCookie(name) {
    try { document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/;`; } catch (e) {}
    const host = location.hostname || '';
    const parts = host.split('.');
    for (let i = 0; i < parts.length - 0; i++) {
      const domain = '.' + parts.slice(i).join('.');
      try {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${domain};`;
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${domain.replace(/^\./,'')};`;
      } catch (e) {}
    }
  }

  function clearCookiesAndStorage(prefix = null, clearStorage = false) {
    try {
      const all = document.cookie || '';
      if (!all) {
        console.info('[widget.js] clear-cookies: document.cookie 비어있음');
      } else {
        const pairs = all.split(';').map(s => s.trim()).filter(Boolean);
        pairs.forEach(pair => {
          const eq = pair.indexOf('=');
          const name = eq > -1 ? pair.slice(0, eq).trim() : pair;
          if (!name) return;
          if (prefix) {
            if (name.indexOf(prefix) === 0) {
              deleteCookie(name);
              console.debug(`[widget.js] clear-cookies: deleted cookie ${name} (prefix match)`);
            }
          } else {
            deleteCookie(name);
            console.debug(`[widget.js] clear-cookies: deleted cookie ${name}`);
          }
        });
      }
    } catch (e) {
      console.warn('[widget.js] clear-cookies: 예외 발생', e);
    }

    if (clearStorage) {
      try { sessionStorage.clear(); localStorage.clear(); console.info('[widget.js] clear-storage: cleared'); }
      catch (e) { console.warn('[widget.js] clear-storage: 예외', e); }
    }
  }

  function setCookieClient(name, value, opts = {}) {
    if (!name) return;
    const parts = [];
    parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    parts.push(`path=${opts.path || '/'}`);
    if (opts.domain) parts.push(`domain=${opts.domain}`);
    if (opts.maxAge != null) parts.push(`max-age=${Number(opts.maxAge)}`);
    if (opts.expires) {
      const expires = (opts.expires instanceof Date) ? opts.expires.toUTCString() : String(opts.expires);
      parts.push(`expires=${expires}`);
    }
    if (opts.secure) parts.push('secure');
    if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
    document.cookie = parts.join('; ');
  }

  async function tryServerSetCookiesByEndpoint(endpoint) {
    if (!endpoint) return false;
    try {
      await fetch(endpoint, { method: 'GET', credentials: 'include' });
      console.info('[widget.js] refresh-cookies: endpoint requested (credentials: include)');
      return true;
    } catch (e) {
      console.warn('[widget.js] refresh-cookies: endpoint request failed', e);
      return false;
    }
  }

  (function cookieClearIfRequested() {
    const shouldClear = script.dataset.clearCookies === '1';
    if (!shouldClear) return;
    const prefix = script.dataset.clearCookiePrefix || null;
    const clearStorage = script.dataset.clearStorage === '1';
    clearCookiesAndStorage(prefix, clearStorage);
    console.info('[widget.js] clear-cookies: 완료 (HttpOnly 쿠키는 JS에서 삭제 불가 — 서버 처리 필요)');
  })();
  /* --------------------- END COOKIE CLEAR FEATURE --------------------- */

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

  const visitorId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : String(Date.now()) + '-' + Math.random().toString(36).slice(2);

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
    if (!API_BASE) return;
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
      const m = str.match(/src=["']([^"']+)["']/i);
      if (m) return parseYouTubeId(m[1]);
    }
    return null;
  }

  function toBool(v) {
    return v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
  }

  const productsCache = {};
  const storagePrefix = `widgetCache_${pageId}_`;
  let CURRENT_COUPON_VERSION = localStorage.getItem(storagePrefix + 'couponVersion') || null;

  function makeStorageKeyWithCv(baseKey) {
    const cv = CURRENT_COUPON_VERSION || localStorage.getItem(storagePrefix + 'couponVersion') || 'none';
    return storagePrefix + baseKey + '__cv:' + cv;
  }

  function invalidateProductCache() {
    try {
      const keys = Object.keys(localStorage);
      for (const k of keys) {
        if (!k) continue;
        if (k.indexOf(storagePrefix + 'direct_') === 0 || k.indexOf(storagePrefix + 'cat_') === 0) {
          localStorage.removeItem(k);
        }
      }
      console.info('[widget.js] Product cache invalidated');
    } catch (e) {
      console.warn('[widget.js] invalidateProductCache error', e);
    }
  }

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
  // 3) 블록 렌더(텍스트/이미지/영상)
  // ────────────────────────────────────────────────────────────────
  function getRootContainer() {
    let root = document.getElementById('evt-root');
    if (!root) root = document.getElementById('evt-images');
    if (!root) {
      root = document.createElement('div');
      root.id = 'evt-root';
      document.body.insertBefore(root, document.body.firstChild);
    }
    const textDiv = document.getElementById('evt-text');
    if (textDiv) textDiv.innerHTML = '';
    root.innerHTML = '';
    return root;
  }

  function renderBlocks(blocks) {
    const root = getRootContainer();

    blocks.forEach((b) => {
      const type = b.type || 'image';

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

      if (type === 'video') {
        const ratio = b.ratio || { w: 16, h: 9 };
        const yid = b.youtubeId || parseYouTubeId(b.src);
        if (!yid) return;

        const willAutoplay = autoplayAll || toBool(b.autoplay);
        const willLoop = loopAll || toBool(b.loop) || willAutoplay;

        const qs = new URLSearchParams({
          autoplay: willAutoplay ? '1' : '0',
          mute: willAutoplay ? '1' : '0',
          playsinline: '1',
          rel: '0',
          modestbranding: '1'
        });

        if (willLoop) {
          qs.set('loop', '1');
          qs.set('playlist', yid);
        }

        const src = `https://www.youtube.com/embed/${yid}?${qs.toString()}`;

        const wrap = document.createElement('div');
        wrap.style.position = 'relative';
        wrap.style.width = '100%';
        wrap.style.maxWidth = '800px';
        wrap.style.margin = '0 auto';

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
            btn.style.opacity = '0';
            btn.addEventListener('click', () => downloadCoupon(r.coupon));
            wrap.appendChild(btn);
          } else if (r.href) {
            const rawHref = String(r.href || '').trim();
            const isTab = /^#?tab[:\s\-]?\d+$/i.test(rawHref);

            const a = document.createElement('a');
            a.dataset.trackClick = 'url';
            a.style.position = 'absolute';
            a.style.left = `${l}%`;
            a.style.top = `${t}%`;
            a.style.width = `${w}%`;
            a.style.height = `${h}%`;
            a.style.display = 'block';
            a.style.textDecoration = 'none';
            a.style.cursor = 'pointer';
            a.setAttribute('data-href', rawHref);

            if (isTab) {
              a.href = 'javascript:void(0)';
            } else {
              const hrefValue = /^https?:\/\//i.test(rawHref) ? rawHref : `https://${rawHref}`;
              a.href = hrefValue;
              a.target = '_blank';
              a.rel = 'noopener noreferrer';
            }

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
    const cols = parseInt(ul.dataset.gridSize, 10) || 1;
    const limit = ul.dataset.count || 300;
    const category = ul.dataset.cate;
    const ulDirect = ul.dataset.directNos || directNos;
    const baseCacheKey = ulDirect ? `direct_${ulDirect}` : (category ? `cat_${category}` : null);
    const storageKey = baseCacheKey ? makeStorageKeyWithCv(baseCacheKey) : null;

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

    const fetchOpts = { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } };

    if (ulDirect) {
      const ids = ulDirect.split(',').map(s => s.trim()).filter(Boolean);
      Promise.all(ids.map(no =>
        fetchWithRetry(`${API_BASE}/api/${mallId}/products/${no}${couponQSStart}`, fetchOpts).then(r => r.json())
      ))
      .then(raw => raw.map(p => (typeof p === 'object' ? p : {}).product_no ? p : {}))
      .then(products => products.map(p => ({
        product_no: p.product_no,
        product_name: p.product_name,
        summary_description: p.summary_description || '',
        price: p.price,
        list_image: p.list_image,
        sale_price: p.sale_price || null,
        benefit_price: p.benefit_price || null,
        benefit_percentage: p.benefit_percentage || null
      })))
      .then(products => {
        if (baseCacheKey && storageKey) {
          productsCache[baseCacheKey] = products;
          try { localStorage.setItem(storageKey, JSON.stringify(products)); } catch (e) { /* ignore quota */ }
        }
        renderProducts(ul, products, cols);
        spinner.remove();
      })
      .catch(showError);

    } else if (category) {
      const prodUrl = `${API_BASE}/api/${mallId}/categories/${category}/products?limit=${limit}${couponQSAppend}`;
      const perfUrl = `${API_BASE}/api/${mallId}/analytics/${pageId}/product-performance?category_no=${category}`;

      Promise.all([
        fetchWithRetry(prodUrl, fetchOpts).then(r => r.json()).then(json => Array.isArray(json) ? json : (json.products || [])),
        fetchWithRetry(perfUrl, fetchOpts).then(r => r.json()).then(json => Array.isArray(json) ? json : (json.data || []))
      ])
      .then(([rawProducts, clicksData]) => {
        const clickMap = clicksData.reduce((m, c) => { m[c.productNo] = c.clicks; return m; }, {});
        const products = rawProducts.map(p => (typeof p === 'object' ? p : {})).map(p => ({
          product_no: p.product_no,
          product_name: p.product_name,
          summary_description: p.summary_description || '',
          price: p.price,
          list_image: p.list_image,
          sale_price: p.sale_price || null,
          benefit_price: p.benefit_price || null,
          benefit_percentage: p.benefit_percentage || null,
          clicks: clickMap[p.product_no] || 0
        }));
        if (baseCacheKey && storageKey) {
          productsCache[baseCacheKey] = products;
          try { localStorage.setItem(storageKey, JSON.stringify(products)); } catch (e) { /* ignore quota */ }
        }
        renderProducts(ul, products, cols);
        spinner.remove();
      })
      .catch(showError);

    } else {
      spinner.remove();
    }
  }

  // ────────────────────────────────────────────────────────────────
  // 5) 안전한 renderProducts (할인율 계산 보강)
  // ────────────────────────────────────────────────────────────────
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

    function parseNumber(v) {
      if (v == null) return null;
      if (typeof v === 'number') {
        return isFinite(v) ? v : null;
      }
      const s = String(v).replace(/[^\d.-]/g, '');
      const n = parseFloat(s);
      return isFinite(n) ? n : null;
    }

    const items = products.map(p => {
      const origPrice = parseNumber(p.price) || 0;
      const salePrice = parseNumber(p.sale_price);
      const benefitPrice = parseNumber(p.benefit_price);
      let apiPercent = null;
      if (p.benefit_percentage != null && p.benefit_percentage !== '') {
        const np = parseNumber(p.benefit_percentage);
        apiPercent = np != null ? Math.round(np) : null;
      }

      let displayPercent = null;
      if (apiPercent != null && apiPercent > 0) {
        displayPercent = apiPercent;
      } else if (benefitPrice != null && origPrice > 0) {
        const calc = Math.round((origPrice - benefitPrice) / origPrice * 100);
        displayPercent = (isFinite(calc) && calc > 0) ? calc : null;
      } else if (salePrice != null && origPrice > 0) {
        const calc2 = Math.round((origPrice - salePrice) / origPrice * 100);
        displayPercent = (isFinite(calc2) && calc2 > 0) ? calc2 : null;
      } else {
        displayPercent = null;
      }

      const priceText = formatKRW(origPrice);
      const saleText = salePrice != null ? formatKRW(salePrice) : null;
      const couponText = benefitPrice != null ? formatKRW(benefitPrice) : null;
      const salePercent = (salePrice != null && origPrice > 0) ? Math.round((origPrice - salePrice) / origPrice * 100) : null;

      return `
        <li style="list-style:none;">
          <a href="/product/detail.html?product_no=${p.product_no}"
             class="prd_link"
             style="text-decoration:none;color:inherit;"
             data-track-click="product"
             data-product-no="${p.product_no}"
             target="_blank" rel="noopener noreferrer">
            <img src="${p.list_image}" alt="${(p.product_name||'')}" style="width:100%;display:block;" />
            <div class="prd_desc" style="font-size:14px;color:#666;padding:4px 0;">
              ${p.summary_description || ''}
            </div>
            <div class="prd_name" style="font-weight:500;padding-bottom:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-overflow:ellipsis;">
              ${escapeHtml(p.product_name || '')}
            </div>
          </a>
          <div class="prd_price"${couponText ? ' style="display:none;"' : ''} style="font-size:16px;font-weight:500;">
            ${
              saleText
                ? `<span class="original_price" style="text-decoration: line-through; color: #999; margin-right: 6px;">
                     ${priceText}
                   </span>
                   <span class="sale_price">${saleText}</span>
                   ${salePercent && salePercent > 0
                     ? `<div class="sale_wrapper" style="display:inline-block;margin-right:4px;">
                          <span class="sale_percent" style="color:#ff4d4f;">${salePercent}%</span>
                        </div>` : ``}`
                : `<span>${priceText}</span>`
            }
          </div>
          ${
            couponText
              ? `<div class="coupon_wrapper" style="margin-top:4px;display:flex;align-items:center;">
                   <span class="original_price" style="text-decoration: line-through; color: #999; margin-right: 6px;">
                     ${priceText}
                   </span>
                   ${displayPercent ? `<span class="prd_coupon_percent" style="color:#ff4d4f;font-weight:500;margin-right:4px;">${displayPercent}%</span>` : ''}
                   <span class="prd_coupon" style="font-weight:500;">${couponText}</span>
                 </div>`
              : ``
          }
        </li>`;
    }).join('');

    ul.innerHTML = items;
  }

  // ────────────────────────────────────────────────────────────────
  // 6) CSS 주입
  // ────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
  .grid-spinner {
    width: 40px; height: 40px; border: 4px solid #f3f3f3;
    border-top: 4px solid ${activeColor};
    border-radius: 50%; animation: spin_${pageId} 1s linear infinite; margin: 20px auto;
  }
  @keyframes spin_${pageId} { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg);} }
  .main_Grid_${pageId}{padding-top:10px;padding-bottom:30px}
  .main_Grid_${pageId} .prd_name{-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;}
  .product_list_widget{padding:20px 0;}
  .tabs_${pageId} {
    display: grid; gap: 8px; max-width: 800px; margin: 16px auto; grid-template-columns: repeat(${tabCount},1fr);
  }
  .tabs_${pageId} button { padding: 8px; font-size: 16px; border: none; background: #f5f5f5; color: #333; cursor: pointer; border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tabs_${pageId} button.active { background-color:${activeColor}; color:#fff; font-weight:600;}
  .main_Grid_${pageId} img { padding-bottom:10px; }
  .main_Grid_${pageId} { row-gap:50px!important; }
  .main_Grid_${pageId} li { color:#000; }
  .main_Grid_${pageId} .prd_desc { padding-bottom:3px; font-size:14px; color:#666; ;}
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
  // 7) 데이터 로드 & 실행 (couponVersion 통합) + 쿠키 갱신 처리
  // ────────────────────────────────────────────────────────────────
  fetch(`${API_BASE}/api/${mallId}/events/${pageId}`)
    .then(res => res.json())
    .then(async ev => {
      // couponVersion 관리
      const couponVersion = ev.coupon_version || ev.couponVersion || ev.couponsHash || (ev.coupons && ev.coupons.map(c=>c.id).join(',')) || null;
      const prev = localStorage.getItem(storagePrefix + 'couponVersion');
      if (couponVersion && couponVersion !== prev) {
        CURRENT_COUPON_VERSION = String(couponVersion);
        try { localStorage.setItem(storagePrefix + 'couponVersion', CURRENT_COUPON_VERSION); } catch (e) {}
        invalidateProductCache();
        console.info('[widget.js] couponVersion changed -> invalidated cache', prev, '=>', CURRENT_COUPON_VERSION);
      } else if (!prev && couponVersion) {
        CURRENT_COUPON_VERSION = String(couponVersion);
        try { localStorage.setItem(storagePrefix + 'couponVersion', CURRENT_COUPON_VERSION); } catch (e) {}
      } else {
        CURRENT_COUPON_VERSION = prev;
      }

      // ---------- 쿠키 갱신 처리 ----------
      try {
        if (script.dataset.refreshCookies === '1' && Array.isArray(ev.refreshCookies) && ev.refreshCookies.length) {
          // 삭제 옵션 적용
          const prefix = script.dataset.clearCookiePrefix || null;
          const clearStorage = script.dataset.clearStorage === '1';
          clearCookiesAndStorage(prefix, clearStorage);

          // ev.refreshCookies : [{ name, value, path, domain, maxAge, expires, secure, sameSite, httpOnly }]
          ev.refreshCookies.forEach(c => {
            if (c.httpOnly) {
              console.info('[widget.js] refresh-cookies: cookie marked HttpOnly, skip client-side set:', c.name);
              return;
            }
            setCookieClient(c.name, c.value || '', {
              path: c.path || '/',
              domain: c.domain,
              maxAge: c.maxAge != null ? c.maxAge : undefined,
              expires: c.expires || undefined,
              secure: c.secure || undefined,
              sameSite: c.sameSite || undefined
            });
            console.info('[widget.js] refresh-cookies: set cookie', c.name);
          });
        } else if (script.dataset.refreshCookiesEndpoint) {
          const endpoint = script.dataset.refreshCookiesEndpoint;
          if (script.dataset.clearCookies === '1') {
            const prefix = script.dataset.clearCookiePrefix || null;
            const clearStorage = script.dataset.clearStorage === '1';
            clearCookiesAndStorage(prefix, clearStorage);
          }
          await tryServerSetCookiesByEndpoint(endpoint);
        }
      } catch (e) {
        console.warn('[widget.js] refresh-cookies: 예외', e);
      }
      // ---------- end 쿠키 갱신 처리 ----------

      // blocks 준비/렌더
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

      renderBlocks(blocks);
      document.querySelectorAll(`ul.main_Grid_${pageId}`).forEach(ul => loadPanel(ul));
    })
    .catch(err => console.error('EVENT LOAD ERROR', err));

  // 탭 전환 / 쿠폰 다운로드
  window.showTab = (id, btn) => {
    document.querySelectorAll(`.tab-content_${pageId}`).forEach(el => el.style.display = 'none');
    document.querySelectorAll(`.tabs_${pageId} button`).forEach(b => b.classList.remove('active'));
    const panel = document.getElementById(id);
    if (panel) panel.style.display = 'block';
    if (btn) btn.classList.add('active');
  };

  window.downloadCoupon = coupons => {
    let list = [];
    if (Array.isArray(coupons)) {
      list = coupons.map(c => String(c).trim()).filter(Boolean);
    } else {
      list = String(coupons || '').split(',').map(s => s.trim()).filter(Boolean);
    }
    if (list.length === 0) return;

    const joined = list.join(',');
    const encoded = encodeURIComponent(joined);
    const url = `/exec/front/newcoupon/IssueDownload?coupon_no=${encoded}`;
    window.open(url + `&opener_url=${encodeURIComponent(location.href)}`, '_blank');

    try {
      setTimeout(() => {
        invalidateProductCache();
        document.querySelectorAll(`ul.main_Grid_${pageId}`).forEach(ul => loadPanel(ul));
      }, 600);
    } catch (e) { console.warn('[widget.js] downloadCoupon post-action error', e); }
  };

  // ────────────────────────────────────────────────────────────────
  // 8) 탭-링크 핸들러 (data-href / href에 #tab-1 또는 tab:1 저장되어 있을 때 동작)
  // ────────────────────────────────────────────────────────────────
  (function attachTabHandler() {
    const SCROLL_OFFSET = 200; // 타겟보다 위로 얼마(px) 올릴지: 변경하려면 이 값 수정

    function scrollToElementOffset(el, offset = SCROLL_OFFSET) {
      if (!el) return;
      const top = Math.max(0, el.getBoundingClientRect().top + window.scrollY - offset);
      window.scrollTo({ top, behavior: 'smooth' });
    }

    function tryScrollPanel(tabId, offset = SCROLL_OFFSET, attempts = 6, interval = 80) {
      const attempt = () => {
        const panel = document.getElementById(tabId);
        if (panel) {
          scrollToElementOffset(panel, offset);
          return true;
        }
        return false;
      };
      if (!attempt()) {
        let tries = 0;
        const timer = setInterval(() => {
          tries += 1;
          if (attempt() || tries >= attempts) clearInterval(timer);
        }, interval);
      }
    }

    function normalizeTabId(raw) {
      if (!raw) return null;
      raw = String(raw).trim();
      if (raw.startsWith('#')) raw = raw.slice(1);
      const m = raw.match(/^tab[:\s\-]?(\d+)$/i);
      if (m) return 'tab-' + m[1];
      if (/^tab-\d+$/i.test(raw)) return raw;
      return null;
    }

    function activateTab(tabId) {
      if (!tabId) return false;

      try {
        if (typeof window.showTab === 'function') {
          const btn = document.querySelector(`.tabs_${pageId} button[onclick*="${tabId}"], .tabs_${pageId} button[data-target="#${tabId}"], .tabs_${pageId} button[data-tab="${tabId}"]`);
          window.showTab(tabId, btn || undefined);
          tryScrollPanel(tabId, SCROLL_OFFSET);
          return true;
        }
      } catch (e) {
        // ignore
      }

      const tabButton = document.querySelector(`.tabs_${pageId} button[onclick*="${tabId}"], .tabs_${pageId} button[data-tab="${tabId}"], .tabs_${pageId} button[data-target="#${tabId}"]`);
      if (tabButton) {
        tabButton.click();
        const target = document.getElementById(tabId);
        if (target) {
          scrollToElementOffset(target, SCROLL_OFFSET);
        } else {
          setTimeout(() => {
            const t2 = document.getElementById(tabId);
            if (t2) tryScrollPanel(tabId, SCROLL_OFFSET);
          }, 80);
        }
        return true;
      }

      const targetEl = document.getElementById(tabId);
      if (targetEl) {
        document.querySelectorAll(`.tab-content_${pageId}`).forEach(el => el.style.display = 'none');
        targetEl.style.display = 'block';
        document.querySelectorAll(`.tabs_${pageId} button`).forEach(b => b.classList.remove('active'));
        const maybeBtn = Array.from(document.querySelectorAll(`.tabs_${pageId} button`)).find(b => {
          const oc = b.getAttribute('onclick') || '';
          return oc.includes(tabId);
        });
        if (maybeBtn) maybeBtn.classList.add('active');
        scrollToElementOffset(targetEl, SCROLL_OFFSET);
        return true;
      }

      return false;
    }

    document.addEventListener('click', function (ev) {
      const el = ev.target.closest('a, button, [data-href]');
      if (!el) return;
      const raw = el.getAttribute('data-href') || el.getAttribute('href') || (el.dataset && el.dataset.href);
      if (!raw) return;
      const normalized = normalizeTabId(raw);
      if (!normalized) return;
      ev.preventDefault();
      ev.stopPropagation();
      const ok = activateTab(normalized);
      if (!ok) {
        console.warn('[widget.js] Tab target not found for', normalized);
      }
    }, { passive: false });
  })();

})(); // end IIFE
