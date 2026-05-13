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
  customerId: '',
  category: '',
  onlyMissing: false,
  items: [],            // 자산 + 배정 + 거래처
  curMap: {},           // item_id → 이번달 row
  prevMap: {},          // item_id → 이전월 row
  histMap: {},          // item_id → [ {ym, bw, color, uptime_hours} ... ]  (최근 6개월)
  suppliesMap: {},      // item_id → 최근 supplies row
  customers: [],
};

if (window.totalasAuth) {
  init();
} else {
  document.addEventListener('totalas:ready', init, { once: true });
  // 안전망
  setTimeout(() => { if (!state.items.length) init(); }, 2000);
}

async function init() {
  if (!supa) {
    toast('Supabase 클라이언트 초기화 실패', true);
    return;
  }
  // 초기 월 셀렉터
  document.getElementById('f-month').value = state.ym;
  document.getElementById('f-month').addEventListener('change', e => { state.ym = e.target.value || ymOfNow(); reload(); });
  document.getElementById('f-customer').addEventListener('change', e => { state.customerId = e.target.value; render(); });
  document.getElementById('f-category').addEventListener('change', e => { state.category = e.target.value; render(); });
  document.getElementById('f-only-missing').addEventListener('change', e => { state.onlyMissing = e.target.checked; render(); });
  document.getElementById('btn-refresh').addEventListener('click', reload);

  initExcelImport();

  await reload();
}

async function reload() {
  setBodyLoading();
  try {
    await Promise.all([loadCustomers(), loadItems(), loadCounters(), loadSupplies()]);
    fillCustomerFilter();
    render();
    updateExcelTargetYm();
    rematchExcelRows();
  } catch (err) {
    console.error(err);
    toast('로드 실패: ' + (err.message || err), true);
    document.getElementById('grid-body').innerHTML =
      `<tr><td colspan="10" style="text-align:center; padding:20px; color:#dc2626;">데이터 로드 실패: ${escapeHtml(err.message || String(err))}</td></tr>`;
  }
}

async function loadCustomers() {
  const { data, error } = await supa.from('rental_customers')
    .select('id, company').order('company');
  if (error) throw error;
  state.customers = data || [];
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
  const { data, error } = await supa.from('rental_counters')
    .select('item_id, ym, bw, color, uptime_hours, read_at, source')
    .in('ym', monthsBack);
  if (error) throw error;

  const prevYm = listMonthsBack(state.ym, 2)[1]; // 직전월
  state.curMap = {};
  state.prevMap = {};
  state.histMap = {};

  for (const r of (data || [])) {
    if (r.ym === state.ym) state.curMap[r.item_id] = r;
    else if (r.ym === prevYm) state.prevMap[r.item_id] = r;
    if (r.ym !== state.ym) {
      (state.histMap[r.item_id] ||= []).push(r);
    }
  }
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

function fillCustomerFilter() {
  const sel = document.getElementById('f-customer');
  const cur = state.customerId;
  // 자산에 실제 배정된 거래처만
  const inUse = new Set(state.items.map(i => i.customer_id).filter(Boolean));
  const list = state.customers.filter(c => inUse.has(c.id));
  sel.innerHTML = '<option value="">전체</option>' +
    list.map(c => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.company)}</option>`).join('');
  if (cur) sel.value = cur;
}

function render() {
  const tbody = document.getElementById('grid-body');
  const rows = state.items
    .filter(it => !state.customerId || it.customer_id === state.customerId)
    .filter(it => !state.category || (it.category === state.category))
    .map(it => buildRow(it))
    .filter(r => !state.onlyMissing || r.missing);

  // 통계
  let totalBW = 0, totalCO = 0, alerts = 0, entered = 0, missing = 0;
  for (const r of rows) {
    const cur = state.curMap[r.item.id];
    if (cur) {
      entered++;
      totalBW += (cur.bw || 0);
      totalCO += (cur.color || 0);
    } else {
      missing++;
    }
    if (r.anomaly) alerts++;
  }
  document.getElementById('st-entered').textContent = entered.toLocaleString();
  document.getElementById('st-bw').textContent = totalBW.toLocaleString();
  document.getElementById('st-co').textContent = totalCO.toLocaleString();
  document.getElementById('st-missing').textContent = missing.toLocaleString();
  document.getElementById('st-alerts').textContent = alerts.toLocaleString();
  document.getElementById('row-count').textContent = `${rows.length}개 자산`;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="muted-small" style="text-align:center; padding:30px;">조건에 맞는 자산이 없습니다.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => renderRow(r)).join('');
  attachCellHandlers();
}

function buildRow(item) {
  const cur  = state.curMap[item.id]  || null;
  const prev = state.prevMap[item.id] || null;
  const hist = state.histMap[item.id] || [];

  const isMeter = (item.category === 'printer') || ['laser', 'inkjet', '복합기'].includes(item.subtype);
  const isUptime = ['pc', 'nas'].includes(item.category) || ['pc', 'nas'].includes(item.subtype);

  const bw_cur   = cur?.bw ?? null;
  const co_cur   = cur?.color ?? null;
  const up_cur   = cur?.uptime_hours ?? null;
  const bw_prev  = prev?.bw ?? null;
  const co_prev  = prev?.color ?? null;

  const bw_inc = (bw_cur != null && bw_prev != null) ? Math.max(0, bw_cur - bw_prev) : null;
  const co_inc = (co_cur != null && co_prev != null) ? Math.max(0, co_cur - co_prev) : null;

  // 이전 6개월 평균 증가량 (cur 직전 6개)
  const avgBW = avgIncrease(hist, 'bw');
  const avgCO = avgIncrease(hist, 'color');
  const anomaly =
    (bw_inc != null && avgBW > 0 && bw_inc > avgBW * 3) ||
    (co_inc != null && avgCO > 0 && co_inc > avgCO * 3);

  // 소모품 잔여 예측
  const supplyForecast = forecastSupply(item, bw_inc, co_inc);

  return {
    item, cur, prev, isMeter, isUptime,
    bw_prev, bw_cur, bw_inc,
    co_prev, co_cur, co_inc,
    up_cur,
    avgBW, avgCO,
    anomaly,
    supplyForecast,
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
  const meterCells = r.isUptime && !r.isMeter
    ? `
      <td class="num" style="text-align:right; color:#94a3b8;">N/A</td>
      <td class="num" style="text-align:right; color:#94a3b8;">N/A</td>
      <td class="num" style="text-align:right; color:#94a3b8;">N/A</td>
      <td class="num" style="text-align:right; color:#94a3b8;">N/A</td>
      <td class="num" style="text-align:right; color:#94a3b8;">N/A</td>
      <td class="num" style="text-align:right; color:#94a3b8;">N/A</td>
    `
    : `
      <td class="num" style="text-align:right; color:#64748b;">${fmt(r.bw_prev)}</td>
      <td class="num" style="text-align:right;">
        <input type="number" class="cell-edit num" data-item="${escapeAttr(rowId)}" data-field="bw" value="${r.bw_cur ?? ''}" placeholder="–">
      </td>
      <td class="num" style="text-align:right; ${r.anomaly && r.bw_inc != null && r.avgBW > 0 && r.bw_inc > r.avgBW * 3 ? 'color:#dc2626;font-weight:600;' : ''}">${fmt(r.bw_inc)}</td>
      <td class="num" style="text-align:right; color:#64748b;">${fmt(r.co_prev)}</td>
      <td class="num" style="text-align:right;">
        <input type="number" class="cell-edit num" data-item="${escapeAttr(rowId)}" data-field="color" value="${r.co_cur ?? ''}" placeholder="–">
      </td>
      <td class="num" style="text-align:right; ${r.anomaly && r.co_inc != null && r.avgCO > 0 && r.co_inc > r.avgCO * 3 ? 'color:#dc2626;font-weight:600;' : ''}">${fmt(r.co_inc)}</td>
    `;

  const uptimeCell = r.isUptime
    ? `<td class="num" style="text-align:right;"><input type="number" class="cell-edit num" data-item="${escapeAttr(rowId)}" data-field="uptime_hours" value="${r.up_cur ?? ''}" placeholder="–"></td>`
    : `<td class="num" style="text-align:right; color:#94a3b8;">–</td>`;

  // 경고/예측 셀
  const badges = [];
  if (r.anomaly) badges.push(`<span style="color:#dc2626; font-weight:600;" title="이전 6개월 평균의 3배 초과">🔴 이상치</span>`);
  for (const f of (r.supplyForecast || [])) {
    if (f.days == null) continue;
    if (f.days <= 30) {
      badges.push(`<span style="color:#d97706;" title="${escapeAttr(f.kind)} 교체 ${f.days}일 이내">⚠ ${escapeHtml(f.kind)} ${f.days}일</span>`);
    }
  }
  const warnCell = badges.length
    ? `<td>${badges.join(' · ')}</td>`
    : `<td class="muted-small">정상</td>`;

  const subtag = it.subtype ? `<span class="muted-small">/${escapeHtml(it.subtype)}</span>` : '';
  const meterTag = r.isMeter ? '🖨' : (r.isUptime ? '💻' : '📦');

  return `
    <tr data-row="${escapeAttr(rowId)}">
      <td>
        <div style="font-weight:600;">${escapeHtml(it.customer_name)}</div>
        <div class="muted-small">${escapeHtml(it.brand || '')} ${escapeHtml(it.model || rowId)}</div>
      </td>
      <td style="text-align:center;">${meterTag} <span class="muted-small">${escapeHtml(it.category || '')}${subtag ? ' ' + subtag : ''}</span></td>
      ${meterCells}
      ${uptimeCell}
      ${warnCell}
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
    inp.classList.add('saved');
    setTimeout(() => inp.classList.remove('saved'), 900);
    // 통계 즉시 갱신
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => render(), 250);
    toast('저장됨');
  } catch (err) {
    console.error(err);
    toast('저장 실패: ' + (err.message || err), true);
  }
}

// ---------- utils ----------
function setBodyLoading() {
  document.getElementById('grid-body').innerHTML =
    '<tr><td colspan="10" class="muted-small" style="text-align:center; padding:30px;">데이터 로딩 중…</td></tr>';
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

  save.addEventListener('click', saveExcelBatch);

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
    toast(`${excelState.rows.length}행 로드됨`);
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
    if (r.status === 'ok')   ok++;
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
      r.status === 'ok'   ? `<span class="excel-badge ok">✔ 매칭</span>`
    : r.status === 'warn' ? `<span class="excel-badge warn">⚠ ${escapeHtml(r.note || '확인필요')}</span>`
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

async function saveExcelBatch() {
  const targets = excelState.rows.filter(r => r.status === 'ok' && r.itemId);
  if (!targets.length) { toast('저장할 행이 없습니다', true); return; }

  const btn = document.getElementById('btn-excel-save');
  btn.disabled = true;
  btn.textContent = '저장 중…';

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

    for (const p of payloads) state.curMap[p.item_id] = p;
    toast(`${payloads.length}건 저장됨`);
    render();
    renderExcelPreview();
  } catch (err) {
    console.error(err);
    toast('일괄 저장 실패: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 최종 저장';
  }
}

function toNum(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
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
