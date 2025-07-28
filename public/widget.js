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
  const API_BASE      = script.dataset.apiBase;
  const pageId        = script.dataset.pageId;
  const mallId        = script.dataset.mallId;
  const tabCount      = parseInt(script.dataset.tabCount, 10) || 0;
  const activeColor   = script.dataset.activeColor || '#1890ff';
  const couponNos     = script.dataset.couponNos || '';
  const couponQSStart = couponNos ? `?coupon_no=${couponNos}` : '';
  const couponQSAppend= couponNos ? `&coupon_no=${couponNos}` : '';
  const directNos     = script.dataset.directNos || '';

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
      pageId,
      pageUrl: location.pathname,
      visitorId,
      type: 'view',
      device,
      referrer: document.referrer || 'direct',
      timestamp: new Date().toISOString()
    });
  } else {
    track({
      pageId,
      pageUrl: location.pathname,
      visitorId,
      type: 'revisit',
      device,
      referrer: document.referrer || 'direct',
      timestamp: new Date().toISOString()
    });
  }

  // ─── 클릭 트래킹 (URL / 쿠폰) ─────────────────────────────────────
  document.body.addEventListener('click', e => {
    const el = e.target.closest('[data-track-click]');
    if (!el) return;
  
    const elementType = el.dataset.trackClick; // 'url' | 'coupon' | 'product'
    const payload = {
      pageId,
      pageUrl: location.pathname,
      visitorId,
      type: 'click',
      element: elementType,
      device,
      referrer: document.referrer || 'direct',
      timestamp: new Date().toISOString(),
    };
  
    // ⬇️ 상품 클릭이면 productNo 까지 추가
    if (elementType === 'product') {
      const productNo = el.dataset.productNo;
      if (productNo) payload.productNo = productNo;
    }
  
    track(payload);
  });
// ─── 1-2) 상품 그리드 (lazy load) ───────────────────────────────
fetch(`${API_BASE}/api/${mallId}/events/${pageId}`)
  .then(res => res.json())
  .then(ev => {
    // … 1-1 이미지 렌더링 생략 …

    // 1-2) 상품 그리드: UL 리스트와 탭 버튼을 함께 가져오기
    const uls     = Array.from(document.querySelectorAll(`ul.main_Grid_${pageId}`));
    const buttons = Array.from(document.querySelectorAll(`.tabs_${pageId} button`));

    // (A) 상품 로드 함수: 기존 fetch → renderProducts 로직 통째로 옮김
    function loadProducts(ul) {
      const cols     = parseInt(ul.dataset.gridSize, 10) || 1;
      const limit    = ul.dataset.count || 300;
      const category = ul.dataset.cate;
      const ulDirect = ul.dataset.directNos || directNos;

      if (ulDirect) {
        // 직접 등록 모드
        const ids = ulDirect.split(',').map(s=>s.trim()).filter(Boolean);
        Promise.all(ids.map(no =>
          fetch(`${API_BASE}/api/${mallId}/products/${no}${couponQSStart}`)
            .then(r => r.json())
            .then(p => ({
              product_no:          p.product_no,
              product_name:        p.product_name,
              summary_description: p.summary_description || '',
              price:               p.price,
              list_image:          p.list_image,
              sale_price:          p.sale_price    || null,
              benefit_price:       p.benefit_price || null,
              benefit_percentage:  p.benefit_percentage || null,
            }))
        ))
        .then(products => renderProducts(ul, products, cols))
        .catch(err => console.error('DIRECT GRID ERROR', err));

      } else {
        // 카테고리 모드
        const prodPromise = fetch(
          `${API_BASE}/api/${mallId}/categories/${category}/products`
          + `?limit=${limit}${couponQSAppend}`
        ).then(r => r.json());

        const clickPromise = fetch(
          `${API_BASE}/api/${mallId}/analytics/${pageId}/product-performance`
          + `?category_no=${category}`
        ).then(r => r.json());

        Promise.all([prodPromise, clickPromise])
          .then(([rawProducts, clicksData]) => {
            const clickMap = clicksData.reduce((m, c) => {
              m[c.productNo] = c.clicks;
              return m;
            }, {});

            const products = rawProducts.map(p => ({
              product_no:         p.product_no,
              product_name:       p.product_name,
              summary_description: p.summary_description || '',
              price:              p.price,
              list_image:         p.list_image,
              sale_price:         p.sale_price    || null,
              benefit_price:      p.benefit_price || null,
              benefit_percentage: p.benefit_percentage || null,
              clicks:             clickMap[p.product_no] || 0,
            }));

            renderProducts(ul, products, cols);
          })
          .catch(err => console.error('PRODUCT GRID ERROR', err));
      }
    }

    // 1) 첫 번째 탭만 즉시 로드
    if (uls[0]) {
      loadProducts(uls[0]);
      uls[0].dataset.loaded = '1';
    }

    // 2) 나머지 탭은 버튼 클릭 시 한 번만 로드
    buttons.forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        const ul = uls[idx];
        if (ul && ul.dataset.loaded !== '1') {
          loadProducts(ul);
          ul.dataset.loaded = '1';
        }
        // 기존 탭 전환 함수도 호출
        window.showTab(ul.id, btn);
      });
    });
  })
  .catch(err => console.error('EVENT LOAD ERROR', err));

  // ─── 2) CSS 동적 주입 ─────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
  .main_Grid_${pageId}{margin-top:10px}
  /*글자 2줄 클램프*/
  .main_Grid_${pageId} .prd_name {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .product_list_widget{padding-top:20px;padding-bottom:20px;}
  /* 탭 버튼 스타일 */
  .tabs_${pageId} {
    display: grid;
    gap: 8px;
    max-width: 800px;
    margin: 16px auto;
    grid-template-columns: repeat(${tabCount},1fr);
  }
  .tabs_${pageId} button {
    padding:8px;
    font-size:16px;
    border:none;
    background:#f5f5f5;
    color:#333;
    cursor:pointer;
    border-radius:4px;
    display:-webkit-box;
    -webkit-line-clamp:2;
    -webkit-box-orient:vertical;
    overflow:hidden;
    text-overflow:ellipsis;
  }
  .tabs_${pageId} button.active {
    background-color:${activeColor};
    color:#fff;
  }

  /* 쿠폰/할인 스타일 */
  .main_Grid_${pageId} img { padding-bottom:10px; }
  .main_Grid_${pageId} { row-gap:50px!important; }
  .main_Grid_${pageId} li { color:#000; }
  .main_Grid_${pageId} .prd_desc {
    padding-bottom:3px;
    font-size:14px;
    color:#666;
  }
  .main_Grid_${pageId} .prd_price { font-size:16px; }
  .main_Grid_${pageId} .coupon_wrapper,
  .main_Grid_${pageId} .sale_wrapper {
    margin-top:4px;
    display:flex;
    align-items:center;
  }
  .main_Grid_${pageId} .prd_coupon_percent,
  .main_Grid_${pageId} .sale_percent {
    color:#ff4d4f;
    font-weight:500;
    margin-right:4px;
  }
  .main_Grid_${pageId} .sale_price,
  .main_Grid_${pageId} .prd_coupon {
    font-weight:500;
  }

  @media (max-width: 400px) {
  .tabs_${pageId}{
    width:95%;margin:0 auto;
    font-weight:bold;
  }
    .tabs_${pageId} button{
      font-size:14px;
    }

  tab-content_${pageId} {
    margin-top:10px;
  }
    .main_Grid_${pageId} {
      width:95%;
      margin:0 auto;
      row-gap:30px!important;
    }
    .main_Grid_${pageId} .prd_desc {
      padding-bottom:5px;
      font-size:12px;
    }
    .main_Grid_${pageId} .prd_price {
      font-size:15px;
    }
    .main_Grid_${pageId} .sale_percent,
    .main_Grid_${pageId} .prd_coupon_percent {
      font-size:15px;
    }
  }
  `;
  document.head.appendChild(style);
  // ─── 탭 전환 & 쿠폰 다운로드 헬퍼 ─────────────────────────────────
  window.showTab = (id, btn) => {
    document.querySelectorAll(`.tab-content_${pageId}`).forEach(el => el.style.display = 'none');
    document.querySelectorAll(`.tabs_${pageId} button`).forEach(b => b.classList.remove('active'));
    document.getElementById(id).style.display = 'block';
    btn.classList.add('active');
  };
  window.downloadCoupon = coupons => {
    const list = Array.isArray(coupons) ? coupons : [coupons];
    list.forEach(cpn => {
      const url = `/exec/front/newcoupon/IssueDownload?coupon_no=${cpn}`;
      // 새 탭으로 열어서 동시에 여러 다운로드를 트리거
      window.open(
        url + `&opener_url=${encodeURIComponent(location.href)}`,
        '_blank'
      );
    });
  };

})();
