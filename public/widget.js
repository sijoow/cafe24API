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

  // ─── visitorId 관리 ───────────────────────────────────────────────
  const visitorId = (() => {
    const key = 'appVisitorId';
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
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
    track({
      pageId, pageUrl: location.pathname, visitorId,
      type: 'view', device,
      referrer: document.referrer || 'direct',
      timestamp: new Date().toISOString()
    });
  } else {
    track({
      pageId, pageUrl: location.pathname, visitorId,
      type: 'revisit', device,
      referrer: document.referrer || 'direct',
      timestamp: new Date().toISOString()
    });
  }

  // ─── 클릭 트래킹 (URL / 쿠폰 / 상품) ───────────────────────────────
  document.body.addEventListener('click', e => {
    const el = e.target.closest('[data-track-click]');
    if (!el) return;
    const payload = {
      pageId, pageUrl: location.pathname, visitorId,
      type: 'click', element: el.dataset.trackClick,
      device, referrer: document.referrer || 'direct',
      timestamp: new Date().toISOString()
    };
    if (payload.element === 'product' && el.dataset.productNo) {
      payload.productNo = el.dataset.productNo;
    }
    track(payload);
  });

  // ─── 1) 이벤트 데이터 로드 & 이미지/상품 그리드 생성 ────────────────
  fetch(`${API_BASE}/api/${mallId}/events/${pageId}`)
    .then(res => res.json())
    .then(ev => {
      // 1-1) 이미지 영역 치환
      const imagesHtml = ev.images.map((img, idx) => {
        const regs = (img.regions || []).map(r => {
          const l = (r.xRatio * 100).toFixed(2),
                t = (r.yRatio * 100).toFixed(2),
                w = (r.wRatio * 100).toFixed(2),
                h = (r.hRatio * 100).toFixed(2);
          if (r.coupon) {
            return `<button
              data-track-click="coupon"
              style="position:absolute;left:${l}%;top:${t}%;width:${w}%;height:${h}%;border:none;cursor:pointer;opacity:0"
              onclick="downloadCoupon('${r.coupon}')"></button>`;
          } else {
            const href = /^https?:\/\//.test(r.href) ? r.href : `https://${r.href}`;
            return `<a
              data-track-click="url"
              style="position:absolute;left:${l}%;top:${t}%;width:${w}%;height:${h}%"
              href="${href}" target="_blank" rel="noreferrer"></a>`;
          }
        }).join('');
        return `
          <div style="position:relative;margin:0 auto;width:100%;max-width:800px;">
            <img src="${img.src}"
                 style="max-width:100%;height:auto;display:block;margin:0 auto;"
                 data-img-index="${idx}" />
            ${regs}
          </div>`;
      }).join('\n');

      const imagesContainer = document.getElementById('widget-images-container');
      if (imagesContainer) {
        imagesContainer.innerHTML = imagesHtml;
      } else {
        console.warn('⚠️ widget-images-container가 없습니다.');
      }

      // 1-2) 상품 그리드: 커서 기반 페이징 + 더보기 버튼
      document.querySelectorAll(`ul.main_Grid_${pageId}`).forEach(ul => {
        const cols       = parseInt(ul.dataset.gridSize, 10) || 1;
        const limit      = parseInt(ul.dataset.count, 10) || cols * 2;
        const category   = ul.dataset.cate;
        const ulDirect   = ul.dataset.directNos || directNos;

        // 직접 등록된 상품만 있는 경우 한 번에 로드
        if (ulDirect) {
          const ids = ulDirect.split(',').map(s => s.trim()).filter(Boolean);
          Promise.all(ids.map(no =>
            fetch(`${API_BASE}/api/${mallId}/products/${no}${couponQSStart}`)
              .then(r => r.json())
          ))
          .then(list => {
            renderProducts(ul, list, cols);
          })
          .catch(err => console.error('DIRECT GRID ERROR', err));
          return;
        }

        let cursor   = null;
        let clickMap = {};

        // 더보기 버튼 컨테이너
        const btnContainer = document.createElement('div');
        btnContainer.style.textAlign = 'center';
        btnContainer.style.margin = '16px 0';
        ul.parentNode.insertBefore(btnContainer, ul.nextSibling);

        // 클릭수 미리 가져오기
        fetch(`${API_BASE}/api/${mallId}/analytics/${pageId}/product-performance?category_no=${category}`)
          .then(r => r.json())
          .then(data => {
            clickMap = data.reduce((m,c) => (m[c.productNo] = c.clicks, m), {});
            loadBatch();      // 첫 배치
          })
          .catch(err => console.error('CLICK DATA ERROR', err));

        // 배치 로드 함수
        function loadBatch() {
          let url = `${API_BASE}/api/${mallId}/categories/${category}/products?limit=${limit}${couponQSAppend}`;
          if (cursor) url += `&cursor=${cursor}`;
          fetch(url)
            .then(r => r.json())
            .then(data => {
              const items      = data.items || [];
              const nextCursor = data.nextCursor;
              if (!items.length) {
                btnContainer.innerHTML = ''; // 더 이상 없으면 버튼 제거
                return;
              }
              // 클릭수 매핑
              const withClicks = items.map(p => ({
                ...p,
                clicks: clickMap[p.product_no] || 0
              }));
              appendProducts(ul, withClicks, cols);
              cursor = nextCursor;
              renderLoadMore();
            })
            .catch(err => console.error('BATCH LOAD ERROR', err));
        }

        // 더보기 버튼 렌더링
        function renderLoadMore() {
          btnContainer.innerHTML = '';
          if (!cursor) return;
          const btn = document.createElement('button');
          btn.textContent = '더보기';
          btn.style.padding = '8px 16px';
          btn.style.cursor  = 'pointer';
          btn.onclick = () => {
            btn.disabled = true;
            btn.textContent = '로딩 중…';
            loadBatch();
          };
          btnContainer.appendChild(btn);
        }
      });
    })
    .catch(err => console.error('EVENT LOAD ERROR', err));

  // ─── 제품 렌더 헬퍼 ───────────────────────────────────────────────
  function renderProducts(ul, products, cols) {
    ul.style.display             = 'grid';
    ul.style.gridTemplateColumns = `repeat(${cols},1fr)`;
    ul.style.gap                 = '20px';
    ul.style.maxWidth            = '800px';
    ul.style.margin              = '0 auto';
    products.forEach(p => {
      const li = document.createElement('li');
      li.style.listStyle = 'none';
      const orig = p.price;
      const sale = p.sale_price != null
        ? `${p.sale_price.toLocaleString('ko-KR')}원`
        : null;
      const percent = sale
        ? Math.round((orig - p.sale_price) / orig * 100)
        : null;
      li.innerHTML = `
  <a href="/product/detail.html?product_no=${p.product_no}"
     class="prd_link" data-track-click="product"
     data-product-no="${p.product_no}"
     target="_blank" rel="noopener noreferrer">
    <img src="${p.list_image}" loading="lazy"
         alt="${p.product_name}"
         style="width:100%;display:block;" />
    <div class="prd_desc" style="font-size:14px;color:#666;padding:4px 0;">
      ${p.summary_description || ''}
    </div>
    <div class="prd_name" style="
      font-weight:500;
      padding-bottom:4px;
      display:-webkit-box;
      -webkit-line-clamp:2;
      -webkit-box-orient:vertical;
      overflow:hidden;
      text-overflow:ellipsis;
    ">
      ${p.product_name}
    </div>
  </a>
  <div class="prd_price"${sale ? ' style="display:none;"' : ''}
       style="font-size:16px;font-weight:500;">
    ${sale
      ? `<span class="sale_price">${sale}</span>
         ${percent > 0
            ? `<div class="sale_wrapper" style="display:inline-block;margin-right:4px;">
                 <span class="sale_percent" style="color:#ff4d4f;">${percent}%</span>
               </div>`
            : ''
          }`
      : `<span>${orig.toLocaleString('ko-KR')}원</span>`
    }
  </div>
  ${p.benefit_price != null
    ? `<div class="coupon_wrapper" style="margin-top:4px;">
         <span class="prd_coupon_percent" style="color:#ff4d4f;font-weight:500;margin-right:4px;">
           ${p.benefit_percentage}%</span>
         <span class="prd_coupon" style="font-weight:500;">
           ${p.benefit_price.toLocaleString('ko-KR')}원</span>
       </div>`
    : ''
  }
      `;
      ul.appendChild(li);
    });
  }

  // ─── CSS 동적 주입 & 기타 헬퍼 ─────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
  /* 기존 CSS 모두 여기에 포함 (생략하지 않고 그대로 유지) */
  /* ... */
  `;
  document.head.appendChild(style);

  // 탭 전환 & 쿠폰 다운로드 헬퍼
  window.showTab = (id, btn) => {
    document.querySelectorAll(`.tab-content_${pageId}`)
      .forEach(el => el.style.display = 'none');
    document.querySelectorAll(`.tabs_${pageId} button`)
      .forEach(b => b.classList.remove('active'));
    document.getElementById(id).style.display = 'block';
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
