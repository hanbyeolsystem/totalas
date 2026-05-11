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
  if (homeState.sort === 'fee') {
    custs.sort((a, b) => (b.base_fee || 0) - (a.base_fee || 0));
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
    tbody.innerHTML = '<tr><td colspan="6" style="padding:20px; text-align:center; color:var(--muted);">조건에 맞는 거래처가 없습니다.</td></tr>';
    return;
  }

  tbody.innerHTML = custs.map(c => {
    const cnt = getLatestCountersForCustomer(c.id, latest);
    const fee = c.base_fee || 0;
    const sCnt = (c.serials || []).length;
    return `
      <tr style="border-bottom:1px solid var(--border);">
        <td style="padding:8px 10px;"><a href="customers.html" style="color:var(--primary); text-decoration:none;">${escapeHtml(c.company || '(이름없음)')}</a></td>
        <td style="padding:8px 10px;">${escapeHtml(c.ceo || '—')}</td>
        <td style="padding:8px 10px; text-align:right; font-variant-numeric:tabular-nums; ${fee ? 'color:var(--primary); font-weight:500;' : 'color:var(--muted);'}">${fee ? fee.toLocaleString() : '—'}</td>
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
