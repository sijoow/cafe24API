;(function () {
    // ────────────────────────────────────────────────────────────────
    // 0) 스크립트/설정값
    // ────────────────────────────────────────────────────────────────
    let script = document.currentScript;
    if (!script || !script.dataset.pageId) {
      script = Array.from(document.getElementsByTagName('script')).find(s =>
        /eventOnimon\.js/.test(s.src) && s.dataset.pageId
      );
    }
    if (!script || !script.dataset.pageId || !script.dataset.mallId) {
      console.warn('⚠️ eventOnimon.js: mallId/pageId 누락');
      return;
    }
  
    const API_BASE = script.dataset.apiBase || '';
    const pageId = script.dataset.pageId;
    const mallId = script.dataset.mallId;
    let couponNos = script.dataset.couponNos || '';
    let couponQSStart = couponNos ? `?coupon_no=${couponNos}` : '';
    let couponQSAppend = couponNos ? `&coupon_no=${couponNos}` : '';
    // 이벤트 전체 페이지 최대 너비 (미설정 시 800px)
    const pageMaxWidth = parseInt(script.dataset.pageMaxWidth, 10) || 800;
  
    // ────────────────────────────────────────────────────────────────
    // 1) 유틸/트래킹
    // ────────────────────────────────────────────────────────────────
    const ua = navigator.userAgent;
    const device = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : 'PC';
    const visitorId = (() => {
      const key = 'appVisitorId';
      try {
        let id = localStorage.getItem(key);
        if (!id) {
          id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
          localStorage.setItem(key, id);
        }
        return id;
      } catch (e) {
        return (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
      }
    })();
  
    const pad = n => String(n).padStart(2, '0');
    function today() {
      const d = new Date();
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    function shouldTrack() {
      try {
        if (/[?&]track=true/.test(location.search)) return true;
        const key = `tracked_${pageId}_${visitorId}_${today()}`;
        if (sessionStorage.getItem(key)) return false;
        sessionStorage.setItem(key, '1');
        return true;
      } catch (e) {
        return true;
      }
    }
    function track(payload) {
      fetch(`${API_BASE}/api/${mallId}/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true, // 다른 탭/페이지로 이동(URL·쿠폰 클릭) 시에도 전송 유실 방지
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
      } else if (elementType === 'coupon') {
        // 쿠폰 영역: 쿠폰번호(콤마 구분)를 배열로 전송 → 백엔드가 쿠폰별로 분리 집계
        const nos = (el.dataset.couponNo || '').split(',').map(s => s.trim()).filter(Boolean);
        if (nos.length) payload.productNo = nos;
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

    /**
     * 카페24 상품 URL을 iOS Safari에서 안전한 형태로 정규화 (강화 버전)
     *
     * 처리 가능한 입력 형태:
     *   - 평문 한글/이모지: /product/💗5월-한정💗.../230/category/24/display/1/
     *   - URL 인코딩된 한글/이모지: /product/%F0%9F%92%97.../230/category/24/display/1/
     *   - 카테고리 없는 케이스: /product/{slug}/230
     *   - 끝에 /display/1/ 같은 꼬리 붙은 케이스
     *
     * 변환 결과:
     *   https://meliens.com/product/detail.html?product_no=230&cate_no=24
     *
     * 비정상 입력은 null 반환 (호출부에서 링크 생성 자체를 스킵):
     *   - 빈 값, "#", 너무 짧은 값
     *   - 숫자만 있는 값
     *   - 호스트명에 점(.)이 없는 값
     *   - 디코딩 시도 실패하는 값
     */
    function normalizeHref(rawHref) {
        if (!rawHref) return null;
        let href = String(rawHref).trim();
        if (!href || href === '#') return null;

        // 숫자만 있거나 너무 짧은 비정상 값 차단 (예: "1", "12")
        if (/^\d+$/.test(href) || href.length < 4) return null;

        // 1차: percent-encoded 입력은 디코딩해서 매칭에 사용
        //     - 디코딩 실패해도 원본으로 fallback
        let decoded = href;
        try {
            decoded = decodeURI(href);
        } catch (e) {
            decoded = href;
        }

        // 2차: 카페24 상품 URL 패턴 매칭
        //     - 슬러그 부분은 어떤 문자든 허용 (이모지/한글/percent-encoded 모두)
        //     - product_no(숫자) 추출
        //     - 선택적으로 category/{cate_no} 추출
        //     - 그 뒤에 /display/1/ 같은 꼬리표는 무시
        const m = decoded.match(/\/product\/[^\/]+\/(\d+)(?:\/category\/(\d+))?/);
        if (m) {
            try {
                // origin(호스트) 추출은 인코딩된 원본 기준
                const baseForOrigin = /^https?:\/\//i.test(href) ? href : `https://${href}`;
                const u = new URL(baseForOrigin);
                const productNo = m[1];
                const cateNo = m[2];
                return `${u.origin}/product/detail.html?product_no=${productNo}`
                     + (cateNo ? `&cate_no=${cateNo}` : '');
            } catch (e) {
                return null;
            }
        }

        // 3차: 카페24 상품 URL이 아닌 일반 URL인 경우 — 유효성만 검증
        try {
            const finalUrl = /^https?:\/\//i.test(href) ? href : `https://${href}`;
            const u = new URL(finalUrl);
            // 호스트명에 점(.)이 없으면 비정상 (예: https://1)
            if (!u.hostname.includes('.')) return null;
            return finalUrl;
        } catch (e) {
            return null;
        }
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
      wrap.style.cssText = `position:relative; margin:0 auto; width:100%; max-width:${pageMaxWidth}px; font-size:0;`;
      const img = document.createElement('img');
      img.src = block.src;
      img.style.cssText = 'max-width:100%; height:auto; display:block; margin:0 auto;';
      wrap.appendChild(img);
      (block.regions || []).forEach(r => {
        const l = (r.xRatio * 100).toFixed(2), t = (r.yRatio * 100).toFixed(2), w = (r.wRatio * 100).toFixed(2), h = (r.hRatio * 100).toFixed(2);
        if (r.coupon) {
          const btn = document.createElement('button');
          btn.dataset.couponNo = r.coupon;
          btn.dataset.trackClick = 'coupon';
          btn.onclick = () => window.downloadCoupon(r.coupon);
          btn.style.cssText = `position:absolute; left:${l}%; top:${t}%; width:${w}%; height:${h}%; border:none; cursor:pointer; background:transparent;`;
          wrap.appendChild(btn);
        } else if (r.tabTarget) {
          // 탭 이동 — 클릭 시 대상 상품 블록의 해당 탭 활성화 + 스크롤
          const a = document.createElement('a');
          a.href = 'javascript:void(0)';
          a.dataset.trackClick = 'tab';
          a.style.cssText = `position:absolute; left:${l}%; top:${t}%; width:${w}%; height:${h}%; display:block; cursor:pointer;`;
          a.addEventListener('click', (e) => {
            e.preventDefault();
            const panel = document.getElementById(`${r.tabTarget.blockId}-tab-${r.tabTarget.tabIndex}`);
            if (!panel) return;
            const groupWrapper = panel.parentElement;
            const tabBtns = groupWrapper ? groupWrapper.querySelectorAll(`.tabs_${pageId} button`) : null;
            const targetBtn = tabBtns ? tabBtns[r.tabTarget.tabIndex] : null;
            if (targetBtn) targetBtn.click();
            const scrollTarget = groupWrapper || panel;
            const top = Math.max(0, scrollTarget.getBoundingClientRect().top + window.scrollY - 80);
            window.scrollTo({ top, behavior: 'smooth' });
          });
          wrap.appendChild(a);
        } else if (r.popup && Array.isArray(r.popup.images) && r.popup.images.length) {
          // 팝업 영역 — 클릭 시 이미지 캐러셀 오버레이
          const btn = document.createElement('button');
          btn.dataset.trackClick = 'popup';
          btn.onclick = () => window.openEventPopup(r.popup);
          btn.style.cssText = `position:absolute; left:${l}%; top:${t}%; width:${w}%; height:${h}%; border:none; cursor:pointer; background:transparent;`;
          wrap.appendChild(btn);
        } else if (r.href) {
          // 카페24 상품 URL이면 ASCII 단축형으로 자동 변환
          // (운영자가 등록한 이모지/한글 포함 URL이 iOS Safari에서
          //  다운로드 화면으로 빠지는 문제 방지)
          const safeHref = normalizeHref(r.href);

          // 비정상 URL이면 링크 자체를 만들지 않음 (iOS Safari 다운로드 다이얼로그 방지)
          if (!safeHref) return;

          const a = document.createElement('a');
          a.href = safeHref;
          a.dataset.trackClick = 'url';
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

    // 이벤트 유의사항 — 토글 버튼(이미지 또는 텍스트버튼) 클릭 시 본문 슬라이드 다운
    function renderEventNoticeBlock(block, root) {
      const title = block.noticeTitle || '이벤트 유의사항';
      const noticeImg = block.noticeImage || '';
      const noticeText = block.noticeText || '';
      if (!noticeImg && !noticeText) return;
      const wrap = document.createElement('div');
      wrap.style.cssText = `position:relative; margin:0 auto; width:100%; max-width:${pageMaxWidth}px; font-size:0;`;
      let trigger;
      if (noticeImg) {
        trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.style.cssText = 'width:100%; padding:0; margin:0; border:0; background:transparent; cursor:pointer; display:block; font-size:0;';
        trigger.setAttribute('aria-label', title);
        const img = document.createElement('img');
        img.src = noticeImg; img.alt = title;
        img.style.cssText = 'max-width:100%; height:auto; display:block; margin:0 auto;';
        trigger.appendChild(img);
      } else {
        trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.style.cssText = 'width:100%; padding:16px 20px; background:#f5f5f5; border:1px solid #e0e0e0; border-radius:6px; font-size:15px; font-weight:600; color:#333; cursor:pointer; display:flex; justify-content:space-between; align-items:center; text-align:left; margin:24px 0;';
        trigger.innerHTML = `<span>${escapeHtml(title)}</span><span class="evt-notice-caret" style="transition:transform 0.3s ease; font-size:12px;">&#9662;</span>`;
      }
      const panel = document.createElement('div');
      panel.style.cssText = 'overflow:hidden; max-height:0; transition:max-height 0.4s ease;';
      const ns = block.noticeStyle || {};
      const padding = (typeof ns.padding === 'number') ? ns.padding : 16;
      const bg = ns.background || 'transparent';
      const color = ns.color || '#444';
      const fontSize = (typeof ns.fontSize === 'number') ? ns.fontSize : 14;
      const lineHeight = (typeof ns.lineHeight === 'number') ? ns.lineHeight : 1.7;
      const letterSpacing = (typeof ns.letterSpacing === 'number') ? `${ns.letterSpacing}px` : '0';
      const inner = document.createElement('div');
      inner.style.cssText = `padding:${padding}px; background:${bg}; font-size:${fontSize}px; color:${color}; line-height:${lineHeight}; letter-spacing:${letterSpacing}; white-space:pre-wrap;`;
      inner.textContent = noticeText || '';
      panel.appendChild(inner);
      let open = false;
      trigger.addEventListener('click', () => {
        open = !open;
        const caret = trigger.querySelector('.evt-notice-caret');
        if (open) { panel.style.maxHeight = inner.scrollHeight + 32 + 'px'; if (caret) caret.style.transform = 'rotate(180deg)'; }
        else { panel.style.maxHeight = '0'; if (caret) caret.style.transform = 'rotate(0deg)'; }
      });
      wrap.appendChild(trigger);
      if (noticeText) wrap.appendChild(panel);
      root.appendChild(wrap);
    }

    function renderVideoBlock(block, root) {
        const ratio = block.ratio || { w: 16, h: 9 };
        if (!block.youtubeId) return;
        const src = buildYouTubeSrc(block.youtubeId, toBool(block.autoplay), toBool(block.loop));
        const wrap = document.createElement('div');
        wrap.style.cssText = `position:relative; width:100%; max-width:${pageMaxWidth}px; margin:16px auto; aspect-ratio:${ratio.w}/${ratio.h};`;
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
          // 탭 영역(블록 전체) 너비: 기본 98% | 꽉 채움 100% — 탭바·상품 그리드가 이 폭을 함께 채움
          // 기본: 페이지 최대 너비(이미지 등 다른 콘텐츠와 동일 정렬) | 꽉 채움: 전체 화면 너비(풀블리드)
          groupWrapper.style.cssText = block.tabWidthMode === 'full'
            ? 'width:100%; max-width:100%; margin:0 auto;'
            : `width:100%; max-width:${pageMaxWidth}px; margin:0 auto;`;
          const tabsContainer = document.createElement('div');
          tabsContainer.className = `tabs_${pageId}`;
          tabsContainer.style.maxWidth = '100%';
          tabsContainer.style.margin = '16px 0';
          // tabsPerRow 가 2 이상이면 grid 로 줄바꿈 (탭 줄당 개수)
          if (block.tabsPerRow && Number(block.tabsPerRow) >= 2) {
              const n = Number(block.tabsPerRow);
              tabsContainer.style.display = 'grid';
              tabsContainer.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
          }
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
              // 탭별 그리드 사이즈 우선, 없으면 block.gridSize 로 fallback
              ul.dataset.gridSize = (block.tabGridSizes && block.tabGridSizes[i] != null) ? block.tabGridSizes[i] : block.gridSize;
              ul.dataset.widthMode = 'fill';
              ul.dataset.cardTemplate = block.cardTemplate || 'basic';
              ul.dataset.thumbRadius = block.thumbRadius || 'square';
              ul.dataset.iconPosition = block.iconPosition || 'off';
              ul.dataset.cardStyle = JSON.stringify(block.cardStyle || {});
              ul.dataset.rolling = JSON.stringify(block.rolling || {});
              ul.dataset.soldOutNos = JSON.stringify(block.soldOutNos || []);
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
          ul.dataset.widthMode = block.tabWidthMode || 'default';
          ul.dataset.cardTemplate = block.cardTemplate || 'basic';
          ul.dataset.thumbRadius = block.thumbRadius || 'square';
          ul.dataset.iconPosition = block.iconPosition || 'off';
          ul.dataset.cardStyle = JSON.stringify(block.cardStyle || {});
          ul.dataset.rolling = JSON.stringify(block.rolling || {});
              ul.dataset.soldOutNos = JSON.stringify(block.soldOutNos || []);
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
      
      const mapProductData = p => ({
        product_no: p.product_no,
        product_name: p.product_name,
        summary_description: p.summary_description || '',
        price: p.price,
        list_image: p.list_image,
        image_medium: p.image_medium,
        image_small: p.image_small,
        image_thumbnail: p.tiny_image,
        sale_price: p.sale_price || null,
        benefit_price: p.benefit_price || null,
        benefit_percentage: p.benefit_percentage || null,
        decoration_icon_url: p.decoration_icon_url || null,
        icons: p.icons || null,
        additional_icons: p.additional_icons || [],
        product_tags: p.product_tags || ''
      });
  
      if (directNosAttr) {
        const ids = directNosAttr.split(',').map(s => s.trim()).filter(Boolean);
        if (ids.length === 0) return [];
        const results = await Promise.all(ids.map(no =>
          fetchWithRetry(`${API_BASE}/api/${mallId}/products/${no}${couponQSStart}`, fetchOpts).then(r => r.json())
        ));
        return results.map(p => (p && p.product_no) ? p : {}).map(mapProductData);
      } else if (category) {
        const prodUrl = `${API_BASE}/api/${mallId}/categories/${category}/products?limit=${limit}${couponQSAppend}`;
        const rawProducts = await fetchWithRetry(prodUrl, fetchOpts).then(r => r.json()).then(json => Array.isArray(json) ? json : (json.products || []));
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

        const isCriticalError = err && (err.status === 409 || err.status === 404 || err.status === 400 || err.status >= 500);

        const rootContainer = document.getElementById('evt-root');
        
        if (rootContainer && isCriticalError) {
             rootContainer.innerHTML = ''; 

             const errDiv = document.createElement('div');
             errDiv.style.textAlign = 'center';
             errDiv.style.padding = '100px 0';
             errDiv.innerHTML = `
                <div style="font-size:16px; color:#333; font-weight:bold; margin-bottom:8px;">프로모션 올인원 사용기간이 종료되었습니다.</div>
             `;
             
             rootContainer.appendChild(errDiv);
             return;
        }

        if (ul.parentNode) {
          const errDiv = document.createElement('div');
          errDiv.style.textAlign = 'center';
          errDiv.style.padding = '50px 0';
          errDiv.innerHTML = `<p style="color:#666; font-size:14px; margin: 0;">정보를 불러올 수 없습니다.</p>`;
          ul.parentNode.insertBefore(errDiv, ul);
        }

      } finally {
        clearTimeout(spinnerTimer);
        if (spinner) {
          spinner.remove();
        }
      }
    }
  
    // 상품 카드 텍스트(이미지 아래) — 템플릿별 렌더. front/src/components/productCard.js 의 CardBody 와 디자인 일치.
    // 클래스(.prd_name/.prd_desc/.original_price/.sale_percent/.sale_price)는 CSS 커스텀 팁 호환용.
    function buildCardText(p, template, cols, calc, cardStyle) {
      const { orig, finalP, pct, hasDiscount, isCoupon } = calc;
      const cs = cardStyle || {};
      const name = escapeHtml(p.product_name || '');
      const summary = escapeHtml(p.summary_description || '');
      const fmt = v => `${(Number(v) || 0).toLocaleString('ko-KR')}원`;
      // 반응형(cqw+clamp) + 블록별 카드 스타일 오버라이드(상품명/요약 크기·굵기, 할인율 색상)
      const scl = (base, s) => (s && Number(s) !== 1) ? `calc(${base} * ${s})` : base;
      const nameSize = scl('clamp(12px, 6.5cqw, 18px)', cs.nameScale);
      const subSize = scl('clamp(10px, 4.5cqw, 13px)', cs.descScale);
      const priceSize = 'clamp(12px, 6cqw, 17px)', origSize = 'clamp(10px, 5cqw, 14px)', bigSize = 'clamp(13px, 8cqw, 22px)', hugeSize = 'clamp(14px, 9cqw, 24px)';
      const nameW = cs.nameWeight || 500, descW = cs.descWeight || 400, pctColor = cs.percentColor || '#ff4d4f';
      const nameEl = `<div class="prd_name" style="font-weight:${nameW};font-size:${nameSize};line-height:1.3;">${name}</div>`;
      const subEl = (summary && !cs.descHide) ? `<div class="prd_desc" style="font-size:${subSize};font-weight:${descW};color:#999;">${summary}</div>` : '';
      const strikeEl = `<span class="original_price" style="color:#bbb;text-decoration:line-through;font-size:${origSize};">${fmt(orig)}</span>`;
      const pctEl = (sz) => pct > 0 ? `<span class="sale_percent" style="color:${pctColor};font-weight:bold;font-size:${sz};margin-right:6px;">${pct}%</span>` : '';
      const finalEl = (sz, color) => `<span class="sale_price" style="font-weight:bold;font-size:${sz};${color ? `color:${color};` : ''}">${fmt(finalP)}</span>`;
      switch (template) {
        case 'simple':
          return `${nameEl}<div style="margin-top:6px;">${finalEl(priceSize)}</div>`;
        case 'musinsa':
          return `${(summary && !cs.descHide) ? `<div class="prd_desc" style="font-size:${subSize};color:#888;font-weight:${cs.descWeight || 600};">${summary}</div>` : ''}${nameEl}<div style="margin-top:6px;">${pctEl(priceSize)}${finalEl(priceSize)}</div>`;
        case 'gmarket':
          return `${nameEl}${subEl}${hasDiscount ? `<div style="margin-top:6px;"><span style="font-size:${subSize};color:#999;margin-right:4px;">${isCoupon ? '쿠폰적용가' : '판매가'}</span>${strikeEl}</div>` : ''}<div style="margin-top:2px;">${hasDiscount ? pctEl(bigSize) : ''}${finalEl(bigSize, '#111')}</div>`;
        case 'center':
          return `<div style="text-align:center;">${subEl}${nameEl}<div style="margin-top:6px;">${hasDiscount ? `${strikeEl}<span style="margin:0 4px;color:#ccc;">&rarr;</span>` : ''}${hasDiscount ? pctEl(priceSize) : ''}${finalEl(priceSize)}</div></div>`;
        case 'emphasis':
          return `${subEl}${nameEl}${hasDiscount ? `<div style="margin-top:6px;">${strikeEl}</div>` : ''}${hasDiscount && pct > 0 ? `<div class="sale_percent" style="color:${pctColor};font-weight:bold;font-size:${hugeSize};line-height:1.1;">${pct}%</div>` : ''}<div class="sale_price" style="font-weight:bold;font-size:${hugeSize};line-height:1.2;">${fmt(finalP)}</div>`;
        case 'badge':
          return `${nameEl}<div style="margin-top:4px;line-height:1.4;">${hasDiscount ? `<div>${strikeEl}</div>` : ''}<div>${finalEl(bigSize, '#111')}</div></div>`;
        case 'basic':
        default:
          return `${subEl}${nameEl}<div style="margin-top:4px;line-height:1.4;">${hasDiscount ? `<div>${strikeEl}</div>` : ''}<div>${hasDiscount ? pctEl(priceSize) : ''}${finalEl(priceSize)}</div></div>`;
      }
    }

    // ── 상품 롤링(슬라이드): Splide(MIT 라이선스) CDN 로더 — 스킨에 이미 있으면 재사용, 없으면 1회 로드 ──
    const SPLIDE_VER = '4.1.4';
    function loadSplide(cb) {
      let called = false;
      const done = (v) => { if (called) return; called = true; cb(v); };
      if (window.Splide) { done(true); return; }
      if (!document.getElementById('splide-css')) {
        const link = document.createElement('link');
        link.id = 'splide-css'; link.rel = 'stylesheet';
        link.href = `https://cdn.jsdelivr.net/npm/@splidejs/splide@${SPLIDE_VER}/dist/css/splide.min.css`;
        document.head.appendChild(link);
      }
      let s = document.getElementById('splide-js');
      if (s) {
        if (window.Splide) { done(true); return; }
        s.addEventListener('load', () => done(!!window.Splide));
        s.addEventListener('error', () => done(false));
      } else {
        s = document.createElement('script');
        s.id = 'splide-js';
        s.src = `https://cdn.jsdelivr.net/npm/@splidejs/splide@${SPLIDE_VER}/dist/js/splide.min.js`;
        s.onload = () => done(!!window.Splide);
        s.onerror = () => done(false);
        document.head.appendChild(s);
      }
      setTimeout(() => done(!!window.Splide), 5000);
    }

    // 그리드 ul 을 Splide 캐러셀로 변환 + 마운트. 실패 시 네이티브 가로 스크롤로 폴백.
    function mountRolling(ul, rolling, cols, widthCss) {
      if (ul.parentNode && ul.parentNode.className === 'splide__track') return; // 중복 방지
      const pvNum = Math.max(1, Number(rolling.perView) || cols || 2);
      const frac = Math.abs(pvNum - Math.round(pvNum)) > 0.01; // 소수(2.3 등): Splide 정수 perPage 미지원 → autoWidth
      ul.className = 'splide__list';
      ul.style.cssText = 'list-style:none; padding:0; margin:0;';
      Array.from(ul.children).forEach(li => li.classList.add('splide__slide'));
      const track = document.createElement('div'); track.className = 'splide__track';
      const rootEl = document.createElement('div'); rootEl.className = 'splide';
      rootEl.style.cssText = `${widthCss} font-family:inherit;`;
      ul.parentNode.insertBefore(rootEl, ul);
      track.appendChild(ul);
      rootEl.appendChild(track);
      const opts = {
        gap: '16px',
        type: rolling.loop ? 'loop' : 'slide',
        arrows: rolling.arrows !== false,
        pagination: rolling.pagination !== false,
        drag: true,
        autoplay: !!rolling.autoplay,
        interval: (Number(rolling.interval) || 3) * 1000,
        pauseOnHover: true,
      };
      if (frac) {
        opts.autoWidth = true;
        Array.from(ul.children).forEach(li => { li.style.width = `calc((100% - 16px) / ${pvNum})`; li.style.boxSizing = 'border-box'; });
      } else {
        opts.perPage = pvNum;
        opts.padding = rolling.peek ? '10%' : 0;
        opts.breakpoints = { 768: { perPage: Math.min(pvNum, 2), padding: rolling.peek ? '14%' : 0, gap: '10px' } };
      }
      loadSplide((ok) => {
        if (ok && window.Splide) {
          try { const sp = new window.Splide(rootEl, opts); sp.mount(); rootEl.__splide = sp; return; } catch (e) { /* 폴백으로 */ }
        }
        // 폴백: Splide 미로드 시 네이티브 가로 스크롤
        track.style.cssText = 'overflow-x:auto; scroll-snap-type:x mandatory; -webkit-overflow-scrolling:touch;';
        ul.style.cssText = 'list-style:none; padding:0 0 8px; margin:0; display:flex; gap:16px;';
        const peekPx = rolling.peek ? 26 : 0;
        Array.from(ul.children).forEach(li => { li.style.cssText += `;flex:0 0 calc((100% - ${16 * Math.max(0, Math.ceil(pvNum) - 1)}px - ${peekPx}px) / ${pvNum}); scroll-snap-align:start;`; });
      });
    }

    function renderProducts(ul, products, cols) {
        // 탭 콘텐츠 너비 모드 적용 (탭별 ul.dataset.widthMode)
        const widthMode = ul.dataset.widthMode || 'default';
        const thumbRadiusPx = ul.dataset.thumbRadius === 'rounded' ? 12 : 0;
        const iconPosition = ul.dataset.iconPosition || 'off';
        const template = ul.dataset.cardTemplate || 'basic';
        const cardStyle = (() => { try { return JSON.parse(ul.dataset.cardStyle || '{}'); } catch (e) { return {}; } })();
        const rolling = (() => { try { const r = JSON.parse(ul.dataset.rolling || '{}'); return (r && r.enabled) ? r : null; } catch (e) { return null; } })();
        const soldOutSet = new Set((() => { try { return JSON.parse(ul.dataset.soldOutNos || '[]'); } catch (e) { return []; } })().map(String));
        const ipos = iconPosition === 'top-right' ? 'top:8px;right:8px;left:auto;bottom:auto;' : iconPosition === 'bottom-left' ? 'bottom:8px;left:8px;top:auto;right:auto;' : iconPosition === 'bottom-right' ? 'bottom:8px;right:8px;top:auto;left:auto;' : 'top:8px;left:8px;right:auto;bottom:auto;';
        let widthCss;
        if (widthMode === 'fill' || widthMode === 'full') widthCss = 'width:100%; max-width:100%; margin:24px 0;';
        else widthCss = `max-width:${pageMaxWidth}px; margin:24px auto;`;
        if (!rolling) ul.style.cssText = `display:grid; grid-template-columns:repeat(${cols},1fr); gap:16px; ${widthCss} list-style:none; padding:0; font-family:inherit;`;
        
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
            
            const initialImg = p.image_medium || p.list_image;
            const hoverImg = p.image_thumbnail || p.image_small;
            
            const mouseEvents = hoverImg && initialImg && hoverImg !== initialImg 
              ? `onmouseover="this.querySelector('img').src='${hoverImg}'" onmouseout="this.querySelector('img').src='${initialImg}'"` 
              : '';
              
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
    
            let finalP = origPrice; if (isSale) finalP = salePrice; if (isCoupon) finalP = benefitPrice;
            const calc = { orig: origPrice, finalP, pct: displayPercent || 0, hasDiscount: finalP < origPrice, isCoupon };
            const soldOut = soldOutSet.has(String(p.product_no));
            const inner = `
                  <div style="position: relative;width: 100%; display: flex; align-items: center; justify-content: center; background: #f8f9fa; border-radius:${thumbRadiusPx}px; overflow:hidden;${soldOut ? 'filter:grayscale(0.7);' : ''}">
                    ${initialImg ? `<img src="${initialImg}" alt="${escapeHtml(p.product_name||'')}" style="width:100%;" />` : `<span style="font-size:40px; color:#d9d9d9;">⛶</span>`}
                    ${(template === 'badge' && calc.pct > 0 && !soldOut) ? `<div class="sale_badge" style="position:absolute;top:8px;left:8px;background:${cardStyle.percentColor || '#ff4d4f'};color:#fff;border-radius:8px;padding:2px 8px;font-weight:700;font-size:clamp(11px,5.5cqw,16px);line-height:1.2;box-shadow:0 1px 3px rgba(0,0,0,0.2);">${calc.pct}%</div>` : ''}
                    ${(iconHtml && iconPosition !== 'off' && !soldOut) ? `<div class="prd_icons" style="${ipos}">${iconHtml}</div>` : ''}
                  </div>
                  <div style="padding-top:10px; min-height: 90px;">
                    ${buildCardText(p, ul.dataset.cardTemplate || 'basic', cols, calc, cardStyle)}
                  </div>`;
            return `
              <li style="overflow: hidden; background: #fff; container-type: inline-size; position:relative;">
                ${soldOut
                  ? `<div style="text-decoration:none; color:inherit; display:block;">${inner}</div><div style="position:absolute;inset:0;background:rgba(33,37,43,0.5);display:flex;align-items:center;justify-content:center;z-index:4;pointer-events:none;border-radius:${thumbRadiusPx}px;"><span style="color:#fff;font-weight:800;font-size:clamp(14px,9cqw,28px);letter-spacing:1px;margin-top:-18%;">SOLD OUT</span></div>`
                  : `<a href="/product/detail.html?product_no=${p.product_no}" target="_blank" style="text-decoration:none; color:inherit; display:block;" data-track-click="product" data-product-no="${p.product_no}" ${mouseEvents}>${inner}</a>`}
              </li>`;
        }).join('');

        if (rolling && products.length > 0) mountRolling(ul, rolling, cols, widthCss);
    }

    const style = document.createElement('style');
    style.textContent = `
      .grid-spinner { width: 40px; height: 40px; border: 4px solid #f3f3f3; border-top: 4px solid #1890ff; border-radius: 50%; animation: spin_${pageId} 1s linear infinite; margin: 20px auto; }
      @keyframes spin_${pageId} { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg);} }
      .tabs_${pageId} { display: flex; gap: 8px; max-width: ${pageMaxWidth}px; margin: 16px auto; }
      .tabs_${pageId} button { flex: 1; padding: 8px; font-size: 16px; border: 1px solid #d9d9d9; background: #f5f5f5; color: #333; cursor: pointer; border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tabs_${pageId} button.active { font-weight: 600; }
      .prd_price_container .original_price { text-decoration: line-through; color: #999; display: block; font-weight: 400; }
      .prd_price_container .sale_percent, .prd_price_container .prd_coupon_percent { color: #ff4d4f; font-weight: bold; margin-right: 4px; }
      .coupon_wrapper{line-height:1.5;}
      .prd_price_container{line-height:1.5;}
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
        width: clamp(16px, 24cqw, 46px);
        height: auto;
      }
  
    @media (max-width: 400px) {
      .coupon_wrapper{line-height:1.3;}
      .prd_price_container{line-height:1.3;}
      .main_Grid_${pageId}{width:96%;margin:0 auto}
    }
      
    `;
    document.head.appendChild(style);
  
    // 타임세일(기간할인 표시) — 카운트다운 배너 + 대상 상품 그리드(할인가 discountprice 자동 반영)
    // 이미지 슬라이드(스와이퍼) 블록 — 이미지 2장+ 가로 슬라이드. Splide(MIT), 실패 시 네이티브 가로 스크롤.
    function renderImageSlideBlock(block, root) {
      const images = (block.images || []).filter(im => im && im.src);
      if (images.length === 0) return;
      const sw = block.swiper || {};
      const wrap = document.createElement('div');
      wrap.style.cssText = `position:relative; margin:16px auto; width:100%; max-width:${pageMaxWidth}px;`;
      if (images.length < 2) {
        const im = images[0];
        const tag = `<img src="${im.src}" alt="" style="width:100%;display:block;border-radius:8px;" />`;
        wrap.innerHTML = im.href ? `<a href="${im.href}" target="_blank">${tag}</a>` : tag;
        root.appendChild(wrap);
        return;
      }
      const slides = images.map(im => {
        const img = `<img src="${im.src}" alt="" style="width:100%;display:block;" />`;
        return `<li class="splide__slide">${im.href ? `<a href="${im.href}" target="_blank" style="display:block;">${img}</a>` : img}</li>`;
      }).join('');
      const rootEl = document.createElement('div');
      rootEl.className = 'splide';
      rootEl.innerHTML = `<div class="splide__track"><ul class="splide__list">${slides}</ul></div>`;
      wrap.appendChild(rootEl);
      root.appendChild(wrap);
      const perPage = Math.max(1, Number(sw.perView) || 1);
      const frac = Math.abs(perPage - Math.round(perPage)) > 0.01;
      const opts = {
        gap: perPage > 1 ? '12px' : '0',
        type: sw.loop !== false ? 'loop' : 'slide',
        arrows: sw.arrows !== false,
        pagination: sw.pagination !== false,
        drag: true,
        autoplay: !!sw.autoplay,
        interval: (Number(sw.interval) || 3) * 1000,
        pauseOnHover: true,
      };
      if (frac) {
        opts.autoWidth = true;
        rootEl.querySelectorAll('.splide__slide').forEach(li => { li.style.width = `calc((100% - 12px) / ${perPage})`; li.style.boxSizing = 'border-box'; });
      } else {
        opts.perPage = perPage;
        opts.padding = sw.peek ? '8%' : 0;
        opts.breakpoints = { 768: { perPage: Math.min(perPage, 2), padding: sw.peek ? '10%' : 0 } };
      }
      loadSplide((ok) => {
        if (ok && window.Splide) { try { const sp = new window.Splide(rootEl, opts); sp.mount(); rootEl.__splide = sp; return; } catch (e) { /* 폴백 */ } }
        const track = rootEl.querySelector('.splide__track');
        const list = rootEl.querySelector('.splide__list');
        if (track) track.style.cssText = 'overflow-x:auto; scroll-snap-type:x mandatory; -webkit-overflow-scrolling:touch;';
        if (list) list.style.cssText = 'display:flex; gap:12px; list-style:none; padding:0; margin:0;';
        rootEl.querySelectorAll('.splide__slide').forEach(li => { li.style.cssText = `flex:0 0 ${100 / perPage}%; scroll-snap-align:start;`; });
      });
    }

    function renderTimesaleBlock(block, root) {
      const productNos = (block.productNos || []).filter(Boolean);
      const wrap = document.createElement('div');
      wrap.style.cssText = `margin:0 auto; width:100%; max-width:${pageMaxWidth}px;`;
      const BANNERS = {
        dark: { bg: '#1a1a1a', color: '#fff', cd: '#ff6b6b', border: 'none' },
        red: { bg: '#e8332e', color: '#fff', cd: '#ffe600', border: 'none' },
        minimal: { bg: '#fff', color: '#222', cd: '#e8332e', border: '1px solid #e0e0e0' },
        gradient: { bg: 'linear-gradient(90deg,#7b2ff7,#f107a3)', color: '#fff', cd: '#ffe600', border: 'none' },
      };
      const bn = BANNERS[block.bannerStyle] || BANNERS.dark;
      const banner = document.createElement('div');
      banner.style.cssText = `display:flex;align-items:center;justify-content:center;gap:10px;padding:14px 16px;background:${bn.bg};color:${bn.color};border:${bn.border};border-radius:8px;margin:16px 0;font-size:16px;`;
      const title = document.createElement('strong');
      title.textContent = block.title || '타임세일';
      banner.appendChild(title);
      if (block.showCountdown !== false && block.endDate) {
        const cdEl = document.createElement('span');
        cdEl.style.cssText = `color:${bn.cd};font-weight:700;font-variant-numeric:tabular-nums;`;
        banner.appendChild(cdEl);
        const end = new Date(block.endDate).getTime();
        const pad = n => String(n).padStart(2, '0');
        let timer = null;
        const tick = () => {
          let diff = end - Date.now();
          if (diff <= 0) { cdEl.textContent = '종료되었습니다'; if (timer) clearInterval(timer); return; }
          const d = Math.floor(diff / 86400000); diff -= d * 86400000;
          const h = Math.floor(diff / 3600000); diff -= h * 3600000;
          const m = Math.floor(diff / 60000); diff -= m * 60000;
          const s = Math.floor(diff / 1000);
          cdEl.textContent = `⏱ ${d > 0 ? d + '일 ' : ''}${pad(h)}:${pad(m)}:${pad(s)}`;
        };
        tick(); timer = setInterval(tick, 1000);
      }
      wrap.appendChild(banner);
      if (productNos.length) {
        const ul = document.createElement('ul');
        ul.className = `main_Grid_${pageId}`;
        ul.dataset.gridSize = block.gridSize || 2;
        ul.dataset.cardTemplate = block.cardTemplate || 'badge';
        ul.dataset.directNos = productNos.join(',');
        wrap.appendChild(ul);
      }
      root.appendChild(wrap);
    }

    async function initializePage() {
      try {
        const response = await fetch(`${API_BASE}/api/${mallId}/events/${pageId}`);
        if (!response.ok) throw new Error('Event data fetch failed');
        const ev = await response.json();

        // 쿠폰 런타임 병합 — 이벤트에 저장된 couponNos 를 합쳐 임베드 재복사 없이 "저장만으로" 쿠폰 반영
        try {
          const evC = Array.isArray(ev.couponNos) ? ev.couponNos.map(c => String(c).trim()).filter(Boolean) : [];
          const merged = [...new Set([...(couponNos ? couponNos.split(',') : []), ...evC].map(s => String(s).trim()).filter(Boolean))];
          couponNos = merged.join(',');
          couponQSStart = couponNos ? `?coupon_no=${couponNos}` : '';
          couponQSAppend = couponNos ? `&coupon_no=${couponNos}` : '';
        } catch (e) {}

        const root = getRootContainer();
  
        if (ev.content && Array.isArray(ev.content.blocks)) {
            ev.content.blocks.forEach(block => {
                switch(block.type) {
                    case 'image': renderImageBlock(block, root); break;
                    case 'video': renderVideoBlock(block, root); break;
                    case 'text': renderTextBlock(block, root); break;
                    case 'product_group': renderProductBlock(block, root); break;
                    case 'event_notice': renderEventNoticeBlock(block, root); break;
                    case 'timesale': renderTimesaleBlock(block, root); break;
                    case 'image_slide': renderImageSlideBlock(block, root); break;
                    default: break;
                }
            });
            document.querySelectorAll(`ul.main_Grid_${pageId}`).forEach(ul => loadPanel(ul));
        } else {
            (ev.images || []).forEach(img => renderImageBlock({ type: 'image', ...img }, root));
            const productBlock = { type: 'product_group', ...ev.classification, gridSize: ev.gridSize, layoutType: ev.layoutType, id: pageId };
            renderProductBlock(productBlock, root);
            document.querySelectorAll(`ul.main_Grid_${pageId}`).forEach(ul => loadPanel(ul));
        }
  
      } catch (err) {
        console.error('EVENT LOAD ERROR', err);
      }
    }
  
    // 이벤트 팝업 — 1~10장 이미지 캐러셀 오버레이 (각 이미지 닫기/링크 영역 + 자동 순환)
    window.openEventPopup = (popup) => {
      const images = (popup && popup.images) || [];
      if (!images.length) return;
      const interval = Number(popup.interval) || 3000;
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed; inset:0; z-index:99999; background:rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center; padding:20px; box-sizing:border-box;';
      const box = document.createElement('div');
      box.style.cssText = 'position:relative; max-width:480px; width:100%; max-height:100vh; overflow:hidden;';
      const slide = document.createElement('div');
      slide.style.cssText = 'position:relative; width:100%;';
      let idx = 0;
      let timer = null;
      let closeFn = () => {};
      const imgEls = images.map((im, i) => {
        const regions = Array.isArray(im.regions) ? im.regions : [];
        if (regions.length > 0) {
          const cell = document.createElement('div');
          cell.style.cssText = `display:${i === 0 ? 'block' : 'none'}; position:relative;`;
          const img = document.createElement('img');
          img.src = im.url; img.alt = '';
          img.style.cssText = 'width:100%; height:auto; display:block; border-radius:8px;';
          cell.appendChild(img);
          regions.forEach((rg) => {
            const rl = (rg.xRatio * 100).toFixed(2), rt = (rg.yRatio * 100).toFixed(2), rw = (rg.wRatio * 100).toFixed(2), rh = (rg.hRatio * 100).toFixed(2);
            if (rg.action === 'close') {
              const cb = document.createElement('button');
              cb.type = 'button';
              cb.style.cssText = `position:absolute; left:${rl}%; top:${rt}%; width:${rw}%; height:${rh}%; border:none; background:transparent; cursor:pointer;`;
              cb.onclick = (e) => { e.stopPropagation(); closeFn(); };
              cell.appendChild(cb);
            } else if (rg.action === 'link') {
              const safe = rg.href ? normalizeHref(rg.href) : '';
              if (!safe) return;
              const la = document.createElement('a');
              la.href = safe; la.target = '_blank'; la.rel = 'noopener noreferrer';
              la.style.cssText = `position:absolute; left:${rl}%; top:${rt}%; width:${rw}%; height:${rh}%; display:block;`;
              la.onclick = (e) => e.stopPropagation();
              cell.appendChild(la);
            }
          });
          slide.appendChild(cell);
          return cell;
        }
        const a = document.createElement('a');
        const safe = im.href ? normalizeHref(im.href) : '';
        if (safe) { a.href = safe; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
        a.style.cssText = `display:${i === 0 ? 'block' : 'none'};`;
        const img = document.createElement('img');
        img.src = im.url; img.alt = '';
        img.style.cssText = 'width:100%; height:auto; display:block; border-radius:8px;';
        a.appendChild(img);
        slide.appendChild(a);
        return a;
      });
      const show = (n) => { idx = (n + imgEls.length) % imgEls.length; imgEls.forEach((el, i) => { el.style.display = i === idx ? 'block' : 'none'; }); };
      const prevBodyOverflow = document.body.style.overflow;
      const close = () => { if (timer) clearInterval(timer); overlay.remove(); document.body.style.overflow = prevBodyOverflow || 'visible'; };
      closeFn = close;
      box.appendChild(slide);
      if (popup.showCloseButton !== false) {
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.innerHTML = '&times;';
        closeBtn.setAttribute('aria-label', '닫기');
        closeBtn.style.cssText = 'position:absolute; top:8px; right:8px; z-index:2; width:36px; height:36px; border:none; border-radius:50%; background:rgba(0,0,0,0.6); color:#fff; font-size:22px; line-height:36px; cursor:pointer;';
        closeBtn.onclick = (e) => { e.stopPropagation(); close(); };
        box.appendChild(closeBtn);
      }
      if (imgEls.length > 1) {
        const prev = document.createElement('button');
        prev.type = 'button';
        prev.innerHTML = '&#10094;';
        prev.style.cssText = 'position:absolute; top:50%; left:8px; transform:translateY(-50%); z-index:2; width:36px; height:36px; border:none; border-radius:50%; background:rgba(0,0,0,0.4); color:#fff; font-size:18px; cursor:pointer;';
        prev.onclick = (e) => { e.stopPropagation(); show(idx - 1); };
        const next = document.createElement('button');
        next.type = 'button';
        next.innerHTML = '&#10095;';
        next.style.cssText = 'position:absolute; top:50%; right:8px; transform:translateY(-50%); z-index:2; width:36px; height:36px; border:none; border-radius:50%; background:rgba(0,0,0,0.4); color:#fff; font-size:18px; cursor:pointer;';
        next.onclick = (e) => { e.stopPropagation(); show(idx + 1); };
        box.appendChild(prev);
        box.appendChild(next);
        timer = setInterval(() => show(idx + 1), interval);
      }
      overlay.onclick = () => close();
      box.onclick = (e) => e.stopPropagation();
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      document.body.style.overflow = 'hidden';
    };

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
            if (el.id === id) {
                el.style.display = 'block';
                // 숨김 상태에서 마운트된 Splide 는 폭이 0 으로 잡히므로, 보일 때 재계산
                el.querySelectorAll('.splide').forEach(sp => { if (sp.__splide) { try { sp.__splide.refresh(); } catch (e) {} } });
            } else { el.style.display = 'none'; }
        });
    };
  
    /**
     * 쿠폰 다운로드 (iOS Safari 대응 패치 적용)
     *
     * 변경점:
     *  1) 쿠폰 번호 형식 검증 (영숫자만 허용) — 잘못된 값으로 인한
     *     카페24 서버의 비정상 응답("1" 등) → iOS 다운로드 다이얼로그 방지
     *  2) window.open 대신 임시 <a target="_blank"> 태그 클릭 방식 사용
     *     - iOS Safari에서 사용자 제스처 컨텍스트가 명확히 유지되어
     *       팝업 차단 / 다운로드 오인 케이스를 줄임
     */
    window.downloadCoupon = (coupons) => {
        const list = String(coupons || '').split(',').map(s => s.trim()).filter(Boolean);
        if (list.length === 0) {
            alert('쿠폰 정보가 없습니다.');
            return;
        }

        const validCoupons = list.filter(c => /^[a-zA-Z0-9]+$/.test(c));
        if (validCoupons.length === 0) {
            alert('유효하지 않은 쿠폰입니다.');
            return;
        }

        const url = `/exec/front/newcoupon/IssueDownload?coupon_no=${encodeURIComponent(validCoupons.join(','))}&opener_url=${encodeURIComponent(location.href)}`;

        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };
  
    initializePage();
  
  })();
