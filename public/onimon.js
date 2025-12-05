;(function () {
    // ────────────────────────────────────────────────────────────────
    // 0) 스크립트/설정값
    // ────────────────────────────────────────────────────────────────
    let script = document.currentScript;
    if (!script || !script.dataset.pageId) {
      script = Array.from(document.getElementsByTagName('script')).find(s =>
        /onimon\.js/.test(s.src) && s.dataset.pageId
      );
    }
    if (!script || !script.dataset.pageId || !script.dataset.mallId) {
      console.warn('⚠️ onimon.js: mallId/pageId 누락');
      return;
    }
  
    const API_BASE = script.dataset.apiBase || '';
    const pageId = script.dataset.pageId;
    const mallId = script.dataset.mallId;
    const couponNos = script.dataset.couponNos || '';
    const couponQSStart = couponNos ? `?coupon_no=${couponNos}` : '';
    const couponQSAppend = couponNos ? `&coupon_no=${couponNos}` : '';
  
    
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
  
    function renderImageBlock(block, root) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative; margin:0 auto; width:100%; max-width:800px; font-size:0;';
      const img = document.createElement('img');
      img.src = block.src;
      img.style.cssText = 'max-width:100%; height:auto; display:block; margin:0 auto;';
      wrap.appendChild(img);
      (block.regions || []).forEach(r => {
        const l = (r.xRatio * 100).toFixed(2), t = (r.yRatio * 100).toFixed(2), w = (r.wRatio * 100).toFixed(2), h = (r.hRatio * 100).toFixed(2);
        if (r.coupon) {
          const btn = document.createElement('button');
          btn.dataset.couponNo = r.coupon;
          btn.onclick = () => window.downloadCoupon(r.coupon);
          btn.style.cssText = `position:absolute; left:${l}%; top:${t}%; width:${w}%; height:${h}%; border:none; cursor:pointer; background:transparent;`;
          wrap.appendChild(btn);
        } else if (r.href) {
          const a = document.createElement('a');
          a.href = /^https?:\/\//i.test(r.href) ? r.href : `https://${r.href}`;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.style.cssText = `position:absolute; left:${l}%; top:${t}%; width:${w}%; height:${h}%; display:block;`;
          wrap.appendChild(a);
        }
      });
      root.appendChild(wrap);
    }
    
    function renderTextBlock(block, root) {
      const st = block.style || {};
      const wrapper = document.createElement('div');
      wrapper.style.textAlign = st.align || 'center';
      wrapper.style.marginTop = `${st.mt ?? 16}px`;
      wrapper.style.marginBottom = `${st.mb ?? 16}px`;
      const inner = document.createElement('div');
      inner.style.fontSize = `${st.fontSize || 18}px`;
      inner.style.fontWeight = st.fontWeight || 'normal';
      inner.style.color = st.color || '#333';
      inner.innerHTML = escapeHtml(block.text || '').replace(/\n/g, '<br/>');
      wrapper.appendChild(inner);
      root.appendChild(wrapper);
    }
  
    function renderVideoBlock(block, root) {
        const ratio = block.ratio || { w: 16, h: 9 };
        if (!block.youtubeId) return;
        const src = buildYouTubeSrc(block.youtubeId, toBool(block.autoplay), toBool(block.loop));
        const wrap = document.createElement('div');
        wrap.style.cssText = `position:relative; width:100%; max-width:800px; margin:16px auto; aspect-ratio:${ratio.w}/${ratio.h};`;
        const iframe = document.createElement('iframe');
        iframe.src = src;
        iframe.title = `youtube-${block.youtubeId}`;
        iframe.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; border:0;';
        iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
        iframe.setAttribute('allowfullscreen', '');
        wrap.appendChild(iframe);
        root.appendChild(wrap);
    }
  
    function renderProductBlock(block, root) {
      const groupWrapper = document.createElement('div');
      groupWrapper.className = 'product-group-wrapper';
      
      if (block.layoutType === 'tabs') {
          const activeColor = block.activeColor || '#1890ff';
          const tabsContainer = document.createElement('div');
          tabsContainer.className = `tabs_${pageId}`;
          (block.tabs || []).forEach((t, i) => {
              const btn = document.createElement('button');
              if (i === 0) {
                  btn.className = 'active';
                  btn.style.backgroundColor = activeColor;
                  btn.style.color = '#fff';
                  btn.style.borderColor = activeColor;
              }
              btn.onclick = () => window.showTab(`${block.id || pageId}-tab-${i}`, btn, activeColor);
              btn.textContent = t.title || `탭 ${i+1}`;
              tabsContainer.appendChild(btn);
          });
          groupWrapper.appendChild(tabsContainer);
  
          (block.tabs || []).forEach((t, i) => {
              const panel = document.createElement('div');
              panel.id = `${block.id || pageId}-tab-${i}`;
              panel.className = `tab-content_${pageId}`;
              panel.style.display = i === 0 ? 'block' : 'none';
              const ul = document.createElement('ul');
              ul.className = `main_Grid_${pageId}`;
              ul.dataset.gridSize = block.gridSize;
              if (block.registerMode === 'direct') {
                  const directNos = (block.tabDirectProducts?.[i] || []).map(p => p.product_no).join(',');
                  ul.dataset.directNos = directNos;
              } else { ul.dataset.cate = t.sub || t.root; }
              panel.appendChild(ul);
              groupWrapper.appendChild(panel);
          });
      } else { // single
          const widgetDiv = document.createElement('div');
          widgetDiv.className = 'product_list_widget';
          const ul = document.createElement('ul');
          ul.className = `main_Grid_${pageId}`;
          ul.dataset.gridSize = block.gridSize;
          if (block.registerMode === 'direct') {
              const directNos = (block.directProducts || []).map(p => p.product_no).join(',');
              ul.dataset.directNos = directNos;
          } else { ul.dataset.cate = block.sub || block.root; }
          widgetDiv.appendChild(ul);
          groupWrapper.appendChild(widgetDiv);
      }
      root.appendChild(groupWrapper);
    }
  
    // ────────────────────────────────────────────────────────────────
    // 4) 상품 데이터 로드 및 렌더링
    // ────────────────────────────────────────────────────────────────
async function fetchProducts(directNosAttr, category, limit = 300) {
    const fetchOpts = { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } };
      
      // ✨ API에서 반환하는 상품 객체에 아이콘 관련 필드를 추가합니다.
      const mapProductData = p => ({
        product_no: p.product_no,
        product_name: p.product_name,
        summary_description: p.summary_description || '',
        price: p.price,
        list_image: p.list_image,
        image_medium: p.image_medium,
        image_small: p.image_small,
        image_thumbnail: p.tiny_image, // tiny_image -> image_thumbnail로 변경
        sale_price: p.sale_price || null,
        benefit_price: p.benefit_price || null,
        benefit_percentage: p.benefit_percentage || null,
        decoration_icon_url: p.decoration_icon_url || null,
        // ✨ 아이콘 필드 추가
        icons: p.icons || null,
        additional_icons: p.additional_icons || [],
        product_tags: p.product_tags || ''
      });
	if (directNosAttr) {
			// ... (직접 상품 번호로 조회하는 로직은 변경 없음)
		} else if (category) {
			// 👇👇👇 카테고리 상품 로드 시 is_active=true 파라미터 추가
			const prodUrl = `${API_BASE}/api/${mallId}/categories/${category}/products?is_active=true&limit=${limit}${couponQSAppend}`;
			// 👆👆👆
			const rawProducts = await fetchWithRetry(prodUrl, fetchOpts).then(r => {
				// 🚨 여기서도 409 응답을 체크하여 차단할 수 있지만, 
				// initializePage에서 409를 처리하므로 여기서는 간단히 처리합니다.
				if (r.status === 409) throw new Error('App token required/expired (409)');
				if (!r.ok) throw r;
				return r.json();
			}).then(json => Array.isArray(json) ? json : (json.products || []));
			return rawProducts.map(p => (typeof p === 'object' ? p : {})).map(mapProductData);
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
  
    function renderProducts(ul, products, cols) {
        ul.style.cssText = `display:grid; grid-template-columns:repeat(${cols},1fr); gap:16px; max-width:800px; margin:24px auto; list-style:none; padding:0; font-family: 'Noto Sans KR', sans-serif;`;
        
        const titleFontSize = `${18 - cols}px`;
        const originalPriceFontSize = `${16 - cols}px`;
        const salePriceFontSize = `${18 - cols}px`;
        
        const formatKRW = val => `${(Number(val) || 0).toLocaleString('ko-KR')}원`;
        const parseNumber = v => {
            if (v == null) return null;
            if (typeof v === 'number' && isFinite(v)) return v;
            const n = parseFloat(String(v).replace(/[^\d.-]/g, ''));
            return isFinite(n) ? n : null;
        };
  
        // ✨ 상품 태그-아이콘 매핑 (선택 사항)
        const TAG_ICON_MAP = {};

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
            
            // 이미지 호버를 위한 이미지 소스 설정
            const initialImg = p.image_medium || p.list_image;
            const hoverImg = p.image_thumbnail || p.image_small; // tiny_image -> image_thumbnail로 변경
            
            const mouseEvents = hoverImg && initialImg && hoverImg !== initialImg 
              ? `onmouseover="this.querySelector('img').src='${hoverImg}'" onmouseout="this.querySelector('img').src='${initialImg}'"` 
              : '';
              
            // ✨ 아이콘 HTML 생성 로직
            let iconHtml = '';
            const renderedUrls = new Set();

            if (p.decoration_icon_url && !renderedUrls.has(p.decoration_icon_url)) {
              iconHtml += `<img src="${p.decoration_icon_url}" alt="icon" class="prd_icon" />`;
              renderedUrls.add(p.decoration_icon_url);
            }
            if (Array.isArray(p.additional_icons)) {
              p.additional_icons.forEach(icon => {
                if (icon.icon_url && !renderedUrls.has(icon.icon_url)) {
                  iconHtml += `<img src="${icon.icon_url}" alt="${escapeHtml(icon.icon_alt || '상품 아이콘')}" class="prd_icon" />`;
                  renderedUrls.add(icon.icon_url);
                }
              });
            }
            if (p.icons) {
              ['icon_new', 'icon_recom', 'icon_best', 'icon_sale'].forEach(key => {
                const url = p.icons[key];
                if (url && !renderedUrls.has(url)) {
                  const altText = key.replace('icon_', '') + ' 아이콘';
                  iconHtml += `<img src="${url}" alt="${altText}" class="prd_icon" />`;
                  renderedUrls.add(url);
                }
              });
            }
            if (p.product_tags) {
              const tags = p.product_tags.split(',').map(t => t.trim());
              tags.forEach(tag => {
                const url = TAG_ICON_MAP[tag];
                if (url && !renderedUrls.has(url)) {
                  iconHtml += `<img src="${url}" alt="${escapeHtml(tag)}" class="prd_icon" />`;
                  renderedUrls.add(url);
                }
              });
            }
    
            return `
              <li style="overflow: hidden; background: #fff;">
                <a href="/product/detail.html?product_no=${p.product_no}" target="_blank" style="text-decoration:none; color:inherit;" data-track-click="product" data-product-no="${p.product_no}" ${mouseEvents}>
                  <div style="position: relative;width: 100%; display: flex; align-items: center; justify-content: center; background: #f8f9fa;">
                    ${initialImg ? `<img src="${initialImg}" alt="${escapeHtml(p.product_name||'')}" style="width:100%;" />` : `<span style="font-size:40px; color:#d9d9d9;">⛶</span>`}
                    ${iconHtml ? `<div class="prd_icons">${iconHtml}</div>` : ''}
                  </div>
                  <div style="padding-top:10px; min-height: 90px;">
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
      .coupon_wrapper{line-height:1.5;}
      .prd_price_container{line-height:1.5;}
      /* ✨ 아이콘 스타일 추가 */
      .prd_icons {
        position: absolute;
        top: 8px;
        left: 8px;
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        pointer-events: none;
      }
      .prd_icon {
        width: auto;
      }

    @media (max-width: 400px) {
      .coupon_wrapper{line-height:1.3;}
      .prd_price_container{line-height:1.3;}
	  .main_Grid_${pageId}{width:96%;margin:0 auto}
    }
      
    `;
    document.head.appendChild(style);
  // onimon.js 내 initializePage 함수 수정 (2025-12-05 14:20:48 로그에 맞춰 URL에 is_active=true 추가)
		async function initializePage() {
			try {
				// GET /api/tude/events/68f8d5caab557a196597df94?is_active=true 형태로 호출되어야 함
				const response = await fetch(`${API_BASE}/api/${mallId}/events/${pageId}?is_active=true`);
				
				// 🚨 409 (token 만료/설치 필요) 응답 시 노출 차단 로직 강화 🚨
				if (response.status === 409) {
					console.error('EVENT LOAD ERROR: ❌ App token required/expired (409). Not rendering content.');
					// 409 응답 시, 이벤트를 로드하는 모든 로직을 중단합니다.
					// 이미지를 포함한 어떤 내용도 렌더링하지 않습니다.
					return;
				}
				
				// 404 (기간 만료) 응답 시 노출 차단
				if (response.status === 404) {
					console.warn('EVENT LOAD WARNING: ⚠️ Event not found or expired (404). Not rendering content.');
					return;
				}

				// 409/404가 아닌, 기타 에러 또는 정상 응답이 아닐 때
				if (!response.ok) throw new Error(`Event data fetch failed with status ${response.status}`);
				
				const ev = await response.json();
				
				const root = getRootContainer();

				// 이하 렌더링 로직 (ev.content.blocks.forEach...)
				if (ev.content && Array.isArray(ev.content.blocks)) {
					ev.content.blocks.forEach(block => {
						// block.type이 'image'이더라도, 이미 위에서 409를 걸렀으므로 렌더링됩니다.
						// 409에서 return 하는 것이 핵심입니다.
						switch(block.type) {
							case 'image': renderImageBlock(block, root); break;
							case 'video': renderVideoBlock(block, root); break;
							case 'text': renderTextBlock(block, root); break;
							case 'product_group': renderProductBlock(block, root); break;
							default: break;
						}
					});
					document.querySelectorAll(`ul.main_Grid_${pageId}`).forEach(ul => loadPanel(ul));
				} else {
					// 구버전 데이터 처리 (동일하게 409에서 이미 return 되었어야 함)
					(ev.images || []).forEach(img => renderImageBlock({ type: 'image', ...img }, root));
					const productBlock = { type: 'product_group', ...ev.classification, gridSize: ev.gridSize, layoutType: ev.layoutType, id: pageId };
					renderProductBlock(productBlock, root);
					document.querySelectorAll(`ul.main_Grid_${pageId}`).forEach(ul => loadPanel(ul));
				}

			} catch (err) {
				console.error('EVENT LOAD CATCH ERROR', err);
				// fetch 자체가 실패한 경우 (네트워크 등)
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
