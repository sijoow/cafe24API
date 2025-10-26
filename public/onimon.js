;(function () {
  // ────────────────────────────────────────────────────────────────
  // 0) 스크립트/설정값
  // ────────────────────────────────────────────────────────────────
  let script = document.currentScript;
  if (!script || !script.dataset.pageId) {
    script = Array.from(document.getElementsByTagName('script')).find(s =>
      /onimon\.js|widget\.js/.test(s.src) && s.dataset.pageId
    );
  }
  if (!script || !script.dataset.pageId || !script.dataset.mallId) {
    console.warn('⚠️ onimon.js: mallId/pageId 누락');
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

  // ────────────────────────────────────────────────────────────────
  // 2) 공통 헬퍼
  // ────────────────────────────────────────────────────────────────
  function escapeHtml(s = '') { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function toBool(v) { return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'; }
  function fetchWithRetry(url, opts = {}, retries = 3, backoff = 1000) {
      return fetch(url, opts).then(res => {
          if (res.status === 429 && retries > 0) {
              return new Promise(r => setTimeout(r, backoff)).then(() => fetchWithRetry(url, opts, retries - 1, backoff * 2));
          }
          if (!res.ok) throw res;
          return res;
      });
  }
  function buildYouTubeSrc(id, autoplay = false, loop = false) {
      const params = new URLSearchParams({ autoplay: autoplay ? '1' : '0', mute: autoplay ? '1' : '0', playsinline: '1', rel: 0, modestbranding: 1, enablejsapi: 1 });
      if (loop) { params.set('loop', '1'); params.set('playlist', id); }
      return `https://www.youtube.com/embed/${id}?${params.toString()}`;
  }
  
  // ────────────────────────────────────────────────────────────────
  // 3) 블록 렌더링 함수들
  // ────────────────────────────────────────────────────────────────
  function getRootContainer() {
    let root = document.getElementById('evt-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'evt-root';
      script.parentNode.insertBefore(root, script);
    }
    root.innerHTML = '';
    return root;
  }

  function renderImageBlock(block, root) { /* ... 이전과 동일 ... */ }
  function renderTextBlock(block, root) { /* ... 이전과 동일 ... */ }
  function renderVideoBlock(block, root) { /* ... 이전과 동일 ... */ }
  function renderProductBlock(block, root) { /* ... 이전과 동일 ... */ }

  // ────────────────────────────────────────────────────────────────
  // 4) 상품 데이터 로드 및 렌더링
  // ────────────────────────────────────────────────────────────────
  // ✅ [수정] 요청하신 새로운 fetchProducts 함수로 교체
  async function fetchProducts(directNosAttr, category, limit = 300) {
    const fetchOpts = { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } };
    
    if (directNosAttr) {
      const ids = directNosAttr.split(',').map(s => s.trim()).filter(Boolean);
      if (ids.length === 0) return [];
      const results = await Promise.all(ids.map(no =>
        fetchWithRetry(`${API_BASE}/api/${mallId}/products/${no}${couponQSStart}`, fetchOpts).then(r => r.json())
      ));
      return results.map(p => (p && p.product_no) ? p : {}).map(p => ({
        product_no: p.product_no, product_name: p.product_name, summary_description: p.summary_description || '', price: p.price,
        list_image: p.list_image, image_medium: p.image_medium, image_small: p.image_small, tiny_image: p.tiny_image,
        sale_price: p.sale_price || null, benefit_price: p.benefit_price || null, benefit_percentage: p.benefit_percentage || null,
        decoration_icon_url: p.decoration_icon_url || null
      }));
    } else if (category) {
      const prodUrl = `${API_BASE}/api/${mallId}/categories/${category}/products?limit=${limit}${couponQSAppend}`;
      const rawProducts = await fetchWithRetry(prodUrl, fetchOpts).then(r => r.json()).then(json => Array.isArray(json) ? json : (json.products || []));
      return rawProducts.map(p => (typeof p === 'object' ? p : {})).map(p => ({
        product_no: p.product_no, product_name: p.product_name, summary_description: p.summary_description || '', price: p.price,
        list_image: p.list_image, image_medium: p.image_medium, image_small: p.image_small, tiny_image: p.tiny_image,
        sale_price: p.sale_price || null, benefit_price: p.benefit_price || null, benefit_percentage: p.benefit_percentage || null,
        decoration_icon_url: p.decoration_icon_url || null
      }));
    }
    return [];
  }

  async function loadPanel(ul) {
    const cols = parseInt(ul.dataset.gridSize, 10) || 2;
    let spinner = null;
    
    const spinnerTimer = setTimeout(() => {
      spinner = document.createElement('div');
      spinner.className = 'grid-spinner';
      if (ul.parentNode) {
        ul.parentNode.insertBefore(spinner, ul);
      }
    }, 2000);

    try {
      const products = await fetchProducts(ul.dataset.directNos, ul.dataset.cate, ul.dataset.count);
      renderProducts(ul, products, cols);
    } catch (err) {
      console.error('상품 로드 실패:', err);
      if (ul.parentNode) {
        const errDiv = document.createElement('div');
        errDiv.style.textAlign = 'center';
        errDiv.innerHTML = `<p style="color:#f00;">상품 로드에 실패했습니다.</p><button style="padding:6px 12px;cursor:pointer;">다시 시도</button>`;
        errDiv.querySelector('button').onclick = () => { errDiv.remove(); loadPanel(ul); };
        ul.parentNode.insertBefore(errDiv, ul);
      }
    } finally {
      clearTimeout(spinnerTimer);
      if (spinner) {
        spinner.remove();
      }
    }
  }

  // ✅ [수정] renderProducts 함수에 마우스 오버 기능 적용
  function renderProducts(ul, products, cols) {
      ul.style.cssText = `display:grid; grid-template-columns:repeat(${cols},1fr); gap:16px; max-width:800px; margin:24px auto; list-style:none; padding:0; font-family: 'Noto Sans KR', sans-serif;`;
      
      const titleFontSize = `${20 - cols}px`;
      const originalPriceFontSize = `${16 - cols}px`;
      const salePriceFontSize = `${18 - cols}px`;
      
      const formatKRW = val => `${(Number(val) || 0).toLocaleString('ko-KR')}원`;
      const parseNumber = v => {
          if (v == null) return null;
          if (typeof v === 'number' && isFinite(v)) return v;
          const n = parseFloat(String(v).replace(/[^\d.-]/g, ''));
          return isFinite(n) ? n : null;
      };

      ul.innerHTML = products.map(p => {
          const origPrice = parseNumber(p.price) || 0;
          const salePrice = parseNumber(p.sale_price);
          const benefitPrice = parseNumber(p.benefit_price);
  
          const isSale = salePrice != null && salePrice < origPrice;
          const isCoupon = benefitPrice != null && benefitPrice < (isSale ? salePrice : origPrice);
          
          let displayPercent = null;
          if (isCoupon) {
              const basePriceForCoupon = isSale ? salePrice : origPrice;
              if (basePriceForCoupon > 0 && benefitPrice >= 0) {
                displayPercent = Math.round((basePriceForCoupon - benefitPrice) / basePriceForCoupon * 100);
              }
          } else if (isSale) {
              if (origPrice > 0) {
                displayPercent = Math.round((origPrice - salePrice) / origPrice * 100);
              }
          }
  
          const priceText = formatKRW(origPrice);
          const saleText = isSale ? formatKRW(salePrice) : null;
          const couponText = isCoupon ? formatKRW(benefitPrice) : null;
          
          const initialImg = p.image_medium || p.list_image;
          const hoverImg = p.tiny_image || p.image_small; // tiny가 우선, 없으면 small
          
          const mouseEvents = hoverImg && initialImg && hoverImg !== initialImg 
            ? `onmouseover="this.querySelector('img').src='${hoverImg}'" onmouseout="this.querySelector('img').src='${initialImg}'"` 
            : '';
  
          return `
            <li style="overflow: hidden; border: 1px solid #e8e8e8; background: #fff;">
              <a href="/product/detail.html?product_no=${p.product_no}" style="text-decoration:none; color:inherit;" data-track-click="product" data-product-no="${p.product_no}" ${mouseEvents}>
                <div style="position: relative; aspect-ratio: 1 / 1; width: 100%; display: flex; align-items: center; justify-content: center; background: #f8f9fa;">
                  ${initialImg ? `<img src="${initialImg}" alt="${escapeHtml(p.product_name||'')}" style="width:100%; height:100%; object-fit:cover;" />` : `<span style="font-size:40px; color:#d9d9d9;">⛶</span>`}
                  ${p.decoration_icon_url ? `<div style="position: absolute; top: 10px; right: 10px; width: 40px; height: 40px; z-index: 2;"><img src="${p.decoration_icon_url}" alt="icon" style="width: 100%; height: auto;" /></div>` : ''}
                </div>
                <div style="padding: 12px; min-height: 90px;">
                  <div class="prd_name" style="font-weight: 500; font-size: ${titleFontSize}; line-height: 1.2;">${escapeHtml(p.product_name || '')}</div>
                  <div class="prd_price_container" style="margin-top: 4px;">
                    ${isCoupon ? `
                      <div class="coupon_wrapper">
                        <span class="original_price" style="font-size: ${originalPriceFontSize};">${isSale ? saleText : priceText}</span>
                        ${displayPercent > 0 ? `<span class="prd_coupon_percent" style="font-size: ${salePriceFontSize};">${displayPercent}%</span>` : ''}
                        <span class="prd_coupon" style="font-weight: bold; font-size: ${salePriceFontSize};">${couponText}</span>
                      </div>
                    ` : isSale ? `
                      <div class="prd_price">
                        <span class="original_price" style="font-size: ${originalPriceFontSize};">${priceText}</span>
                        ${displayPercent > 0 ? `<span class="sale_percent" style="font-size: ${salePriceFontSize};">${displayPercent}%</span>` : ''}
                        <span class="sale_price" style="font-weight: bold; font-size: ${salePriceFontSize};">${saleText}</span>
                      </div>
                    ` : `
                      <div class="prd_price">
                        <span style="font-weight: bold; font-size: ${salePriceFontSize};">${priceText}</span>
                      </div>
                    `}
                  </div>
                </div>
              </a>
            </li>`;
      }).join('');
  }

  const style = document.createElement('style');
  style.textContent = `
    .grid-spinner { width: 40px; height: 40px; border: 4px solid #f3f3f3; border-top: 4px solid #1890ff; border-radius: 50%; animation: spin_${pageId} 1s linear infinite; margin: 20px auto; }
    @keyframes spin_${pageId} { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg);} }
    .tabs_${pageId} { display: flex; gap: 8px; max-width: 800px; margin: 16px auto; }
    .tabs_${pageId} button { flex: 1; padding: 8px; font-size: 16px; border: 1px solid #d9d9d9; background: #f5f5f5; color: #333; cursor: pointer; border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tabs_${pageId} button.active { font-weight: 600; }
    .prd_price_container .original_price { text-decoration: line-through; color: #999; display: block; font-weight: 400; }
    .prd_price_container .sale_percent, .prd_price_container .prd_coupon_percent { color: #ff4d4f; font-weight: bold; margin-right: 4px; }
  `;
  document.head.appendChild(style);

  async function initializePage() {
    try {
      const response = await fetch(`${API_BASE}/api/${mallId}/events/${pageId}`);
      if (!response.ok) throw new Error('Event data fetch failed');
      const ev = await response.json();
      
      const root = getRootContainer();

      if (ev.content && Array.isArray(ev.content.blocks)) {
          ev.content.blocks.forEach(block => {
              switch(block.type) {
                  case 'image': renderImageBlock(block, root); break;
                  case 'video': renderVideoBlock(block, root); break;
                  case 'text': renderTextBlock(block, root); break;
                  case 'product_group': renderProductBlock(block, root); break;
                  default: break;
              }
          });
          document.querySelectorAll(`ul.main_Grid_${pageId}`).forEach(ul => loadPanel(ul));
      } else { // 구버전 데이터 처리
          (ev.images || []).forEach(img => renderImageBlock({ type: 'image', ...img }, root));
          const productBlock = { type: 'product_group', ...ev.classification, gridSize: ev.gridSize, layoutType: ev.layoutType, id: pageId };
          renderProductBlock(productBlock, root);
          document.querySelectorAll(`ul.main_Grid_${pageId}`).forEach(ul => loadPanel(ul));
      }

    } catch (err) {
      console.error('EVENT LOAD ERROR', err);
    }
  }

  window.showTab = (id, btn, activeColor = '#1890ff') => {
      const parent = btn.closest('.tabs_' + pageId);
      if (!parent) return;
      parent.querySelectorAll('button').forEach(b => {
          b.classList.remove('active');
          b.style.backgroundColor = '#f5f5f5';
          b.style.color = '#333';
          b.style.borderColor = '#d9d9d9';
      });
      
      btn.classList.add('active');
      btn.style.backgroundColor = activeColor;
      btn.style.color = '#fff';
      btn.style.borderColor = activeColor;

      const contentParent = parent.parentElement;
      contentParent.querySelectorAll('.tab-content_' + pageId).forEach(el => {
          if (el.id === id) { el.style.display = 'block'; } 
          else { el.style.display = 'none'; }
      });
  };

  window.downloadCoupon = (coupons) => {
      const list = String(coupons || '').split(',').map(s => s.trim()).filter(Boolean);
      if (list.length === 0) return;
      const url = `/exec/front/newcoupon/IssueDownload?coupon_no=${encodeURIComponent(list.join(','))}`;
      window.open(url + `&opener_url=${encodeURIComponent(location.href)}`);
  };

  initializePage();

})(); // end IIFE
