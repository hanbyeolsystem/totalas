// 한별시스템 임대관리 — 임대홈 대시보드
// 거래처 전체 + 수익 구조 한눈에
'use strict';

const homeState = { search: '', sort: 'fee', activeOnly: false };

document.addEventListener('totalas:ready', async () => {
  if (!document.querySelector('.home-page')) return;
  try {
    if (typeof showLoading === 'function') showLoading('임대 현황 로드 중…');
    await store.load();
  } catch (err) {
    console.error('store.load() 실패:', err);
    alert('데이터 로드 실패: ' + (err.message || err));
    return;
  } finally {
    if (typeof hideLoading === 'function') hideLoading();
  }
  initHome();
});

function initHome() {
  document.getElementById('home-search').addEventListener('input', e => {
    homeState.search = e.target.value.toLowerCase().trim();
    renderHomeTable();
  });
  document.getElementById('home-sort').addEventListener('change', e => {
    homeState.sort = e.target.value;
    renderHomeTable();
  });
  document.getElementById('home-only-active').addEventListener('change', e => {
    homeState.activeOnly = e.target.checked;
    renderHomeTable();
  });

  renderHomeStats();
  renderHomeTable();
  renderHomeRevenue();
}

function getLatestPeriod() {
  const periods = Object.keys(store.data.counters || {}).sort();
  return periods[periods.length - 1] || '';
}

/** 거래처별 수익률 계산 — app.js renderTabProfit 와 동일 공식.
 *  대량 호출 대비 인덱스 한 번만 만들고 재사용. */
let _profitIndex = null;
function buildProfitIndex() {
  const idx = { contracts: {}, billings: {}, costs: {}, visits: {}, supplies: {} };
  for (const ct of Object.values(store.data.contracts || {})) {
    if (!ct.customer_id) continue;
    (idx.contracts[ct.customer_id] = idx.contracts[ct.customer_id] || []).push(ct);
  }
  for (const b of Object.values(store.data.billings || {})) {
    (idx.billings[b.customer_id] = idx.billings[b.customer_id] || []).push(b);
  }
  for (const r of Object.values(store.data.productCosts || {})) {
    (idx.costs[r.customer_id] = idx.costs[r.customer_id] || []).push(r);
  }
  for (const r of Object.values(store.data.serviceVisits || {})) {
    (idx.visits[r.customer_id] = idx.visits[r.customer_id] || []).push(r);
  }
  for (const r of Object.values(store.data.supplies || {})) {
    (idx.supplies[r.customer_id] = idx.supplies[r.customer_id] || []).push(r);
  }
  return idx;
}

function computeCustomerProfit(c, idx) {
  // 임대 시작일
  let startDate = c.contract_start || c.created_at;
  const cts = (idx.contracts[c.id] || []);
  for (const ct of cts) {
    if (ct.contract_date && (!startDate || ct.contract_date < startDate)) startDate = ct.contract_date;
  }
  const start = startDate ? new Date(startDate) : new Date();
  const today = new Date();
  const months = Math.max(1,
    (today.getFullYear() - start.getFullYear()) * 12 + (today.getMonth() - start.getMonth()) + 1);

  const baseFee = c.base_fee || 0;
  const billings = idx.billings[c.id] || [];
  const totalExtra = billings.reduce((s, b) => s + (b.total_bw_fee || 0) + (b.total_co_fee || 0), 0);
  const monthlyExtraAvg = totalExtra / months;
  const monthlyRevenue = baseFee + monthlyExtraAvg;

  const costs = idx.costs[c.id] || [];
  const monthlyAmort = costs.reduce((s, r) => s + (r.amortization_months > 0 ? (r.purchase_price / r.amortization_months) : 0), 0);
  const visits = idx.visits[c.id] || [];
  const monthlyVisit = visits.reduce((s, r) => s + (r.travel_cost || 0) + (r.labor_cost || 0), 0) / months;
  const sups = idx.supplies[c.id] || [];
  const monthlySupply = sups.reduce((s, r) => s + (r.total_cost || 0), 0) / months;
  const monthlyCost = monthlyAmort + monthlyVisit + monthlySupply;

  const monthlyProfit = monthlyRevenue - monthlyCost;
  const profitRate = monthlyRevenue > 0 ? (monthlyProfit / monthlyRevenue * 100) : 0;

  return { months, monthlyRevenue, monthlyCost, monthlyProfit, profitRate };
}

function getLatestCountersForCustomer(custId, latestPeriod) {
  if (!latestPeriod) return { bw: 0, co: 0 };
  const cust = store.data.customers[custId];
  if (!cust) return { bw: 0, co: 0 };
  const periodData = store.data.counters[latestPeriod] || {};
  let bw = 0, co = 0;
  for (const s of (cust.serials || [])) {
    const d = periodData[s];
    if (d) {
      if (d.bw != null) bw += d.bw;
      if (d.co != null) co += d.co;
    }
  }
  return { bw, co };
}

function renderHomeStats() {
  const customers = Object.values(store.data.customers || {});
  const printers = Object.values(store.data.printers || {});
  const total = customers.length;
  const active = customers.filter(c => (c.serials || []).length > 0).length;
  const matched = printers.filter(p => p.matched_customer_id || p.customer_id).length;
  const unmatched = printers.length - matched;
  const totalRev = customers.reduce((s, c) => s + (c.base_fee || 0), 0);

  const latest = getLatestPeriod();
  const latestCount = latest ? Object.keys(store.data.counters[latest] || {}).length : 0;

  document.getElementById('s-cust').innerHTML = `${active}<span class="unit">곳</span>`;
  document.getElementById('s-cust-sub').textContent = `시리얼 보유 거래처 · 전체 ${total}곳`;

  document.getElementById('s-serial').innerHTML = `${matched}<span class="unit">대</span>`;
  document.getElementById('s-serial-sub').textContent = `매칭 ${matched} / 미매칭 ${unmatched}`;

  document.getElementById('s-rev').innerHTML = `${totalRev.toLocaleString()}<span class="unit">원</span>`;
  document.getElementById('s-rev-sub').textContent = '월 기본료 합계 (추가요금 미포함)';

  document.getElementById('s-latest').innerHTML = `${latestCount}<span class="unit">대</span>`;
  document.getElementById('s-latest-sub').textContent = latest ? `${latest} 카운터 보유` : '카운터 데이터 없음';

  // 수익률 — 원가/출장/소모품 데이터가 1개라도 있는 거래처 대상
  _profitIndex = buildProfitIndex();
  const haveAny = id => (_profitIndex.costs[id]?.length || _profitIndex.visits[id]?.length || _profitIndex.supplies[id]?.length);
  const profitable = customers
    .filter(c => haveAny(c.id))
    .map(c => computeCustomerProfit(c, _profitIndex));

  const rateEl = document.getElementById('s-profit-rate');
  const rateSub = document.getElementById('s-profit-rate-sub');
  const lossEl = document.getElementById('s-loss');
  const lossSub = document.getElementById('s-loss-sub');
  if (!profitable.length) {
    rateEl.textContent = '—';
    rateSub.textContent = '원가/출장/소모품 데이터 미입력';
    lossEl.textContent = '—';
    lossSub.textContent = '데이터 입력 시 자동 표시';
    return;
  }
  const avgRate = profitable.reduce((s, p) => s + p.profitRate, 0) / profitable.length;
  const losses = profitable.filter(p => p.monthlyProfit < 0).length;
  const rateColor = avgRate >= 30 ? '#16a34a' : avgRate >= 10 ? '#ca8a04' : '#dc2626';
  rateEl.innerHTML = `<span style="color:${rateColor};">${avgRate.toFixed(1)}<span class="unit">%</span></span>`;
  rateSub.textContent = `원가 입력된 ${profitable.length}곳 평균`;
  lossEl.innerHTML = `${losses}<span class="unit">곳</span>`;
  lossSub.textContent = losses ? `월 순익 < 0 인 거래처` : '🎉 적자 거래처 없음';
}

function renderHomeTable() {
  let custs = Object.values(store.data.customers || {});
  if (homeState.activeOnly) custs = custs.filter(c => (c.serials || []).length > 0);
  if (homeState.search) {
    const f = homeState.search;
    custs = custs.filter(c =>
      [c.company, c.ceo, c.phone, c.address].some(v => (v || '').toLowerCase().includes(f))
    );
  }

  // 수익률 계산 (모든 거래처)
  if (!_profitIndex) _profitIndex = buildProfitIndex();
  const profitMap = {};
  for (const c of custs) profitMap[c.id] = computeCustomerProfit(c, _profitIndex);

  if (homeState.sort === 'fee') {
    custs.sort((a, b) => (b.base_fee || 0) - (a.base_fee || 0));
  } else if (homeState.sort === 'profit') {
    custs.sort((a, b) => profitMap[b.id].monthlyProfit - profitMap[a.id].monthlyProfit);
  } else if (homeState.sort === 'rate-desc') {
    custs.sort((a, b) => profitMap[b.id].profitRate - profitMap[a.id].profitRate);
  } else if (homeState.sort === 'rate-asc') {
    // 적자 위로 — 단, 데이터 없는 거래처는 뒤로
    custs.sort((a, b) => {
      const ha = (profitMap[a.id].monthlyCost > 0);
      const hb = (profitMap[b.id].monthlyCost > 0);
      if (ha && !hb) return -1;
      if (!ha && hb) return 1;
      return profitMap[a.id].profitRate - profitMap[b.id].profitRate;
    });
  } else if (homeState.sort === 'serials') {
    custs.sort((a, b) => ((b.serials || []).length) - ((a.serials || []).length));
  } else if (homeState.sort === 'recent') {
    custs.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  } else {
    custs.sort((a, b) => (a.company || '').localeCompare(b.company || '', 'ko'));
  }

  document.getElementById('cust-table-count').textContent = `(${custs.length}곳)`;

  const latest = getLatestPeriod();
  const tbody = document.getElementById('home-cust-tbody');
  if (custs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="padding:20px; text-align:center; color:var(--muted);">조건에 맞는 거래처가 없습니다.</td></tr>';
    return;
  }

  tbody.innerHTML = custs.map(c => {
    const cnt = getLatestCountersForCustomer(c.id, latest);
    const fee = c.base_fee || 0;
    const sCnt = (c.serials || []).length;
    const p = profitMap[c.id];
    // 원가/출장/소모품 데이터 없으면 수익률 정보 표시 안함
    const hasCostData = p.monthlyCost > 0;
    const profit = hasCostData ? p.monthlyProfit : null;
    const rate   = hasCostData ? p.profitRate   : null;
    const profitColor = profit == null ? 'color:var(--muted);' : profit >= 0 ? 'color:#16a34a;' : 'color:#dc2626;';
    const rateColor   = rate == null ? 'color:var(--muted);'
                       : rate >= 30 ? 'color:#16a34a; font-weight:600;'
                       : rate >= 10 ? 'color:#ca8a04;'
                       : 'color:#dc2626; font-weight:600;';
    return `
      <tr style="border-bottom:1px solid var(--border);">
        <td style="padding:8px 10px;"><a href="customers.html" style="color:var(--primary); text-decoration:none;">${escapeHtml(c.company || '(이름없음)')}</a></td>
        <td style="padding:8px 10px;">${escapeHtml(c.ceo || '—')}</td>
        <td style="padding:8px 10px; text-align:right; font-variant-numeric:tabular-nums; ${fee ? 'color:var(--primary); font-weight:500;' : 'color:var(--muted);'}">${fee ? fee.toLocaleString() : '—'}</td>
        <td style="padding:8px 10px; text-align:right; font-variant-numeric:tabular-nums; ${profitColor}">${profit == null ? '—' : Math.round(profit).toLocaleString()}</td>
        <td style="padding:8px 10px; text-align:right; ${rateColor}">${rate == null ? '—' : rate.toFixed(1) + '%'}</td>
        <td style="padding:8px 10px; text-align:right; ${sCnt ? '' : 'color:var(--muted);'}">${sCnt || '—'}</td>
        <td style="padding:8px 10px; text-align:right; font-variant-numeric:tabular-nums; ${cnt.bw ? '' : 'color:var(--muted);'}">${cnt.bw ? cnt.bw.toLocaleString() : '—'}</td>
        <td style="padding:8px 10px; text-align:right; font-variant-numeric:tabular-nums; ${cnt.co ? '' : 'color:var(--muted);'}">${cnt.co ? cnt.co.toLocaleString() : '—'}</td>
      </tr>
    `;
  }).join('');
}

function renderHomeRevenue() {
  const customers = Object.values(store.data.customers || {});

  // 기본료 구간 분포
  const bins = [
    { label: '0원',    min: 0,      max: 0,         count: 0, color: '#94a3b8' },
    { label: '~10만',  min: 1,      max: 99999,     count: 0, color: '#60a5fa' },
    { label: '10~30만',min: 100000, max: 299999,    count: 0, color: '#3b82f6' },
    { label: '30만+',  min: 300000, max: Infinity,  count: 0, color: '#1d4ed8' },
  ];
  for (const c of customers) {
    const v = c.base_fee || 0;
    for (const b of bins) {
      if (v >= b.min && v <= b.max) { b.count++; break; }
    }
  }
  const maxBin = Math.max(...bins.map(b => b.count), 1);
  document.getElementById('home-rev-bins').innerHTML = bins.map(b => `
    <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px; font-size:12px;">
      <div style="width:64px; color:var(--muted); flex-shrink:0;">${b.label}</div>
      <div style="flex:1; background:#f1f5f9; border-radius:4px; height:18px; overflow:hidden; min-width:60px;">
        <div style="background:${b.color}; height:100%; width:${(b.count / maxBin * 100).toFixed(1)}%; transition:width .3s;"></div>
      </div>
      <div style="width:48px; text-align:right; font-variant-numeric:tabular-nums; flex-shrink:0;">${b.count}곳</div>
    </div>
  `).join('');

  // 기본료 Top 10
  const top = customers.filter(c => (c.base_fee || 0) > 0)
    .sort((a, b) => (b.base_fee || 0) - (a.base_fee || 0))
    .slice(0, 10);
  const topEl = document.getElementById('home-rev-top');
  if (top.length === 0) {
    topEl.innerHTML = '<div class="muted-small">기본료 등록된 거래처 없음</div>';
    return;
  }
  const maxFee = top[0].base_fee;
  topEl.innerHTML = top.map(c => `
    <div style="display:flex; align-items:center; gap:8px; margin-bottom:5px; font-size:12px;">
      <div style="width:100px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex-shrink:0;" title="${escapeHtml(c.company)}">${escapeHtml(c.company)}</div>
      <div style="flex:1; background:#f1f5f9; border-radius:4px; height:14px; overflow:hidden; min-width:50px;">
        <div style="background:linear-gradient(90deg, #3b82f6, #1d4ed8); height:100%; width:${(c.base_fee / maxFee * 100).toFixed(1)}%;"></div>
      </div>
      <div style="width:72px; text-align:right; font-variant-numeric:tabular-nums; color:var(--primary); flex-shrink:0;">${c.base_fee.toLocaleString()}</div>
    </div>
  `).join('');
}
