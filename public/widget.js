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
            // 쿠폰 클릭 트래킹
            return `<button
              data-track-click="coupon"
              style="position:absolute;left:${l}%;top:${t}%;width:${w}%;height:${h}%;border:none;cursor:pointer;opacity:0"
              onclick="downloadCoupon('${r.coupon}')"></button>`;
          } else {
            const href = /^https?:\/\//.test(r.href) ? r.href : `https://${r.href}`;
            // URL 클릭 트래킹
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

      // 1-1) 이미지 영역 치환 (전체 body가 아니라, placeholder 요소만)
      const imagesContainer = document.getElementById('widget-images-container');
      if (imagesContainer) {
        imagesContainer.innerHTML = imagesHtml;
      } else {
        console.warn('⚠️ widget-images-container가 없습니다.');
      }
      // 1-2) 상품 그리드
      document.querySelectorAll(`ul.main_Grid_${pageId}`).forEach(ul => {
        const cols     = parseInt(ul.dataset.gridSize, 10) || 1;
        const limit    = ul.dataset.count || 300;
        const category = ul.dataset.cate;
        const ulDirect = ul.dataset.directNos || directNos;

        if (ulDirect) {
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
          // 1) 카테고리 상품 리스트
          const prodPromise = fetch(
            `${API_BASE}/api/${mallId}/categories/${category}/products`
            + `?limit=${limit}${couponQSAppend}`
          ).then(r => r.json());
      
          // 2) 같은 카테고리 상품별 클릭수
          const clickPromise = fetch(
            `${API_BASE}/api/${mallId}/analytics/${pageId}/product-performance`
            + `?category_no=${category}`
          ).then(r => r.json());
      
          // 둘 다 받은 뒤에…
          Promise.all([prodPromise, clickPromise])
            .then(([rawProducts, clicksData]) => {
              // 클릭수를 매핑
              const clickMap = clicksData.reduce((m, c) => {
                m[c.productNo] = c.clicks;
                return m;
              }, {});
      
              // renderProducts 가 기대하는 형태로 맞추기
              const products = rawProducts.map(p => ({
                product_no:         p.product_no,
                product_name:       p.product_name,
                summary_description: p.summary_description || '',
                price:              p.price,
                list_image:         p.list_image,
                sale_price:         p.sale_price    || null,
                benefit_price:      p.benefit_price || null,
                benefit_percentage: p.benefit_percentage || null,
                clicks:             clickMap[p.product_no] || 0    // 여기!
              }));
      
              renderProducts(ul, products, cols);
            })
            .catch(err => console.error('PRODUCT GRID ERROR', err));
        }
      });
    })
    .catch(err => console.error('EVENT LOAD ERROR', err));

  // ─── 제품 목록 렌더링 헬퍼 ───────────────────────────────────────
  function renderProducts(ul, products, cols) {
    ul.style.display = 'grid';
    ul.style.gridTemplateColumns = `repeat(${cols},1fr)`;
    ul.style.gap = '20px';
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
          <a href="/product/detail.html?product_no=${p.product_no}" class="prd_link" style="text-decoration:none;color:inherit;" 
           data-track-click="product" data-product-no="${p.product_no}"  target="_blank" rel="noopener noreferrer" >
            <img src="${p.list_image}" alt="${p.product_name}" style="width:100%;display:block;" />
            <div class="prd_desc" style="font-size:14px;color:#666;padding:4px 0;">${p.summary_description||''}</div>
            <div class="prd_name" style="font-weight:500;padding-bottom:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-overflow:ellipsis;">
              ${p.product_name}
            </div>
          </a>
          <div class="prd_price"${couponText ? ' style="display:none;"' : ''} style="font-size:16px;font-weight:500;">
            ${saleText
              ? `<span class="sale_price">${saleText}</span>
                 ${salePercent>0?`<div class="sale_wrapper" style="display:inline-block;margin-right:4px;">
                                    <span class="sale_percent" style="color:#ff4d4f;">
                                      ${salePercent}%</span>
                                  </div>`:''}`
              : `<span>${priceText}</span>`}
          </div>
          ${couponText?`
            <div class="coupon_wrapper" style="margin-top:4px;">
              <span class="prd_coupon_percent" style="color:#ff4d4f;font-weight:500;margin-right:4px;">
                ${p.benefit_percentage}%</span>
              <span class="prd_coupon" style="font-weight:500;">
                ${couponText}</span>
            </div>`:''}

            
        </li>`;
    }).join('');

    ul.innerHTML = items;
  }

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
