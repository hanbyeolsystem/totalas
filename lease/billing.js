// 한별시스템 임대관리 — 추가요금 청구 페이지
'use strict';

// ============================================================
// state
// ============================================================
const billingState = {
  currentBilling: null,   // 계산 결과 또는 로드된 청구
  listSearch: '',
  listFilter: 'all',
  tab: 'compose',
};

// ============================================================
// 부트 — auth + supabase 로드 후 실행
// ============================================================
document.addEventListener('totalas:ready', async () => {
  if (!document.querySelector('.billing-page')) return;
  try {
    showLoading('데이터 로드 중…');
    await store.load();
  } catch (e) {
    console.error('store.load 실패:', e);
    alert('데이터 로드 실패: ' + (e.message || e));
    return;
  } finally { hideLoading(); }

  bindUI();
  refreshCustomerDatalist();
  renderBillingList();
  // 기본값: 시작 = 지난달, 종료 = 지난달
  const today = new Date();
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const ym = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  $('#period-start').value = ym(lastMonth);
  $('#period-end').value   = ym(lastMonth);
  $('#issued-at').value    = today.toISOString().slice(0, 10);
});

// ============================================================
// 이벤트 바인딩
// ============================================================
function bindUI() {
  // 탭
  document.querySelectorAll('.billing-tabs button').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });

  $('#btn-calc').addEventListener('click', onCalc);
  $('#btn-reset').addEventListener('click', resetForm);
  $('#btn-save').addEventListener('click', onSave);
  $('#btn-preview').addEventListener('click', () => switchTab('print'));
  $('#btn-print').addEventListener('click', () => { switchTab('print'); setTimeout(() => window.print(), 200); });
  $('#btn-do-print').addEventListener('click', () => window.print());
  $('#btn-back').addEventListener('click', () => switchTab('compose'));

  $('#list-search').addEventListener('input', e => { billingState.listSearch = e.target.value.toLowerCase().trim(); renderBillingList(); });
  $('#list-filter').addEventListener('change', e => { billingState.listFilter = e.target.value; renderBillingList(); });
}

function switchTab(name) {
  billingState.tab = name;
  document.querySelectorAll('.billing-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name && name !== 'print'));
  $('#tab-compose').style.display = name === 'compose' ? '' : 'none';
  $('#tab-list').style.display    = name === 'list'    ? '' : 'none';
  $('#tab-print').style.display   = name === 'print'   ? '' : 'none';
  if (name === 'print') renderPrintArea();
  if (name === 'list')  renderBillingList();
}

function resetForm() {
  $('#customer-search').value = '';
  $('#calc-result').style.display = 'none';
  billingState.currentBilling = null;
}

// ============================================================
// 거래처 datalist
// ============================================================
function refreshCustomerDatalist() {
  const dl = $('#customer-list');
  dl.innerHTML = '';
  const customers = Object.values(store.data.customers || {})
    .sort((a, b) => (a.company || '').localeCompare(b.company || '', 'ko'));
  for (const c of customers) {
    const opt = document.createElement('option');
    opt.value = c.company;
    opt.dataset.id = c.id;
    dl.appendChild(opt);
  }
}

function findCustomerByCompany(name) {
  if (!name) return null;
  const n = name.trim();
  return Object.values(store.data.customers || {}).find(c => (c.company || '').trim() === n) || null;
}

// ============================================================
// 계산 — 핵심 공식
//   월카운터  = 당월COUNT - 전월COUNT
//   추가카운터 = 월카운터 - 기본매수    (음수면 무료 범위 내)
//   추가사용료 = max(0, 추가카운터) × 추가단가
// ============================================================
function enumerateMonths(startYm, endYm) {
  // 'YYYY-MM' 인덱스. start ≤ end 가정
  const [sy, sm] = startYm.split('-').map(Number);
  const [ey, em] = endYm.split('-').map(Number);
  const out = [];
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
function prevYm(ym) {
  const [y, m] = ym.split('-').map(Number);
  const pm = m - 1;
  return pm <= 0 ? `${y - 1}-12` : `${y}-${String(pm).padStart(2, '0')}`;
}

/** 거래처에 매칭된 시리얼 목록 (printer rows). */
function getCustomerPrinters(customerId) {
  return Object.values(store.data.printers || {})
    .filter(p => p.customer_id === customerId || p.matched_customer_id === customerId)
    .sort((a, b) => (a.serial || '').localeCompare(b.serial || ''));
}

function getCounter(period, serial) {
  return (store.data.counters?.[period]?.[serial]) || null;
}

/** 청구 한 건 계산. */
function computeBilling(customer, startYm, endYm) {
  const months = enumerateMonths(startYm, endYm);
  if (!months.length) throw new Error('기간이 잘못되었습니다');
  const printers = getCustomerPrinters(customer.id);

  // 단가/무료매수 — 거래처 1정책
  const policy = {
    base_fee: customer.base_fee || 0,
    bw_free:  customer.bw_free  || 0,
    bw_rate:  customer.bw_rate  || 0,
    co_free:  customer.co_free  || 0,
    co_rate:  customer.co_rate  || 0,
  };
  const unlimitedBw = policy.bw_free >= 999999;
  const unlimitedCo = policy.co_free >= 999999;

  const serials = [];
  let totalBwFee = 0;
  let totalCoFee = 0;

  for (const p of printers) {
    const rows = [];
    for (let i = 0; i < months.length; i++) {
      const curYm = months[i];
      const prevYmStr = prevYm(curYm);
      const prev = getCounter(prevYmStr, p.serial);
      const curr = getCounter(curYm,     p.serial);

      const bwPrev = prev?.bw ?? null;
      const bwCurr = curr?.bw ?? null;
      const coPrev = prev?.co ?? null;
      const coCurr = curr?.co ?? null;

      const bwMonth = (bwPrev != null && bwCurr != null) ? Math.max(0, bwCurr - bwPrev) : null;
      const coMonth = (coPrev != null && coCurr != null) ? Math.max(0, coCurr - coPrev) : null;

      const bwExtra = (bwMonth != null && !unlimitedBw) ? (bwMonth - policy.bw_free) : (unlimitedBw ? -Infinity : null);
      const coExtra = (coMonth != null && !unlimitedCo) ? (coMonth - policy.co_free) : (unlimitedCo ? -Infinity : null);

      const bwFee = (bwExtra != null && bwExtra > 0 && policy.bw_rate > 0) ? bwExtra * policy.bw_rate : 0;
      const coFee = (coExtra != null && coExtra > 0 && policy.co_rate > 0) ? coExtra * policy.co_rate : 0;

      rows.push({
        period: curYm,
        bw: { prev: bwPrev, curr: bwCurr, month: bwMonth, extra: bwExtra, fee: bwFee, missing: bwPrev == null || bwCurr == null },
        co: { prev: coPrev, curr: coCurr, month: coMonth, extra: coExtra, fee: coFee, missing: coPrev == null || coCurr == null },
      });
      totalBwFee += bwFee;
      totalCoFee += coFee;
    }
    serials.push({
      serial: p.serial,
      model:  p.model || '',
      asset_name: p.asset_name || '',
      rows,
    });
  }

  const totalAmount = policy.base_fee + totalBwFee + totalCoFee;

  return {
    customer_id: customer.id,
    customer_snapshot: {
      company: customer.company, ceo: customer.ceo, address: customer.address,
      phone: customer.phone, biz_no: customer.biz_no, biz_type: customer.biz_type, biz_item: customer.biz_item,
    },
    period_start: startYm,
    period_end:   endYm,
    months,
    ...policy,
    details: { serials },
    total_bw_fee: totalBwFee,
    total_co_fee: totalCoFee,
    total_amount: totalAmount,
  };
}

// ============================================================
// 계산 실행
// ============================================================
function onCalc() {
  const company = $('#customer-search').value;
  const customer = findCustomerByCompany(company);
  if (!customer) { alert('거래처를 선택해주세요'); $('#customer-search').focus(); return; }
  const ps = $('#period-start').value;
  const pe = $('#period-end').value;
  if (!ps || !pe) { alert('기간을 입력해주세요'); return; }
  if (ps > pe) { alert('시작이 종료보다 늦습니다'); return; }

  let b;
  try { b = computeBilling(customer, ps, pe); }
  catch (e) { alert('계산 실패: ' + e.message); return; }

  billingState.currentBilling = b;
  renderCalcResult(b);
}

// ============================================================
// 계산 결과 렌더링
// ============================================================
function renderCalcResult(b) {
  const cs = b.customer_snapshot;
  $('#customer-info').innerHTML = `
    <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:10px;">
      <div>
        <h3 style="margin:0; font-size:16px;">${escapeHtml(cs.company)}</h3>
        <div class="muted-small">${escapeHtml(cs.address || '')}</div>
      </div>
      <div class="muted-small">
        정책: 흑 ${fmtFree(b.bw_free)} / ${fmtKR(b.bw_rate)}원 · 컬 ${fmtFree(b.co_free)} / ${fmtKR(b.co_rate)}원
        · 기본료 ${fmtKR(b.base_fee)}원
      </div>
    </div>
  `;

  const sArea = $('#serials-area');
  sArea.innerHTML = '';

  if (!b.details.serials.length) {
    sArea.innerHTML = '<div class="muted" style="padding:18px; text-align:center;">이 거래처에 매칭된 시리얼이 없습니다. 임대카운터 페이지에서 시리얼을 거래처에 연결해주세요.</div>';
  }

  for (const s of b.details.serials) {
    const div = document.createElement('div');
    div.className = 'serial-block';

    let bwSum = 0, coSum = 0;
    const rows = s.rows.map(r => {
      bwSum += r.bw.fee;
      coSum += r.co.fee;
      const bwExtraStr = r.bw.missing ? '<span class="muted">—</span>'
                          : (r.bw.extra === -Infinity ? '<span class="neg">무제한</span>'
                          : r.bw.extra > 0 ? `<span class="pos">+${fmtKR(r.bw.extra)}</span>` : `<span class="neg">${fmtKR(r.bw.extra)}</span>`);
      const coExtraStr = r.co.missing ? '<span class="muted">—</span>'
                          : (r.co.extra === -Infinity ? '<span class="neg">무제한</span>'
                          : r.co.extra > 0 ? `<span class="pos">+${fmtKR(r.co.extra)}</span>` : `<span class="neg">${fmtKR(r.co.extra)}</span>`);
      return `
        <tr>
          <td class="tl">${r.period}</td>
          <td>${r.bw.prev ?? '—'}</td>
          <td>${r.bw.curr ?? '—'}</td>
          <td>${r.bw.month ?? '—'}</td>
          <td>${bwExtraStr}</td>
          <td>${r.bw.fee ? fmtKR(r.bw.fee) : '0'}</td>
          <td>${r.co.prev ?? '—'}</td>
          <td>${r.co.curr ?? '—'}</td>
          <td>${r.co.month ?? '—'}</td>
          <td>${coExtraStr}</td>
          <td>${r.co.fee ? fmtKR(r.co.fee) : '0'}</td>
        </tr>`;
    }).join('');

    div.innerHTML = `
      <h4>🖨 ${escapeHtml(s.serial)} ${s.model ? '· ' + escapeHtml(s.model) : ''} ${s.asset_name ? '· ' + escapeHtml(s.asset_name) : ''}</h4>
      <div style="overflow-x:auto;">
        <table class="calc-table">
          <thead>
            <tr class="section-header">
              <th class="tl" rowspan="2">기간</th>
              <th colspan="5" style="text-align:center;">흑백</th>
              <th colspan="5" style="text-align:center;">컬러</th>
            </tr>
            <tr class="section-bw">
              <th>전월</th><th>당월</th><th>월카운터</th><th>추가</th><th>추가료</th>
              <th>전월</th><th>당월</th><th>월카운터</th><th>추가</th><th>추가료</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr>
              <td class="tl">소계</td>
              <td colspan="4"></td>
              <td>${fmtKR(bwSum)}</td>
              <td colspan="4"></td>
              <td>${fmtKR(coSum)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;
    sArea.appendChild(div);
  }

  $('#sum-base').textContent  = fmtKR(b.base_fee) + '원';
  $('#sum-bw').textContent    = fmtKR(b.total_bw_fee) + '원';
  $('#sum-co').textContent    = fmtKR(b.total_co_fee) + '원';
  $('#sum-total').textContent = fmtKR(b.total_amount) + '원';

  $('#calc-result').style.display = '';
}

// ============================================================
// 저장
// ============================================================
async function onSave() {
  const b = billingState.currentBilling;
  if (!b) { alert('계산 먼저 진행해주세요'); return; }

  const billingNo = store.nextBillingNo();
  const issuedAt = ($('#issued-at').value ? new Date($('#issued-at').value + 'T00:00:00').toISOString() : new Date().toISOString());

  try {
    showLoading('저장 중…');
    const saved = await store.upsertBilling({
      customer_id: b.customer_id,
      billing_no:  billingNo,
      period_start: b.period_start,
      period_end:   b.period_end,
      issued_at: issuedAt,
      base_fee: b.base_fee,
      bw_free:  b.bw_free, bw_rate: b.bw_rate,
      co_free:  b.co_free, co_rate: b.co_rate,
      details:  b.details,
      total_bw_fee: b.total_bw_fee,
      total_co_fee: b.total_co_fee,
      total_amount: b.total_amount,
    });
    billingState.currentBilling = { ...b, ...saved };
    alert(`청구 저장 완료: ${billingNo}`);
    renderBillingList();
  } catch (e) {
    console.error('save 실패:', e);
    alert('저장 실패: ' + (e.message || e));
  } finally { hideLoading(); }
}

// ============================================================
// 청구 이력 목록
// ============================================================
function renderBillingList() {
  const tbody = $('#billing-list-tbody');
  const all = Object.values(store.data.billings || {})
    .sort((a, b) => (b.issued_at || '').localeCompare(a.issued_at || ''));

  const filtered = all.filter(b => {
    if (billingState.listFilter === 'paid'   && !b.paid_at) return false;
    if (billingState.listFilter === 'unpaid' &&  b.paid_at) return false;
    if (!billingState.listSearch) return true;
    const cust = store.data.customers?.[b.customer_id] || {};
    const hay = ((cust.company || '') + ' ' + (b.billing_no || '')).toLowerCase();
    return hay.includes(billingState.listSearch);
  });

  $('#list-count').textContent = `(${filtered.length})`;

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="muted" style="text-align:center; padding:24px;">청구 이력이 없습니다</td></tr>';
    return;
  }
  tbody.innerHTML = filtered.map(b => {
    const cust = store.data.customers?.[b.customer_id] || {};
    const paidCls = b.paid_at ? 'paid' : 'unpaid';
    const paidStr = b.paid_at ? '✓ 입금' : '미입금';
    return `
      <tr class="${paidCls}" data-id="${b.id}">
        <td><b>${escapeHtml(b.billing_no || '—')}</b></td>
        <td>${escapeHtml(cust.company || '(삭제됨)')}</td>
        <td>${b.period_start} ~ ${b.period_end}</td>
        <td>${b.issued_at ? b.issued_at.slice(0, 10) : ''}</td>
        <td class="r">${fmtKR(b.base_fee)}</td>
        <td class="r">${fmtKR((b.total_bw_fee || 0) + (b.total_co_fee || 0))}</td>
        <td class="r"><b>${fmtKR(b.total_amount)}</b></td>
        <td class="status">${paidStr}</td>
        <td style="white-space:nowrap;">
          <button class="btn-ghost" data-act="view"   data-id="${b.id}" style="padding:3px 8px; font-size:11.5px; border-radius:4px; border:1px solid var(--border);">미리보기</button>
          <button class="btn-ghost" data-act="paid"   data-id="${b.id}" style="padding:3px 8px; font-size:11.5px; border-radius:4px; border:1px solid var(--border);">${b.paid_at ? '↺' : '✓'}</button>
          <button class="btn-ghost" data-act="delete" data-id="${b.id}" style="padding:3px 8px; font-size:11.5px; border-radius:4px; border:1px solid var(--border); color:#dc2626;">삭제</button>
        </td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if      (act === 'view')   onViewBilling(id);
      else if (act === 'paid')   onTogglePaid(id);
      else if (act === 'delete') onDeleteBilling(id);
    });
  });
}

function onViewBilling(id) {
  const b = store.data.billings[id];
  if (!b) return;
  // 저장된 청구를 currentBilling 으로 끌어와서 인쇄 영역 렌더
  const cust = store.data.customers?.[b.customer_id] || {};
  billingState.currentBilling = {
    ...b,
    customer_snapshot: {
      company: cust.company, ceo: cust.ceo, address: cust.address,
      phone: cust.phone, biz_no: cust.biz_no, biz_type: cust.biz_type, biz_item: cust.biz_item,
    },
    months: enumerateMonths(b.period_start, b.period_end),
  };
  switchTab('print');
}

async function onTogglePaid(id) {
  const b = store.data.billings[id];
  if (!b) return;
  try {
    if (b.paid_at) {
      if (!confirm('입금 표시를 해제할까요?')) return;
      await store.markBillingUnpaid(id);
    } else {
      await store.markBillingPaid(id);
    }
    renderBillingList();
  } catch (e) { alert('처리 실패: ' + (e.message || e)); }
}

async function onDeleteBilling(id) {
  const b = store.data.billings[id];
  if (!b) return;
  if (!confirm(`청구 ${b.billing_no || ''} 를 삭제할까요? 되돌릴 수 없습니다.`)) return;
  try {
    await store.deleteBilling(id);
    renderBillingList();
  } catch (e) { alert('삭제 실패: ' + (e.message || e)); }
}

// ============================================================
// 인쇄 영역 렌더 (A4 양식)
// ============================================================
function renderPrintArea() {
  const b = billingState.currentBilling;
  const area = $('#print-area');
  if (!b) { area.innerHTML = '<div class="muted">미리볼 청구가 없습니다.</div>'; return; }
  const cs = b.customer_snapshot || {};
  const issuedDay = (b.issued_at || new Date().toISOString()).slice(0, 10);

  // 시리얼별 월 상세 — 한 표로 통합 (시리얼 컬럼 추가)
  const detailRows = [];
  for (const s of (b.details?.serials || [])) {
    for (const r of s.rows) {
      detailRows.push({ serial: s.serial, model: s.model, ...r });
    }
  }

  const bodyHtml = detailRows.map(r => {
    const bwExtra = r.bw.missing ? '—' : (r.bw.extra === -Infinity ? '∞' : r.bw.extra);
    const coExtra = r.co.missing ? '—' : (r.co.extra === -Infinity ? '∞' : r.co.extra);
    return `
      <tr>
        <td class="tl">${escapeHtml(r.serial)}</td>
        <td class="tl">${r.period}</td>
        <td>${r.bw.prev ?? '—'}</td>
        <td>${r.bw.curr ?? '—'}</td>
        <td>${r.bw.month ?? '—'}</td>
        <td>${bwExtra}</td>
        <td>${r.bw.fee ? fmtKR(r.bw.fee) : '0'}</td>
        <td>${r.co.prev ?? '—'}</td>
        <td>${r.co.curr ?? '—'}</td>
        <td>${r.co.month ?? '—'}</td>
        <td>${coExtra}</td>
        <td>${r.co.fee ? fmtKR(r.co.fee) : '0'}</td>
      </tr>`;
  }).join('') || '<tr><td colspan="12">표시할 카운터가 없습니다</td></tr>';

  area.innerHTML = `
    <h1>청 구 서</h1>
    <div class="print-sub">${escapeHtml(cs.company || '')} · ${b.period_start} ~ ${b.period_end} · 발행일 ${issuedDay}</div>

    <div class="biz-block">
      <div class="col">
        <div style="font-weight:700; margin-bottom:6px;">공급자 (한별시스템)</div>
        <div class="row"><div class="k">회사명</div><div class="v">한별시스템</div></div>
        <div class="row"><div class="k">주소</div><div class="v">대구광역시 달서구 문화회관11안길 22-7 1층</div></div>
        <div class="row"><div class="k">대표</div><div class="v">053-588-7119 · 010-4585-6890</div></div>
      </div>
      <div class="col">
        <div style="font-weight:700; margin-bottom:6px;">공급받는자</div>
        <div class="row"><div class="k">회사명</div><div class="v">${escapeHtml(cs.company || '')}</div></div>
        <div class="row"><div class="k">대표자</div><div class="v">${escapeHtml(cs.ceo || '')}</div></div>
        <div class="row"><div class="k">사업자번호</div><div class="v">${escapeHtml(cs.biz_no || '')}</div></div>
        <div class="row"><div class="k">주소</div><div class="v">${escapeHtml(cs.address || '')}</div></div>
      </div>
    </div>

    <table class="print-tbl">
      <thead>
        <tr><th class="tl">품 목</th><th>수량</th><th>단가</th><th>금액</th></tr>
      </thead>
      <tbody>
        <tr>
          <td class="tl">유지보수 및 임대료</td>
          <td>1</td>
          <td>${fmtKR(b.base_fee)}</td>
          <td>${fmtKR(b.base_fee)}</td>
        </tr>
        <tr>
          <td class="tl">흑백 추가카운터료 (${fmtFree(b.bw_free)} 초과, ${fmtKR(b.bw_rate)}원/매)</td>
          <td>—</td><td>—</td>
          <td>${fmtKR(b.total_bw_fee)}</td>
        </tr>
        <tr>
          <td class="tl">컬러 추가카운터료 (${fmtFree(b.co_free)} 초과, ${fmtKR(b.co_rate)}원/매)</td>
          <td>—</td><td>—</td>
          <td>${fmtKR(b.total_co_fee)}</td>
        </tr>
      </tbody>
    </table>

    <table class="print-tbl">
      <thead>
        <tr>
          <th class="tl" rowspan="2">시리얼</th>
          <th class="tl" rowspan="2">월</th>
          <th colspan="5" style="text-align:center;">흑백</th>
          <th colspan="5" style="text-align:center;">컬러</th>
        </tr>
        <tr>
          <th>전월</th><th>당월</th><th>월카운터</th><th>추가</th><th>추가료</th>
          <th>전월</th><th>당월</th><th>월카운터</th><th>추가</th><th>추가료</th>
        </tr>
      </thead>
      <tbody>${bodyHtml}</tbody>
    </table>

    <div class="grand-total">
      <div class="lbl">총 청구금액</div>
      <div class="val">${fmtKR(b.total_amount)} 원</div>
    </div>

    <div class="foot-bank">
      입금계좌: (입금계좌를 거래처에 안내한 계좌로 기재) · 청구번호: ${escapeHtml(b.billing_no || '(미저장)')}
    </div>
  `;
}

// ============================================================
// 유틸 (app.js 의 것과 부분 중복 OK)
// ============================================================
function fmtKR(n) {
  if (n == null || isNaN(n)) return '0';
  return Number(n).toLocaleString('ko-KR');
}
function fmtFree(n) {
  if (n == null) return '0';
  if (n >= 999999) return '무제한';
  return fmtKR(n) + '매';
}
