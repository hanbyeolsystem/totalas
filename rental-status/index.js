// ============================================================
// totalas — 임대현황 v2 (rental-status)
// 거래처 / 자산 / 노후도 / 메모 — 4탭 종합 대시보드
// 의존: window.totalasAuth (auth.js), supabase-js v2
// ============================================================
(function () {
  'use strict';

  // ---------- 상수 ----------
  const CATEGORIES = ['IT', '출력', '위생'];
  const REPLACE_THRESHOLD_MONTHS = 60; // 5년
  const WARN_THRESHOLD_MONTHS = 36;    // 3년
  const MAX_RENDER = 1000;

  // ---------- 상태 ----------
  const state = {
    customers: [],
    items: [],
    assignments: [],
    activeTab: 'customers',
    loaded: false,
    filters: {
      cust: { q: '', pay: '', cat: '' },
      item: { q: '', cat: '', sub: '', status: '', assign: '' },
      age:  { q: '', cat: '', band: '' },
      memo: { q: '', kind: '' },
    },
  };

  // ---------- DOM 헬퍼 ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, m =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  }
  function fmtDate(d) {
    if (!d) return '–';
    const s = String(d);
    return s.length >= 10 ? s.slice(0, 10) : s;
  }
  function fmtMoney(n) {
    if (n == null || Number.isNaN(Number(n))) return '–';
    return Math.round(Number(n)).toLocaleString('ko-KR');
  }
  function todayStr() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }
  function timeStr() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // ---------- 노후도 ----------
  function ageMonths(item) {
    if (!item || !item.install_date) return null;
    const ins = new Date(item.install_date);
    if (Number.isNaN(ins.getTime())) return null;
    const now = new Date();
    const m = (now.getFullYear() - ins.getFullYear()) * 12
            + (now.getMonth() - ins.getMonth());
    return Math.max(0, m);
  }
  function ageBand(m) {
    if (m == null) return 'none';
    if (m >= REPLACE_THRESHOLD_MONTHS) return 'bad';
    if (m >= WARN_THRESHOLD_MONTHS) return 'warn';
    return 'ok';
  }
  function agePillHtml(m) {
    const band = ageBand(m);
    const label = m == null ? '–' : `${m}개월`;
    return `<span class="age-pill ${band}">${label}</span>`;
  }
  function statusTagHtml(s) {
    const safe = String(s || 'active').toLowerCase();
    return `<span class="status-tag ${safe}">${escapeHtml(safe)}</span>`;
  }
  function payTagHtml(p) {
    if (!p) return '<span class="muted-cell">–</span>';
    const safe = String(p);
    return `<span class="pay-tag ${escapeHtml(safe)}">${escapeHtml(safe)}</span>`;
  }

  // ---------- 데이터 로딩 ----------
  async function loadAll() {
    const supa = window.totalasAuth;
    if (!supa) throw new Error('Supabase 클라이언트(window.totalasAuth) 미초기화');

    const [cuRes, itRes, asRes] = await Promise.all([
      supa.from('rental_customers').select('*').range(0, 9999),
      supa.from('rental_items').select('*').range(0, 9999),
      supa.from('rental_assignments').select('*').range(0, 9999),
    ]);
    if (cuRes.error) throw cuRes.error;
    if (itRes.error) throw itRes.error;
    if (asRes.error) throw asRes.error;

    state.customers = cuRes.data || [];
    state.items = itRes.data || [];
    state.assignments = asRes.data || [];
    state.loaded = true;
  }

  // ---------- 파생 데이터 (Map 조인) ----------
  function activeAssignmentsList() {
    const t = todayStr();
    return state.assignments.filter(a =>
      (!a.end_date || a.end_date >= t) &&
      (!a.start_date || a.start_date <= t));
  }
  function buildItemAssignMap() {
    const map = new Map();
    const acts = activeAssignmentsList().sort((a, b) =>
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
  function buildItemMap() {
    const m = new Map();
    for (const it of state.items) m.set(it.id, it);
    return m;
  }
  /** customer_id -> { items: [...], assignments: [...activeOnly], monthlyFee, byCat:{IT,출력,위생,...}, maxAge } */
  function buildCustomerStats() {
    const itemMap = buildItemMap();
    const stats = new Map();
    const acts = activeAssignmentsList();
    for (const a of acts) {
      const it = itemMap.get(a.item_id);
      if (!it) continue;
      const s = stats.get(a.customer_id) || {
        items: [],
        assignments: [],
        monthlyFee: 0,
        byCat: {},
        maxAge: null,
      };
      s.items.push(it);
      s.assignments.push(a);
      s.monthlyFee += Number(a.monthly_fee || 0);
      const c = it.category || '기타';
      s.byCat[c] = (s.byCat[c] || 0) + 1;
      const ag = ageMonths(it);
      if (ag != null) s.maxAge = s.maxAge == null ? ag : Math.max(s.maxAge, ag);
      stats.set(a.customer_id, s);
    }
    return stats;
  }

  // ---------- 상단 요약 ----------
  function renderTopStats() {
    const activeCust = state.customers.filter(c => c.active !== false && !c.archived_at);
    const items = state.items;
    const activeItems = items.filter(i => (i.status || 'active') === 'active');
    const acts = activeAssignmentsList();

    const totalFee = acts.reduce((s, a) => s + Number(a.monthly_fee || 0), 0);

    const ages = activeItems.map(ageMonths).filter(v => v != null);
    const avgAge = ages.length ? Math.round(ages.reduce((s, v) => s + v, 0) / ages.length) : null;
    const old5y = activeItems.filter(i => {
      const m = ageMonths(i);
      return m != null && m >= REPLACE_THRESHOLD_MONTHS;
    }).length;

    const util = items.length ? Math.round(activeItems.length / items.length * 100) : 0;

    $('#stat-cust').textContent = activeCust.length.toLocaleString();
    $('#stat-cust-sub').textContent = `전체 ${state.customers.length.toLocaleString()}개사`;

    $('#stat-items').textContent = items.length.toLocaleString();
    $('#stat-items-sub').textContent = `활성 ${activeItems.length.toLocaleString()} · 배정 ${acts.length.toLocaleString()}`;

    $('#stat-fee').innerHTML = `${fmtMoney(totalFee)}<span class="unit">원</span>`;
    $('#stat-fee-sub').textContent = `배정 ${acts.length.toLocaleString()}건 합산`;

    $('#stat-avgage').innerHTML = avgAge != null
      ? `${avgAge}<span class="unit">개월</span>` : `–<span class="unit">개월</span>`;
    $('#stat-avgage-sub').textContent = ages.length
      ? `${ages.length.toLocaleString()}건 평균` : '도입일 없음';

    $('#stat-old5y').textContent = old5y.toLocaleString();
    $('#stat-util').innerHTML = `${util}<span class="unit">%</span>`;
  }

  // ---------- 카테고리 빠른 분포 ----------
  function renderCatRow() {
    const row = $('#rs-cat-row');
    // 라벨 이외 제거
    Array.from(row.querySelectorAll('.cat-pill')).forEach(p => p.remove());

    const counts = {};
    for (const it of state.items) {
      const c = it.category || '기타';
      counts[c] = (counts[c] || 0) + 1;
    }
    // 카테고리 순서: IT, 출력, 위생, 기타
    const order = [...CATEGORIES, ...Object.keys(counts).filter(c => !CATEGORIES.includes(c))];
    for (const c of order) {
      if (!counts[c]) continue;
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'cat-pill';
      pill.innerHTML = `<span>${escapeHtml(c)}</span><span class="cat-pill-count">${counts[c]}</span>`;
      pill.addEventListener('click', () => {
        // 자산 탭으로 이동 + 카테고리 필터 적용
        state.filters.item.cat = c;
        switchTab('items');
        const sel = $('#if-cat');
        if (sel) sel.value = c;
        renderItemsTab();
      });
      row.appendChild(pill);
    }
  }

  // ---------- 탭 카운터 ----------
  function refreshTabCounts() {
    $('#tc-customers').textContent =
      state.customers.filter(c => c.active !== false && !c.archived_at).length.toLocaleString();
    $('#tc-items').textContent = state.items.length.toLocaleString();
    $('#tc-age').textContent = state.items.length.toLocaleString();

    let memoCount = 0;
    for (const c of state.customers) if (c.notes && String(c.notes).trim()) memoCount++;
    for (const it of state.items) if (it.notes && String(it.notes).trim()) memoCount++;
    $('#tc-memo').textContent = memoCount.toLocaleString();
  }

  // ---------- 탭 전환 ----------
  function switchTab(tab) {
    state.activeTab = tab;
    $$('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    $$('.tab-panel').forEach(p => {
      p.style.display = p.dataset.tab === tab ? '' : 'none';
    });
  }

  // ========================================================
  // 거래처별 탭
  // ========================================================
  function renderCustomersTab() {
    const tbody = $('#cust-table tbody');
    tbody.innerHTML = '';

    const f = state.filters.cust;
    const q = f.q.trim().toLowerCase();
    const stats = buildCustomerStats();

    // 활성 + 아카이브 안된 거래처
    let rows = state.customers
      .filter(c => c.active !== false && !c.archived_at)
      .map(c => {
        const s = stats.get(c.id) || { items: [], monthlyFee: 0, byCat: {}, maxAge: null };
        return { c, s };
      });

    rows = rows.filter(({ c, s }) => {
      if (f.pay && c.payment_type !== f.pay) return false;
      if (f.cat && !s.byCat[f.cat]) return false;
      if (q) {
        const hay = [c.company, c.address, c.notes, c.contact_name]
          .map(v => (v == null ? '' : String(v).toLowerCase())).join(' ');
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    // 정렬: 자산수 desc, 회사명 asc
    rows.sort((a, b) =>
      (b.s.items.length - a.s.items.length) ||
      String(a.c.company || '').localeCompare(String(b.c.company || ''), 'ko'));

    $('#cf-count').textContent = `${rows.length.toLocaleString()} 건`;

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="11" class="empty-row">조건에 맞는 거래처가 없습니다.</td></tr>`;
      return;
    }

    const slice = rows.slice(0, MAX_RENDER);
    const html = slice.map(({ c, s }, idx) => {
      const dist = Object.entries(s.byCat)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `<span class="mini-pill ${escapeHtml(k)}">${escapeHtml(k)} ${v}</span>`)
        .join(' ');
      const memoText = (c.notes && String(c.notes).trim())
        ? (String(c.notes).length > 60
            ? String(c.notes).slice(0, 60) + '…'
            : String(c.notes))
        : '';
      return `
        <tr class="cust-row" data-cid="${escapeHtml(c.id)}" title="클릭하여 상세 보기">
          <td>${idx + 1}</td>
          <td><strong>${escapeHtml(c.company || '–')}</strong>${c.contact_name ? `<br><span class="muted-cell" style="font-size:11.5px;">${escapeHtml(c.contact_name)}</span>` : ''}</td>
          <td class="num">${s.items.length.toLocaleString()}</td>
          <td><span class="mini-cat-dist">${dist || '<span class="muted-cell">–</span>'}</span></td>
          <td class="num">${s.monthlyFee > 0 ? fmtMoney(s.monthlyFee) : '<span class="muted-cell">–</span>'}</td>
          <td class="hide-mobile">${escapeHtml(c.address || '–')}</td>
          <td>${payTagHtml(c.payment_type)}</td>
          <td class="num hide-mobile">${c.invoice_day != null ? escapeHtml(String(c.invoice_day)) + '일' : '<span class="muted-cell">–</span>'}</td>
          <td class="num hide-mobile">${c.deposit ? fmtMoney(c.deposit) : '<span class="muted-cell">–</span>'}</td>
          <td class="num">${agePillHtml(s.maxAge)}</td>
          <td class="hide-mobile"><span class="memo-cell">${memoText ? escapeHtml(memoText) : '<span class="muted-cell">–</span>'}</span></td>
        </tr>`;
    }).join('');
    tbody.insertAdjacentHTML('beforeend', html);

    if (rows.length > MAX_RENDER) {
      tbody.insertAdjacentHTML('beforeend',
        `<tr><td colspan="11" class="empty-row">… 외 ${rows.length - MAX_RENDER}건 (필터를 좁혀 주세요)</td></tr>`);
    }
  }

  // ========================================================
  // 자산별 탭
  // ========================================================
  function getItemRows() {
    const assignMap = buildItemAssignMap();
    const custMap = buildCustomerMap();
    return state.items.map(it => {
      const a = assignMap.get(it.id);
      const cust = a && custMap.get(a.customer_id);
      return {
        it,
        assignment: a || null,
        customer: cust || null,
        ageM: ageMonths(it),
      };
    });
  }
  function renderItemsTab() {
    const tbody = $('#item-table tbody');
    tbody.innerHTML = '';
    const f = state.filters.item;
    const q = f.q.trim().toLowerCase();

    let rows = getItemRows();

    rows = rows.filter(({ it, customer, assignment }) => {
      if (f.cat && it.category !== f.cat) return false;
      if (f.sub && it.subtype !== f.sub) return false;
      if (f.status && (it.status || 'active') !== f.status) return false;
      const has = !!assignment;
      if (f.assign === 'assigned' && !has) return false;
      if (f.assign === 'idle' && has) return false;
      if (q) {
        const hay = [it.brand, it.model, it.serial, it.subtype, it.category,
                     it.notes, customer && customer.company]
          .map(v => (v == null ? '' : String(v).toLowerCase())).join(' ');
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    // 정렬: 카테고리 > 품목 > 모델
    rows.sort((a, b) =>
      String(a.it.category || '').localeCompare(String(b.it.category || ''), 'ko') ||
      String(a.it.subtype || '').localeCompare(String(b.it.subtype || ''), 'ko') ||
      String(a.it.model || '').localeCompare(String(b.it.model || ''), 'ko'));

    $('#if-count').textContent = `${rows.length.toLocaleString()} 건`;

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" class="empty-row">조건에 맞는 자산이 없습니다.</td></tr>`;
      return;
    }
    const slice = rows.slice(0, MAX_RENDER);
    const html = slice.map(({ it, assignment, customer, ageM }, idx) => {
      const cust = customer
        ? `<strong>${escapeHtml(customer.company || '–')}</strong>`
        : '<span class="muted-cell">미배정</span>';
      const fee = assignment && Number(assignment.monthly_fee) > 0
        ? fmtMoney(assignment.monthly_fee) : '<span class="muted-cell">–</span>';
      return `
        <tr>
          <td>${idx + 1}</td>
          <td>${escapeHtml(it.category || '–')}</td>
          <td>${escapeHtml(it.subtype || '–')}</td>
          <td>${escapeHtml(it.brand || '–')} / ${escapeHtml(it.model || '–')}</td>
          <td class="hide-mobile">${escapeHtml(it.serial || '–')}</td>
          <td>${cust}</td>
          <td class="num hide-mobile">${fmtDate(it.install_date)}</td>
          <td class="num">${agePillHtml(ageM)}</td>
          <td class="num">${fee}</td>
          <td>${statusTagHtml(it.status)}</td>
        </tr>`;
    }).join('');
    tbody.insertAdjacentHTML('beforeend', html);

    if (rows.length > MAX_RENDER) {
      tbody.insertAdjacentHTML('beforeend',
        `<tr><td colspan="10" class="empty-row">… 외 ${rows.length - MAX_RENDER}건</td></tr>`);
    }
  }

  // ========================================================
  // 노후도 순 탭
  // ========================================================
  function renderAgeTab() {
    const tbody = $('#age-table tbody');
    tbody.innerHTML = '';
    const f = state.filters.age;
    const q = f.q.trim().toLowerCase();

    let rows = getItemRows();
    rows = rows.filter(({ it, customer, ageM }) => {
      if (f.cat && it.category !== f.cat) return false;
      if (f.band && ageBand(ageM) !== f.band) return false;
      if (q) {
        const hay = [it.brand, it.model, it.serial, it.subtype, it.category,
                     customer && customer.company]
          .map(v => (v == null ? '' : String(v).toLowerCase())).join(' ');
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    // 노후도 desc, null 은 맨 아래
    rows.sort((a, b) => {
      const aA = a.ageM == null ? -1 : a.ageM;
      const bA = b.ageM == null ? -1 : b.ageM;
      return bA - aA;
    });

    $('#af-count').textContent = `${rows.length.toLocaleString()} 건`;

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" class="empty-row">조건에 맞는 자산이 없습니다.</td></tr>`;
      return;
    }
    const slice = rows.slice(0, MAX_RENDER);
    const html = slice.map(({ it, customer, ageM }, idx) => {
      const cust = customer
        ? escapeHtml(customer.company || '–')
        : '<span class="muted-cell">미배정</span>';
      const replace = ageM != null && ageM >= REPLACE_THRESHOLD_MONTHS
        ? '<span class="replace-tag">교체</span>' : '';
      return `
        <tr>
          <td>${idx + 1}</td>
          <td>${escapeHtml(it.category || '–')}</td>
          <td>${escapeHtml(it.subtype || '–')}</td>
          <td>${escapeHtml(it.brand || '–')} / ${escapeHtml(it.model || '–')}</td>
          <td class="hide-mobile">${escapeHtml(it.serial || '–')}</td>
          <td>${cust}</td>
          <td class="num hide-mobile">${fmtDate(it.install_date)}</td>
          <td class="num">${agePillHtml(ageM)}</td>
          <td>${statusTagHtml(it.status)}</td>
          <td>${replace}</td>
        </tr>`;
    }).join('');
    tbody.insertAdjacentHTML('beforeend', html);

    if (rows.length > MAX_RENDER) {
      tbody.insertAdjacentHTML('beforeend',
        `<tr><td colspan="10" class="empty-row">… 외 ${rows.length - MAX_RENDER}건</td></tr>`);
    }
  }

  // ========================================================
  // 메모/특이사항 탭
  // ========================================================
  function getMemoRows() {
    const rows = [];
    for (const c of state.customers) {
      if (c.notes && String(c.notes).trim()) {
        rows.push({
          kind: 'customer',
          target: c.company || c.contact_name || `#${c.id}`,
          memo: String(c.notes),
        });
      }
    }
    for (const it of state.items) {
      if (it.notes && String(it.notes).trim()) {
        const label = [it.brand, it.model].filter(Boolean).join(' ').trim() ||
                      it.serial || `#${it.id}`;
        rows.push({
          kind: 'item',
          target: label,
          memo: String(it.notes),
        });
      }
    }
    return rows;
  }
  function renderMemoTab() {
    const tbody = $('#memo-table tbody');
    tbody.innerHTML = '';
    const f = state.filters.memo;
    const q = f.q.trim().toLowerCase();

    let rows = getMemoRows();
    rows = rows.filter(r => {
      if (f.kind && r.kind !== f.kind) return false;
      if (q) {
        const hay = (r.target + ' ' + r.memo).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    rows.sort((a, b) =>
      String(a.kind).localeCompare(String(b.kind)) ||
      String(a.target).localeCompare(String(b.target), 'ko'));

    $('#mf-count').textContent = `${rows.length.toLocaleString()} 건`;

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="empty-row">메모가 입력된 항목이 없습니다.</td></tr>`;
      return;
    }

    const html = rows.map(r => {
      const memo = r.memo.length > 200 ? r.memo.slice(0, 200) + '…' : r.memo;
      const tag = r.kind === 'customer'
        ? '<span class="kind-tag">거래처</span>'
        : '<span class="kind-tag item">자산</span>';
      return `
        <tr>
          <td>${tag}</td>
          <td><strong>${escapeHtml(r.target)}</strong></td>
          <td><div class="memo-cell">${escapeHtml(memo)}</div></td>
        </tr>`;
    }).join('');
    tbody.insertAdjacentHTML('beforeend', html);
  }

  // ========================================================
  // 필터 select 채우기
  // ========================================================
  let _selectsBuilt = false;
  function populateSelectsOnce() {
    if (_selectsBuilt) return;
    const cats = new Set();
    const subs = new Set();
    for (const it of state.items) {
      if (it.category) cats.add(it.category);
      if (it.subtype) subs.add(it.subtype);
    }
    const fillSel = (sel, values) => {
      if (!sel) return;
      for (const v of Array.from(values).sort()) {
        const opt = document.createElement('option');
        opt.value = v; opt.textContent = v;
        sel.appendChild(opt);
      }
    };
    fillSel($('#if-cat'), cats);
    fillSel($('#if-sub'), subs);
    fillSel($('#af-cat'), cats);
    _selectsBuilt = true;
  }

  // ========================================================
  // 이벤트 바인딩
  // ========================================================
  function bindEvents() {
    // 탭
    $$('.tab-btn').forEach(b => {
      b.addEventListener('click', () => {
        switchTab(b.dataset.tab);
        renderActiveTab();
      });
    });

    // 거래처 행 클릭 → 상세 모달 (이벤트 위임)
    document.addEventListener('click', (e) => {
      const row = e.target.closest('.cust-row');
      if (row && row.dataset.cid) openCustomerDetail(row.dataset.cid);
    });
    // 모달 닫기: backdrop / X 버튼 / ESC
    document.addEventListener('click', (e) => {
      if (e.target.id === 'rs-modal-backdrop' || e.target.closest('[data-modal-close]')) {
        closeCustomerDetail();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeCustomerDetail();
    });

    // 거래처별 필터
    const debCust = debounce(() => renderCustomersTab(), 150);
    $('#cf-q').addEventListener('input', e => {
      state.filters.cust.q = e.target.value; debCust();
    });
    $('#cf-pay').addEventListener('change', e => {
      state.filters.cust.pay = e.target.value; renderCustomersTab();
    });
    $('#cf-cat').addEventListener('change', e => {
      state.filters.cust.cat = e.target.value; renderCustomersTab();
    });

    // 자산별 필터
    const debItem = debounce(() => renderItemsTab(), 150);
    $('#if-q').addEventListener('input', e => {
      state.filters.item.q = e.target.value; debItem();
    });
    $('#if-cat').addEventListener('change', e => {
      state.filters.item.cat = e.target.value; renderItemsTab();
    });
    $('#if-sub').addEventListener('change', e => {
      state.filters.item.sub = e.target.value; renderItemsTab();
    });
    $('#if-status').addEventListener('change', e => {
      state.filters.item.status = e.target.value; renderItemsTab();
    });
    $('#if-assign').addEventListener('change', e => {
      state.filters.item.assign = e.target.value; renderItemsTab();
    });

    // 노후도 필터
    const debAge = debounce(() => renderAgeTab(), 150);
    $('#af-q').addEventListener('input', e => {
      state.filters.age.q = e.target.value; debAge();
    });
    $('#af-cat').addEventListener('change', e => {
      state.filters.age.cat = e.target.value; renderAgeTab();
    });
    $('#af-band').addEventListener('change', e => {
      state.filters.age.band = e.target.value; renderAgeTab();
    });

    // 메모 필터
    const debMemo = debounce(() => renderMemoTab(), 150);
    $('#mf-q').addEventListener('input', e => {
      state.filters.memo.q = e.target.value; debMemo();
    });
    $('#mf-kind').addEventListener('change', e => {
      state.filters.memo.kind = e.target.value; renderMemoTab();
    });

    // 새로고침
    $('#btn-refresh').addEventListener('click', async () => {
      const btn = $('#btn-refresh');
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = '⏳ 로딩…';
      try { await refresh(); }
      finally { btn.disabled = false; btn.textContent = orig; }
    });

    // CSV 내보내기
    $('#btn-export').addEventListener('click', exportCurrentTabCsv);
  }

  // ========================================================
  // CSV 내보내기
  // ========================================================
  function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function downloadCsv(filename, rows) {
    // UTF-8 BOM 추가 (Excel 한글 호환)
    const BOM = '﻿';
    const csv = rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  }
  function exportCurrentTabCsv() {
    const tab = state.activeTab;
    const date = todayStr();
    if (tab === 'customers') {
      const f = state.filters.cust;
      const q = f.q.trim().toLowerCase();
      const stats = buildCustomerStats();
      let rows = state.customers
        .filter(c => c.active !== false && !c.archived_at)
        .map(c => ({ c, s: stats.get(c.id) || { items: [], monthlyFee: 0, byCat: {}, maxAge: null } }));
      rows = rows.filter(({ c, s }) => {
        if (f.pay && c.payment_type !== f.pay) return false;
        if (f.cat && !s.byCat[f.cat]) return false;
        if (q) {
          const hay = [c.company, c.address, c.notes, c.contact_name]
            .map(v => (v == null ? '' : String(v).toLowerCase())).join(' ');
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      rows.sort((a, b) =>
        (b.s.items.length - a.s.items.length) ||
        String(a.c.company || '').localeCompare(String(b.c.company || ''), 'ko'));

      const csv = [['#', '회사명', '담당자', '자산수', '카테고리분포', '월임대료', '주소',
                    '결제', '청구일', '보증금', '최대노후도(개월)', '메모']];
      rows.forEach(({ c, s }, idx) => {
        const dist = Object.entries(s.byCat).map(([k, v]) => `${k}:${v}`).join(' / ');
        csv.push([
          idx + 1, c.company || '', c.contact_name || '',
          s.items.length, dist, s.monthlyFee || 0,
          c.address || '', c.payment_type || '',
          c.invoice_day || '', c.deposit || '',
          s.maxAge == null ? '' : s.maxAge,
          c.notes || '',
        ]);
      });
      downloadCsv(`임대현황_거래처별_${date}.csv`, csv);
      return;
    }
    if (tab === 'items') {
      const f = state.filters.item;
      const q = f.q.trim().toLowerCase();
      let rows = getItemRows();
      rows = rows.filter(({ it, customer, assignment }) => {
        if (f.cat && it.category !== f.cat) return false;
        if (f.sub && it.subtype !== f.sub) return false;
        if (f.status && (it.status || 'active') !== f.status) return false;
        const has = !!assignment;
        if (f.assign === 'assigned' && !has) return false;
        if (f.assign === 'idle' && has) return false;
        if (q) {
          const hay = [it.brand, it.model, it.serial, it.subtype, it.category,
                       it.notes, customer && customer.company]
            .map(v => (v == null ? '' : String(v).toLowerCase())).join(' ');
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      rows.sort((a, b) =>
        String(a.it.category || '').localeCompare(String(b.it.category || ''), 'ko') ||
        String(a.it.subtype || '').localeCompare(String(b.it.subtype || ''), 'ko') ||
        String(a.it.model || '').localeCompare(String(b.it.model || ''), 'ko'));

      const csv = [['#', '카테고리', '품목', '브랜드', '모델', '시리얼', '거래처',
                    '도입일', '노후도(개월)', '월임대료', '상태']];
      rows.forEach(({ it, assignment, customer, ageM }, idx) => {
        csv.push([
          idx + 1, it.category || '', it.subtype || '',
          it.brand || '', it.model || '', it.serial || '',
          customer ? (customer.company || '') : '',
          fmtDate(it.install_date) === '–' ? '' : fmtDate(it.install_date),
          ageM == null ? '' : ageM,
          assignment ? (assignment.monthly_fee || 0) : '',
          it.status || 'active',
        ]);
      });
      downloadCsv(`임대현황_자산별_${date}.csv`, csv);
      return;
    }
    if (tab === 'age') {
      const f = state.filters.age;
      const q = f.q.trim().toLowerCase();
      let rows = getItemRows();
      rows = rows.filter(({ it, customer, ageM }) => {
        if (f.cat && it.category !== f.cat) return false;
        if (f.band && ageBand(ageM) !== f.band) return false;
        if (q) {
          const hay = [it.brand, it.model, it.serial, it.subtype, it.category,
                       customer && customer.company]
            .map(v => (v == null ? '' : String(v).toLowerCase())).join(' ');
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      rows.sort((a, b) => {
        const aA = a.ageM == null ? -1 : a.ageM;
        const bA = b.ageM == null ? -1 : b.ageM;
        return bA - aA;
      });
      const csv = [['#', '카테고리', '품목', '브랜드', '모델', '시리얼', '거래처',
                    '도입일', '노후도(개월)', '상태', '교체권장']];
      rows.forEach(({ it, customer, ageM }, idx) => {
        const replace = ageM != null && ageM >= REPLACE_THRESHOLD_MONTHS ? '교체' : '';
        csv.push([
          idx + 1, it.category || '', it.subtype || '',
          it.brand || '', it.model || '', it.serial || '',
          customer ? (customer.company || '') : '',
          fmtDate(it.install_date) === '–' ? '' : fmtDate(it.install_date),
          ageM == null ? '' : ageM,
          it.status || 'active',
          replace,
        ]);
      });
      downloadCsv(`임대현황_노후도순_${date}.csv`, csv);
      return;
    }
    if (tab === 'memo') {
      const f = state.filters.memo;
      const q = f.q.trim().toLowerCase();
      let rows = getMemoRows();
      rows = rows.filter(r => {
        if (f.kind && r.kind !== f.kind) return false;
        if (q) {
          const hay = (r.target + ' ' + r.memo).toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      rows.sort((a, b) =>
        String(a.kind).localeCompare(String(b.kind)) ||
        String(a.target).localeCompare(String(b.target), 'ko'));
      const csv = [['종류', '대상', '메모']];
      rows.forEach(r => {
        csv.push([r.kind === 'customer' ? '거래처' : '자산', r.target, r.memo]);
      });
      downloadCsv(`임대현황_메모_${date}.csv`, csv);
      return;
    }
  }

  // ========================================================
  // 거래처 상세 모달
  // ========================================================
  function openCustomerDetail(cid) {
    const c = state.customers.find(x => x.id === cid);
    if (!c) return;
    const assignMap = buildItemAssignMap();
    const items = state.items
      .filter(it => {
        const a = assignMap.get(it.id);
        return a && a.customer_id === cid;
      })
      .sort((a, b) => (b.install_date || '').localeCompare(a.install_date || ''));

    // 카테고리별 자산 수 집계
    const byCat = {};
    items.forEach(it => {
      const cat = it.category || '기타';
      byCat[cat] = (byCat[cat] || 0) + 1;
    });
    const catDist = Object.entries(byCat).sort((a,b) => b[1]-a[1])
      .map(([k,v]) => `<span class="mini-pill ${escapeHtml(k)}">${escapeHtml(k)} ${v}</span>`).join(' ');

    // 월 임대료 / 보증금 / 최대 노후도 계산
    let monthlyTotal = 0;
    items.forEach(it => {
      const a = assignMap.get(it.id);
      if (a && a.monthly_fee) monthlyTotal += Number(a.monthly_fee) || 0;
    });
    const maxAge = items.reduce((m, it) => {
      const ag = ageMonths(it);
      return ag != null && ag > m ? ag : m;
    }, 0);

    // 자산 표
    const itemRows = items.length === 0
      ? `<tr><td colspan="8" class="empty-row">배정된 자산이 없습니다.</td></tr>`
      : items.map((it, i) => {
          const a = assignMap.get(it.id) || {};
          const ag = ageMonths(it);
          return `<tr>
            <td>${i+1}</td>
            <td><span class="mini-pill ${escapeHtml(it.category||'기타')}">${escapeHtml(it.category||'기타')}</span></td>
            <td>${escapeHtml(it.subtype || '–')}</td>
            <td><strong>${escapeHtml(it.brand || '')} ${escapeHtml(it.model || '–')}</strong>${it.serial ? `<br><span class="muted-cell" style="font-size:11px;">${escapeHtml(it.serial)}</span>` : ''}</td>
            <td class="num">${escapeHtml(it.install_date || '–')}</td>
            <td class="num">${agePillHtml(ag)}</td>
            <td class="num">${a.monthly_fee ? fmtMoney(a.monthly_fee) : '<span class="muted-cell">–</span>'}</td>
            <td>${statusTagHtml(it.status)}</td>
          </tr>`;
        }).join('');

    let modal = document.getElementById('rs-modal-backdrop');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'rs-modal-backdrop';
      modal.className = 'rs-modal-backdrop';
      document.body.appendChild(modal);
    }
    modal.innerHTML = `
      <div class="rs-modal" role="dialog" aria-modal="true" aria-labelledby="rs-modal-title">
        <div class="rs-modal-head">
          <div>
            <h2 id="rs-modal-title" style="margin:0; font-size:18px;">🏢 ${escapeHtml(c.company || '거래처')}</h2>
            <div class="muted-small" style="margin-top:2px;">
              ${c.contact_name ? '담당: ' + escapeHtml(c.contact_name) + ' · ' : ''}자산 ${items.length}건 · 월 ${fmtMoney(monthlyTotal)}
              ${maxAge ? ' · 최대 노후 ' + maxAge + '개월' : ''}
            </div>
          </div>
          <button type="button" class="btn ghost small" data-modal-close aria-label="닫기">✕</button>
        </div>

        <div class="rs-modal-body">
          <h3 class="rs-h3">📋 기본 정보</h3>
          <div class="rs-info-grid">
            <div><label>회사명</label><div>${escapeHtml(c.company || '–')}</div></div>
            <div><label>담당자</label><div>${escapeHtml(c.contact_name || '–')}</div></div>
            <div><label>전화</label><div>${escapeHtml(c.phone || '–')}</div></div>
            <div><label>휴대폰</label><div>${escapeHtml(c.mobile || '–')}</div></div>
            <div><label>이메일</label><div>${escapeHtml(c.email || '–')}</div></div>
            <div><label>사업자번호</label><div>${escapeHtml(c.biz_no || '–')}</div></div>
            <div style="grid-column:1/-1;"><label>주소</label><div>${escapeHtml(c.address || '–')}</div></div>
            <div><label>결제방식</label><div>${payTagHtml(c.payment_type)}</div></div>
            <div><label>청구일</label><div>${c.invoice_day ? escapeHtml(String(c.invoice_day)) + '일' : '–'}</div></div>
            <div><label>보증금</label><div>${c.deposit ? fmtMoney(c.deposit) : '–'}</div></div>
            <div><label>등록일</label><div>${(c.created_at || '').slice(0,10) || '–'}</div></div>
          </div>

          <h3 class="rs-h3">📦 보유 자산 (${items.length}건)</h3>
          ${catDist ? `<div style="margin:-6px 0 8px 0;">${catDist}</div>` : ''}
          <div class="scroll-x">
            <table class="data-table">
              <thead><tr>
                <th>#</th><th>카테고리</th><th>품목</th><th>브랜드/모델</th>
                <th>도입일</th><th class="num">노후도</th><th class="num">월 임대료</th><th>상태</th>
              </tr></thead>
              <tbody>${itemRows}</tbody>
            </table>
          </div>

          ${c.notes && c.notes.trim() ? `
            <h3 class="rs-h3">📝 메모/특이사항</h3>
            <div class="rs-notes">${escapeHtml(c.notes)}</div>
          ` : ''}
        </div>

        <div class="rs-modal-foot">
          <button type="button" class="btn ghost" data-modal-close>닫기</button>
        </div>
      </div>
    `;
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
  }

  function closeCustomerDetail() {
    const modal = document.getElementById('rs-modal-backdrop');
    if (modal) modal.classList.remove('show');
    document.body.style.overflow = '';
  }

  // ========================================================
  // 렌더 진입점
  // ========================================================
  function renderActiveTab() {
    if (state.activeTab === 'customers') renderCustomersTab();
    else if (state.activeTab === 'items') renderItemsTab();
    else if (state.activeTab === 'age') renderAgeTab();
    else if (state.activeTab === 'memo') renderMemoTab();
  }
  function renderAll() {
    renderTopStats();
    renderCatRow();
    refreshTabCounts();
    populateSelectsOnce();
    renderActiveTab();
    $('#last-updated').textContent = timeStr();
  }

  async function refresh() {
    try {
      await loadAll();
      renderAll();
    } catch (err) {
      console.error('[rental-status] 로드 실패:', err);
      showError(err);
    }
  }

  function showError(err) {
    const msg = (err && (err.message || err.hint)) || String(err);
    let banner = document.getElementById('rs-err-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'rs-err-banner';
      banner.className = 'card';
      banner.style.cssText =
        'padding:14px; border-color:#fecaca; background:#fef2f2; color:#991b1b; margin-bottom:14px;';
      const main = $('main.container');
      main.insertBefore(banner, main.firstChild);
    }
    banner.innerHTML =
      '⚠️ 데이터 로드 실패: <code>' + escapeHtml(msg) + '</code><br>' +
      '<span class="muted-small">Supabase 스키마(rental_customers / rental_items / rental_assignments) 적용 여부 확인.</span>';
  }

  // ========================================================
  // 부팅
  // ========================================================
  function boot() {
    if (state.loaded) return;
    refresh();
  }

  function start() {
    bindEvents();
    if (window.totalasAuth) {
      boot();
    } else {
      document.addEventListener('totalas:ready', boot, { once: true });
      // 안전망
      setTimeout(() => {
        if (!state.loaded && !window.totalasAuth) {
          console.warn('[rental-status] window.totalasAuth 미초기화 — auth.js 점검 필요');
        }
        if (!state.loaded && window.totalasAuth) boot();
      }, 2000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
