// ============================================================
// rental-billing/index.js — 임대추가요금청구 (Supabase 실데이터)
// 하이브리드 빌링: 고정료 + 사용량 초과 과금
// 의존: ../config.js, ../auth.js (window.totalasAuth)
// 스키마: rental_customers, rental_items, rental_assignments,
//        rental_counters, rental_billings
// ============================================================
'use strict';

(function () {
  // ── 전역 상태 ───────────────────────────────────────────────
  const state = {
    ym: '',                  // 'YYYY-MM'
    customers: [],           // [{id, company, biz_no, payment_type, invoice_day, ...}]
    items: new Map(),        // item_id -> {id, category, subtype, brand, model, ...}
    assignments: [],         // [{id, item_id, customer_id, monthly_fee, bw_free, co_free, bw_rate, co_rate, end_date}]
    counters: new Map(),     // `${item_id}|${ym}` -> {bw, color, uptime_hours}
    billings: new Map(),     // customer_id -> billing row (for current ym)
    selectedCustomerId: null,
    filterText: '',
    loading: false,
  };

  // ── 유틸 ────────────────────────────────────────────────────
  const $  = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const fmtKRW = (n) => {
    const v = Number(n || 0);
    return v.toLocaleString('ko-KR');
  };
  const todayYM = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  const escapeHtml = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (m) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])
    );

  function toast(msg, kind = 'info') {
    const el = $('#rb-toast');
    if (!el) return;
    el.textContent = msg;
    el.style.background = kind === 'error' ? '#dc2626' : (kind === 'ok' ? '#16a34a' : '#0f172a');
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function setStatusText(s) {
    const el = $('#rb-status');
    if (el) el.textContent = s || '';
  }

  // ── Supabase 클라이언트 ─────────────────────────────────────
  function sb() {
    if (!window.totalasAuth) {
      throw new Error('Supabase 클라이언트(auth.js) 미초기화');
    }
    return window.totalasAuth;
  }

  // ── 데이터 로드 ─────────────────────────────────────────────
  async function loadAll() {
    state.loading = true;
    setStatusText('데이터 로딩 중…');
    renderList();
    renderDetail();
    try {
      const ym = state.ym;
      const client = sb();

      const [
        rCust, rItems, rAssign, rCnt, rBill,
      ] = await Promise.all([
        client.from('rental_customers')
          .select('id, company, biz_no, payment_type, invoice_day, address, active')
          .eq('active', true)
          .order('company', { ascending: true }),
        client.from('rental_items')
          .select('id, category, subtype, brand, model, status')
          .neq('status', 'returned'),
        client.from('rental_assignments')
          .select('id, item_id, customer_id, monthly_fee, bw_free, co_free, bw_rate, co_rate, end_date'),
        client.from('rental_counters')
          .select('item_id, ym, bw, color, uptime_hours')
          .eq('ym', ym),
        client.from('rental_billings')
          .select('id, customer_id, ym, fixed_total, usage_total, total, items, status, issued_at, paid_at, notes')
          .eq('ym', ym),
      ]);

      // 에러 체크
      for (const r of [rCust, rItems, rAssign, rCnt, rBill]) {
        if (r.error) throw r.error;
      }

      state.customers = rCust.data || [];
      state.items = new Map();
      (rItems.data || []).forEach((it) => state.items.set(it.id, it));

      // 활성 assignment 만 (end_date null or 미래)
      const todayStr = new Date().toISOString().slice(0, 10);
      state.assignments = (rAssign.data || []).filter((a) =>
        !a.end_date || a.end_date >= todayStr
      );

      state.counters = new Map();
      (rCnt.data || []).forEach((c) => {
        state.counters.set(`${c.item_id}|${c.ym}`, {
          bw: c.bw || 0, color: c.color || 0, uptime_hours: c.uptime_hours || 0,
        });
      });

      state.billings = new Map();
      (rBill.data || []).forEach((b) => state.billings.set(b.customer_id, b));

      setStatusText(`거래처 ${state.customers.length}곳 · 자산 ${state.items.size}건 · 청구 ${state.billings.size}건`);
    } catch (e) {
      console.error('[billing] load error', e);
      toast('데이터 로드 실패: ' + (e.message || e), 'error');
      setStatusText('로드 실패');
    } finally {
      state.loading = false;
      renderAll();
    }
  }

  // ── 빌링 계산 (한 거래처) ───────────────────────────────────
  // 반환: { fixed_total, usage_total, items: [...] }
  function computeBilling(customerId) {
    const ym = state.ym;
    const myAssigns = state.assignments.filter((a) => a.customer_id === customerId);

    // 고정료: IT / 위생 / 출력 카테고리 모두 (출력기기도 기본 임대료 있음)
    const fixedItems = [];
    const usageItems = [];

    for (const a of myAssigns) {
      const it = state.items.get(a.item_id);
      if (!it) continue; // 자산이 returned 등으로 빠졌다면 스킵

      const cat = it.category;
      const FIXED_CATS = ['IT', '위생', '출력'];
      if (FIXED_CATS.includes(cat) && (a.monthly_fee || 0) > 0) {
        fixedItems.push({
          item_id: a.item_id,
          kind: 'fixed',
          category: cat,
          subtype: it.subtype,
          label: `${cat}/${it.subtype}${it.model ? ' ' + it.model : ''}`,
          qty: 1,
          unit_price: a.monthly_fee || 0,
          subtotal: a.monthly_fee || 0,
        });
      }

      // 사용량 초과: 출력 카테고리만
      if (cat === '출력') {
        const cnt = state.counters.get(`${a.item_id}|${ym}`) || { bw: 0, color: 0 };
        const exBw = Math.max(0, (cnt.bw || 0) - (a.bw_free || 0));
        const exCo = Math.max(0, (cnt.color || 0) - (a.co_free || 0));
        const sub = exBw * (a.bw_rate || 0) + exCo * (a.co_rate || 0);
        if (sub > 0) {
          usageItems.push({
            item_id: a.item_id,
            kind: 'usage',
            category: cat,
            subtype: it.subtype,
            label: `${it.subtype}${it.model ? ' ' + it.model : ''} 초과사용`,
            bw: exBw,
            co: exCo,
            bw_rate: a.bw_rate || 0,
            co_rate: a.co_rate || 0,
            counter_bw: cnt.bw || 0,
            counter_color: cnt.color || 0,
            bw_free: a.bw_free || 0,
            co_free: a.co_free || 0,
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
    };
  }

  // ── 상단 stat-card ──────────────────────────────────────────
  function renderStats() {
    const wrap = $('#rb-stats');
    if (!wrap) return;

    let issued = 0, paidSum = 0, billedSum = 0, unpaidSum = 0;
    const billedCustIds = new Set();
    for (const b of state.billings.values()) {
      issued += 1;
      billedSum += b.total || 0;
      billedCustIds.add(b.customer_id);
      if (b.status === 'paid') paidSum += b.total || 0;
      else if (b.status !== 'void') unpaidSum += b.total || 0;
    }
    const totalCust = state.customers.length;
    const notIssued = totalCust - billedCustIds.size;
    const avg = issued > 0 ? Math.round(billedSum / issued) : 0;

    wrap.innerHTML = `
      <div class="stat-card">
        <div class="stat-label">발행 청구서</div>
        <div class="stat-value primary">${issued}<span class="unit">건</span></div>
        <div class="stat-sub muted">/ 총 ${totalCust}곳</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">미발행 거래처</div>
        <div class="stat-value ${notIssued > 0 ? 'warn' : ''}">${notIssued}<span class="unit">곳</span></div>
        <div class="stat-sub muted">일괄 생성 대상</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">합계 청구액</div>
        <div class="stat-value">₩${fmtKRW(billedSum)}</div>
        <div class="stat-sub muted">${state.ym}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">미입금액</div>
        <div class="stat-value warn">₩${fmtKRW(unpaidSum)}</div>
        <div class="stat-sub muted">draft + sent</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">평균 청구</div>
        <div class="stat-value">₩${fmtKRW(avg)}</div>
        <div class="stat-sub muted">건당</div>
      </div>
    `;
  }

  // ── 좌측 거래처 리스트 ──────────────────────────────────────
  function renderList() {
    const ul = $('#rb-list');
    if (!ul) return;

    if (state.loading) {
      ul.innerHTML = '<li class="rb-list-empty">로딩 중…</li>';
      return;
    }
    const q = (state.filterText || '').trim().toLowerCase();
    let custs = state.customers;
    if (q) {
      custs = custs.filter((c) =>
        (c.company || '').toLowerCase().includes(q) ||
        (c.biz_no || '').toLowerCase().includes(q)
      );
    }
    if (!custs.length) {
      ul.innerHTML = '<li class="rb-list-empty">검색 결과 없음</li>';
      return;
    }

    const html = custs.map((c) => {
      const b = state.billings.get(c.id);
      let total = b ? (b.total || 0) : 0;
      let statusBadge = '';
      if (b) {
        statusBadge = `<span class="badge status-${b.status}">${labelStatus(b.status)}</span>`;
      } else {
        // 미리계산 (실시간으로 보이도록)
        const calc = computeBilling(c.id);
        total = calc.total;
        statusBadge = `<span class="badge" style="background:#fef3c7;color:#b45309;">미발행</span>`;
      }
      const sel = state.selectedCustomerId === c.id ? ' selected' : '';
      return `
        <li class="rb-item${sel}" data-customer-id="${escapeHtml(c.id)}">
          <div>
            <div class="rb-item-name">${escapeHtml(c.company || '(이름없음)')}</div>
            <div class="rb-item-meta">
              ${statusBadge}
              <span>${escapeHtml(c.invoice_day || '-')}</span>
              <span>${escapeHtml(c.payment_type || '')}</span>
            </div>
          </div>
          <div class="rb-item-total">₩${fmtKRW(total)}</div>
        </li>
      `;
    }).join('');
    ul.innerHTML = html;

    ul.querySelectorAll('.rb-item').forEach((li) => {
      li.addEventListener('click', () => {
        state.selectedCustomerId = li.dataset.customerId;
        renderList();
        renderDetail();
      });
    });
  }

  function labelStatus(s) {
    return ({ draft: '초안', sent: '발송됨', paid: '입금완료', void: '취소' })[s] || s;
  }

  // ── 우측 상세 ───────────────────────────────────────────────
  function renderDetail() {
    const wrap = $('#rb-detail');
    if (!wrap) return;
    const cid = state.selectedCustomerId;
    if (!cid) {
      wrap.innerHTML = '<div class="rb-detail-empty">좌측에서 거래처를 선택하세요.</div>';
      return;
    }
    const c = state.customers.find((x) => x.id === cid);
    if (!c) {
      wrap.innerHTML = '<div class="rb-detail-empty">거래처를 찾을 수 없습니다.</div>';
      return;
    }

    const billing = state.billings.get(cid);
    const calc = computeBilling(cid);

    // 발행본이 있으면 발행 데이터 우선, 없으면 즉시 계산 결과 사용
    const view = billing ? {
      fixed_total: billing.fixed_total || 0,
      usage_total: billing.usage_total || 0,
      total: billing.total || 0,
      items: Array.isArray(billing.items) ? billing.items : [],
    } : calc;

    const fixedRows = view.items.filter((x) => x.kind === 'fixed');
    const usageRows = view.items.filter((x) => x.kind === 'usage');
    const status = billing ? billing.status : null;

    wrap.innerHTML = `
      <div class="rb-detail-head">
        <div>
          <h2>${escapeHtml(c.company)}</h2>
          <div class="rb-meta-row">
            ${escapeHtml(c.biz_no || '')}${c.biz_no ? ' · ' : ''}${escapeHtml(c.address || '')}
            ${status ? ` · <span class="badge status-${status}">${labelStatus(status)}</span>` : ' · <span class="badge" style="background:#fef3c7;color:#b45309;">미발행</span>'}
          </div>
          <div class="rb-meta-row">청구월: <b>${escapeHtml(state.ym)}</b> · 결제: ${escapeHtml(c.payment_type || '-')} · 청구일: ${escapeHtml(c.invoice_day || '-')}</div>
        </div>
        <div class="rb-detail-actions no-print">
          ${renderActionButtons(billing)}
          <button class="btn ghost" id="rb-print">🖨 인쇄/PDF</button>
        </div>
      </div>

      <div class="rb-section">
        <h3>고정 임대료 (${fixedRows.length}건)</h3>
        ${renderFixedTable(fixedRows)}
        <div style="text-align:right; margin-top:6px; font-size:13px;">
          소계: <b>₩${fmtKRW(view.fixed_total)}</b>
        </div>
      </div>

      <div class="rb-section">
        <h3>사용량 초과 과금 (${usageRows.length}건)</h3>
        ${renderUsageTable(usageRows)}
        <div style="text-align:right; margin-top:6px; font-size:13px;">
          소계: <b>₩${fmtKRW(view.usage_total)}</b>
        </div>
      </div>

      <div class="rb-grand">
        <span>총 청구액</span>
        <span class="num">₩${fmtKRW(view.total)}</span>
      </div>

      ${billing && billing.notes ? `<div class="rb-section"><h3>메모</h3><div style="white-space:pre-wrap; font-size:13px;">${escapeHtml(billing.notes)}</div></div>` : ''}
    `;

    // 이벤트 바인딩
    const printBtn = $('#rb-print');
    if (printBtn) printBtn.addEventListener('click', () => window.print());

    const saveBtn = $('#rb-save');
    if (saveBtn) saveBtn.addEventListener('click', () => saveOne(cid));

    const sendBtn = $('#rb-send');
    if (sendBtn) sendBtn.addEventListener('click', () => updateStatus(cid, 'sent'));

    const paidBtn = $('#rb-paid');
    if (paidBtn) paidBtn.addEventListener('click', () => updateStatus(cid, 'paid'));

    const voidBtn = $('#rb-void');
    if (voidBtn) voidBtn.addEventListener('click', () => {
      if (!confirm('이 청구서를 취소(void) 처리하시겠습니까?')) return;
      updateStatus(cid, 'void');
    });
  }

  function renderActionButtons(billing) {
    if (!billing) {
      return `<button class="btn primary" id="rb-save">💾 청구서 생성</button>`;
    }
    const s = billing.status;
    const parts = [`<button class="btn ghost" id="rb-save">↻ 재계산/저장</button>`];
    if (s === 'draft') parts.push(`<button class="btn primary" id="rb-send">📤 발송 처리</button>`);
    if (s === 'sent')  parts.push(`<button class="btn primary" id="rb-paid">✅ 입금 처리</button>`);
    if (s !== 'void' && s !== 'paid') parts.push(`<button class="btn danger" id="rb-void">취소</button>`);
    return parts.join('');
  }

  function renderFixedTable(rows) {
    if (!rows.length) {
      return '<div class="muted" style="font-size:12.5px; padding:6px 0;">고정 임대료 없음.</div>';
    }
    return `
      <table class="rb-table">
        <thead>
          <tr>
            <th style="width:55%;">품목</th>
            <th class="num" style="width:10%;">수량</th>
            <th class="num" style="width:18%;">단가</th>
            <th class="num" style="width:17%;">소계</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${escapeHtml(r.label || (r.category + '/' + r.subtype))}</td>
              <td class="num">${r.qty || 1}</td>
              <td class="num">₩${fmtKRW(r.unit_price || 0)}</td>
              <td class="num">₩${fmtKRW(r.subtotal || 0)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function renderUsageTable(rows) {
    if (!rows.length) {
      return '<div class="muted" style="font-size:12.5px; padding:6px 0;">초과 사용 없음.</div>';
    }
    return `
      <table class="rb-table">
        <thead>
          <tr>
            <th style="width:34%;">품목</th>
            <th class="num">흑백(무료/사용/초과)</th>
            <th class="num">컬러(무료/사용/초과)</th>
            <th class="num">단가</th>
            <th class="num">소계</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${escapeHtml(r.label || r.subtype || '')}</td>
              <td class="num">${fmtKRW(r.bw_free)} / ${fmtKRW(r.counter_bw)} / <b>${fmtKRW(r.bw)}</b></td>
              <td class="num">${fmtKRW(r.co_free)} / ${fmtKRW(r.counter_color)} / <b>${fmtKRW(r.co)}</b></td>
              <td class="num">흑 ₩${fmtKRW(r.bw_rate)}<br>컬 ₩${fmtKRW(r.co_rate)}</td>
              <td class="num">₩${fmtKRW(r.subtotal || 0)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // ── 저장 (개별) ─────────────────────────────────────────────
  async function saveOne(customerId) {
    try {
      const calc = computeBilling(customerId);
      const ym = state.ym;
      const payload = {
        id: `b_${customerId}_${ym}`,
        customer_id: customerId,
        ym,
        fixed_total: calc.fixed_total,
        usage_total: calc.usage_total,
        items: calc.items,
      };
      // 신규일 때만 status/draft, 기존이면 status는 유지
      const existing = state.billings.get(customerId);
      if (!existing) payload.status = 'draft';

      const { data, error } = await sb()
        .from('rental_billings')
        .upsert(payload, { onConflict: 'customer_id,ym' })
        .select()
        .single();
      if (error) throw error;
      state.billings.set(customerId, data);
      renderAll();
      toast('청구서를 저장했습니다.', 'ok');
    } catch (e) {
      console.error('[billing] save error', e);
      toast('저장 실패: ' + (e.message || e), 'error');
    }
  }

  // ── 상태 변경 ───────────────────────────────────────────────
  async function updateStatus(customerId, status) {
    try {
      const existing = state.billings.get(customerId);
      if (!existing) {
        toast('먼저 청구서를 저장하세요.', 'error');
        return;
      }
      const patch = { status };
      if (status === 'sent' && !existing.issued_at) {
        patch.issued_at = new Date().toISOString().slice(0, 10);
      }
      if (status === 'paid' && !existing.paid_at) {
        patch.paid_at = new Date().toISOString().slice(0, 10);
      }
      const { data, error } = await sb()
        .from('rental_billings')
        .update(patch)
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      state.billings.set(customerId, data);
      renderAll();
      toast(`상태를 '${labelStatus(status)}'(으)로 변경.`, 'ok');
    } catch (e) {
      console.error('[billing] status error', e);
      toast('상태 변경 실패: ' + (e.message || e), 'error');
    }
  }

  // ── 일괄 생성 ───────────────────────────────────────────────
  async function bulkGenerate() {
    if (state.loading) return;
    if (!confirm(`${state.ym} 청구서를 모든 활성 거래처(${state.customers.length}곳)에 대해 일괄 생성/갱신합니다.\n기존 draft 는 갱신, 발송/입금된 건은 건너뜁니다. 계속하시겠습니까?`)) {
      return;
    }

    setStatusText('일괄 생성 중…');
    const ym = state.ym;
    const rows = [];
    let skipped = 0, candidate = 0;

    for (const c of state.customers) {
      const calc = computeBilling(c.id);
      // 청구할 게 없는 거래처는 스킵
      if (calc.total <= 0 && calc.items.length === 0) continue;
      candidate += 1;

      const existing = state.billings.get(c.id);
      if (existing && (existing.status === 'sent' || existing.status === 'paid')) {
        skipped += 1;
        continue;
      }
      rows.push({
        id: `b_${c.id}_${ym}`,
        customer_id: c.id,
        ym,
        fixed_total: calc.fixed_total,
        usage_total: calc.usage_total,
        items: calc.items,
        status: existing ? existing.status : 'draft',
      });
    }

    if (!rows.length) {
      setStatusText('생성할 청구서 없음');
      toast(`생성 대상 없음 (후보 ${candidate}건, 잠긴 건 ${skipped}건)`, 'info');
      return;
    }

    try {
      // 200건씩 청크 업서트
      const CHUNK = 200;
      let ok = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const { data, error } = await sb()
          .from('rental_billings')
          .upsert(slice, { onConflict: 'customer_id,ym' })
          .select();
        if (error) throw error;
        (data || []).forEach((b) => state.billings.set(b.customer_id, b));
        ok += slice.length;
        setStatusText(`일괄 생성 중… ${ok}/${rows.length}`);
      }
      toast(`청구서 ${ok}건 생성/갱신 (잠긴 건 ${skipped}건 스킵)`, 'ok');
      setStatusText(`생성 완료: ${ok}건`);
      renderAll();
    } catch (e) {
      console.error('[billing] bulk error', e);
      toast('일괄 생성 실패: ' + (e.message || e), 'error');
      setStatusText('일괄 생성 실패');
    }
  }

  // ── 통합 렌더 ───────────────────────────────────────────────
  function renderAll() {
    renderStats();
    renderList();
    renderDetail();
  }

  // ── 부트스트랩 ──────────────────────────────────────────────
  function attachEvents() {
    const ymInput = $('#rb-ym');
    if (ymInput) {
      ymInput.value = state.ym;
      ymInput.addEventListener('change', () => {
        const v = (ymInput.value || '').trim();
        if (!/^\d{4}-\d{2}$/.test(v)) {
          toast('월 형식이 올바르지 않습니다.', 'error');
          ymInput.value = state.ym;
          return;
        }
        state.ym = v;
        loadAll();
      });
    }

    const sBox = $('#rb-search');
    if (sBox) {
      sBox.addEventListener('input', () => {
        state.filterText = sBox.value || '';
        renderList();
      });
    }

    const bulkBtn = $('#rb-bulk');
    if (bulkBtn) bulkBtn.addEventListener('click', bulkGenerate);

    const reloadBtn = $('#rb-reload');
    if (reloadBtn) reloadBtn.addEventListener('click', loadAll);
  }

  function start() {
    state.ym = todayYM();
    attachEvents();
    loadAll();
  }

  // auth.js 가 totalas:ready 발행 후 시작 (세션 + 프로필 확보 후)
  if (window.currentUser && window.totalasAuth) {
    start();
  } else {
    document.addEventListener('totalas:ready', start, { once: true });
  }
})();
