;(function(){
  // ─── 0) 스크립트 엘리먼트 찾기 & 설정값 가져오기 ─────────────────────────
  let script = document.currentScript;
  if (!script || !script.dataset.pageId) {
    script = Array.from(document.getElementsByTagName('script')).find(s =>
      /widget\.js/.test(s.src) && s.dataset.pageId
    );
  }
  if (!script) {
    console.warn('⚠️ Widget 스크립트를 찾을 수 없습니다.');
    return;
  }
  const API_BASE      = script.dataset.apiBase;
  const pageId        = script.dataset.pageId;
  const mallId        = script.dataset.mallId;      // ← 추가
  const tabCount      = parseInt(script.dataset.tabCount, 10) || 0;
  const activeColor   = script.dataset.activeColor || '#1890ff';
  const couponNos     = script.dataset.couponNos || '';
  const couponQSStart = couponNos ? `?coupon_no=${couponNos}` : '';
  const couponQSAppend= couponNos ? `&coupon_no=${couponNos}` : '';
  const directNos     = script.dataset.directNos || '';

  // ─── visitorId 관리, 트랙 함수 등은 그대로 ──────────────────────────────
  // …(생략)…

  // ─── 페이지뷰/재방문 트래킹 ─────────────────────────────────
  function track(payload) {
    fetch(`${API_BASE}/api/${mallId}/track`, {  // ← 변경: /api/track → /api/{mallId}/track
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(e => console.error('TRACK ERROR', e));
  }

  // ─── 이벤트 데이터 로드 & 이미지/상품 그리드 생성 ────────────────────
  fetch(`${API_BASE}/api/${mallId}/events/${pageId}`)  // ← 변경
    .then(res => res.json())
    .then(ev => {
      // 이미지 처리 생략…

      // ─── 상품 그리드: directNos 우선 → 카테고리 API 호출 ───────────────
      document.querySelectorAll(`ul.main_Grid_${pageId}`).forEach(ul => {
        const cols     = parseInt(ul.dataset.gridSize, 10) || 1;
        const limit    = ul.dataset.count || 300;
        const category = ul.dataset.cate;
        const ulDirect = ul.dataset.directNos || directNos;

        if (ulDirect) {
          const ids = ulDirect.split(',').map(s => s.trim()).filter(Boolean);
          Promise.all(ids.map(no =>
            fetch(`${API_BASE}/api/${mallId}/products/${no}${couponQSStart}`) // ← 변경
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
          fetch(`${API_BASE}/api/${mallId}/categories/${category}/products?limit=${limit}${couponQSAppend}`) // ← 변경
            .then(r => r.json())
            .then(products => renderProducts(ul, products, cols))
            .catch(err => console.error('PRODUCT GRID ERROR', err));
        }
      });
    })
    .catch(err => console.error('EVENT LOAD ERROR', err));


  // ─── 2) CSS 동적 주입 ──────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
  .main_Grid_${pageId}{margin-top:10px}
    /*글자 3줄이상 수정*/
    .main_Grid_${pageId} .prd_name {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    .product_list_widget{padding-top:20px;padding-bottom:20px;}
    /* 전역 grid row 간격 */
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

    /* 쿠폰 퍼센트/금액 스타일 (스코프 적용) */
    .main_Grid_${pageId} img{padding-bottom:10px;}
     .main_Grid_${pageId}{row-gap:50px} 
    .main_Grid_${pageId}{row-gap:50px!important}
    .main_Grid_${pageId} li{color:#000;}
    .main_Grid_${pageId} .prd_desc{padding-bottom:3px;
     font-size:14px;color:#666;
    } 
    .main_Grid_${pageId} .prd_name{padding-bottom:3px;} 
    .main_Grid_${pageId} .prd_price{font-size: 16px;} 
    .main_Grid_${pageId} .prd_coupon{
      float: left;
      font-weight: 500;
    } 
    .main_Grid_${pageId} .prd_coupon_percent{
      float: left;
      color: #ff0000;
      font-size: 16px;
      padding-right:5px;
    } 
    /*즉시 할인율*/

      .main_Grid_${pageId} .sale_price{
        float: left;
        font-weight: 500;
      } 
      .main_Grid_${pageId} .sale_percent{
        float: left;
        color: #ff0000;
        font-size: 16px;
        padding-right:5px;
      } 


    @media (max-width: 400px) {
      .main_Grid_${pageId} {
        width: 95%;
        margin: 0 auto;
        gab:10px!important;
        row-gap:30px!important
      }
      .main_Grid_${pageId} .prd_desc{padding-bottom:5px;
      font-size:12px;color:#666;
      } 
      .main_Grid_${pageId} .prd_name{padding-bottom:5px;} 
      .main_Grid_${pageId} .prd_price{font-size: 15px;} 
      .main_Grid_${pageId} .prd_coupon{
        float: left;
        font-weight: 500;
      } 
     .main_Grid_${pageId} .prd_price{font-size: 15px;} 
      .main_Grid_${pageId} .sale_percent{
        float: left;
        color: #ff0000;
        font-size: 15px;
      } 
    }

  `;
  document.head.appendChild(style);

  // ─── 탭 전환 & 쿠폰 다운로드 헬퍼 ───────────────────────────────────
  window.showTab = (id, btn) => {
    document.querySelectorAll(`.tab-content_${pageId}`).forEach(el => el.style.display = 'none');
    document.querySelectorAll(`.tabs_${pageId} button`).forEach(b => b.classList.remove('active'));
    document.getElementById(id).style.display = 'block';
    btn.classList.add('active');
  };
  window.downloadCoupon = coupon => {
    const url = `/exec/front/newcoupon/IssueDownload?coupon_no=${coupon}`;
    window.location.href = url + `&opener_url=${encodeURIComponent(location.href)}`;
  };

})();
