// ===========================================================
// totalas — 임대현황 (rental-status) 모듈
// Supabase 실데이터 기반 자산 가동률/노후도/카테고리 분포
// 의존: window.totalasAuth (auth.js 가 부착), supabase-js v2
// ===========================================================
(function () {
  'use strict';

  // ----- 상수 -----
  const CATEGORIES = ['IT', '출력', '위생'];
  const SUBTYPES_BY_CAT = {
    'IT':    ['PC', 'monitor', 'NAS'],
    '출력':  ['잉크젯', '레이저', '복합기'],
    '위생':  ['웰리스'],
  };
  const REPLACE_THRESHOLD_MONTHS = 60; // 5년 이상 -> 교체 검토

  // ----- 상태 -----
  /** @type {{items: any[], assignments: any[], customers: any[]}} */
  const state = { items: [], assignments: [], customers: [] };
  const filters = { q: '', cat: '', sub: '', status: '', assign: '' };

  // ----- DOM 헬퍼 -----
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') e.className = v;
        else if (k === 'style') e.style.cssText = v;
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (v != null) e.setAttribute(k, v);
      }
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      e.appendChild(typeof c === 'string' || typeof c === 'number'
        ? document.createTextNode(String(c))
        : c);
    }
    return e;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, m =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  }
  function fmtDate(d) {
    if (!d) return '–';
    const s = String(d);
    return s.length >= 10 ? s.slice(0, 10) : s;
  }

  // ----- 노후도 계산 (DB age_months 없거나 누락 시 fallback) -----
  function computeAgeMonths(item) {
    if (item.age_months != null && !Number.isNaN(Number(item.age_months))) {
      return Math.max(0, Math.round(Number(item.age_months)));
    }
    if (!item.install_date) return null;
    const ins = new Date(item.install_date);
    if (Number.isNaN(ins.getTime())) return null;
    const now = new Date();
    return (now.getFullYear() - ins.getFullYear()) * 12
         + (now.getMonth() - ins.getMonth());
  }
  function agePill(months) {
    if (months == null) return '<span class="age-pill ok">–</span>';
    let cls = 'ok';
    if (months >= REPLACE_THRESHOLD_MONTHS) cls = 'bad';
    else if (months >= 36) cls = 'warn';
    return `<span class="age-pill ${cls}">${months}개월</span>`;
  }
  function statusTag(s) {
    const safe = String(s || 'active').toLowerCase();
    return `<span class="status-tag ${safe}">${escapeHtml(safe)}</span>`;
  }

  // ----- 데이터 로드 -----
  async function loadAll() {
    const supa = window.totalasAuth;
    if (!supa) throw new Error('Supabase 클라이언트(window.totalasAuth) 미초기화');

    // PostgREST 기본 1000 row 한도 → .range(0, 9999) 로 여유 확보
    const [itRes, asRes, cuRes] = await Promise.all([
      supa.from('rental_items').select('*').range(0, 9999),
      supa.from('rental_assignments').select('*').range(0, 9999),
      supa.from('rental_customers').select('id, company, contact_name, active').range(0, 9999),
    ]);

    if (itRes.error) throw itRes.error;
    if (asRes.error) throw asRes.error;
    if (cuRes.error) throw cuRes.error;

    state.items = itRes.data || [];
    state.assignments = asRes.data || [];
    state.customers = cuRes.data || [];
  }

  // ----- 파생 데이터 -----
  /** 활성(end_date 없거나 미래) 배정만 추출 */
  function activeAssignments() {
    const today = new Date().toISOString().slice(0, 10);
    return state.assignments.filter(a => !a.end_date || a.end_date >= today);
  }
  /** item_id → 활성 배정 (최신 시작일) */
  function buildItemAssignMap() {
    const map = new Map();
    const acts = activeAssignments().sort((a, b) =>
      String(b.start_date || '').localeCompare(String(a.start_date || '')));
    for (const a of acts) {
      if (!map.has(a.item_id)) map.set(a.item_id, a);
    }
    return map;
  }
  function buildCustomerMap() {
    const m = new Map();
    for (const c of state.customers) m.set(c.id, c);
    return m;
  }

  // ----- 렌더링 -----
  function renderStats() {
    const items = state.items;
    const total = items.length;
    const active = items.filter(i => (i.status || 'active') === 'active').length;
    const assignMap = buildItemAssignMap();
    const idle = items.filter(i => (i.status || 'active') === 'active' && !assignMap.has(i.id)).length;

    const activeItems = items.filter(i => (i.status || 'active') === 'active');
    const ages = activeItems.map(computeAgeMonths).filter(v => v != null);
    const avgAge = ages.length ? Math.round(ages.reduce((s, v) => s + v, 0) / ages.length) : null;
    const old5y = activeItems.filter(i => {
      const m = computeAgeMonths(i);
      return m != null && m >= REPLACE_THRESHOLD_MONTHS;
    }).length;
    const util = total ? Math.round((active - idle) / Math.max(1, total) * 100) : 0;

    $('#stat-total').textContent = total.toLocaleString();
    $('#stat-total-sub').textContent = `등록된 자산 총 ${total.toLocaleString()}건`;
    $('#stat-active').textContent = active.toLocaleString();
    $('#stat-active-sub').textContent = total
      ? `${Math.round(active / total * 100)}% (활성/전체)` : '–';
    $('#stat-idle').textContent = idle.toLocaleString();
    $('#stat-idle-sub').textContent = active
      ? `활성 자산 중 ${Math.round(idle / Math.max(1, active) * 100)}%` : '–';
    $('#stat-avgage').innerHTML = avgAge != null
      ? `${avgAge}<span class="unit">개월</span>` : '–';
    $('#stat-avgage-sub').textContent = ages.length
      ? `${ages.length}건 평균` : '도입일 없음';
    $('#stat-old5y').textContent = old5y.toLocaleString();
    $('#stat-old5y-sub').textContent = `60개월(5년)↑`;
    $('#stat-util').innerHTML = `${util}<span class="unit">%</span>`;
  }

  function renderCategoryGrid() {
    const grid = $('#cat-grid');
    grid.innerHTML = '';

    // 카테고리 → subtype → count 집계
    const counts = {};
    for (const c of CATEGORIES) {
      counts[c] = {};
      for (const s of (SUBTYPES_BY_CAT[c] || [])) counts[c][s] = 0;
      counts[c].__OTHER__ = 0;
    }
    for (const it of state.items) {
      const cat = counts[it.category] ? it.category : null;
      if (!cat) continue;
      const sub = it.subtype || '';
      if (counts[cat][sub] != null) counts[cat][sub] += 1;
      else counts[cat].__OTHER__ += 1;
    }

    const ICONS = { 'IT':'💻', '출력':'🖨', '위생':'🌿' };

    for (const cat of CATEGORIES) {
      const subs = SUBTYPES_BY_CAT[cat] || [];
      const tot = Object.values(counts[cat]).reduce((s, v) => s + v, 0);
      const ul = el('ul');
      for (const s of subs) {
        ul.appendChild(el('li', null,
          el('span', { class: 'sub-name' }, `${s}`),
          el('span', { class: 'sub-count' }, `${counts[cat][s]}건`)));
      }
      if (counts[cat].__OTHER__ > 0) {
        ul.appendChild(el('li', null,
          el('span', { class: 'sub-name' }, '(기타)'),
          el('span', { class: 'sub-count' }, `${counts[cat].__OTHER__}건`)));
      }
      const card = el('div', { class: 'cat-card' },
        el('h3', null,
          document.createTextNode(`${ICONS[cat] || '📦'} ${cat}`),
          el('span', { class: 'muted-small' }, `${tot}건`)),
        el('div', { class: 'cat-total' }, `${tot}`),
        ul);
      grid.appendChild(card);
    }
  }

  function renderNasArea() {
    const area = $('#nas-area');
    area.innerHTML = '';

    const nasItems = state.items.filter(i =>
      (i.subtype === 'NAS') || (i.storage_gb != null));

    if (nasItems.length === 0) {
      area.appendChild(el('div', { class: 'nas-card' },
        el('div', { class: 'nas-icon' }, '💾'),
        el('div', { class: 'nas-text' },
          el('h3', null, 'NAS 자산 없음 — 확장 대비 영역'),
          el('p', null,
            '차후 NAS 렌탈 도입 시 ',
            el('code', null, 'rental_items.storage_gb'),
            ' 컬럼에 용량(GB)을 기록하면 이 영역에 표시됩니다.'))));
      return;
    }

    const totalGB = nasItems.reduce((s, i) => s + (Number(i.storage_gb) || 0), 0);
    const card = el('div', { class: 'card', style: 'padding: 4px;' });
    const wrap = el('div', { class: 'scroll-x' });
    const table = el('table', { class: 'data-table' });
    table.innerHTML = `
      <thead><tr>
        <th>#</th><th>브랜드 / 모델</th><th>시리얼</th>
        <th class="num">용량(GB)</th><th>도입일</th><th class="num">노후도</th><th>상태</th>
      </tr></thead><tbody></tbody>`;
    const tb = $('tbody', table);
    nasItems
      .sort((a, b) => (Number(b.storage_gb) || 0) - (Number(a.storage_gb) || 0))
      .forEach((it, idx) => {
        const m = computeAgeMonths(it);
        tb.insertAdjacentHTML('beforeend', `
          <tr>
            <td>${idx + 1}</td>
            <td>${escapeHtml(it.brand || '–')} / ${escapeHtml(it.model || '–')}</td>
            <td>${escapeHtml(it.serial || '–')}</td>
            <td class="num">${it.storage_gb != null ? Number(it.storage_gb).toLocaleString() : '–'}</td>
            <td>${fmtDate(it.install_date)}</td>
            <td class="num">${agePill(m)}</td>
            <td>${statusTag(it.status)}</td>
          </tr>`);
      });
    wrap.appendChild(table);
    card.appendChild(wrap);

    const summary = el('div', { class: 'muted-small', style:'padding:8px 12px; text-align:right;' },
      `NAS 자산 ${nasItems.length}건 · 누적 용량 ${totalGB.toLocaleString()} GB`);
    card.appendChild(summary);
    area.appendChild(card);
  }

  function renderAgeTop() {
    const tb = $('#age-top-table tbody');
    tb.innerHTML = '';
    const rows = state.items
      .map(it => ({ it, age: computeAgeMonths(it) }))
      .filter(x => x.age != null)
      .sort((a, b) => b.age - a.age)
      .slice(0, 10);

    if (rows.length === 0) {
      tb.innerHTML = `<tr><td colspan="9" class="empty-row">노후도 계산 가능한 자산이 없습니다.</td></tr>`;
      return;
    }
    rows.forEach(({ it, age }, idx) => {
      const replace = age >= REPLACE_THRESHOLD_MONTHS;
      tb.insertAdjacentHTML('beforeend', `
        <tr>
          <td>${idx + 1}</td>
          <td>${escapeHtml(it.category || '–')}</td>
          <td>${escapeHtml(it.subtype || '–')}</td>
          <td>${escapeHtml(it.brand || '–')} / ${escapeHtml(it.model || '–')}</td>
          <td>${escapeHtml(it.serial || '–')}</td>
          <td class="num">${agePill(age)}</td>
          <td>${fmtDate(it.install_date)}</td>
          <td>${statusTag(it.status)}</td>
          <td>${replace ? '<span class="replace-tag">교체</span>' : ''}</td>
        </tr>`);
    });
  }

  function renderIdleTable() {
    const tb = $('#idle-table tbody');
    tb.innerHTML = '';
    const assignMap = buildItemAssignMap();
    const idle = state.items.filter(i =>
      (i.status || 'active') === 'active' && !assignMap.has(i.id));

    $('#idle-hint').textContent = `활성이지만 거래처 미배정 · 총 ${idle.length}건`;
    if (idle.length === 0) {
      tb.innerHTML = `<tr><td colspan="8" class="empty-row">🎉 모든 활성 자산이 배정되었습니다.</td></tr>`;
      return;
    }
    idle
      .sort((a, b) => (computeAgeMonths(b) ?? -1) - (computeAgeMonths(a) ?? -1))
      .forEach((it, idx) => {
        const m = computeAgeMonths(it);
        tb.insertAdjacentHTML('beforeend', `
          <tr>
            <td>${idx + 1}</td>
            <td>${escapeHtml(it.category || '–')}</td>
            <td>${escapeHtml(it.subtype || '–')}</td>
            <td>${escapeHtml(it.brand || '–')} / ${escapeHtml(it.model || '–')}</td>
            <td>${escapeHtml(it.serial || '–')}</td>
            <td class="num">${agePill(m)}</td>
            <td>${fmtDate(it.install_date)}</td>
            <td>${statusTag(it.status)}</td>
          </tr>`);
      });
  }

  // ===== 전체 자산 (검색·필터) =====
  function populateFilterSelects() {
    const cats = new Set();
    const subs = new Set();
    for (const it of state.items) {
      if (it.category) cats.add(it.category);
      if (it.subtype)  subs.add(it.subtype);
    }
    const fCat = $('#f-cat');
    const fSub = $('#f-sub');
    for (const c of Array.from(cats).sort()) fCat.appendChild(el('option', { value: c }, c));
    for (const s of Array.from(subs).sort()) fSub.appendChild(el('option', { value: s }, s));
  }

  function renderAllTable() {
    const tb = $('#all-table tbody');
    tb.innerHTML = '';
    const assignMap = buildItemAssignMap();
    const custMap = buildCustomerMap();

    const q = filters.q.trim().toLowerCase();
    const filtered = state.items.filter(it => {
      if (filters.cat && it.category !== filters.cat) return false;
      if (filters.sub && it.subtype !== filters.sub) return false;
      if (filters.status && (it.status || 'active') !== filters.status) return false;
      const has = assignMap.has(it.id);
      if (filters.assign === 'assigned' && !has) return false;
      if (filters.assign === 'idle' && has) return false;
      if (q) {
        const hay = [it.brand, it.model, it.serial, it.notes, it.subtype, it.category]
          .map(v => (v == null ? '' : String(v).toLowerCase())).join(' ');
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    $('#f-count').textContent = `${filtered.length.toLocaleString()} 건`;

    if (filtered.length === 0) {
      tb.innerHTML = `<tr><td colspan="9" class="empty-row">조건에 맞는 자산이 없습니다.</td></tr>`;
      return;
    }

    // 최대 500건만 렌더 (모바일 성능)
    const MAX_RENDER = 500;
    const slice = filtered.slice(0, MAX_RENDER);
    const html = slice.map((it, idx) => {
      const m = computeAgeMonths(it);
      const a = assignMap.get(it.id);
      const cust = a && custMap.get(a.customer_id);
      const custLabel = cust
        ? escapeHtml(cust.company || cust.contact_name || '–')
        : '<span class="muted">미배정</span>';
      return `
        <tr>
          <td>${idx + 1}</td>
          <td>${escapeHtml(it.category || '–')}</td>
          <td>${escapeHtml(it.subtype || '–')}</td>
          <td>${escapeHtml(it.brand || '–')} / ${escapeHtml(it.model || '–')}</td>
          <td>${escapeHtml(it.serial || '–')}</td>
          <td class="num">${agePill(m)}</td>
          <td>${fmtDate(it.install_date)}</td>
          <td>${statusTag(it.status)}</td>
          <td>${custLabel}</td>
        </tr>`;
    }).join('');
    tb.insertAdjacentHTML('beforeend', html);

    if (filtered.length > MAX_RENDER) {
      tb.insertAdjacentHTML('beforeend',
        `<tr><td colspan="9" class="empty-row">… 외 ${filtered.length - MAX_RENDER}건 (필터를 좁혀 주세요)</td></tr>`);
    }
  }

  // ----- 이벤트 바인딩 -----
  function bindFilters() {
    $('#f-q').addEventListener('input', (e) => {
      filters.q = e.target.value; renderAllTable();
    });
    $('#f-cat').addEventListener('change', (e) => {
      filters.cat = e.target.value; renderAllTable();
    });
    $('#f-sub').addEventListener('change', (e) => {
      filters.sub = e.target.value; renderAllTable();
    });
    $('#f-status').addEventListener('change', (e) => {
      filters.status = e.target.value; renderAllTable();
    });
    $('#f-assign').addEventListener('change', (e) => {
      filters.assign = e.target.value; renderAllTable();
    });
    $('#btn-refresh').addEventListener('click', async () => {
      $('#btn-refresh').disabled = true;
      try { await refresh(); } finally { $('#btn-refresh').disabled = false; }
    });
  }

  // ----- 메인 -----
  function renderAll() {
    renderStats();
    renderCategoryGrid();
    renderNasArea();
    renderAgeTop();
    renderIdleTable();
    renderAllTable();
  }

  async function refresh() {
    try {
      await loadAll();
      populateFilterSelectsIfEmpty();
      renderAll();
    } catch (err) {
      console.error('[rental-status] 로드 실패:', err);
      const msg = (err && (err.message || err.hint)) || String(err);
      // 첫 카드 위에 에러 배너 표기
      let banner = document.getElementById('rs-err-banner');
      if (!banner) {
        banner = el('div', {
          id: 'rs-err-banner',
          class: 'card',
          style: 'padding:14px; border-color:#fecaca; background:#fef2f2; color:#991b1b; margin-bottom:14px;'
        });
        $('main.container').insertBefore(banner, $('.stats'));
      }
      banner.innerHTML = `⚠️ 데이터 로드 실패: <code>${escapeHtml(msg)}</code><br>
        <span class="muted-small">Supabase 스키마(rental_items / rental_assignments / rental_customers) 적용 여부를 확인해 주세요.</span>`;
    }
  }

  let _filterSelectsBuilt = false;
  function populateFilterSelectsIfEmpty() {
    if (_filterSelectsBuilt) return;
    populateFilterSelects();
    _filterSelectsBuilt = true;
  }

  // window.totalasAuth 는 auth.js 가 비동기 부착 → totalas:ready 이벤트 대기
  function start() {
    bindFilters();
    if (window.totalasAuth) {
      refresh();
    } else {
      document.addEventListener('totalas:ready', () => refresh(), { once: true });
      // 안전망: 3초 후에도 없으면 에러 표시
      setTimeout(() => {
        if (!window.totalasAuth) {
          console.warn('[rental-status] Supabase 미초기화 — auth.js 확인 필요');
        }
      }, 3000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
