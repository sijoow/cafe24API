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
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
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
  const device = /Android/i.test(ua) ? 'Android'
               : /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
               : 'PC';

  // ─── 트랙 함수 ────────────────────────────────────────────────
  function track(payload) {
    fetch(`${API_BASE}/api/${mallId}/track`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    }).catch(e=>console.error('TRACK ERROR',e));
  }

  // ─── 페이지뷰/재방문 트래킹 ─────────────────────────────────────
  if (shouldTrack()) {
    track({pageId, pageUrl: location.pathname, visitorId, type:'view', device, referrer:document.referrer||'direct', timestamp:new Date().toISOString()});
  } else {
    track({pageId, pageUrl: location.pathname, visitorId, type:'revisit', device, referrer:document.referrer||'direct', timestamp:new Date().toISOString()});
  }

  // ─── 클릭 트래킹 ───────────────────────────────────────────────
  document.body.addEventListener('click', e=>{
    const el = e.target.closest('[data-track-click]');
    if (!el) return;
    const elementType = el.dataset.trackClick;
    const payload = { pageId, pageUrl:location.pathname, visitorId, type:'click', element:elementType, device, referrer:document.referrer||'direct', timestamp:new Date().toISOString() };
    if (elementType==='product' && el.dataset.productNo) payload.productNo = el.dataset.productNo;
    track(payload);
  });

  // ─── 1) 이벤트 데이터 로드 & 이미지 치환 ────────────────────────────
  fetch(`${API_BASE}/api/${mallId}/events/${pageId}`)
    .then(r=>r.json())
    .then(ev=>{
      // 1-1) 이미지 영역
      const imagesHtml = ev.images.map((img,idx)=>{
        const regs = (img.regions||[]).map(r=>{
          const l=(r.xRatio*100).toFixed(2), t=(r.yRatio*100).toFixed(2),
                w=(r.wRatio*100).toFixed(2), h=(r.hRatio*100).toFixed(2);
          if (r.coupon) {
            return `<button data-track-click="coupon"
                      style="position:absolute;left:${l}%;top:${t}%;width:${w}%;height:${h}%;border:none;opacity:0;cursor:pointer;"
                      onclick="downloadCoupon('${r.coupon}')"></button>`;
          } else {
            const href = /^https?:\/\//.test(r.href)?r.href:`https://${r.href}`;
            return `<a data-track-click="url"
                      style="position:absolute;left:${l}%;top:${t}%;width:${w}%;height:${h}%"
                      href="${href}" target="_blank" rel="noreferrer"></a>`;
          }
        }).join('');
        return `<div style="position:relative;margin:0 auto;width:100%;max-width:800px;">
                  <img src="${img.src}"
                       style="max-width:100%;height:auto;display:block;margin:0 auto;"
                       data-img-index="${idx}" />
                  ${regs}
                </div>`;
      }).join('\n');
      const imagesContainer = document.getElementById('evt-images');
      if (imagesContainer) imagesContainer.innerHTML = imagesHtml;
      else console.warn('⚠ evt-images container 없음');

      // 1-2) UL 패널 초기 세팅 (id, 클래스, 숨김, 비로드 표시)
      document.querySelectorAll(`ul.main_Grid_${pageId}`).forEach((ul, idx)=>{
        ul.id = `panel-${idx}`;
        ul.classList.add(`tab-content_${pageId}`);
        if (idx!==0) ul.style.display = 'none';
        ul.dataset.loaded = 'false';
      });

      // 첫 번째 탭은 자동으로 로드
      const first = document.getElementById('panel-0');
      if (first) loadPanel(first);
    })
    .catch(err=>console.error('EVENT LOAD ERROR', err));

  // ─── 패널 로드 함수 (한 번만 실행) ────────────────────────────────
  function loadPanel(ul) {
    if (ul.dataset.loaded==='true') return;
    const cols     = parseInt(ul.dataset.gridSize,10)||1;
    const limit    = ul.dataset.count||300;
    const category = ul.dataset.cate;
    const ulDirect = ul.dataset.directNos||directNos;

    const fetchProducts = ulDirect
      ? Promise.all(
          ulDirect.split(',').map(no=>
            fetch(`${API_BASE}/api/${mallId}/products/${no.trim()}${couponQSStart}`)
              .then(r=>r.json())
          )
        )
      : Promise.all([
          fetch(`${API_BASE}/api/${mallId}/categories/${category}/products?limit=${limit}${couponQSAppend}`)
            .then(r=>r.json()),
          fetch(`${API_BASE}/api/${mallId}/analytics/${pageId}/product-performance?category_no=${category}`)
            .then(r=>r.json())
        ]).then(([raw, clicks]) => {
          const clickMap = clicks.reduce((m,c)=>{ m[c.productNo]=c.clicks; return m },{});
          return raw.map(p=>({ ...p, clicks: clickMap[p.product_no]||0 }));
        });

    fetchProducts
      .then(productsData => {
        renderProducts(ul, productsData, cols);
        ul.dataset.loaded = 'true';
      })
      .catch(err=>console.error('PANEL LOAD ERROR', err));
  }

  // ─── showTab 수정 (guard + lazy load) ─────────────────────────────
  window.showTab = (id, btn) => {
    document.querySelectorAll(`.tab-content_${pageId}`).forEach(el=> el.style.display='none');
    document.querySelectorAll(`.tabs_${pageId} button`).forEach(b=> b.classList.remove('active'));

    const panel = document.getElementById(id);
    if (!panel) {
      console.error(`⚠ 탭 패널 [id="${id}"] 없음`);
      return;
    }
    // 필요 시 해당 패널 로드
    loadPanel(panel);

    panel.style.display = 'block';
    btn.classList.add('active');
  };

  // ─── 나머지 헬퍼들 (renderProducts, CSS, downloadCoupon) ─────────
  function renderProducts(ul, products, cols) {
    ul.style.display = 'grid';
    ul.style.gridTemplateColumns = `repeat(${cols},1fr)`;
    ul.style.gap = '20px';
    ul.style.maxWidth = '800px';
    ul.style.margin = '16px auto';
    const formatKRW = v=>{
      const n = typeof v==='number' ? v : parseFloat(String(v).replace(/,/g,''))||0;
      return `${n.toLocaleString('ko-KR')}원`;
    };
    ul.innerHTML = products.map(p=>{
      const orig = p.price, sale = p.sale_price, coupon = p.benefit_price;
      const saleText = sale!=null?formatKRW(sale):null;
      const couponText = coupon!=null?formatKRW(coupon):null;
      const salePct = saleText?Math.round((orig-sale)/orig*100):0;
      return `<li style="list-style:none;">
        <a href="/product/detail.html?product_no=${p.product_no}" data-track-click="product" data-product-no="${p.product_no}" target="_blank" style="text-decoration:none;color:inherit">
          <img src="${p.list_image}" alt="" style="width:100%;display:block"/>
          <div class="prd_desc">${p.summary_description||''}</div>
          <div class="prd_name">${p.product_name}</div>
        </a>
        <div class="prd_price"${couponText?' style="display:none"':''}>
          ${saleText
            ? `<span class="sale_price">${saleText}</span>${salePct>0?`<span class="sale_percent">${salePct}%</span>`:''}`
            : `<span>${formatKRW(orig)}</span>`}
        </div>
        ${couponText?`<div class="coupon_wrapper"><span class="prd_coupon_percent">${p.benefit_percentage}%</span><span class="prd_coupon">${couponText}</span></div>`:''}
      </li>`;
    }).join('');
  }

  const style = document.createElement('style');
  style.textContent = `
    .prd_desc{font-size:14px;color:#666;margin:4px 0}
    .prd_name{font-weight:500;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .prd_price{font-size:16px;font-weight:500}
    .sale_percent, .prd_coupon_percent{color:#ff4d4f;font-weight:500;margin-left:6px}
    .coupon_wrapper, .sale_wrapper{margin-top:4px;display:flex;align-items:center}
    .tabs_${pageId} { display:grid; gap:8px; max-width:800px; margin:16px auto; grid-template-columns: repeat(${tabCount},1fr) }
    .tabs_${pageId} button { padding:8px; font-size:16px; border:none; background:#f5f5f5; border-radius:4px; cursor:pointer }
    .tabs_${pageId} button.active { background:${activeColor}; color:#fff }
  `;
  document.head.appendChild(style);

  window.downloadCoupon = coupons => {
    (Array.isArray(coupons)?coupons:[coupons]).forEach(cpn=>{
      window.open(
        `/exec/front/newcoupon/IssueDownload?coupon_no=${cpn}&opener_url=${encodeURIComponent(location.href)}`,
        '_blank'
      );
    });
  };

})();
