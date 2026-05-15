// ===========================================================
// totalas — 임대카운터 (rental-counters)
// 실데이터 Supabase 연동
//  · 월별 BW/컬러/uptime 카운터 입력 (upsert by item_id+ym)
//  · 이전 6개월 평균 대비 이상치 경고
//  · 토너/잉크/필터 잔여 일수 예측
// ===========================================================
'use strict';

// 평균 소모품 수명 (장당) — 카테고리/subtype별 기본값
const TONER_LIFE = {
  laser:    { bw: 12000, color: 8000 },
  printer:  { bw: 10000, color: 6000 }, // generic printer
  inkjet:   { bw: 1500,  color: 1200 },
  복합기:    { bw: 12000, color: 8000 },
};
const FILTER_LIFE_DAYS = 180; // 웰리스 필터 6개월

const supa = window.totalasAuth || (window.supabase && window.TOTALAS
  ? supabase.createClient(window.TOTALAS.URL, window.TOTALAS.PUBLISHABLE, {
      auth: { storageKey: window.TOTALAS.AUTH_KEY, persistSession: true, autoRefreshToken: true }
    })
  : null);

const state = {
  ym: ymOfNow(),
  customerQuery: '',
  onlyMissing: false,
  items: [],            // 자산 + 배정 + 거래처
  curMap: {},           // item_id → 이번달 row
  prevMap: {},          // item_id → 이전월 row
  histMap: {},          // item_id → [ {ym, bw, color, uptime_hours} ... ]  (최근 6개월)
  suppliesMap: {},      // item_id → 최근 supplies row
  itemsEverCounted: new Set(),     // 과거 어느 달이든 카운터 1건 이상 입력된 item_id
  customersEverCounted: new Set(), // 과거 어느 달이든 카운터 입력된 customer_id
  customers: [],
  customerCombined: {}, // cid → boolean (합산 청구 여부 캐시)
  customerPeriod: {},   // cid → 1/3/6/12 (청구 주기 개월)
  drilldown: null,      // { new, entered, missing, anomaly }
  activeDrilldown: null,
  // 거래처별 자산 수 (1대만 가진 거래처는 합산 토글 숨김용)
  itemsPerCustomer: {},
  // 거래처 인라인 확장 (지난 자료 펼침)
  expandedCustomerId: null,
  expansionMonths: 6,                  // 3 / 6 / 12 (sticky)
  expansionRows: null,                 // Map: `${item_id}|${ym}` → {bw, color, uptime_hours}
  expansionLoading: false,
};

// auth.js 의 bootstrap() 이 완료되어 window.currentUser 가 채워질 때까지 대기
if (window.currentUser) {
  init();
} else {
  document.addEventListener('totalas:ready', init, { once: true });
  // 안전망 — 인증이 끝났는데 이벤트를 놓친 경우 대비
  setTimeout(() => {
    if (!state.items.length && window.currentUser) init();
  }, 4000);
}

async function init() {
  if (!supa) {
    toast('Supabase 클라이언트 초기화 실패', true);
    return;
  }
  // 초기 월 셀렉터
  document.getElementById('f-month').value = state.ym;
  updateYearHeader();
  document.getElementById('f-month').addEventListener('change', e => {
    state.ym = e.target.value || ymOfNow();
    updateYearHeader();
    reload();
  });
  document.getElementById('f-customer-search').addEventListener('input', e => {
    state.customerQuery = e.target.value || '';
    render();
  });
  document.getElementById('f-only-missing').addEventListener('change', e => { state.onlyMissing = e.target.checked; render(); });
  document.getElementById('btn-refresh').addEventListener('click', reload);

  // 통계 카드 클릭 → 드릴다운 토글
  document.querySelectorAll('#stats .stat-card').forEach(card => {
    card.addEventListener('click', () => {
      const key = card.dataset.drill;
      if (key) toggleDrilldown(key);
    });
  });
  document.getElementById('btn-drilldown-close').addEventListener('click', () => closeDrilldown());

  initExcelImport();

  await reload();
}

async function reload() {
  setBodyLoading();
  try {
    await Promise.all([loadCustomers(), loadItems(), loadCounters(), loadSupplies()]);
    deriveCustomersEverCounted();
    render();
    updateExcelTargetYm();
    rematchExcelRows();
  } catch (err) {
    console.error(err);
    toast('로드 실패: ' + (err.message || err), true);
    document.getElementById('grid-body').innerHTML =
      `<tr><td colspan="16" style="text-align:center; padding:20px; color:#dc2626;">데이터 로드 실패: ${escapeHtml(err.message || String(err))}</td></tr>`;
  }
}

async function loadCustomers() {
  // bill_combined / billing_months 컬럼이 아직 없는 환경에서도 동작하도록 시도-실패 분기
  let { data, error } = await supa.from('rental_customers')
    .select('id, company, bill_combined, billing_months').order('company');
  if (error && /column .* does not exist/i.test(error.message || '')) {
    console.warn('[loadCustomers] bill_combined/billing_months 컬럼 없음 — 17, 18 SQL 실행 필요');
    const fallback = await supa.from('rental_customers').select('id, company').order('company');
    if (fallback.error) throw fallback.error;
    data = (fallback.data || []).map(c => ({ ...c, bill_combined: false, billing_months: 1 }));
  } else if (error) {
    throw error;
  }
  state.customers = data || [];
  state.customerCombined = {};
  state.customerPeriod = {};
  for (const c of state.customers) {
    state.customerCombined[c.id] = !!c.bill_combined;
    state.customerPeriod[c.id]   = c.billing_months || 1;
  }
}

async function loadItems() {
  // rental_items + 배정/거래처 join (배정이 없는 자산은 LEFT join 결과로 null)
  const { data, error } = await supa.from('rental_items')
    .select(`
      id, category, subtype, brand, model, install_date, status,
      rental_assignments ( customer_id, monthly_fee, bw_free, co_free, bw_rate, co_rate,
                            rental_customers ( id, company ) )
    `)
    .eq('status', 'active')
    .order('install_date', { ascending: false, nullsFirst: false })
    .order('id');
  if (error) throw error;
  state.items = (data || []).map(it => {
    const asgn = Array.isArray(it.rental_assignments) ? it.rental_assignments[0] : it.rental_assignments;
    return {
      id: it.id,
      category: it.category,
      subtype: it.subtype,
      brand: it.brand,
      model: it.model,
      install_date: it.install_date,
      customer_id: asgn?.customer_id || null,
      customer_name: asgn?.rental_customers?.company || '(미배정)',
      monthly_fee: asgn?.monthly_fee ?? 0,
      bw_rate: asgn?.bw_rate ?? 0,
      co_rate: asgn?.co_rate ?? 0,
      bw_free: asgn?.bw_free ?? 0,
      co_free: asgn?.co_free ?? 0,
    };
  });
}

async function loadCounters() {
  // 이번달 + 이전 6개월 한 번에 가져와서 클라이언트에서 그룹핑
  const monthsBack = listMonthsBack(state.ym, 7); // 이번달 + 6개월 전까지
  // "과거 어느 달이든 카운터 입력된" 집합은 ym 필터 없이 별도 조회
  const [detailRes, everRes] = await Promise.all([
    supa.from('rental_counters')
      .select('item_id, ym, bw, color, uptime_hours, read_at, source')
      .in('ym', monthsBack),
    supa.from('rental_counters')
      .select('item_id')
      .range(0, 99999),
  ]);
  if (detailRes.error) throw detailRes.error;
  if (everRes.error) throw everRes.error;

  const prevYm = listMonthsBack(state.ym, 2)[1]; // 직전월
  state.curMap = {};
  state.prevMap = {};
  state.histMap = {};

  for (const r of (detailRes.data || [])) {
    if (r.ym === state.ym) state.curMap[r.item_id] = r;
    else if (r.ym === prevYm) state.prevMap[r.item_id] = r;
    if (r.ym !== state.ym) {
      (state.histMap[r.item_id] ||= []).push(r);
    }
  }

  state.itemsEverCounted = new Set((everRes.data || []).map(r => r.item_id));
}

async function loadSupplies() {
  // 자산별 가장 최근 교체 기록 1건씩 (단순화: 전체 가져와 클라이언트 groupBy)
  const { data, error } = await supa.from('rental_supplies')
    .select('item_id, kind, changed_at, next_due, cost')
    .order('changed_at', { ascending: false });
  if (error) {
    // 테이블이 없을 수도 있음 — 경고만, 진행
    console.warn('[supplies] load skipped:', error.message);
    state.suppliesMap = {};
    return;
  }
  const map = {};
  for (const r of (data || [])) {
    if (!map[r.item_id]) map[r.item_id] = r;
  }
  state.suppliesMap = map;
}

function deriveCustomersEverCounted() {
  const ever = new Set();
  for (const it of state.items) {
    if (it.customer_id && state.itemsEverCounted.has(it.id)) ever.add(it.customer_id);
  }
  state.customersEverCounted = ever;
}

function render() {
  const tbody = document.getElementById('grid-body');
  const q = normalize(state.customerQuery || '');
  let rows = state.items
    .filter(it => it.customer_id && state.customersEverCounted.has(it.customer_id))
    .filter(it => !q || normalize(it.customer_name || '').includes(q))
    .map(it => buildRow(it))
    .filter(r => !state.onlyMissing || r.missing);

  // 거래처별 정렬 → 한 거래처의 첫 행에 합산 체크박스 표시
  rows.sort((a, b) => {
    const an = a.item.customer_name || '';
    const bn = b.item.customer_name || '';
    if (an !== bn) return an.localeCompare(bn);
    return (a.item.model || '').localeCompare(b.item.model || '');
  });
  state.itemsPerCustomer = {};
  for (const r of rows) {
    const cid = r.item.customer_id;
    if (cid) state.itemsPerCustomer[cid] = (state.itemsPerCustomer[cid] || 0) + 1;
  }
  let lastCid = null;
  for (const r of rows) {
    r._isCustomerFirst = r.item.customer_id !== lastCid;
    lastCid = r.item.customer_id;
  }

  // === 통계 ===
  // 신규 입력 = 이전월에 카운터 없었지만 이번달에 입력된 거래처 (= 새로 시작된 업체)
  // 카운터 입력된 업체 = 이번달 카운터 1건 이상 입력된 거래처 (총)
  // 입력 안된 업체 = 자산 보유 중 이번달 미입력 거래처
  // 이상치 경고 = 자산 단위 이상치 수
  let alerts = 0;
  const customerStats = new Map(); // cid → { id, name, items[], enteredItems[], anomalies[], bwTotal, coTotal, hadPrev }
  for (const r of rows) {
    const cid = r.item.customer_id;
    if (!cid) continue;
    if (!customerStats.has(cid)) {
      customerStats.set(cid, {
        id: cid, name: r.item.customer_name,
        items: [], enteredItems: [], anomalies: [],
        bwTotal: 0, coTotal: 0,
        hadPrev: false,  // 이전월 카운터 존재 여부 (자산 1대라도)
      });
    }
    const cs = customerStats.get(cid);
    cs.items.push(r);
    if (r.cur) {
      cs.enteredItems.push(r);
      cs.bwTotal += (r.cur.bw || 0);
      cs.coTotal += (r.cur.color || 0);
    }
    if (r.prev) cs.hadPrev = true;
    if (r.anomaly) { alerts++; cs.anomalies.push(r); }
  }

  const all = [...customerStats.values()];
  const entered = all.filter(cs => cs.enteredItems.length > 0);
  const missing = all.filter(cs => cs.enteredItems.length === 0);
  const newly   = entered.filter(cs => !cs.hadPrev); // 이전월 미입력 → 이번달 입력
  const anomaly = all.filter(cs => cs.anomalies.length > 0);

  state.drilldown = { new: newly, entered, missing, anomaly };

  document.getElementById('st-new').textContent = newly.length.toLocaleString();
  document.getElementById('st-co-done').textContent = entered.length.toLocaleString();
  document.getElementById('st-co-missing').textContent = missing.length.toLocaleString();
  document.getElementById('st-alerts').textContent = alerts.toLocaleString();
  document.getElementById('row-count').textContent = `${rows.length}개 자산`;

  // 활성 드릴다운 재렌더
  if (state.activeDrilldown) renderDrilldown(state.activeDrilldown);

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="16" class="muted-small" style="text-align:center; padding:30px;">조건에 맞는 자산이 없습니다.</td></tr>';
    return;
  }

  // 거래처별 그룹 끝마다 확장 영역 삽입
  let html = '';
  let lastCid = null;
  for (const r of rows) {
    const cid = r.item.customer_id;
    if (lastCid !== null && cid !== lastCid && state.expandedCustomerId === lastCid) {
      html += renderExpansion(lastCid);
    }
    html += renderRow(r);
    lastCid = cid;
  }
  if (lastCid !== null && state.expandedCustomerId === lastCid) {
    html += renderExpansion(lastCid);
  }
  tbody.innerHTML = html;
  attachCellHandlers();
}

function buildRow(item) {
  const cur  = state.curMap[item.id]  || null;
  const prev = state.prevMap[item.id] || null;
  const hist = state.histMap[item.id] || [];

  const isMeter = (item.category === 'printer') || (item.category === '출력') || ['laser', 'inkjet', '복합기'].includes(item.subtype);

  const bw_cur  = cur?.bw ?? null;
  const co_cur  = cur?.color ?? null;
  const bw_prev = prev?.bw ?? null;
  const co_prev = prev?.color ?? null;

  // 월카운터 = max(0, 당월 - 전월)
  const bw_month = (bw_cur != null && bw_prev != null) ? Math.max(0, bw_cur - bw_prev) : null;
  const co_month = (co_cur != null && co_prev != null) ? Math.max(0, co_cur - co_prev) : null;

  // 추가카운터 = max(0, 월카운터 - 기본매수)
  const bw_extra = bw_month != null ? Math.max(0, bw_month - (item.bw_free || 0)) : null;
  const co_extra = co_month != null ? Math.max(0, co_month - (item.co_free || 0)) : null;

  // 추가사용료 = 추가카운터 × 추가사용단가
  const bw_charge = bw_extra != null ? bw_extra * (item.bw_rate || 0) : null;
  const co_charge = co_extra != null ? co_extra * (item.co_rate || 0) : null;

  // 이전 6개월 평균 증가량 (이상치 탐지용)
  const avgBW = avgIncrease(hist, 'bw');
  const avgCO = avgIncrease(hist, 'color');
  const bwAnomaly = bw_month != null && avgBW > 0 && bw_month > avgBW * 3;
  const coAnomaly = co_month != null && avgCO > 0 && co_month > avgCO * 3;
  const anomaly = bwAnomaly || coAnomaly;

  return {
    item, cur, prev, isMeter,
    bw_prev, bw_cur, bw_month, bw_extra, bw_charge, bwAnomaly,
    co_prev, co_cur, co_month, co_extra, co_charge, coAnomaly,
    avgBW, avgCO,
    anomaly,
    missing: !cur,
  };
}

function avgIncrease(hist, field) {
  if (!hist || hist.length < 2) return 0;
  const sorted = hist.slice().sort((a, b) => a.ym.localeCompare(b.ym));
  const last6 = sorted.slice(-6);
  let total = 0, n = 0;
  for (let i = 1; i < last6.length; i++) {
    const a = last6[i - 1][field] ?? 0;
    const b = last6[i][field] ?? 0;
    if (b >= a) { total += (b - a); n++; }
  }
  return n ? total / n : 0;
}

function forecastSupply(item, bw_inc, co_inc) {
  // category/subtype 기반 toner life
  const key = item.subtype || item.category || '';
  const life = TONER_LIFE[key] || TONER_LIFE.printer;

  // 직전 교체 이후 누적 사용량 추정 — 직전월 카운터에서 +bw_inc / +co_inc 가 한 달치
  // (단순화) 월 증가량 → 평균 사용량으로 잔여 일수 = (life - used_since_change)/(daily_use)
  const last = state.suppliesMap[item.id];
  const out = [];

  if (item.category === 'printer' || ['laser','inkjet','복합기'].includes(item.subtype)) {
    // BW 토너
    const monthlyBW = bw_inc || 0;
    const dailyBW = monthlyBW / 30;
    const usedSinceBW = monthlyBW; // 단순: 이번달 사용량
    const remainBW = Math.max(0, life.bw - usedSinceBW);
    const daysBW = dailyBW > 0 ? Math.round(remainBW / dailyBW) : null;
    if (daysBW != null) out.push({ kind: 'BW토너', days: daysBW });

    if (life.color) {
      const monthlyCO = co_inc || 0;
      const dailyCO = monthlyCO / 30;
      const usedSinceCO = monthlyCO;
      const remainCO = Math.max(0, life.color - usedSinceCO);
      const daysCO = dailyCO > 0 ? Math.round(remainCO / dailyCO) : null;
      if (daysCO != null) out.push({ kind: '컬러토너', days: daysCO });
    }
  }
  if (item.category === 'wellness' || item.subtype === 'wellness') {
    if (last && last.changed_at) {
      const diff = Math.round((Date.now() - new Date(last.changed_at).getTime()) / 86400000);
      const days = FILTER_LIFE_DAYS - diff;
      out.push({ kind: '필터', days });
    } else if (item.install_date) {
      const diff = Math.round((Date.now() - new Date(item.install_date).getTime()) / 86400000);
      const days = FILTER_LIFE_DAYS - (diff % FILTER_LIFE_DAYS);
      out.push({ kind: '필터', days });
    }
  }
  return out;
}

function renderRow(r) {
  const it = r.item;
  const rowId = it.id;
  const dateLabel = state.ym ? `${Number(state.ym.split('-')[1])}월` : '–';
  const subtag = it.subtype ? ` <span class="muted-small">/${escapeHtml(it.subtype)}</span>` : '';

  // 거래처 옵션 (합산 청구 + 청구 주기) — 첫 행에만 표시
  const cid = it.customer_id;
  const showCombine = r._isCustomerFirst && cid && (state.itemsPerCustomer[cid] || 0) >= 2;
  const combined = !!state.customerCombined[cid];
  const period   = Number(state.customerPeriod[cid]) || 1;
  const combineHTML = showCombine
    ? `<label class="bill-combine-toggle ${combined ? 'on' : ''}" title="여러 자산 합산하여 청구">
         <input type="checkbox" class="bill-combined-chk" data-cid="${escapeAttr(cid)}" ${combined ? 'checked' : ''}>
         ${combined ? '합산 청구 ON' : '합산 청구'}
       </label>`
    : '';
  const periodHTML = (r._isCustomerFirst && cid)
    ? `<select class="bill-period-sel ${period > 1 ? 'on' : ''}" data-cid="${escapeAttr(cid)}" title="청구 주기">
         <option value="1"  ${period===1?'selected':''}>월별</option>
         <option value="3"  ${period===3?'selected':''}>3개월</option>
         <option value="6"  ${period===6?'selected':''}>6개월</option>
         <option value="12" ${period===12?'selected':''}>1년</option>
       </select>`
    : '';
  const optsHTML = (combineHTML || periodHTML)
    ? `<div class="bill-options">${combineHTML}${periodHTML}</div>`
    : '';
  const expandedCls = (cid && state.expandedCustomerId === cid) ? ' expanded' : '';
  const expandedIcon = (cid && state.expandedCustomerId === cid) ? '📂' : '📅';
  const customerLine = r._isCustomerFirst
    ? `<div style="font-weight:600;"><span class="customer-name-link${expandedCls}" data-cid="${escapeAttr(cid || '')}" role="button" tabindex="0" title="지난 자료 펼치기/접기">${escapeHtml(it.customer_name)}<span class="icon">${expandedIcon}</span></span></div>${optsHTML}`
    : `<div class="muted-small" style="color:#94a3b8;">↳ ${escapeHtml(it.customer_name)}</div>`;

  // 출력기기가 아니면 흑백/컬러 셀 모두 N/A 처리
  if (!r.isMeter) {
    const dash = `<td class="num grp-bw dim">N/A</td>`;
    const dash2 = `<td class="num grp-co dim">N/A</td>`;
    return `
      <tr data-row="${escapeAttr(rowId)}">
        <td>
          ${customerLine}
          <div class="muted-small">${escapeHtml(it.brand || '')} ${escapeHtml(it.model || rowId)}${subtag}</div>
        </td>
        <td style="text-align:center; color:#64748b;">${dateLabel}</td>
        ${dash.repeat(7)}
        ${dash2.repeat(7)}
      </tr>`;
  }

  const bwAnomStyle = r.bwAnomaly ? 'color:#dc2626;font-weight:600;' : '';
  const coAnomStyle = r.coAnomaly ? 'color:#dc2626;font-weight:600;' : '';

  const bwCells = `
    <td class="num grp-bw" style="color:#64748b;">${fmt(r.bw_prev)}</td>
    <td class="num grp-bw">
      <input type="number" class="cell-edit num" data-item="${escapeAttr(rowId)}" data-field="bw" value="${r.bw_cur ?? ''}" placeholder="–">
    </td>
    <td class="num grp-bw dim">${fmt(it.bw_free)}</td>
    <td class="num grp-bw" style="${bwAnomStyle}">${r.bwAnomaly ? '🔴 ' : ''}${fmt(r.bw_month)}</td>
    <td class="num grp-bw">${fmt(r.bw_extra)}</td>
    <td class="num grp-bw dim">${fmt(it.bw_rate)}</td>
    <td class="num grp-bw charge">${fmt(r.bw_charge)}</td>
  `;

  const coCells = `
    <td class="num grp-co" style="color:#64748b;">${fmt(r.co_prev)}</td>
    <td class="num grp-co">
      <input type="number" class="cell-edit num" data-item="${escapeAttr(rowId)}" data-field="color" value="${r.co_cur ?? ''}" placeholder="–">
    </td>
    <td class="num grp-co dim">${fmt(it.co_free)}</td>
    <td class="num grp-co" style="${coAnomStyle}">${r.coAnomaly ? '🔴 ' : ''}${fmt(r.co_month)}</td>
    <td class="num grp-co">${fmt(r.co_extra)}</td>
    <td class="num grp-co dim">${fmt(it.co_rate)}</td>
    <td class="num grp-co charge">${fmt(r.co_charge)}</td>
  `;

  return `
    <tr data-row="${escapeAttr(rowId)}">
      <td>
        ${customerLine}
        <div class="muted-small">🖨 ${escapeHtml(it.brand || '')} ${escapeHtml(it.model || rowId)}${subtag}</div>
      </td>
      <td style="text-align:center; color:#64748b;">${dateLabel}</td>
      ${bwCells}
      ${coCells}
    </tr>
  `;
}

function attachCellHandlers() {
  document.querySelectorAll('input.cell-edit').forEach(inp => {
    inp.addEventListener('change', onCellChange);
    inp.addEventListener('blur',   onCellChange);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    });
  });
  // 합산 청구 체크박스
  document.querySelectorAll('input.bill-combined-chk').forEach(chk => {
    chk.addEventListener('change', onCombinedToggle);
    chk.addEventListener('click', e => e.stopPropagation());
  });
  // 청구 주기 드롭다운
  document.querySelectorAll('select.bill-period-sel').forEach(sel => {
    sel.addEventListener('change', onPeriodChange);
    sel.addEventListener('click', e => e.stopPropagation());
  });
  // 거래처명 클릭 → 인라인 확장 토글 (지난 자료 펼침/접기)
  document.querySelectorAll('.customer-name-link').forEach(el => {
    const handle = (e) => {
      if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggleCustomerExpansion(el.dataset.cid);
    };
    el.addEventListener('click', handle);
    el.addEventListener('keydown', handle);
  });
  // 확장 영역: 기간 탭 (3/6/12개월)
  document.querySelectorAll('tr.expansion-header .ch-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = Number(btn.dataset.months) || 6;
      changeExpansionMonths(m);
    });
  });
  // 확장 영역: 접기 버튼
  const collapseBtn = document.getElementById('btn-collapse-expansion');
  if (collapseBtn) collapseBtn.addEventListener('click', collapseCustomerExpansion);
}

async function onPeriodChange(e) {
  const sel = e.currentTarget;
  const cid = sel.dataset.cid;
  const newVal = parseInt(sel.value, 10) || 1;
  const prevVal = Number(state.customerPeriod[cid]) || 1;
  state.customerPeriod[cid] = newVal;
  try {
    const { error } = await supa.from('rental_customers')
      .update({ billing_months: newVal }).eq('id', cid);
    if (error) throw error;
    const label = { 1: '월별', 3: '3개월', 6: '6개월', 12: '1년' }[newVal] || `${newVal}개월`;
    toast(`청구 주기: ${label}`);
    render();
    // 월별 거래처만 자동 청구 갱신 (다개월 거래처는 청구 페이지에서 발행)
    if (newVal === 1) {
      autoUpdateBillings([cid], { silent: true }).catch(err =>
        console.warn('[billing-sync] period change', err));
    }
  } catch (err) {
    console.error(err);
    state.customerPeriod[cid] = prevVal;
    sel.value = String(prevVal);
    if (/column .* does not exist/i.test(err.message || '')) {
      toast('18_add_billing_period.sql 을 먼저 실행해 주세요', true);
    } else {
      toast('청구 주기 저장 실패: ' + (err.message || err), true);
    }
  }
}

async function onCombinedToggle(e) {
  const cid = e.currentTarget.dataset.cid;
  const newVal = e.currentTarget.checked;
  const prevVal = !!state.customerCombined[cid];
  state.customerCombined[cid] = newVal; // 낙관적 업데이트
  try {
    const { error } = await supa.from('rental_customers')
      .update({ bill_combined: newVal }).eq('id', cid);
    if (error) throw error;
    toast(newVal ? '합산 청구 ON' : '합산 청구 OFF');
    render(); // 토글 라벨 갱신
    // 청구서 자동 재계산
    autoUpdateBillings([cid], { silent: true }).catch(err => {
      console.warn('[billing-sync] combined toggle', err);
    });
  } catch (err) {
    console.error(err);
    state.customerCombined[cid] = prevVal;
    e.currentTarget.checked = prevVal;
    if (/column .* does not exist/i.test(err.message || '')) {
      toast('17_add_bill_combined.sql 을 먼저 실행해 주세요', true);
    } else {
      toast('합산 청구 저장 실패: ' + (err.message || err), true);
    }
  }
}

let saveTimer = null;
async function onCellChange(e) {
  const inp = e.currentTarget;
  const itemId = inp.dataset.item;
  const field = inp.dataset.field;
  const raw = inp.value.trim();
  const val = raw === '' ? null : Number(raw);
  if (raw !== '' && !Number.isFinite(val)) {
    toast('숫자만 입력하세요', true);
    return;
  }
  // 기존 row와 병합 후 upsert
  const existing = state.curMap[itemId] || { item_id: itemId, ym: state.ym, bw: null, color: null, uptime_hours: null };
  const payload = {
    item_id: itemId,
    ym: state.ym,
    bw: field === 'bw' ? val : (existing.bw ?? null),
    color: field === 'color' ? val : (existing.color ?? null),
    uptime_hours: field === 'uptime_hours' ? val : (existing.uptime_hours ?? null),
    read_at: new Date().toISOString(),
    source: 'manual',
  };
  try {
    const { error } = await supa.from('rental_counters')
      .upsert(payload, { onConflict: 'item_id,ym' });
    if (error) throw error;
    state.curMap[itemId] = payload;
    state.itemsEverCounted.add(itemId);
    deriveCustomersEverCounted();
    inp.classList.add('saved');
    setTimeout(() => inp.classList.remove('saved'), 900);
    // 통계 즉시 갱신
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => render(), 250);
    toast('저장됨');

    // 청구서 자동 갱신 (해당 거래처)
    const item = state.items.find(i => i.id === itemId);
    if (item?.customer_id) {
      autoUpdateBillings([item.customer_id], { silent: true }).catch(e =>
        console.warn('[billing-sync] cell update fail', e)
      );
    }
  } catch (err) {
    console.error(err);
    toast('저장 실패: ' + (err.message || err), true);
  }
}

// ---------- 드릴다운 ----------
const DRILL_TITLES = {
  new:     '🆕 이번달 신규 입력 업체',
  entered: '✔ 카운터 입력된 업체',
  missing: '⚠ 입력 안된 업체',
  anomaly: '🔴 이상치 경고 업체',
};

function toggleDrilldown(key) {
  if (state.activeDrilldown === key) return closeDrilldown();
  state.activeDrilldown = key;
  document.querySelectorAll('#stats .stat-card').forEach(c => {
    c.classList.toggle('active', c.dataset.drill === key);
  });
  document.getElementById('drilldown').style.display = '';
  renderDrilldown(key);
}
function closeDrilldown() {
  state.activeDrilldown = null;
  document.querySelectorAll('#stats .stat-card').forEach(c => c.classList.remove('active'));
  document.getElementById('drilldown').style.display = 'none';
}
function renderDrilldown(key) {
  const list = state.drilldown?.[key] || [];
  document.getElementById('drilldown-title').textContent =
    `${DRILL_TITLES[key] || '업체 목록'} (${list.length})`;
  const body = document.getElementById('drilldown-body');
  if (!list.length) {
    body.innerHTML = `<div class="drilldown-empty">해당하는 업체가 없습니다.</div>`;
    return;
  }
  const isAnomaly = key === 'anomaly';
  body.innerHTML = `
    <table class="drilldown-table">
      <thead><tr>
        <th>업체</th>
        <th class="num">자산</th>
        <th class="num">입력</th>
        <th class="num">흑백 합계</th>
        <th class="num">컬러 합계</th>
        ${isAnomaly ? '<th>이상치 자산</th>' : ''}
        <th></th>
      </tr></thead>
      <tbody>
        ${list.map(cs => `
          <tr class="drilldown-row" data-cid="${escapeAttr(cs.id)}">
            <td><b>${escapeHtml(cs.name)}</b></td>
            <td class="num">${cs.items.length}</td>
            <td class="num">${cs.enteredItems.length}</td>
            <td class="num">${cs.bwTotal.toLocaleString()}</td>
            <td class="num">${cs.coTotal.toLocaleString()}</td>
            ${isAnomaly ? `<td>${cs.anomalies.map(a => escapeHtml((a.item.brand||'') + ' ' + (a.item.model||a.item.id))).join('<br>')}</td>` : ''}
            <td><span class="muted-small">필터 →</span></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  body.querySelectorAll('.drilldown-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const cid = tr.dataset.cid;
      const cust = state.customers.find(c => c.id === cid);
      const name = cust?.company || '';
      const inp = document.getElementById('f-customer-search');
      if (inp) inp.value = name;
      state.customerQuery = name;
      render();
      const card = document.querySelector('.counters-card');
      if (card) window.scrollTo({ top: card.offsetTop - 20, behavior: 'smooth' });
    });
  });
}

// ===========================================================
// 거래처 인라인 확장 — 지난 자료 (3 / 6 / 12개월)
// 거래처명 클릭 시 해당 거래처 행 그룹 바로 아래에
// 동일한 16개 컬럼(전월/당월/기본매수/월카운터/추가카운터/단가/추가요금 × 흑백/컬러)
// 으로 과거 N개월치 행을 펼친다.
// ===========================================================
async function toggleCustomerExpansion(cid) {
  if (!cid) return;
  if (state.expandedCustomerId === cid) {
    collapseCustomerExpansion();
    return;
  }
  state.expandedCustomerId = cid;
  state.expansionLoading = true;
  state.expansionRows = null;
  render();
  await loadExpansionData(cid, state.expansionMonths);
  // 사용자가 로딩 중 다른 거래처를 클릭한 경우 무시
  if (state.expandedCustomerId !== cid) return;
  render();
}

function collapseCustomerExpansion() {
  state.expandedCustomerId = null;
  state.expansionRows = null;
  state.expansionLoading = false;
  render();
}

async function changeExpansionMonths(months) {
  const m = [3, 6, 12].includes(months) ? months : 6;
  if (m === state.expansionMonths && state.expansionRows) return;
  state.expansionMonths = m;
  if (!state.expandedCustomerId) return;
  state.expansionLoading = true;
  render();
  await loadExpansionData(state.expandedCustomerId, m);
  render();
}

async function loadExpansionData(cid, months) {
  const myItems = state.items.filter(it => it.customer_id === cid);
  if (!myItems.length) {
    state.expansionRows = new Map();
    state.expansionLoading = false;
    return;
  }
  // 가장 오래된 표시 월의 "전월" 까지 포함하려면 months+2 개월 필요
  const ymList = listMonthsBack(state.ym, months + 2);
  try {
    const { data, error } = await supa.from('rental_counters')
      .select('item_id, ym, bw, color, uptime_hours')
      .in('item_id', myItems.map(i => i.id))
      .in('ym', ymList);
    if (error) throw error;
    const m = new Map();
    for (const r of (data || [])) m.set(`${r.item_id}|${r.ym}`, r);
    state.expansionRows = m;
  } catch (err) {
    console.error(err);
    toast('이력 로드 실패: ' + (err.message || err), true);
    state.expansionRows = new Map();
  } finally {
    state.expansionLoading = false;
  }
}

function renderExpansion(cid) {
  const months = state.expansionMonths;
  const periodHtml = [3, 6, 12].map(m =>
    `<button class="ch-tab${m === months ? ' active' : ''}" data-months="${m}" type="button">${m}개월</button>`
  ).join('');

  const headerRow = `
    <tr class="expansion-header">
      <td colspan="16">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
            <strong style="font-size:13px;">📂 지난 자료</strong>
            <div style="display:flex; gap:4px;">${periodHtml}</div>
          </div>
          <button class="btn ghost small" id="btn-collapse-expansion" type="button">✕ 접기</button>
        </div>
      </td>
    </tr>
  `;

  if (state.expansionLoading || !state.expansionRows) {
    return headerRow + `<tr class="expansion-row"><td colspan="16" style="padding:18px; text-align:center; color:#64748b;">로딩 중…</td></tr>`;
  }

  const items = state.items.filter(it => it.customer_id === cid);
  if (!items.length) {
    return headerRow + `<tr class="expansion-row"><td colspan="16" style="padding:18px; text-align:center; color:#64748b;">자산이 없습니다.</td></tr>`;
  }

  // 표시 대상: 과거 N개월 (현재월 제외, 최신부터)
  const ymAll  = listMonthsBack(state.ym, months + 2);
  const pastYms = ymAll.slice(1, months + 1);

  let rowsHtml = '';
  for (const it of items) {
    const isMeter = (it.category === 'printer') || (it.category === '출력') || ['laser','inkjet','복합기'].includes(it.subtype);
    for (let i = 0; i < pastYms.length; i++) {
      const ym = pastYms[i];
      const prevYm = ymAll[i + 2]; // ym 의 직전월
      const cur  = state.expansionRows.get(`${it.id}|${ym}`) || null;
      const prev = state.expansionRows.get(`${it.id}|${prevYm}`) || null;
      rowsHtml += renderExpansionRow(it, ym, cur, prev, isMeter);
    }
  }

  return headerRow + (rowsHtml ||
    `<tr class="expansion-row"><td colspan="16" style="padding:18px; text-align:center; color:#64748b;">표시할 데이터가 없습니다.</td></tr>`);
}

function renderExpansionRow(it, ym, cur, prev, isMeter) {
  const [yy, mm] = ym.split('-');
  const dateLabel = `${Number(mm)}월<br><span style="font-size:10px;color:#94a3b8;">${yy}</span>`;
  const subtag = it.subtype ? ` <span class="muted-small">/${escapeHtml(it.subtype)}</span>` : '';

  if (!isMeter) {
    const dash  = `<td class="num grp-bw dim">N/A</td>`;
    const dash2 = `<td class="num grp-co dim">N/A</td>`;
    return `
      <tr class="expansion-row">
        <td><div class="muted-small" style="padding-left:18px; color:#94a3b8;">↳ ${escapeHtml(it.brand||'')} ${escapeHtml(it.model||it.id)}${subtag}</div></td>
        <td style="text-align:center; color:#64748b;">${dateLabel}</td>
        ${dash.repeat(7)}${dash2.repeat(7)}
      </tr>
    `;
  }

  const bw_cur  = cur?.bw ?? null;
  const co_cur  = cur?.color ?? null;
  const bw_prev = prev?.bw ?? null;
  const co_prev = prev?.color ?? null;
  const bw_month = (bw_cur != null && bw_prev != null) ? Math.max(0, bw_cur - bw_prev) : null;
  const co_month = (co_cur != null && co_prev != null) ? Math.max(0, co_cur - co_prev) : null;
  const bw_extra = bw_month != null ? Math.max(0, bw_month - (it.bw_free || 0)) : null;
  const co_extra = co_month != null ? Math.max(0, co_month - (it.co_free || 0)) : null;
  const bw_charge = bw_extra != null ? bw_extra * (it.bw_rate || 0) : null;
  const co_charge = co_extra != null ? co_extra * (it.co_rate || 0) : null;

  return `
    <tr class="expansion-row">
      <td><div class="muted-small" style="padding-left:18px; color:#94a3b8;">↳ ${escapeHtml(it.brand||'')} ${escapeHtml(it.model||it.id)}${subtag}</div></td>
      <td style="text-align:center; color:#64748b;">${dateLabel}</td>
      <td class="num grp-bw" style="color:#64748b;">${fmt(bw_prev)}</td>
      <td class="num grp-bw">${fmt(bw_cur)}</td>
      <td class="num grp-bw dim">${fmt(it.bw_free)}</td>
      <td class="num grp-bw">${fmt(bw_month)}</td>
      <td class="num grp-bw">${fmt(bw_extra)}</td>
      <td class="num grp-bw dim">${fmt(it.bw_rate)}</td>
      <td class="num grp-bw charge">${fmt(bw_charge)}</td>
      <td class="num grp-co" style="color:#64748b;">${fmt(co_prev)}</td>
      <td class="num grp-co">${fmt(co_cur)}</td>
      <td class="num grp-co dim">${fmt(it.co_free)}</td>
      <td class="num grp-co">${fmt(co_month)}</td>
      <td class="num grp-co">${fmt(co_extra)}</td>
      <td class="num grp-co dim">${fmt(it.co_rate)}</td>
      <td class="num grp-co charge">${fmt(co_charge)}</td>
    </tr>
  `;
}

// ---------- utils ----------
function setBodyLoading() {
  document.getElementById('grid-body').innerHTML =
    '<tr><td colspan="16" class="muted-small" style="text-align:center; padding:30px;">데이터 로딩 중…</td></tr>';
}
function updateYearHeader() {
  const el = document.getElementById('hdr-year');
  if (el && state.ym) el.textContent = state.ym.split('-')[0];
}
function ymOfNow() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function listMonthsBack(ym, count) {
  const [y, m] = ym.split('-').map(Number);
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(y, m - 1 - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
function fmt(n) {
  if (n == null || n === '') return '–';
  return Number(n).toLocaleString();
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ===========================================================
// 엑셀 일괄 입력
// ===========================================================
const excelState = {
  rows: [],   // [{ idx, raw, company, model, bw, color, customerId, itemId, status, note }]
};

const HEADER_ALIASES = {
  company: ['업체명', '거래처', '거래처명', '회사', '회사명', '고객사', '고객명', 'company', 'customer'],
  model:   ['모델', '모델명', '기종', 'model'],
  bw:      ['흑백', '흑백카운터', '흑백카운트', 'bw', 'mono', '모노'],
  color:   ['컬러', '컬러카운터', '컬러카운트', 'color', 'col'],
};

let _excelInited = false;
function initExcelImport() {
  if (_excelInited) return;
  _excelInited = true;
  const toggle = document.getElementById('btn-excel-toggle');
  const body   = document.getElementById('excel-body');
  const drop   = document.getElementById('excel-drop');
  const file   = document.getElementById('excel-file');
  const clear  = document.getElementById('btn-excel-clear');
  const save   = document.getElementById('btn-excel-save');

  toggle.addEventListener('click', () => {
    const open = body.style.display === 'none';
    body.style.display = open ? '' : 'none';
    toggle.textContent = open ? '닫기 ▴' : '열기 ▾';
  });

  drop.addEventListener('dragover',  e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('drag-over');
    const f = e.dataTransfer?.files?.[0];
    if (f) handleExcelFile(f);
  });
  file.addEventListener('change', e => {
    const f = e.target.files?.[0];
    if (f) handleExcelFile(f);
  });

  clear.addEventListener('click', () => {
    excelState.rows = [];
    file.value = '';
    document.getElementById('excel-preview').classList.add('hidden');
    document.getElementById('excel-preview-body').innerHTML = '';
    save.disabled = true;
  });

  save.addEventListener('click', () => saveExcelBatch({ auto: false }));

  updateExcelTargetYm();
}

function updateExcelTargetYm() {
  const el = document.getElementById('excel-target-ym');
  if (el) el.textContent = state.ym;
}

async function handleExcelFile(file) {
  if (typeof XLSX === 'undefined') {
    toast('엑셀 라이브러리 로드 실패', true);
    return;
  }
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
    if (!json.length) {
      toast('빈 파일입니다', true);
      return;
    }
    const headerMap = detectHeaders(Object.keys(json[0]));
    if (!headerMap.company) {
      toast('업체명 열을 찾을 수 없습니다', true);
      return;
    }
    if (!headerMap.bw && !headerMap.color) {
      toast('흑백/컬러 카운터 열을 찾을 수 없습니다', true);
      return;
    }
    excelState.rows = json.map((r, i) => ({
      idx: i + 1,
      raw: r,
      company: String(r[headerMap.company] || '').trim(),
      model:   headerMap.model ? String(r[headerMap.model] || '').trim() : '',
      bw:      headerMap.bw ? toNum(r[headerMap.bw]) : null,
      color:   headerMap.color ? toNum(r[headerMap.color]) : null,
      customerId: null,
      itemId: null,
      status: 'pending',
      note: '',
    })).filter(r => r.company);

    rematchExcelRows();
    document.getElementById('excel-preview').classList.remove('hidden');

    // 자동 분석 결과 안내 + 자동 저장
    const okCount = excelState.rows.filter(r => r.status === 'ok' && r.itemId).length;
    if (okCount > 0) {
      toast(`📥 ${excelState.rows.length}행 로드 · ${okCount}건 자동 저장 중…`);
      await saveExcelBatch({ auto: true });
    } else {
      toast(`📥 ${excelState.rows.length}행 로드 · 자동 매칭 0건 — 아래 미리보기에서 자산을 직접 선택하세요.`, true);
    }
  } catch (err) {
    console.error(err);
    toast('파일 읽기 실패: ' + (err.message || err), true);
  }
}

function detectHeaders(keys) {
  const out = {};
  for (const key of keys) {
    const norm = normalize(key);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (out[field]) continue;
      if (aliases.some(a => normalize(a) === norm)) { out[field] = key; break; }
    }
  }
  return out;
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[()\[\]\-_./]/g, '');
}

function rematchExcelRows() {
  if (!excelState.rows.length) return;
  for (const row of excelState.rows) {
    matchRow(row);
  }
  renderExcelPreview();
}

function matchRow(row) {
  row.note = '';
  // 1) 거래처 매칭
  const normCompany = normalize(row.company);
  const cust = state.customers.find(c => normalize(c.company) === normCompany)
            || state.customers.find(c => normalize(c.company).includes(normCompany) || normCompany.includes(normalize(c.company)));

  if (!cust) {
    row.customerId = null;
    row.itemId = null;
    row.status = 'fail';
    row.note = '거래처 없음';
    return;
  }
  row.customerId = cust.id;

  // 2) 자산 매칭
  const candidates = state.items.filter(it => it.customer_id === cust.id);
  if (!candidates.length) {
    row.itemId = null;
    row.status = 'warn';
    row.note = '배정 자산 없음';
    return;
  }

  let picked = null;
  if (row.model) {
    const nm = normalize(row.model);
    picked = candidates.find(it => normalize(it.model) === nm)
          || candidates.find(it => normalize(it.model).includes(nm) || nm.includes(normalize(it.model)));
  }
  if (!picked && candidates.length === 1) picked = candidates[0];

  if (picked) {
    row.itemId = picked.id;
    row.status = 'ok';
  } else {
    row.itemId = null;
    row.status = 'warn';
    row.note = `자산 선택 필요 (${candidates.length}대)`;
  }
}

function renderExcelPreview() {
  const tbody = document.getElementById('excel-preview-body');
  const rows = excelState.rows;
  let ok = 0, warn = 0, fail = 0;

  tbody.innerHTML = rows.map(r => {
    if (r.status === 'ok' || r.status === 'saved') ok++;
    if (r.status === 'warn') warn++;
    if (r.status === 'fail') fail++;

    const cust = r.customerId ? state.customers.find(c => c.id === r.customerId) : null;
    const cands = r.customerId ? state.items.filter(it => it.customer_id === r.customerId) : [];
    const item  = r.itemId ? state.items.find(it => it.id === r.itemId) : null;

    const prev = r.itemId ? state.prevMap[r.itemId] : null;
    const bwPrev = prev?.bw ?? null;
    const coPrev = prev?.color ?? null;
    const bwInc  = (r.bw != null && bwPrev != null) ? Math.max(0, r.bw - bwPrev) : null;
    const coInc  = (r.color != null && coPrev != null) ? Math.max(0, r.color - coPrev) : null;

    const itemSel = r.status === 'fail'
      ? `<span class="muted-small">–</span>`
      : `<select class="cell-edit excel-item-sel" data-idx="${r.idx}">
           <option value="">— 선택 —</option>
           ${cands.map(c => `<option value="${escapeAttr(c.id)}" ${c.id === r.itemId ? 'selected' : ''}>${escapeHtml((c.brand||'') + ' ' + (c.model||c.id))}</option>`).join('')}
         </select>`;

    const custCell = cust
      ? `<span title="${escapeAttr(cust.id)}">${escapeHtml(cust.company)}</span>`
      : `<span style="color:#dc2626;">매칭 실패</span>`;

    const statusBadge =
      r.status === 'saved' ? `<span class="excel-badge ok">💾 저장됨</span>`
    : r.status === 'ok'    ? `<span class="excel-badge ok">✔ 매칭</span>`
    : r.status === 'warn'  ? `<span class="excel-badge warn">⚠ ${escapeHtml(r.note || '확인필요')}</span>`
                           : `<span class="excel-badge fail">✖ ${escapeHtml(r.note || '실패')}</span>`;

    return `
      <tr class="excel-row excel-row-${r.status}">
        <td>${r.idx}</td>
        <td>${escapeHtml(r.company)}${r.model ? `<div class="muted-small">${escapeHtml(r.model)}</div>` : ''}</td>
        <td>${custCell}</td>
        <td>${itemSel}</td>
        <td class="num">${fmt(bwPrev)}</td>
        <td class="num">${fmt(r.bw)}</td>
        <td class="num" style="${bwInc != null && bwInc > 0 ? 'color:#16a34a;font-weight:600;' : ''}">${fmt(bwInc)}</td>
        <td class="num">${fmt(coPrev)}</td>
        <td class="num">${fmt(r.color)}</td>
        <td class="num" style="${coInc != null && coInc > 0 ? 'color:#16a34a;font-weight:600;' : ''}">${fmt(coInc)}</td>
        <td>${statusBadge}</td>
      </tr>
    `;
  }).join('');

  document.getElementById('excel-total').textContent = rows.length;
  document.getElementById('excel-matched').textContent = ok;
  document.getElementById('excel-warn').textContent = warn;
  document.getElementById('excel-fail').textContent = fail;
  document.getElementById('btn-excel-save').disabled = ok === 0;

  // 수동 자산 선택 핸들러
  tbody.querySelectorAll('select.excel-item-sel').forEach(sel => {
    sel.addEventListener('change', e => {
      const idx = Number(e.target.dataset.idx);
      const row = excelState.rows.find(r => r.idx === idx);
      if (!row) return;
      row.itemId = e.target.value || null;
      if (row.itemId) { row.status = 'ok'; row.note = ''; }
      else            { row.status = 'warn'; row.note = '자산 선택 필요'; }
      renderExcelPreview();
    });
  });
}

async function saveExcelBatch({ auto = false } = {}) {
  const targets = excelState.rows.filter(r => r.status === 'ok' && r.itemId);
  if (!targets.length) {
    if (!auto) toast('저장할 행이 없습니다', true);
    return;
  }

  const btn = document.getElementById('btn-excel-save');
  btn.disabled = true;
  btn.textContent = auto ? '자동 저장 중…' : '저장 중…';

  try {
    const now = new Date().toISOString();
    const payloads = targets.map(r => {
      const existing = state.curMap[r.itemId] || {};
      return {
        item_id: r.itemId,
        ym: state.ym,
        bw:    r.bw    != null ? r.bw    : (existing.bw    ?? null),
        color: r.color != null ? r.color : (existing.color ?? null),
        uptime_hours: existing.uptime_hours ?? null,
        read_at: now,
        source: 'excel',
      };
    });

    const { error } = await supa.from('rental_counters')
      .upsert(payloads, { onConflict: 'item_id,ym' });
    if (error) throw error;

    for (const p of payloads) {
      state.curMap[p.item_id] = p;
      state.itemsEverCounted.add(p.item_id);
    }
    deriveCustomersEverCounted();
    // 저장된 행 상태 표시
    for (const r of targets) r.status = 'saved';

    const failCount = excelState.rows.filter(r => r.status !== 'saved' && r.status !== 'ok').length;
    const warnCount = excelState.rows.filter(r => r.status === 'warn').length;
    if (auto) {
      const parts = [`✔ ${payloads.length}건 자동 저장`];
      if (warnCount) parts.push(`⚠ ${warnCount}건 확인 필요`);
      if (failCount) parts.push(`✖ ${failCount}건 실패`);
      toast(parts.join(' · '), warnCount + failCount > 0);
    } else {
      toast(`${payloads.length}건 저장됨`);
    }
    render();
    renderExcelPreview();

    // 청구서 자동 갱신 (영향받은 거래처 일괄)
    const affected = [];
    for (const p of payloads) {
      const it = state.items.find(i => i.id === p.item_id);
      if (it?.customer_id) affected.push(it.customer_id);
    }
    if (affected.length) {
      autoUpdateBillings(affected, { silent: auto }).catch(e => {
        console.warn('[billing-sync] batch fail', e);
        if (!auto) toast('청구서 자동 갱신 실패', true);
      });
    }
  } catch (err) {
    console.error(err);
    toast('일괄 저장 실패: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 추가 저장';
  }
}

function toNum(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ===========================================================
// 청구서 자동 동기화 (카운터 → rental_billings)
// rental-billing/index.js 의 computeBilling 로직을 미러링.
// sent / paid / void 상태는 잠금 → 건너뜀, 그 외는 draft 로 upsert.
// ===========================================================
const BILLING_FIXED_CATS = ['IT', '위생', '출력'];
const BILLING_LOCKED_STATUSES = new Set(['sent', 'paid', 'void']);

function computeCustomerBilling(customerId) {
  const myItems = state.items.filter(it => it.customer_id === customerId);
  const combined = !!state.customerCombined[customerId];
  const fixedItems = [];
  const usageItems = [];

  // 고정비 (IT/위생/출력 monthly_fee)
  for (const it of myItems) {
    const cat = it.category;
    if (BILLING_FIXED_CATS.includes(cat) && (it.monthly_fee || 0) > 0) {
      fixedItems.push({
        item_id: it.id,
        kind: 'fixed',
        category: cat,
        subtype: it.subtype,
        label: `${cat}/${it.subtype}${it.model ? ' ' + it.model : ''}`,
        qty: 1,
        unit_price: it.monthly_fee || 0,
        subtotal: it.monthly_fee || 0,
      });
    }
  }

  // 출력 사용량
  const printItems = myItems.filter(it => it.category === '출력');

  if (combined && printItems.length >= 2) {
    // === 합산 모드: 자산별 월카운터를 합산해 한 항목으로 ===
    let monthBwT = 0, monthCoT = 0, bwFreeT = 0, coFreeT = 0;
    let curBwT = 0, curCoT = 0, prevBwT = 0, prevCoT = 0;
    let bwRate = 0, coRate = 0;
    const itemIds = [];
    const labels = [];
    for (const it of printItems) {
      const cnt  = state.curMap[it.id]  || { bw: 0, color: 0 };
      const prev = state.prevMap[it.id] || { bw: 0, color: 0 };
      const monthBw = Math.max(0, (cnt.bw    || 0) - (prev.bw    || 0));
      const monthCo = Math.max(0, (cnt.color || 0) - (prev.color || 0));
      monthBwT += monthBw; monthCoT += monthCo;
      bwFreeT  += it.bw_free || 0; coFreeT  += it.co_free || 0;
      curBwT   += cnt.bw   || 0; curCoT   += cnt.color || 0;
      prevBwT  += prev.bw  || 0; prevCoT  += prev.color || 0;
      if (!bwRate) bwRate = it.bw_rate || 0;
      if (!coRate) coRate = it.co_rate || 0;
      itemIds.push(it.id);
      labels.push(`${it.subtype || ''}${it.model ? ' '+it.model : ''}`.trim());
    }
    const exBw = Math.max(0, monthBwT - bwFreeT);
    const exCo = Math.max(0, monthCoT - coFreeT);
    const sub  = exBw * bwRate + exCo * coRate;
    if (sub > 0) {
      usageItems.push({
        item_id: itemIds.join(','),
        kind: 'usage',
        category: '출력',
        subtype: 'combined',
        label: `출력 합산 (${printItems.length}대: ${labels.filter(Boolean).join(' + ')}) 초과사용`,
        bw: exBw,
        co: exCo,
        month_bw: monthBwT,
        month_co: monthCoT,
        bw_rate: bwRate,
        co_rate: coRate,
        counter_bw_prev: prevBwT,
        counter_color_prev: prevCoT,
        counter_bw: curBwT,
        counter_color: curCoT,
        bw_free: bwFreeT,
        co_free: coFreeT,
        subtotal: sub,
        combined: true,
      });
    }
  } else {
    // === 자산별 모드 ===
    for (const it of printItems) {
      const cnt  = state.curMap[it.id]  || { bw: 0, color: 0 };
      const prev = state.prevMap[it.id] || { bw: 0, color: 0 };
      const monthBw = Math.max(0, (cnt.bw    || 0) - (prev.bw    || 0));
      const monthCo = Math.max(0, (cnt.color || 0) - (prev.color || 0));
      const exBw = Math.max(0, monthBw - (it.bw_free || 0));
      const exCo = Math.max(0, monthCo - (it.co_free || 0));
      const sub = exBw * (it.bw_rate || 0) + exCo * (it.co_rate || 0);
      if (sub > 0) {
        usageItems.push({
          item_id: it.id,
          kind: 'usage',
          category: '출력',
          subtype: it.subtype,
          label: `${it.subtype}${it.model ? ' ' + it.model : ''} 초과사용`,
          bw: exBw,
          co: exCo,
          month_bw: monthBw,
          month_co: monthCo,
          bw_rate: it.bw_rate || 0,
          co_rate: it.co_rate || 0,
          counter_bw_prev: prev.bw || 0,
          counter_color_prev: prev.color || 0,
          counter_bw: cnt.bw || 0,
          counter_color: cnt.color || 0,
          bw_free: it.bw_free || 0,
          co_free: it.co_free || 0,
          subtotal: sub,
        });
      }
    }
  }

  const fixed_total = fixedItems.reduce((s, x) => s + x.subtotal, 0);
  const usage_total = usageItems.reduce((s, x) => s + x.subtotal, 0);
  return {
    fixed_total,
    usage_total,
    total: fixed_total + usage_total,
    items: [...fixedItems, ...usageItems],
    combined,
  };
}

async function autoUpdateBillings(customerIds, { silent = false } = {}) {
  // 다개월 거래처(분기/반기/연간)는 카운터 페이지에서 자동 갱신하지 않음
  // (정확한 N개월 합산은 청구 페이지에서 발행)
  const uniq = [...new Set((customerIds || []).filter(Boolean))]
    .filter(cid => (Number(state.customerPeriod[cid]) || 1) === 1);
  if (!uniq.length) return { ok: 0, skipped: 0, empty: 0 };

  const ym = state.ym;

  // 기존 청구서 상태 조회
  const { data: existRows, error: exErr } = await supa.from('rental_billings')
    .select('id, customer_id, ym, status')
    .eq('ym', ym)
    .in('customer_id', uniq);
  if (exErr) throw exErr;

  const existMap = new Map();
  for (const b of (existRows || [])) existMap.set(b.customer_id, b);

  const rows = [];
  let skipped = 0, empty = 0;

  for (const cid of uniq) {
    const ex = existMap.get(cid);
    if (ex && BILLING_LOCKED_STATUSES.has(ex.status)) { skipped++; continue; }

    const calc = computeCustomerBilling(cid);
    // 추가요금(usage)이 발생한 거래처만 청구서 발행
    if ((calc.usage_total || 0) <= 0) { empty++; continue; }

    rows.push({
      id: `b_${cid}_${ym}`,
      customer_id: cid,
      ym,
      fixed_total: calc.fixed_total,
      usage_total: calc.usage_total,
      items: calc.items,
      status: ex?.status || 'draft',
    });
  }

  if (!rows.length) {
    if (!silent) toast(`청구서 갱신 대상 없음 (잠금 ${skipped}건)`);
    return { ok: 0, skipped, empty };
  }

  const { error: upErr } = await supa.from('rental_billings')
    .upsert(rows, { onConflict: 'customer_id,ym' });
  if (upErr) throw upErr;

  if (!silent) {
    const parts = [`청구서 ${rows.length}건 자동 갱신`];
    if (skipped) parts.push(`잠긴 ${skipped}건 스킵`);
    toast(parts.join(' · '));
  }
  return { ok: rows.length, skipped, empty };
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.style.background = isError ? '#dc2626' : '#0f172a';
  el.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 1800);
}
