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
  
    const API_BASE = script.dataset.apiBase;
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
    const storagePrefix = `widgetCache_${pageId}_v2_`;
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
    
    function invalidateProductCache() {
      try {
        const keys = Object.keys(localStorage);
        for (const k of keys) {
          if (k.startsWith(storagePrefix)) {
            localStorage.removeItem(k);
          }
        }
        console.info('[widget.js] Product cache invalidated.');
      } catch (e) {
        console.warn('[widget.js] invalidateProductCache error', e);
      }
    }
    
    function fetchWithRetry(url, opts = {}, retries = 3, backoff = 1000) {
      return fetch(url, opts).then(res => {
        // 429 에러 발생 시 재시도 로직 (재시도 횟수 소진 시 throw res)
        if (res.status === 429 && retries > 0) {
          return new Promise(r => setTimeout(r, backoff)).then(() => fetchWithRetry(url, opts, retries - 1, backoff * 2));
        }
        if (!res.ok) throw res; // Error Status를 catch에서 잡기 위해 res 객체 throw
        return res;
      });
    }

    // ────────────────────────────────────────────────────────────────
    // ★ [핵심 1] 이벤트 만료(409) 시 처리 함수
    // ────────────────────────────────────────────────────────────────
    function handleExpiration() {
        let root = document.getElementById('evt-root') || document.getElementById('evt-images');
        if (!root) {
            root = document.createElement('div');
            root.id = 'evt-root';
            document.body.insertBefore(root, document.body.firstChild);
        }
        root.innerHTML = '';
        const errDiv = document.createElement('div');
        errDiv.style.textAlign = 'center';
        errDiv.style.padding = '100px 0';
        errDiv.innerHTML = `
           <div style="font-size:16px; color:#333; font-weight:bold; margin-bottom:8px;">프로모션 올인원 사용기간이 종료되었습니다.</div>
        `;
        root.appendChild(errDiv);
    }

    // ────────────────────────────────────────────────────────────────
    // ★ [핵심 2] 트래픽 초과(429) 시 처리 함수 (.onimonLayout 숨김)
    // ────────────────────────────────────────────────────────────────
    function handleTrafficLimit() {
        // 1. .onimonLayout 클래스를 가진 요소 숨김
        const layouts = document.querySelectorAll('.onimonLayout');
        layouts.forEach(el => {
            el.style.display = 'none';
        });

        // 2. 혹시 몰라 evt-root도 숨김 처리 (안전장치)
        const root = document.getElementById('evt-root') || document.getElementById('evt-images');
        if (root) {
            root.style.display = 'none';
        }
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
          const qs = new URLSearchParams({ autoplay: willAutoplay ? '1' : '0', mute: willAutoplay ? '1' : '0', playsinline: '1', rel: '0', modestbranding: '1' });
          if (willLoop) {
            qs.set('loop', '1');
            qs.set('playlist', yid);
          }
          const src = `https://www.youtube.com/embed/${yid}?${qs.toString()}`;
          const wrap = document.createElement('div');
          wrap.style.cssText = 'position:relative; width:100%; max-width:800px; margin:0 auto;';
          if ('aspectRatio' in wrap.style) {
            wrap.style.aspectRatio = `${ratio.w}/${ratio.h}`;
            const iframe = document.createElement('iframe');
            iframe.src = src;
            iframe.title = `youtube-${yid}`;
            iframe.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; border:0;';
            iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
            iframe.setAttribute('allowfullscreen', '');
            wrap.appendChild(iframe);
            root.appendChild(wrap);
            return;
          }
          const innerBox = document.createElement('div');
          innerBox.style.cssText = `position:relative; width:100%; padding-top:${(ratio.h / ratio.w) * 100}%;`;
          const iframe = document.createElement('iframe');
          iframe.src = src;
          iframe.title = `youtube-${yid}`;
          iframe.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; border:0;';
          iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
          iframe.setAttribute('allowfullscreen', '');
          innerBox.appendChild(iframe);
          wrap.appendChild(innerBox);
          root.appendChild(wrap);
          return;
        }
        // IMAGE
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative; margin:0 auto; width:100%; max-width:800px;';
        const img = document.createElement('img');
        img.src = b.src;
        img.style.cssText = 'max-width:100%; height:auto; display:block; margin:0 auto;';
        wrap.appendChild(img);
        (b.regions || []).forEach(r => {
          const l = (r.xRatio * 100).toFixed(2), t = (r.yRatio * 100).toFixed(2), w = (r.wRatio * 100).toFixed(2), h = (r.hRatio * 100).toFixed(2);
          if (r.coupon) {
            const btn = document.createElement('button');
            btn.dataset.trackClick = 'coupon';
            btn.style.cssText = `position:absolute; left:${l}%; top:${t}%; width:${w}%; height:${h}%; border:none; cursor:pointer; opacity:0;`;
            btn.addEventListener('click', () => downloadCoupon(r.coupon));
            wrap.appendChild(btn);
          } else if (r.href) {
            const a = document.createElement('a');
            a.dataset.trackClick = 'url';
            a.style.cssText = `position:absolute; left:${l}%; top:${t}%; width:${w}%; height:${h}%; display:block; text-decoration:none; cursor:pointer;`;
            a.setAttribute('data-href', r.href);
            a.href = /^https?:\/\//.test(r.href) ? r.href : `https://${r.href}`;
            a.target = '_blank';
            a.rel = 'noreferrer';
            wrap.appendChild(a);
          }
        });
        root.appendChild(wrap);
      });
    }
  // ────────────────────────────────────────────────────────────────
  // 4) 상품 그리드
  // ────────────────────────────────────────────────────────────────
  async function loadPanel(ul) {
    const cols = parseInt(ul.dataset.gridSize, 10) || 1;
    const cacheKey = ul.dataset.directNos ? `direct_${ul.dataset.directNos}` : (ul.dataset.cate ? `cat_${ul.dataset.cate}` : null);
    if (!cacheKey) return;
    const storageKey = storagePrefix + cacheKey;
    const CACHE_DURATION = 30 * 60 * 1000; // 30분 캐시 유효기간

    // 1. 캐시 먼저 보여주기
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const { timestamp, data } = JSON.parse(stored);
        if (Date.now() - timestamp < CACHE_DURATION) {
          renderProducts(ul, data, cols);

          fetchProducts(ul.dataset.directNos, ul.dataset.cate, ul.dataset.count)
            .then(freshData => {
              if (JSON.stringify(data) !== JSON.stringify(freshData)) {
                console.log('[widget.js] 상품 정보가 변경되어 업데이트합니다.', cacheKey);
                renderProducts(ul, freshData, cols);
                localStorage.setItem(storageKey, JSON.stringify({ timestamp: Date.now(), data: freshData }));
              }
            }).catch(console.warn);

          return; 
        }
      }
    } catch (e) {
      console.warn('[widget.js] 캐시 파싱 오류', e);
    }

    // 2. 로딩 및 페치
    const spinner = document.createElement('div');
    spinner.className = 'grid-spinner';
    ul.parentNode.insertBefore(spinner, ul);

    try {
      const products = await fetchProducts(ul.dataset.directNos, ul.dataset.cate, ul.dataset.count);
      localStorage.setItem(storageKey, JSON.stringify({ timestamp: Date.now(), data: products }));
      renderProducts(ul, products, cols);
    } catch (err) {
      // ──────────────────────────────────────────────────────
      // [수정] 429(트래픽) 또는 409(만료) 에러 처리
      // ──────────────────────────────────────────────────────
      
      // 1. 429 (트래픽 초과) -> 레이아웃 숨김
      if (err.status === 429) {
        if (spinner.parentNode) spinner.remove();
        handleTrafficLimit();
        return;
      }

      // 2. 409 등 치명적 에러 -> 만료 메시지
      const isCriticalError = err && (err.status === 409 || err.status === 404 || err.status === 400 || err.status >= 500);
      if (isCriticalError) {
        if (spinner.parentNode) spinner.remove();
        handleExpiration(); 
        return;
      }

      // 3. 일반 에러 -> 재시도 버튼
      if (spinner.parentNode) spinner.remove();
      const errDiv = document.createElement('div');
      errDiv.style.textAlign = 'center';
      errDiv.innerHTML = `<p style="color:#f00;">상품 로드에 실패했습니다.</p><button style="padding:6px 12px;cursor:pointer;">다시 시도</button>`;
      errDiv.querySelector('button').onclick = () => { errDiv.remove(); loadPanel(ul); };
      ul.parentNode.insertBefore(errDiv, ul);
    } finally {
      if(spinner.parentNode) spinner.remove();
    }
  }
  
    async function fetchProducts(directNosAttr, category, limit = 300) {
      const fetchOpts = { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } };
      const ulDirect = directNosAttr || directNos;
  
      if (ulDirect) {
        const ids = ulDirect.split(',').map(s => s.trim()).filter(Boolean);
        const results = await Promise.all(ids.map(no =>
          fetchWithRetry(`${API_BASE}/api/${mallId}/products/${no}${couponQSStart}`, fetchOpts).then(r => r.json())
        ));
        return results.map(p => (p && p.product_no) ? p : {}).map(p => ({
          product_no: p.product_no, product_name: p.product_name, summary_description: p.summary_description || '', price: p.price,
          list_image: p.list_image, image_medium: p.image_medium, image_small: p.image_small,
          sale_price: p.sale_price || null, benefit_price: p.benefit_price || null, benefit_percentage: p.benefit_percentage || null,
          decoration_icon_url: p.decoration_icon_url || null
        }));
      } else if (category) {
        const prodUrl = `${API_BASE}/api/${mallId}/categories/${category}/products?limit=${limit}${couponQSAppend}`;
        const [rawProducts] = await Promise.all([
          fetchWithRetry(prodUrl, fetchOpts).then(r => r.json()).then(json => Array.isArray(json) ? json : (json.products || [])),
        ]);
        return rawProducts.map(p => (typeof p === 'object' ? p : {})).map(p => ({
          product_no: p.product_no, product_name: p.product_name, summary_description: p.summary_description || '', price: p.price,
          list_image: p.list_image, image_medium: p.image_medium, image_small: p.image_small,
          sale_price: p.sale_price || null, benefit_price: p.benefit_price || null, benefit_percentage: p.benefit_percentage || null,
          decoration_icon_url: p.decoration_icon_url || null
        }));
      }
      return [];
    }
  
    // ────────────────────────────────────────────────────────────────
    // 5) 상품 렌더링
    // ────────────────────────────────────────────────────────────────
    function renderProducts(ul, products, cols) {
      ul.style.display = 'grid';
      ul.style.gridTemplateColumns = `repeat(${cols},1fr)`;
      ul.style.gap = '20px';
      ul.style.maxWidth = '800px';
      ul.style.margin = '0 auto';
      
      function formatKRW(val) {
        if (typeof val === 'number') return `${val.toLocaleString('ko-KR')}원`;
        const num = parseFloat(String(val).replace(/[^0-9.]/g, '')) || 0;
        return `${num.toLocaleString('ko-KR')}원`;
      }
      
      ul.innerHTML = products.map(p => {
        const originalPriceNum = parseFloat(String(p.price || '0').replace(/[^0-9.]/g, ''));
        const salePriceNum = parseFloat(String(p.sale_price || '').replace(/[^0-9.]/g, '')) || null;
        const couponPriceNum = parseFloat(String(p.benefit_price || '').replace(/[^0-9.]/g, '')) || null;
        
        let finalPriceNum = originalPriceNum;
        if (salePriceNum != null && salePriceNum < finalPriceNum) {
          finalPriceNum = salePriceNum;
        }
        if (couponPriceNum != null && couponPriceNum < finalPriceNum) {
          finalPriceNum = couponPriceNum;
        }
        
        const hasDiscount = finalPriceNum < originalPriceNum;
        
        let displayPercent = null;
        if (hasDiscount && originalPriceNum > 0) {
          if (finalPriceNum === couponPriceNum && p.benefit_percentage > 0) {
            displayPercent = p.benefit_percentage;
          } else {
            displayPercent = Math.round(((originalPriceNum - finalPriceNum) / originalPriceNum) * 100);
          }
        }
        
        const originalPriceText = formatKRW(originalPriceNum);
        const finalPriceText = formatKRW(finalPriceNum);
        
        const mediumImg = p.image_medium || p.list_image;
        const smallImg = p.image_small;
        
        const mouseEvents = smallImg 
          ? `onmouseover="this.src='${smallImg}'" onmouseout="this.src='${mediumImg}'"`
          : '';
        
        return `
        <li style="list-style:none;">
          <a href="/product/detail.html?product_no=${p.product_no}" class="prd_link" style="text-decoration:none;color:inherit;" data-track-click="product" data-product-no="${p.product_no}" target="_blank" rel="noopener noreferrer">
            <div class="prd_img_container" style="position:relative;">
              <img src="${mediumImg}" alt="${escapeHtml(p.product_name)}" style="width:100%;display:block;" ${mouseEvents} />
              ${p.decoration_icon_url ? `<div class="prd_icon_wrapper"><img src="${p.decoration_icon_url}" alt="icon" /></div>` : ''}
            </div>
            <div class="prd_desc" style="font-size:14px;color:#666;padding:4px 0;display:none">${p.summary_description || ''}</div>
            <div class="prd_name">${p.product_name}</div>
          </a>
          <div class="prd_price_area">
            ${
              hasDiscount
              ? `<div class="price_wrapper vertical_layout">
                   <div class="original_price_line">
                     <span class="original_price">${originalPriceText}</span>
                   </div>
                   <div class="final_price_line">
                     ${(displayPercent && displayPercent > 0) ? `<strong class="discount_percent">${displayPercent}%</strong>` : ''}
                     <span class="final_price">${finalPriceText}</span>
                   </div>
                 </div>`
              : `<div class="price_wrapper">
                   <span class="final_price">${originalPriceText}</span>
                 </div>`
            }
          </div>
        </li>`;
      }).join('');
    }
  
    // ────────────────────────────────────────────────────────────────
    // 6) CSS 주입
    // ────────────────────────────────────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
    .grid-spinner { width: 40px; height: 40px; border: 4px solid #f3f3f3; border-top: 4px solid ${activeColor}; border-radius: 50%; animation: spin_${pageId} 1s linear infinite; margin: 20px auto; }
    @keyframes spin_${pageId} { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg);} }
    .product_list_widget{padding:20px 0;width:95%;margin:0 auto;}
    .main_Grid_${pageId}{padding-top:10px;padding-bottom:30px; row-gap:50px!important;width:95%;}
    .main_Grid_${pageId} li { color:#000; }
    .main_Grid_${pageId} img { padding-bottom:10px; }
    .main_Grid_${pageId} .prd_name {font-weight: 500; padding-bottom: 4px; font-size:16px;line-height:1.2;}
    .main_Grid_${pageId} .prd_desc { padding-bottom:3px; font-size:14px; color:#666; }
    .tabs_${pageId} { display: grid; gap: 8px; max-width: 800px; margin: 16px auto; width:95%; grid-template-columns: repeat(${tabCount},1fr); }
    .tabs_${pageId} button { padding: 8px; font-size: 16px; border: none; background: #f5f5f5; color: #333; cursor: pointer; border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tabs_${pageId} button.active { background-color:${activeColor}; color:#fff; }
    .prd_price_area { margin-top: 2px; }
    .original_price_line .original_price { font-size: 14px; color: #bbb; text-decoration: line-through; }
    .final_price_line { display: flex; align-items: center; margin-top: 2px; }
    .final_price_line .discount_percent { font-size: 15px; font-weight: bold; color: #ff4d4f; margin-right: 6px; }
    .final_price_line .final_price { font-size: 15px; font-weight: bold; color: #000; }
    .price_wrapper:not(.vertical_layout) .final_price { font-size: 16px; font-weight: 500; }
  
    /* ✨✨✨ START: NEW STYLES ✨✨✨ */
    .prd_icon_wrapper {
      position: absolute;
      top: 10px;
      right: 10px;
      z-index: 2;
      width: 40px; /* 아이콘 크기 조절 */
      height: 40px;
    }
    .prd_icon_wrapper img {
      width: 100%;
      height: auto;
    }
    /* ✨✨✨ END: NEW STYLES ✨✨✨ */
  
    @media (max-width: 400px) {
       .prd_name{font-size:15px!important;}
      .tabs_${pageId}{ width:95%; margin:0 auto;margin-top:20px; font-weight:bold; }
      .tabs_${pageId} button{ font-size:14px; }
      .main_Grid_${pageId}{ width:95%; margin:0 auto; row-gap:30px!important; }
      .main_Grid_${pageId} .prd_desc{ font-size:12px; padding-bottom:5px; }
      .final_price_line .discount_percent,
      .final_price_line .final_price { font-size: 15px; }
    }`;
    document.head.appendChild(style);
  
    // ────────────────────────────────────────────────────────────────
    // 7) 메인 초기화 및 전역 함수
    // ────────────────────────────────────────────────────────────────
    async function initializePage() {
      try {
        const response = await fetch(`${API_BASE}/api/${mallId}/events/${pageId}`);
        // ──────────────────────────────────────────────────────
        // [수정] 이벤트 데이터 로드 중 409 등 에러 시 즉시 종료
        // ──────────────────────────────────────────────────────
        if (!response.ok) throw response; // response를 throw하여 catch에서 status 확인
        
        const ev = await response.json();
        
        const rawBlocks = Array.isArray(ev?.content?.blocks) && ev.content.blocks.length ? ev.content.blocks : (ev.images || []).map(img => ({ type: 'image', src: img.src, regions: img.regions || [] }));
        const blocks = rawBlocks.map(b => {
          const t = b.type || 'image';
          if (t === 'video') return { type: 'video', youtubeId: b.youtubeId || parseYouTubeId(b.src), ratio: (b.ratio && b.ratio.w && b.ratio.h) ? b.ratio : { w: 16, h: 9 }, autoplay: toBool(b.autoplay), loop: toBool(b.loop) };
          if (t === 'text') return { type: 'text', text: b.text || '', style: b.style || {} };
          return { type: 'image', src: b.src, regions: (b.regions || []).map(r => ({ xRatio: r.xRatio, yRatio: r.yRatio, wRatio: r.wRatio, hRatio: r.hRatio, href: r.href, coupon: r.coupon })) };
        });
        renderBlocks(blocks);
        document.querySelectorAll(`ul.main_Grid_${pageId}`).forEach(ul => loadPanel(ul));
      } catch (err) {
        console.error('EVENT LOAD ERROR', err);
        // 에러 상태 확인
        if (err.status === 429) {
            handleTrafficLimit();
            return;
        }
        const isCriticalError = err && (err.status === 409 || err.status === 404 || err.status === 400 || err.status >= 500);
        if (isCriticalError) {
             handleExpiration();
        }
      }
    }
  
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
  
    // ────────────────────────────────────────────────────────────────
    // 8) 탭-링크 핸들러
    // ────────────────────────────────────────────────────────────────
    (function attachTabHandler() {
      const SCROLL_OFFSET = 200;
      function scrollToElementOffset(el) {
        if (!el) return;
        const top = Math.max(0, el.getBoundingClientRect().top + window.scrollY - SCROLL_OFFSET);
        window.scrollTo({ top, behavior: 'smooth' });
      }
      function tryScrollPanel(tabId) {
        let attempts = 0;
        const timer = setInterval(() => {
          const panel = document.getElementById(tabId);
          if (panel || ++attempts >= 6) {
            clearInterval(timer);
            if (panel) scrollToElementOffset(panel);
          }
        }, 80);
      }
      function normalizeTabId(raw) {
        if (!raw) return null;
        raw = String(raw).trim().replace(/^#/, '');
        const m = raw.match(/^tab[:\s\-]?(\d+)$/i);
        return m ? 'tab-' + m[1] : (/^tab-\d+$/i.test(raw) ? raw : null);
      }
      document.addEventListener('click', function (ev) {
        const el = ev.target.closest('a[data-href]');
        if (!el) return;
        const raw = el.getAttribute('data-href');
        const tabId = normalizeTabId(raw);
        if (!tabId) return;
        ev.preventDefault();
        ev.stopPropagation();
        const btn = document.querySelector(`.tabs_${pageId} button[onclick*="'${tabId}'"]`);
        if (typeof window.showTab === 'function') {
          window.showTab(tabId, btn);
          tryScrollPanel(tabId);
        }
      }, { passive: false });
    })();
  
    // ────────────────────────────────────────────────────────────────
    // 9) 페이지 초기화
    // ────────────────────────────────────────────────────────────────
    initializePage();
  
  })(); // end IIFE
