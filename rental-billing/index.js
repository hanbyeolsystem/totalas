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
    prevCounters: new Map(), // item_id -> {bw, color}  (전월 카운터)
    billings: new Map(),     // customer_id -> billing row (for current ym)
    prevBillingsTotal: 0,    // 지난달 발행 총액 (추가요금 있는 건만)
    prevBillingsCount: 0,    // 지난달 발행 업체 수
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
      const prevYm = prevMonth(ym);
      // 최대 12개월 합산 청구를 지원하기 위해 13개월(이번달 + 12개월 전)치 카운터 로드
      const ymList = ymRange(ym, 13);
      const client = sb();

      const [
        rCust, rItems, rAssign, rCnt, rBill,
      ] = await Promise.all([
        client.from('rental_customers')
          .select('id, company, biz_no, payment_type, invoice_day, address, active, bill_combined, billing_months')
          .eq('active', true)
          .order('company', { ascending: true }),
        client.from('rental_items')
          .select('id, category, subtype, brand, model, status')
          .neq('status', 'returned'),
        client.from('rental_assignments')
          .select('id, item_id, customer_id, monthly_fee, bw_free, co_free, bw_rate, co_rate, end_date'),
        client.from('rental_counters')
          .select('item_id, ym, bw, color, uptime_hours')
          .in('ym', ymList),
        client.from('rental_billings')
          .select('id, customer_id, ym, fixed_total, usage_total, total, items, status, issued_at, paid_at, notes')
          .in('ym', [ym, prevYm]),
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

      // 13개월치 카운터를 (item_id|ym) → {bw, color} 맵으로 적재
      state.allCounters = new Map();
      state.counters = new Map();      // 이번달용 (호환)
      state.prevCounters = new Map();  // 직전월용 (호환)
      (rCnt.data || []).forEach((c) => {
        state.allCounters.set(`${c.item_id}|${c.ym}`, { bw: c.bw || 0, color: c.color || 0 });
        if (c.ym === ym) {
          state.counters.set(`${c.item_id}|${c.ym}`, {
            bw: c.bw || 0, color: c.color || 0, uptime_hours: c.uptime_hours || 0,
          });
        } else if (c.ym === prevYm) {
          state.prevCounters.set(c.item_id, { bw: c.bw || 0, color: c.color || 0 });
        }
      });

      state.billings = new Map();
      state.prevBillingsTotal = 0;
      state.prevBillingsCount = 0;
      (rBill.data || []).forEach((b) => {
        if (b.ym === ym) {
          state.billings.set(b.customer_id, b);
        } else if (b.ym === prevYm && (b.usage_total || 0) > 0) {
          state.prevBillingsTotal += b.usage_total || 0;
          state.prevBillingsCount += 1;
        }
      });

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
    const customer = state.customers.find((c) => c.id === customerId);
    const combined = !!customer?.bill_combined;
    const months   = Math.max(1, Number(customer?.billing_months) || 1);

    // N개월 합산: 청구 마감월(ym)의 카운터 - (ym - N개월)의 카운터 = 누적 사용량
    // 기본매수도 N배 확장
    const startPrevYm = ymMinus(ym, months);
    const getCnt = (iid, yym) => state.allCounters?.get(`${iid}|${yym}`) || { bw: 0, color: 0 };

    // 고정료: IT / 위생 / 출력 카테고리 모두
    const fixedItems = [];
    const usageItems = [];
    const FIXED_CATS = ['IT', '위생', '출력'];

    // 고정비 — N개월 청구면 monthly_fee × N
    for (const a of myAssigns) {
      const it = state.items.get(a.item_id);
      if (!it) continue;
      const cat = it.category;
      if (FIXED_CATS.includes(cat) && (a.monthly_fee || 0) > 0) {
        const unit = a.monthly_fee || 0;
        fixedItems.push({
          item_id: a.item_id,
          kind: 'fixed',
          category: cat,
          subtype: it.subtype,
          label: `${cat}/${it.subtype}${it.model ? ' ' + it.model : ''}${months > 1 ? ` (${months}개월 × ₩${unit.toLocaleString()})` : ''}`,
          qty: months,
          unit_price: unit,
          subtotal: unit * months,
        });
      }
    }

    // 출력 사용량 — 합산 모드 ↔ 자산별 모드 (× N개월)
    const printAssigns = myAssigns
      .map((a) => ({ a, it: state.items.get(a.item_id) }))
      .filter((x) => x.it && x.it.category === '출력');

    if (combined && printAssigns.length >= 2) {
      // === 합산 모드 (여러 자산 묶음 + N개월) ===
      let periodBwT = 0, periodCoT = 0, bwFreeT = 0, coFreeT = 0;
      let curBwT = 0, curCoT = 0, prevBwT = 0, prevCoT = 0;
      let bwRate = 0, coRate = 0;
      const itemIds = [];
      const labels = [];
      for (const { a, it } of printAssigns) {
        const cnt  = getCnt(a.item_id, ym);
        const prev = getCnt(a.item_id, startPrevYm);
        const periodBw = Math.max(0, (cnt.bw    || 0) - (prev.bw    || 0));
        const periodCo = Math.max(0, (cnt.color || 0) - (prev.color || 0));
        periodBwT += periodBw; periodCoT += periodCo;
        bwFreeT  += (a.bw_free || 0) * months;
        coFreeT  += (a.co_free || 0) * months;
        curBwT  += cnt.bw  || 0; curCoT  += cnt.color || 0;
        prevBwT += prev.bw || 0; prevCoT += prev.color || 0;
        if (!bwRate) bwRate = a.bw_rate || 0;
        if (!coRate) coRate = a.co_rate || 0;
        itemIds.push(a.item_id);
        labels.push(`${it.subtype || ''}${it.model ? ' '+it.model : ''}`.trim());
      }
      const exBw = Math.max(0, periodBwT - bwFreeT);
      const exCo = Math.max(0, periodCoT - coFreeT);
      const sub  = exBw * bwRate + exCo * coRate;
      if (sub > 0) {
        const tag = months > 1 ? ` · ${periodLabel(ym, months)}` : '';
        usageItems.push({
          item_id: itemIds.join(','),
          kind: 'usage',
          category: '출력',
          subtype: 'combined',
          label: `출력 합산 (${printAssigns.length}대: ${labels.filter(Boolean).join(' + ')}) 초과사용${tag}`,
          bw: exBw,
          co: exCo,
          month_bw: periodBwT,
          month_co: periodCoT,
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
          billing_months: months,
        });
      }
    } else {
      // === 자산별 모드 (자산 1대씩 × N개월) ===
      for (const { a, it } of printAssigns) {
        const cnt  = getCnt(a.item_id, ym);
        const prev = getCnt(a.item_id, startPrevYm);
        const periodBw = Math.max(0, (cnt.bw    || 0) - (prev.bw    || 0));
        const periodCo = Math.max(0, (cnt.color || 0) - (prev.color || 0));
        const freeBw = (a.bw_free || 0) * months;
        const freeCo = (a.co_free || 0) * months;
        const exBw = Math.max(0, periodBw - freeBw);
        const exCo = Math.max(0, periodCo - freeCo);
        const sub = exBw * (a.bw_rate || 0) + exCo * (a.co_rate || 0);
        if (sub > 0) {
          const tag = months > 1 ? ` · ${periodLabel(ym, months)}` : '';
          usageItems.push({
            item_id: a.item_id,
            kind: 'usage',
            category: '출력',
            subtype: it.subtype,
            label: `${it.subtype}${it.model ? ' ' + it.model : ''} 초과사용${tag}`,
            bw: exBw,
            co: exCo,
            month_bw: periodBw,
            month_co: periodCo,
            bw_rate: a.bw_rate || 0,
            co_rate: a.co_rate || 0,
            counter_bw_prev: prev.bw || 0,
            counter_color_prev: prev.color || 0,
            counter_bw: cnt.bw || 0,
            counter_color: cnt.color || 0,
            bw_free: freeBw,
            co_free: freeCo,
            subtotal: sub,
            billing_months: months,
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
      billing_months: months,
      period_label: periodLabel(ym, months),
    };
  }

  // ── 상단 stat-card ──────────────────────────────────────────
  // 추가요금이 발생한 거래처에 한해 청구서를 발행 → 통계도 그 기준
  function renderStats() {
    const wrap = $('#rb-stats');
    if (!wrap) return;

    // 이번달: usage_total > 0 인 청구서만 카운트 (추가요금 합계만 집계)
    let issued = 0, billedSum = 0;
    for (const b of state.billings.values()) {
      if ((b.usage_total || 0) <= 0) continue;
      issued += 1;
      billedSum += b.usage_total || 0;
    }
    const prevSum = state.prevBillingsTotal || 0;
    const prevCount = state.prevBillingsCount || 0;
    const prevYm = prevMonth(state.ym);

    wrap.innerHTML = `
      <div class="stat-card">
        <div class="stat-label">추가요금 발행업체</div>
        <div class="stat-value primary">${issued}<span class="unit">곳</span></div>
        <div class="stat-sub muted">${state.ym}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">지난달 발행총액</div>
        <div class="stat-value">₩${fmtKRW(prevSum)}</div>
        <div class="stat-sub muted">${prevYm} · ${prevCount}곳</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">이번달 발행총액</div>
        <div class="stat-value primary">₩${fmtKRW(billedSum)}</div>
        <div class="stat-sub muted">${state.ym} · ${issued}곳</div>
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
        if ((calc.usage_total || 0) > 0) {
          statusBadge = `<span class="badge" style="background:#fef3c7;color:#b45309;">미발행</span>`;
        } else {
          statusBadge = `<span class="badge" style="background:#f1f5f9;color:#64748b;">추가요금없음</span>`;
        }
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
          <button class="btn ghost" id="rb-excel">📊 엑셀</button>
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

    const excelBtn = $('#rb-excel');
    if (excelBtn) excelBtn.addEventListener('click', () => downloadExcel(cid));

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
            <th style="width:30%;">품목</th>
            <th class="num">흑백(전월/당월/월카운터/기본/추가)</th>
            <th class="num">컬러(전월/당월/월카운터/기본/추가)</th>
            <th class="num">단가</th>
            <th class="num">소계</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => {
            const bwMonth = r.month_bw ?? Math.max(0, (r.counter_bw || 0) - (r.counter_bw_prev || 0));
            const coMonth = r.month_co ?? Math.max(0, (r.counter_color || 0) - (r.counter_color_prev || 0));
            return `
              <tr>
                <td>${escapeHtml(r.label || r.subtype || '')}</td>
                <td class="num">${fmtKRW(r.counter_bw_prev)} / ${fmtKRW(r.counter_bw)} / ${fmtKRW(bwMonth)} / ${fmtKRW(r.bw_free)} / <b>${fmtKRW(r.bw)}</b></td>
                <td class="num">${fmtKRW(r.counter_color_prev)} / ${fmtKRW(r.counter_color)} / ${fmtKRW(coMonth)} / ${fmtKRW(r.co_free)} / <b>${fmtKRW(r.co)}</b></td>
                <td class="num">흑 ₩${fmtKRW(r.bw_rate)}<br>컬 ₩${fmtKRW(r.co_rate)}</td>
                <td class="num">₩${fmtKRW(r.subtotal || 0)}</td>
              </tr>
            `;
          }).join('')}
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
      // 추가요금(usage)이 있는 거래처만 청구서 발행
      if ((calc.usage_total || 0) <= 0) continue;
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

  // ── 엑셀 다운로드 ───────────────────────────────────────────
  // 거래처 1곳 × 현재 청구월 → 1 sheet xlsx (엑셀 양식 매칭)
  async function downloadExcel(customerId) {
    try {
      if (typeof XLSX === 'undefined') {
        toast('엑셀 라이브러리(XLSX) 로드 실패', 'error');
        return;
      }
      const c = state.customers.find((x) => x.id === customerId);
      if (!c) { toast('거래처를 찾을 수 없습니다', 'error'); return; }

      const ym = state.ym;
      const billing = state.billings.get(customerId);
      const view = billing ? {
        fixed_total: billing.fixed_total || 0,
        usage_total: billing.usage_total || 0,
        total: billing.total || 0,
        items: Array.isArray(billing.items) ? billing.items : [],
      } : computeBilling(customerId);

      // 전월 카운터: state.prevCounters 우선, 항목에 저장된 값 보조
      const prevCnt = state.prevCounters;

      // ─ 시트 생성 (aoa) ─
      const aoa = [];
      const blank = () => aoa.push([]);

      // 헤더
      aoa.push([`${c.company}  ${ym} 청구서`]);
      aoa.push([`사업자번호: ${c.biz_no || ''}   주소: ${c.address || ''}`]);
      blank();

      // ── 1) 고정 임대료 ──
      const fixedRows = view.items.filter((x) => x.kind === 'fixed');
      aoa.push([`고정 임대료 (${fixedRows.length}건)`]);
      aoa.push(['품목', '수량', '단가', '금액']);
      for (const r of fixedRows) {
        aoa.push([r.label || `${r.category}/${r.subtype}`, r.qty || 1, r.unit_price || 0, r.subtotal || 0]);
      }
      aoa.push(['소계', '', '', view.fixed_total]);
      blank();

      // ── 2) 사용량 초과 과금 (엑셀 양식 그대로) ──
      const usageRows = view.items.filter((x) => x.kind === 'usage');
      aoa.push([`사용량 초과 과금 (${usageRows.length}건)`]);
      // 헤더 2줄
      aoa.push([
        '기기', '날짜',
        '흑백', '', '', '', '', '', '',
        '컬러', '', '', '', '', '', ''
      ]);
      aoa.push([
        '', '',
        '전월COUNT', '당월COUNT', '기본매수', '월카운터', '추가카운터', '추가사용단가', '추가사용료',
        '전월COUNT', '당월COUNT', '기본매수', '월카운터', '추가카운터', '추가사용단가', '추가사용료'
      ]);

      let bwExtraSum = 0, coExtraSum = 0;
      for (const r of usageRows) {
        // 항목에 저장된 prev 가 있으면 우선, 없으면 state.prevCounters
        const fromState = prevCnt.get(r.item_id) || { bw: 0, color: 0 };
        const prevBw = (r.counter_bw_prev != null) ? r.counter_bw_prev : (fromState.bw || 0);
        const prevCo = (r.counter_color_prev != null) ? r.counter_color_prev : (fromState.color || 0);
        const bwCur = r.counter_bw || 0;
        const coCur = r.counter_color || 0;
        const bwMonth = (r.month_bw != null) ? r.month_bw : Math.max(0, bwCur - prevBw);
        const coMonth = (r.month_co != null) ? r.month_co : Math.max(0, coCur - prevCo);
        const bwExtra = bwMonth - (r.bw_free || 0);
        const coExtra = coMonth - (r.co_free || 0);
        const bwFee = bwExtra > 0 ? bwExtra * (r.bw_rate || 0) : 0;
        const coFee = coExtra > 0 ? coExtra * (r.co_rate || 0) : 0;
        bwExtraSum += bwFee;
        coExtraSum += coFee;
        aoa.push([
          r.label || r.subtype || '',
          ym,
          prevBw, bwCur, r.bw_free || 0, bwMonth, bwExtra, r.bw_rate || 0, bwFee,
          prevCo, coCur, r.co_free || 0, coMonth, coExtra, r.co_rate || 0, coFee
        ]);
      }
      if (!usageRows.length) {
        aoa.push(['(초과 사용 없음)']);
      }
      blank();

      // ── 3) 합계 ──
      aoa.push(['', '', '', '', '', '', '', '흑백추가', bwExtraSum]);
      aoa.push(['', '', '', '', '', '', '', '칼라추가', coExtraSum]);
      aoa.push(['', '', '', '', '', '', '', '고정임대료', view.fixed_total]);
      aoa.push(['', '', '', '', '', '', '', '총 청구액', view.total, '', '', '', '부가세별도']);

      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [
        { wch: 22 }, { wch: 10 },
        { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 },
        { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }
      ];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, `${ym} 청구`);

      const safeName = String(c.company || 'customer').replace(/[\\\/:*?"<>|]/g, '_');
      const filename = `청구서_${safeName}_${ym}.xlsx`;
      XLSX.writeFile(wb, filename);
      toast('엑셀 다운로드 완료', 'ok');
    } catch (e) {
      console.error('[billing] excel error', e);
      toast('엑셀 생성 실패: ' + (e.message || e), 'error');
    }
  }

  function prevMonth(ym) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  // ym 부터 count 개월(이번달 포함)을 ['YYYY-MM', ...] 로 반환 — 가장 최근부터 과거 순
  function ymRange(ym, count) {
    const [y, m] = ym.split('-').map(Number);
    const out = [];
    for (let i = 0; i < count; i++) {
      const d = new Date(y, m - 1 - i, 1);
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return out;
  }
  // ym - n 개월 (n=1 이면 직전월)
  function ymMinus(ym, n) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 - n, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  // 청구 주기 라벨
  function periodLabel(ym, months) {
    if (months <= 1) return ym;
    const startYm = ymMinus(ym, months - 1);
    const [y, m] = ym.split('-').map(Number);
    if (months === 3) {
      const q = Math.ceil(m / 3);
      return `${y}년 ${q}분기 (${startYm}~${ym})`;
    }
    if (months === 6) {
      return `${y}년 ${m <= 6 ? '상반기' : '하반기'} (${startYm}~${ym})`;
    }
    if (months === 12) {
      return `${y}년 (${startYm}~${ym})`;
    }
    return `${months}개월 (${startYm}~${ym})`;
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
