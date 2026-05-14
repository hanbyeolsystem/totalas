// ===========================================================
// totalas — 임대거래처 (Growth CRM)
// rental_customers + rental_assignments + rental_items + rental_counters
// Cross-sell 인사이트 · NAS 잠재고객 · 품목별 AS 주기
// ===========================================================
'use strict';

const STATE = {
  customers: [],         // 가공된 거래처 배열
  countersByItem: {},    // { item_id: [{ym, bw, color}, ...] }
  selectedId: null,
  activeDrill: null,     // 상단 통계 카드 드릴다운 필터 키
  filters: {
    q: '',
    sort: 'name',
    onlyNas: false,
    mode: 'active',      // 'active' | 'archived'
  },
};

// 카테고리 분류 (item.subtype 매칭)
const CAT_MAP = {
  // IT
  'PC': 'IT', 'pc': 'IT', '컴퓨터': 'IT', '데스크탑': 'IT', '노트북': 'IT',
  'monitor': 'IT', '모니터': 'IT', 'NAS': 'IT', 'nas': 'IT',
  // 출력
  '잉크젯': '출력', 'inkjet': '출력',
  '레이저': '출력', 'laser': '출력',
  '복합기': '출력', 'mfp': '출력', '복사기': '출력',
  // 위생
  '웰리스': '위생', 'wellis': '위생', '제균기': '위생', '필터': '위생',
};

// AS 주기 (개월) — claude.md 정책
const AS_SCHEDULE = {
  '잉크젯': { months: 3, task: '프린터 헤드 점검·세척' },
  'inkjet': { months: 3, task: '프린터 헤드 점검·세척' },
  '레이저': { months: 6, task: '드럼·롤러 점검' },
  'laser':  { months: 6, task: '드럼·롤러 점검' },
  '복합기': { months: 6, task: '드럼·스캐너 점검' },
  'mfp':    { months: 6, task: '드럼·스캐너 점검' },
  'PC':     { months: 12, task: 'OS 최적화·청소' },
  'pc':     { months: 12, task: 'OS 최적화·청소' },
  '컴퓨터': { months: 12, task: 'OS 최적화·청소' },
  '데스크탑': { months: 12, task: 'OS 최적화·청소' },
  '노트북':   { months: 12, task: 'OS 최적화·청소' },
  'monitor': { months: 24, task: '패널·케이블 점검' },
  '모니터':  { months: 24, task: '패널·케이블 점검' },
  '웰리스': { months: 2, task: '필터 교체' },
  'wellis': { months: 2, task: '필터 교체' },
  '제균기': { months: 2, task: '필터 교체' },
  'NAS':    { months: 6, task: '디스크 SMART·백업 점검' },
  'nas':    { months: 6, task: '디스크 SMART·백업 점검' },
};

function categoryOf(subtype) {
  if (!subtype) return '기타';
  const s = String(subtype).trim();
  if (CAT_MAP[s]) return CAT_MAP[s];
  // 키워드 부분일치
  for (const k of Object.keys(CAT_MAP)) {
    if (s.includes(k)) return CAT_MAP[k];
  }
  return '기타';
}

function asScheduleOf(subtype) {
  if (!subtype) return null;
  const s = String(subtype).trim();
  if (AS_SCHEDULE[s]) return AS_SCHEDULE[s];
  for (const k of Object.keys(AS_SCHEDULE)) {
    if (s.includes(k)) return AS_SCHEDULE[k];
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 부팅
// ─────────────────────────────────────────────────────────────
async function boot() {
  bindUI();
  await loadAll();
}
if (window.totalasAuth) {
  boot();
} else {
  document.addEventListener('totalas:ready', boot, { once: true });
  // 안전망: 2초 안에도 미준비면 그대로 부팅 시도 (loadAll 내부에서 에러 표시)
  setTimeout(() => { if (!STATE.customers.length) boot(); }, 2000);
}

function bindUI() {
  // 상단 통계 카드 → 드릴다운 토글
  document.querySelectorAll('#rc-stats .stat-card[data-cust-filter]').forEach(card => {
    card.addEventListener('click', () => {
      toggleCustDrilldown(card.dataset.custFilter);
    });
  });
  document.getElementById('rc-drilldown-close')?.addEventListener('click', closeCustDrilldown);

  document.getElementById('rc-search').addEventListener('input', (e) => {
    STATE.filters.q = e.target.value.trim();
    renderList();
  });
  document.getElementById('rc-sort').addEventListener('change', (e) => {
    STATE.filters.sort = e.target.value;
    renderList();
  });
  document.getElementById('rc-only-nas').addEventListener('change', (e) => {
    STATE.filters.onlyNas = e.target.checked;
    renderList();
  });
  // 활성/만기 모드 토글
  document.querySelectorAll('input[name="rc-mode"]').forEach(r => {
    r.addEventListener('change', async (e) => {
      if (!e.target.checked) return;
      STATE.filters.mode = e.target.value;
      STATE.selectedId = null;
      await loadAll();
      renderDetail();
    });
  });
  document.getElementById('btn-add').addEventListener('click', () => openForm(null));

  // 상단 "새 계약서 작성" 버튼
  // copy-rental-contract 자식 페이지를 새 창으로 열고, 활성 거래처 정보를 URL 해시로 전달
  const topCtBtn = document.getElementById('btn-ct-new-top');
  if (topCtBtn) {
    topCtBtn.addEventListener('click', () => {
      const sel = STATE.selectedId
        ? STATE.customers.find(x => x.id === STATE.selectedId)
        : null;
      const params = new URLSearchParams();
      if (sel) {
        params.set('customer_id', sel.id || '');
        if (sel.company)      params.set('name',   sel.company);
        if (sel.biz_no)       params.set('reg',    sel.biz_no);
        if (sel.contact_name) {
          params.set('ceo',    sel.contact_name);
          params.set('person', sel.contact_name);
        }
        if (sel.address) params.set('addr',  sel.address);
        if (sel.phone)   params.set('tel',   sel.phone);
        if (sel.email)   params.set('email', sel.email);
      }
      const url = './copy-rental-contract/index.html' + (params.toString() ? '#' + params.toString() : '');
      window.open(url, '_blank');
    });
  }

  const backdrop = document.getElementById('rc-modal');
  backdrop.addEventListener('click', (e) => {
    if (e.target.id === 'rc-modal') closeModal();
  });

  // ESC 키로 모달 닫기
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('rc-modal').classList.contains('show')) {
      closeModal();
    }
  });

  // copy-rental-contract 자식 창에서 보내는 저장 요청 수신
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type !== 'rental-contract-save') return;
    handleChildContractSave(m, e.source);
  });
}

// ─────────────────────────────────────────────────────────────
// 자식 페이지(copy-rental-contract)에서 받은 저장 요청 처리
// 활성 거래처에 회사 정보 동기화 + rental_contracts 에 계약 + 임대 물품 저장
// ─────────────────────────────────────────────────────────────
async function handleChildContractSave(msg, sourceWin) {
  const reply = (ok, message, extra) => {
    try { sourceWin && sourceWin.postMessage(Object.assign({
      type: 'rental-contract-save-result', ok, message
    }, extra || {}), '*'); } catch (_) {}
  };
  const supa = window.totalasAuth;
  if (!supa) { reply(false, '인증이 준비되지 않았습니다.'); return; }

  const cu = msg.customer || {};
  const company = (cu.name || '').trim();
  if (!company) { reply(false, '회사명을 입력하세요.'); return; }

  // ── 1) 대상 거래처 결정 ──
  //   ① msg.customer_id 가 STATE에 있으면 사용 (부모가 선택해서 자식을 열었을 때)
  //   ② STATE.selectedId 가 있으면 그 거래처 사용 (자식 열린 사이 선택이 바뀌었을 때 대비)
  //   ③ DB에서 회사명으로 조회 후 첫 매치
  //   ④ 없으면 신규 INSERT
  let targetId = null;
  let created = false;
  try {
    const candIds = [msg.customer_id, STATE.selectedId].filter(Boolean);
    for (const cid of candIds) {
      if (STATE.customers.some(x => x.id === cid)) { targetId = cid; break; }
    }
    if (!targetId) {
      const { data: found, error: fErr } = await supa
        .from('rental_customers').select('id').eq('company', company).limit(1);
      if (fErr) throw fErr;
      if (found && found.length) targetId = found[0].id;
    }
    if (!targetId) {
      targetId = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const { error: insErr } = await supa.from('rental_customers').insert({
        id: targetId,
        company,
        contact_name: (cu.person || cu.ceo || '').trim() || null,
        phone:        (cu.tel || '').trim() || null,
        biz_no:       (cu.reg || '').trim() || null,
        address:      (cu.addr || '').trim() || null,
        email:        (cu.email || '').trim() || null,
        active: true
      });
      if (insErr) throw insErr;
      created = true;
    } else {
      // 기존 거래처: 입력된 값으로 업데이트 (빈 값은 덮어쓰지 않음)
      const patch = {};
      if (company)    patch.company      = company;
      if (cu.person || cu.ceo) patch.contact_name = (cu.person || cu.ceo).trim();
      if (cu.tel)     patch.phone        = cu.tel.trim();
      if (cu.reg)     patch.biz_no       = cu.reg.trim();
      if (cu.addr)    patch.address      = cu.addr.trim();
      if (cu.email)   patch.email        = cu.email.trim();
      if (Object.keys(patch).length) {
        const { error: upErr } = await supa.from('rental_customers')
          .update(patch).eq('id', targetId);
        if (upErr) throw upErr;
      }
    }
  } catch (err) {
    console.error(err);
    reply(false, '거래처 저장 실패: ' + (err.message || err));
    return;
  }

  // ── 2) rental_contracts upsert (임대 물품 + 계약 내용) ──
  const ri = msg.rentalInfo || {};
  const items = Array.isArray(msg.rentalItems) ? msg.rentalItems : [];
  const contractId = (ri.docNum && ri.docNum.trim())
    ? 'ct_' + targetId + '_' + ri.docNum.trim().replace(/[^a-zA-Z0-9\-]/g,'_')
    : 'ct_' + targetId + '_' + Date.now().toString(36);
  const contractPayload = {
    id: contractId,
    customer_id: targetId,
    contract_no: ri.docNum || null,
    contract_date: ri.docDate || new Date().toISOString().slice(0,10),
    period_years: parseInt(ri.rPeriod, 10) || null,
    deposit: parseInt(ri.rDeposit, 10) || 0,
    install_fee: 0,
    company_snapshot:      company,
    contact_name_snapshot: cu.person || cu.ceo || '',
    biz_no_snapshot:       cu.reg || '',
    address_snapshot:      cu.addr || '',
    phone_snapshot:        cu.tel || '',
    email_snapshot:        cu.email || '',
    items: items,                                    // 임대 물품 내역 (JSON)
    terms: [ri.rt1, ri.rt2, ri.rt3, ri.rt4, ri.rt5].filter(Boolean),
    extras: [ri.re1, ri.re2, ri.re3, ri.re4].filter(Boolean),
    special_terms: [ri.rcSpecial1, ri.rcSpecial2].filter(Boolean).join('\n') || null,
    payment_method: ri.rPayMethod || 'account',
    payment_info: {
      bank: ri.rBank || '', account: ri.rAccount || '',
      holder: ri.rHolder || '', resid: ri.rResid || '',
      debit_day: ri.rDebitDay || '', debit_amt: parseInt(ri.rDebitAmt, 10) || 0,
      bank_memo: ri.rBankMemo || '', card_exp: ri.rCardExp || '',
      bill_type: ri.rBilling || '', bill_email: ri.rBillEmail || '',
      person: ri.rPerson || '', mobile: ri.rMobile || ''
    },
    sign_supplier:  null,
    sign_applicant: ri.customerSig || null,
    signature_type: ri.customerSig ? 'digital' : 'paper',
    status: 'draft',
    updated_at: new Date().toISOString()
  };

  try {
    const { error: ctErr } = await supa.from('rental_contracts').upsert(contractPayload);
    if (ctErr) throw ctErr;
  } catch (err) {
    console.error(err);
    reply(false, '계약 저장 실패: ' + (err.message || err), { customer_id: targetId });
    // 거래처는 살아 있으니 customer_id 회신은 해줌
    await loadAll(); renderList();
    return;
  }

  // ── 3) UI 갱신 ──
  try {
    await loadAll();
    STATE.selectedId = targetId;
    renderList();
    renderDetail();
    if (typeof loadContractsFor === 'function') {
      await loadContractsFor(targetId);
      renderDetail();
    }
  } catch (err) { console.error(err); }

  toast(created ? '신규 거래처 + 계약 저장 완료' : '계약 + 거래처 정보 동기화 완료', 'ok');
  reply(true, created ? '신규 거래처 등록 + 계약 저장 완료' : '활성 거래처에 저장 완료', { customer_id: targetId });
}

// ─────────────────────────────────────────────────────────────
// 데이터 로드
// ─────────────────────────────────────────────────────────────
async function loadAll() {
  const supa = window.totalasAuth;
  const listEl = document.getElementById('rc-cust-list');
  listEl.innerHTML = `<div class="muted" style="text-align:center; padding:20px; font-size:12px;">로딩 중…</div>`;

  try {
    // 1. 거래처 + 할당(자산) JOIN — 활성/만기 모드에 따라 분기
    const wantActive = STATE.filters.mode !== 'archived';
    const { data: custs, error: cErr } = await supa
      .from('rental_customers')
      .select(`
        *,
        rental_assignments(
          id, item_id, start_date, end_date, monthly_fee,
          bw_free, co_free, bw_rate, co_rate,
          rental_items(id, category, subtype, brand, model, serial, install_date, status, storage_gb)
        )
      `)
      .eq('active', wantActive)
      .range(0, 999);
    if (cErr) throw cErr;

    // 2. 카운터 데이터 (전체 — NAS 후보 판정용 월평균 계산)
    const { data: counters, error: ctrErr } = await supa
      .from('rental_counters')
      .select('item_id, ym, bw, color, uptime_hours')
      .range(0, 9999);
    if (ctrErr) throw ctrErr;

    STATE.countersByItem = {};
    (counters || []).forEach(c => {
      (STATE.countersByItem[c.item_id] = STATE.countersByItem[c.item_id] || []).push(c);
    });

    // 3. 가공: 각 거래처에 자산 카테고리/Cross-sell 점수 부여
    STATE.customers = (custs || []).map(c => enrichCustomer(c));

    // 4. 통계 + 리스트 렌더
    renderStats();
    renderList();
  } catch (err) {
    console.error(err);
    listEl.innerHTML = `<div class="rc-error" style="text-align:center; padding:20px;">조회 실패: ${escapeHtml(err.message || String(err))}</div>`;
  }
}

function enrichCustomer(c) {
  const assignments = (c.rental_assignments || []).filter(a => a.rental_items);
  // 종료된 계약 제외
  const active = assignments.filter(a => !a.end_date || new Date(a.end_date) >= new Date());

  // 보유 카테고리/소분류 집합
  const subtypes = new Set();
  const cats = new Set();
  active.forEach(a => {
    const st = a.rental_items.subtype || '';
    subtypes.add(st);
    cats.add(categoryOf(st));
  });

  const hasPC      = [...subtypes].some(s => /pc|컴퓨터|데스크탑|노트북/i.test(s));
  const hasMonitor = [...subtypes].some(s => /monitor|모니터/i.test(s));
  const hasOutput  = cats.has('출력');
  const hasWellis  = cats.has('위생');
  const hasNAS     = [...subtypes].some(s => /nas/i.test(s));
  const hasMFP     = [...subtypes].some(s => /복합기|mfp/i.test(s));

  // 기기 세분류 (출력기기는 흑백/컬러 분리 — assignment.co_rate>0 또는 co_free>0 이면 컬러)
  let hasBwMfp = false, hasColorMfp = false;
  let hasBwLaser = false, hasColorLaser = false;
  let hasInkjet = false;
  active.forEach(a => {
    const it = a.rental_items;
    const sub = (it.subtype || '').toLowerCase();
    const isColor = ((a.co_rate || 0) > 0) || ((a.co_free || 0) > 0);
    if (/복합기|mfp|복사/.test(sub)) {
      if (isColor) hasColorMfp = true; else hasBwMfp = true;
    } else if (/laser|레이저/.test(sub)) {
      if (isColor) hasColorLaser = true; else hasBwLaser = true;
    } else if (/inkjet|잉크젯/.test(sub)) {
      hasInkjet = true;
    }
  });

  // 월평균 출력량 (활성 자산의 카운터 합산 — 최근 6개월)
  const recentYm = recentMonths(6);
  let totalPages = 0;
  let monthsCovered = 0;
  active.forEach(a => {
    const ctrs = (STATE.countersByItem[a.item_id] || []).filter(x => recentYm.includes(x.ym));
    ctrs.forEach(x => {
      totalPages += (x.bw || 0) + (x.color || 0);
      monthsCovered++;
    });
  });
  const avgPagesPerMonth = monthsCovered > 0 ? totalPages / monthsCovered : 0;

  // Cross-sell 점수 (0~100): 제안 가능 항목이 많을수록 높음
  let score = 0;
  if (hasPC && !hasMonitor) score += 25;          // 모니터 제안
  if (hasOutput && !hasWellis) score += 20;        // 웰리스 제안
  if (!hasNAS && (avgPagesPerMonth >= 3000 || hasMFP)) score += 30; // NAS 제안
  if (cats.size <= 1 && active.length > 0) score += 15;            // 라인업 다양화
  if (active.length === 0) score = 0;

  const isNasCandidate = !hasNAS && (avgPagesPerMonth >= 3000 || hasMFP);

  return {
    ...c,
    _assignments: active,
    _allAssignments: assignments,
    _subtypes: subtypes,
    _cats: cats,
    _hasPC: hasPC,
    _hasMonitor: hasMonitor,
    _hasOutput: hasOutput,
    _hasWellis: hasWellis,
    _hasNAS: hasNAS,
    _hasMFP: hasMFP,
    _hasBwMfp: hasBwMfp,
    _hasColorMfp: hasColorMfp,
    _hasBwLaser: hasBwLaser,
    _hasColorLaser: hasColorLaser,
    _hasInkjet: hasInkjet,
    _avgPages: avgPagesPerMonth,
    _score: score,
    _isNasCandidate: isNasCandidate,
  };
}

function recentMonths(n) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 통계 카드
// ─────────────────────────────────────────────────────────────
function renderStats() {
  const cs = STATE.customers;
  const archived = STATE.filters.mode === 'archived';

  const totalLabel = document.querySelector('#s-total')?.parentElement?.querySelector('.stat-label');
  if (totalLabel) totalLabel.textContent = archived ? '만기 거래처' : '활성 거래처';

  document.getElementById('s-total').textContent = cs.length;
  document.getElementById('s-total-sub').textContent = archived
    ? `만기 처리된 거래처 (데이터 보존)`
    : `총 자산 ${cs.reduce((s,c) => s + c._assignments.length, 0)}건`;

  // 기기별 보유 거래처 수
  const setEl = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n.toLocaleString(); };
  setEl('s-bw-mfp',      cs.filter(c => c._hasBwMfp).length);
  setEl('s-color-mfp',   cs.filter(c => c._hasColorMfp).length);
  setEl('s-bw-laser',    cs.filter(c => c._hasBwLaser).length);
  setEl('s-color-laser', cs.filter(c => c._hasColorLaser).length);
  setEl('s-inkjet',      cs.filter(c => c._hasInkjet).length);
  setEl('s-pc',          cs.filter(c => c._hasPC).length);
  setEl('s-monitor',     cs.filter(c => c._hasMonitor).length);
  setEl('s-wellness',    cs.filter(c => c._hasWellis).length);
  setEl('s-nas',         cs.filter(c => c._hasNAS).length);

  // 드릴다운이 열려있으면 재렌더
  if (STATE.activeDrill) renderCustDrilldown(STATE.activeDrill);
}

// ─────────────────────────────────────────────────────────────
// 통계 카드 클릭 → 거래처 목록 드릴다운
// ─────────────────────────────────────────────────────────────
const CUST_DRILL_LABELS = {
  active: '활성 거래처',
  bw_mfp: '🖨 흑백 복사기 보유',
  color_mfp: '🌈 컬러 복사기 보유',
  bw_laser: '⚡ 흑백 레이저 보유',
  color_laser: '🌈 컬러 레이저 보유',
  inkjet: '💧 잉크젯 보유',
  pc: '💻 컴퓨터 보유',
  monitor: '🖥 모니터 보유',
  wellness: '🌿 웰리스 보유',
  nas: '💾 나스 보유',
};
function filteredCustomersFor(filter) {
  const cs = STATE.customers;
  switch (filter) {
    case 'active':      return cs;
    case 'bw_mfp':      return cs.filter(c => c._hasBwMfp);
    case 'color_mfp':   return cs.filter(c => c._hasColorMfp);
    case 'bw_laser':    return cs.filter(c => c._hasBwLaser);
    case 'color_laser': return cs.filter(c => c._hasColorLaser);
    case 'inkjet':      return cs.filter(c => c._hasInkjet);
    case 'pc':          return cs.filter(c => c._hasPC);
    case 'monitor':     return cs.filter(c => c._hasMonitor);
    case 'wellness':    return cs.filter(c => c._hasWellis);
    case 'nas':         return cs.filter(c => c._hasNAS);
    default:            return cs;
  }
}
function toggleCustDrilldown(filter) {
  if (STATE.activeDrill === filter) return closeCustDrilldown();
  STATE.activeDrill = filter;
  document.querySelectorAll('#rc-stats .stat-card').forEach(c =>
    c.classList.toggle('active', c.dataset.custFilter === filter));
  document.getElementById('rc-drilldown').style.display = '';
  renderCustDrilldown(filter);
}
function closeCustDrilldown() {
  STATE.activeDrill = null;
  document.querySelectorAll('#rc-stats .stat-card').forEach(c => c.classList.remove('active'));
  document.getElementById('rc-drilldown').style.display = 'none';
}
function renderCustDrilldown(filter) {
  const list = filteredCustomersFor(filter);
  const title = document.getElementById('rc-drilldown-title');
  if (title) title.textContent = `${CUST_DRILL_LABELS[filter] || '거래처 목록'} (${list.length})`;
  const body = document.getElementById('rc-drilldown-body');
  if (!body) return;
  if (!list.length) {
    body.innerHTML = `<div class="drilldown-empty">해당하는 거래처가 없습니다.</div>`;
    return;
  }
  // 자산 수 많은 순 → 회사명 순
  const sorted = list.slice().sort((a, b) => {
    const da = (b._assignments?.length || 0) - (a._assignments?.length || 0);
    return da !== 0 ? da : (a.company || '').localeCompare(b.company || '');
  });
  body.innerHTML = `
    <table class="drilldown-table">
      <thead><tr>
        <th>회사명</th>
        <th class="num">자산</th>
        <th>보유 카테고리</th>
        <th class="num">월평균 출력</th>
        <th></th>
      </tr></thead>
      <tbody>
        ${sorted.map(c => {
          const cats = [...(c._cats || [])].join(', ') || '–';
          const avg = Math.round(c._avgPages || 0);
          return `
            <tr class="drilldown-row" data-cid="${escapeAttr(c.id)}">
              <td><b>${escapeHtml(c.company || '(이름 없음)')}</b></td>
              <td class="num">${c._assignments?.length || 0}</td>
              <td>${escapeHtml(cats)}</td>
              <td class="num">${avg.toLocaleString()}</td>
              <td><span class="muted-small">→ 상세 보기</span></td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
  body.querySelectorAll('.drilldown-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const cid = tr.dataset.cid;
      STATE.selectedId = cid;
      renderList();
      renderDetail();
      const listCard = document.querySelector('.rc-list-card');
      if (listCard) window.scrollTo({ top: listCard.offsetTop - 20, behavior: 'smooth' });
    });
  });
}

// ─────────────────────────────────────────────────────────────
// 좌측 거래처 리스트
// ─────────────────────────────────────────────────────────────
function renderList() {
  const listEl = document.getElementById('rc-cust-list');
  const { q, sort, onlyNas } = STATE.filters;

  let arr = STATE.customers.slice();
  if (q) {
    const lq = q.toLowerCase();
    arr = arr.filter(c => (c.company || '').toLowerCase().includes(lq));
  }
  if (onlyNas) arr = arr.filter(c => c._isNasCandidate);

  arr.sort((a, b) => {
    switch (sort) {
      case 'recent': return new Date(b.created_at || 0) - new Date(a.created_at || 0);
      case 'assets': return b._assignments.length - a._assignments.length;
      case 'score':  return b._score - a._score;
      case 'name':
      default:       return (a.company || '').localeCompare(b.company || '', 'ko');
    }
  });

  if (!arr.length) {
    listEl.innerHTML = `<div class="muted" style="text-align:center; padding:20px; font-size:12px;">결과 없음</div>`;
    return;
  }

  const archived = STATE.filters.mode === 'archived';

  listEl.innerHTML = arr.map(c => {
    const tags = [];
    if (archived) {
      const ad = c.archived_at ? String(c.archived_at).slice(0, 10) : '';
      tags.push(`<span class="rc-tag" style="background:#fee2e2;color:#991b1b;">만기${ad ? ' ' + ad : ''}</span>`);
    } else {
      if (c._isNasCandidate) tags.push(`<span class="rc-tag nas">NAS 후보</span>`);
      if (c._score >= 50) tags.push(`<span class="rc-tag score-hot">🔥 ${c._score}</span>`);
      else if (c._score >= 25) tags.push(`<span class="rc-tag score-mid">${c._score}</span>`);
      else if (c._score > 0) tags.push(`<span class="rc-tag score-low">${c._score}</span>`);
    }

    // 인라인 액션 버튼 — 모드별 분기
    const actions = archived
      ? `
        <button class="rc-item-action" data-action="edit" title="수정">✏</button>
        <button class="rc-item-action" data-action="restore" title="활성으로 복원">🔄</button>
      `
      : `
        <button class="rc-item-action" data-action="edit" title="수정">✏</button>
        <button class="rc-item-action" data-action="archive" title="만기 처리(보관)">🗑</button>
      `;

    return `
      <div class="rc-cust-item ${STATE.selectedId === c.id ? 'active' : ''} ${archived ? 'archived' : ''}" data-id="${escapeAttr(c.id)}">
        <div class="rc-cust-actions">${actions}</div>
        <div class="rc-cust-name">${escapeHtml((c.company || '').split('\n')[0])}</div>
        <div class="rc-cust-sub">자산 ${c._assignments.length}건 · ${escapeHtml((c.address || '').slice(0, 24))}</div>
        <div class="rc-cust-tags">${tags.join('')}</div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.rc-cust-item').forEach(el => {
    // 액션 버튼 클릭 — 상위 선택 이벤트 방지
    el.querySelectorAll('.rc-item-action').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cid = el.dataset.id;
        const action = btn.dataset.action;
        const cust = STATE.customers.find(x => x.id === cid);
        if (!cust) return;
        if (action === 'edit') openForm(cust);
        else if (action === 'archive') archiveCustomer(cust);
        else if (action === 'restore') restoreCustomer(cust);
      });
    });

    el.addEventListener('click', () => {
      STATE.selectedId = el.dataset.id;
      renderList();
      renderDetail();
    });
  });
}

// 만기 처리 (active=false, archived_at, archived_reason 기록)
async function archiveCustomer(c) {
  const name = (c.company || '').split('\n')[0];
  if (!confirm(`'${name}' 거래처를 만기 처리합니다.\n\n만기 거래처 목록으로 이동되며 데이터는 보존됩니다.\n진행할까요?`)) return;
  try {
    const supa = window.totalasAuth;
    const { error } = await supa.from('rental_customers').update({
      active: false,
      archived_at: new Date().toISOString(),
      archived_reason: '임대 만기',
    }).eq('id', c.id);
    if (error) throw error;
    toast('만기 처리 완료', 'ok');
    if (STATE.selectedId === c.id) STATE.selectedId = null;
    await loadAll();
    renderDetail();
  } catch (err) {
    console.error(err);
    toast('만기 처리 실패: ' + (err.message || err), 'err');
  }
}

// 만기 → 활성 복원
async function restoreCustomer(c) {
  const name = (c.company || '').split('\n')[0];
  if (!confirm(`'${name}' 거래처를 활성으로 복원할까요?`)) return;
  try {
    const supa = window.totalasAuth;
    const { error } = await supa.from('rental_customers').update({
      active: true,
      archived_at: null,
      archived_reason: null,
    }).eq('id', c.id);
    if (error) throw error;
    toast('활성으로 복원되었습니다.', 'ok');
    if (STATE.selectedId === c.id) STATE.selectedId = null;
    await loadAll();
    renderDetail();
  } catch (err) {
    console.error(err);
    toast('복원 실패: ' + (err.message || err), 'err');
  }
}

// ─────────────────────────────────────────────────────────────
// 우측 상세 패널
// ─────────────────────────────────────────────────────────────
function renderDetail() {
  const detail = document.getElementById('rc-detail');
  const c = STATE.customers.find(x => x.id === STATE.selectedId);
  if (!c) {
    const empty = STATE.filters.mode === 'archived'
      ? (STATE.customers.length === 0
          ? `<div class="card rc-detail-empty"><p style="font-size:14px; margin:0;">만기 처리된 거래처가 없습니다.</p><p class="muted" style="font-size:12px; margin-top:8px;">활성 거래처 목록의 🗑 아이콘으로 만기 처리할 수 있습니다.</p></div>`
          : `<div class="card rc-detail-empty"><p style="font-size:14px; margin:0;">좌측에서 만기 거래처를 선택하세요.</p></div>`)
      : `<div class="card rc-detail-empty"><p style="font-size:14px; margin:0;">좌측에서 거래처를 선택하세요.</p></div>`;
    detail.innerHTML = empty;
    return;
  }

  // 1) 기본 정보
  const infoCard = `
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
        <h3 style="margin:0;">${escapeHtml((c.company || '').split('\n')[0])}</h3>
        <div style="display:flex; gap:6px;">
          <button class="btn small" id="btn-edit">수정</button>
          <button class="btn small danger" id="btn-delete">삭제</button>
        </div>
      </div>
      <div class="rc-info-grid" style="margin-top:10px;">
        <div><label>담당자</label>${escapeHtml(c.contact_name || '-')}</div>
        <div><label>전화</label>${escapeHtml(c.phone || '-')}</div>
        <div><label>휴대전화</label>${escapeHtml(c.mobile || '-')}</div>
        <div><label>이메일</label>${escapeHtml(c.email || '-')}</div>
        <div><label>사업자번호</label>${escapeHtml(c.biz_no || '-')}</div>
        <div><label>주소</label>${escapeHtml(c.address || '-')}</div>
        <div><label>결제방식</label>${escapeHtml(c.payment_type || '-')}</div>
        <div><label>보증금</label>${c.deposit != null ? Number(c.deposit).toLocaleString() + '원' : '-'}</div>
        <div><label>청구일</label>${c.invoice_day != null ? c.invoice_day + '일' : '-'}</div>
        <div><label>월 평균 출력량</label>${Math.round(c._avgPages).toLocaleString()}장</div>
      </div>
      ${c.notes ? `<div style="margin-top:10px; padding:8px 10px; background:#f8fafc; border-radius:6px; font-size:12.5px; white-space:pre-wrap;">${escapeHtml(c.notes)}</div>` : ''}
    </div>
  `;

  // 2) Cross-sell 인사이트
  const insights = buildInsights(c);
  const insightCard = `
    <div class="card">
      <h3>💡 Cross-sell 인사이트 <span class="muted-small" style="font-weight:400;">(점수 ${c._score}/100)</span></h3>
      ${insights.length
        ? insights.map(i => `
            <div class="rc-insight ${i.level}">
              <div class="rc-insight-title">${i.icon} ${escapeHtml(i.title)}</div>
              <div class="rc-insight-body">${escapeHtml(i.body)}</div>
            </div>
          `).join('')
        : '<p class="muted" style="margin:0; font-size:12.5px;">현재 추가 제안할 항목이 없습니다.</p>'
      }
    </div>
  `;

  // 3) 보유 자산 표 (카테고리별 정렬)
  const sorted = c._assignments.slice().sort((a, b) => {
    const ca = categoryOf(a.rental_items.subtype);
    const cb = categoryOf(b.rental_items.subtype);
    if (ca !== cb) return ca.localeCompare(cb, 'ko');
    return (a.rental_items.subtype || '').localeCompare(b.rental_items.subtype || '', 'ko');
  });

  const assetCard = `
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:8px;">
        <h3 style="margin:0;">📦 임대 물품 내역 <span class="muted-small" style="font-weight:400;">${sorted.length}건</span></h3>
        <button class="btn small primary" id="btn-asset-add">+ 임대추가</button>
      </div>
      ${sorted.length ? `
        <div style="overflow-x:auto;">
          <table class="rc-asset-table">
            <thead>
              <tr>
                <th>분류</th><th>품목</th><th>모델</th><th>시리얼</th>
                <th>설치일</th><th>월 임대료</th><th>상태</th><th class="act">관리</th>
              </tr>
            </thead>
            <tbody>
              ${sorted.map(a => {
                const it = a.rental_items;
                const cat = categoryOf(it.subtype);
                return `<tr>
                  <td><span class="rc-cat-pill rc-cat-${cat}">${cat}</span></td>
                  <td>${escapeHtml(it.subtype || '-')}</td>
                  <td>${escapeHtml(((it.brand || '') + ' ' + (it.model || '')).trim() || '-')}</td>
                  <td class="muted-small">${escapeHtml(it.serial || '-')}</td>
                  <td class="muted-small">${escapeHtml((it.install_date || '').slice(0, 10))}</td>
                  <td style="text-align:right;">${a.monthly_fee ? Number(a.monthly_fee).toLocaleString() : '-'}</td>
                  <td>${escapeHtml(it.status || '-')}</td>
                  <td class="act">
                    <button class="rc-icon-btn" title="수정" data-act="edit" data-aid="${escapeAttr(a.id)}">✏</button>
                    <button class="rc-icon-btn danger" title="삭제" data-act="del" data-aid="${escapeAttr(a.id)}">🗑</button>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      ` : `<p class="muted" style="margin:0; font-size:12.5px;">등록된 자산이 없습니다.</p>`}
    </div>
  `;

  // 4) 수리내역(지출) + 판매/수리(수익) 카드 — hook 에서 데이터 로드 후 채워짐
  const expenseCard = renderRepairCard(c, 'expense');
  const incomeCard  = renderRepairCard(c, 'income');

  // 순서: 보유자산 → 수리내역(지출) → 판매/수리(수익) → 기본정보 → (hook 으로 계약서) → Cross-sell
  detail.innerHTML = assetCard + expenseCard + incomeCard + infoCard + insightCard;

  document.getElementById('btn-edit').addEventListener('click', () => openForm(c));
  document.getElementById('btn-delete').addEventListener('click', () => deleteCustomer(c));

  const addBtn = document.getElementById('btn-asset-add');
  if (addBtn) addBtn.addEventListener('click', () => openAssetForm(c, null));

  detail.querySelectorAll('.rc-asset-table .rc-icon-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const aid = btn.dataset.aid;
      const a = c._assignments.find(x => x.id === aid);
      if (!a) return;
      if (btn.dataset.act === 'edit') openAssetForm(c, a);
      else if (btn.dataset.act === 'del') deleteAsset(c, a);
    });
  });
}

function buildInsights(c) {
  const out = [];
  // 1. PC+모니터 세트
  if (c._hasPC && !c._hasMonitor) {
    out.push({
      level: 'warn',
      icon: '🖥',
      title: 'PC 단독 보유 — 모니터 제안 기회',
      body: 'PC는 임대 중이나 모니터가 없습니다. PC+모니터 세트 구성을 제안하면 월 임대료 +20% 인상 가능.',
    });
  } else if (c._hasPC && c._hasMonitor) {
    out.push({
      level: 'ok',
      icon: '✅',
      title: 'PC+모니터 세트 구성 완료',
      body: '표준 IT 패키지가 구성되어 있습니다.',
    });
  }

  // 2. 출력기기 → 웰리스 제균기
  if (c._hasOutput && !c._hasWellis) {
    out.push({
      level: 'warn',
      icon: '🌬',
      title: '출력기기 사용처 — 웰리스 제균기 제안',
      body: '토너/잉크 분진이 발생하는 공간입니다. 웰리스 제균기 설치로 실내 공기질 개선 + 추가 매출 확보.',
    });
  }

  // 3. NAS 후보
  if (c._isNasCandidate) {
    const reason = c._hasMFP
      ? `복합기 보유 + 월평균 ${Math.round(c._avgPages).toLocaleString()}장 출력`
      : `월평균 ${Math.round(c._avgPages).toLocaleString()}장 출력 (3,000장 이상)`;
    out.push({
      level: 'hot',
      icon: '💾',
      title: 'NAS 렌탈 우선 타겟',
      body: `${reason} — 대량 문서 스캔/보관 수요 예상. NAS 도입 제안 우선순위 상위.`,
    });
  }

  // 4. 라인업 다양화
  if (c._assignments.length > 0 && c._cats.size <= 1) {
    out.push({
      level: 'info',
      icon: '📊',
      title: '단일 카테고리 의존',
      body: '현재 한 가지 카테고리만 임대 중입니다. 타 카테고리(IT/출력/위생) 확장 여지가 큽니다.',
    });
  }

  return out;
}

function buildAsRows(c) {
  // subtype별 그룹핑
  const groups = {};
  c._assignments.forEach(a => {
    const st = a.rental_items.subtype || '기타';
    if (!groups[st]) groups[st] = { count: 0, items: [] };
    groups[st].count++;
    groups[st].items.push(a.rental_items);
  });

  const rows = [];
  Object.entries(groups).forEach(([subtype, g]) => {
    const sched = asScheduleOf(subtype);
    if (!sched) return;
    // 다음 점검일 = 가장 오래된 설치일 기준
    const installDates = g.items
      .map(it => it.install_date)
      .filter(Boolean)
      .map(d => new Date(d))
      .sort((a, b) => a - b);
    let nextDate = '-';
    let overdue = false;
    if (installDates.length) {
      const oldest = installDates[0];
      // 다음 점검: 현재까지 경과한 사이클의 다음 회차
      const now = new Date();
      const monthsElapsed = (now.getFullYear() - oldest.getFullYear()) * 12 + (now.getMonth() - oldest.getMonth());
      const nextCycle = Math.ceil((monthsElapsed + 0.01) / sched.months);
      const next = new Date(oldest.getFullYear(), oldest.getMonth() + nextCycle * sched.months, oldest.getDate());
      overdue = next < now;
      nextDate = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
    }
    rows.push({
      subtype, count: g.count, months: sched.months, task: sched.task, nextDate, overdue,
    });
  });

  return rows.sort((a, b) => a.months - b.months);
}

// ─────────────────────────────────────────────────────────────
// CRUD: 추가/수정/삭제
// ─────────────────────────────────────────────────────────────
function openForm(existing) {
  const tpl = document.getElementById('tpl-customer-form');
  const body = document.getElementById('rc-modal-body');
  body.innerHTML = '';
  body.appendChild(tpl.content.cloneNode(true));

  if (existing) {
    body.querySelector('#form-title').textContent = `거래처 수정 — ${(existing.company || '').split('\n')[0]}`;
    const f = body.querySelector('#customer-form');
    [
      'company','contact_name','biz_no','phone','mobile','email',
      'address','payment_type','deposit','invoice_day','notes'
    ].forEach(k => {
      if (f[k] != null) f[k].value = existing[k] == null ? '' : existing[k];
    });
    if (f.active) f.active.value = existing.active === false ? 'false' : 'true';
  }

  body.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
  body.querySelector('#customer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const errEl = body.querySelector('#form-error');
    const btn = body.querySelector('#form-submit');
    errEl.textContent = '';
    btn.disabled = true;
    btn.textContent = '저장 중…';

    try {
      const payload = {
        company:      f.company.value.trim(),
        contact_name: f.contact_name.value.trim() || null,
        biz_no:       f.biz_no.value.trim() || null,
        phone:        f.phone.value.trim() || null,
        mobile:       f.mobile.value.trim() || null,
        email:        f.email.value.trim() || null,
        address:      f.address.value.trim() || null,
        payment_type: f.payment_type.value || null,
        deposit:      f.deposit.value ? Number(f.deposit.value) : null,
        invoice_day:  f.invoice_day.value ? Number(f.invoice_day.value) : null,
        notes:        f.notes.value.trim() || null,
        active:       f.active.value === 'true',
      };
      if (!payload.company) throw new Error('회사명은 필수입니다.');

      const supa = window.totalasAuth;
      if (existing) {
        const { error } = await supa.from('rental_customers').update(payload).eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await supa.from('rental_customers').insert(payload);
        if (error) throw error;
      }
      closeModal();
      await loadAll();
      if (existing) renderDetail();
    } catch (err) {
      console.error(err);
      errEl.textContent = err.message || String(err);
      btn.disabled = false;
      btn.textContent = '저장';
    }
  });

  document.getElementById('rc-modal').classList.add('show');
}

async function deleteCustomer(c) {
  if (!confirm(`'${(c.company || '').split('\n')[0]}' 거래처를 삭제할까요?\n\n관련 자산 할당(rental_assignments)이 있으면 실패할 수 있습니다.`)) return;
  try {
    const { error } = await window.totalasAuth.from('rental_customers').delete().eq('id', c.id);
    if (error) throw error;
    STATE.selectedId = null;
    await loadAll();
    renderDetail();
  } catch (err) {
    console.error(err);
    alert('삭제 실패: ' + (err.message || err));
  }
}

function closeModal() {
  document.getElementById('rc-modal').classList.remove('show');
  document.getElementById('rc-modal-body').classList.remove('rc-asset-modal-box');
}

// ─────────────────────────────────────────────────────────────
// CRUD: 자산 (rental_items + rental_assignments)
// ─────────────────────────────────────────────────────────────

// 9개 품목 → { category, subtype } 매핑 (DB 청구 로직 호환)
const ITEM_TO_CATSUB = {
  '흑백복사기': { category: '출력', subtype: '흑백복합기', isPrint: true,  isNas: false },
  '컬러복사기': { category: '출력', subtype: '컬러복합기', isPrint: true,  isNas: false },
  '흑백레이저': { category: '출력', subtype: '흑백레이저', isPrint: true,  isNas: false },
  '컬러레이저': { category: '출력', subtype: '컬러레이저', isPrint: true,  isNas: false },
  '잉크젯':     { category: '출력', subtype: '잉크젯',     isPrint: true,  isNas: false },
  '컴퓨터':     { category: 'IT',   subtype: '컴퓨터',     isPrint: false, isNas: false },
  '모니터':     { category: 'IT',   subtype: '모니터',     isPrint: false, isNas: false },
  '웰리스':     { category: '위생', subtype: '웰리스',     isPrint: false, isNas: false },
  '나스':       { category: 'IT',   subtype: '나스',       isPrint: false, isNas: true  },
};

// 기존 자산(category, subtype, co_rate)을 9개 품목으로 역분류 (수정 폼 열 때)
function classifyToItemType(it, asgn) {
  const sub = (it && it.subtype || '').toLowerCase();
  const cat = it && it.category || '';
  const isColor = asgn ? ((asgn.co_rate || 0) > 0 || (asgn.co_free || 0) > 0) : false;
  if (sub.includes('흑백복합기') || sub.includes('흑백복사기')) return '흑백복사기';
  if (sub.includes('컬러복합기') || sub.includes('컬러복사기')) return '컬러복사기';
  if (sub.includes('흑백레이저')) return '흑백레이저';
  if (sub.includes('컬러레이저')) return '컬러레이저';
  if (/복합기|mfp|복사/.test(sub)) return isColor ? '컬러복사기' : '흑백복사기';
  if (/laser|레이저/.test(sub))   return isColor ? '컬러레이저' : '흑백레이저';
  if (/inkjet|잉크젯/.test(sub))  return '잉크젯';
  if (/pc|컴퓨터|데스크|노트북/.test(sub)) return '컴퓨터';
  if (/monitor|모니터/.test(sub)) return '모니터';
  if (cat === '위생' || /wellness|wellis|웰리스|제균|필터/.test(sub)) return '웰리스';
  if (/nas|나스/.test(sub))       return '나스';
  return '';
}

function applyAssetVisibility(form) {
  const itemType = form.item_type ? form.item_type.value : '';
  const info = ITEM_TO_CATSUB[itemType] || { isPrint: false, isNas: false };
  form.querySelectorAll('[data-show]').forEach(row => {
    const tag = row.dataset.show;
    let show = false;
    if (tag === 'print') show = info.isPrint;
    else if (tag === 'nas') show = info.isNas;
    row.classList.toggle('hidden', !show);
  });
}

function openAssetForm(customer, existing) {
  const tpl = document.getElementById('tpl-asset-form');
  const body = document.getElementById('rc-modal-body');
  body.innerHTML = '';
  body.classList.add('rc-asset-modal-box');
  body.appendChild(tpl.content.cloneNode(true));

  const f = body.querySelector('#asset-form');
  const itemSel = f.item_type;

  // 품목 변경 → print/nas visibility 갱신
  itemSel.addEventListener('change', () => applyAssetVisibility(f));

  if (existing) {
    body.querySelector('#asset-form-title').textContent =
      `자산 수정 — ${(existing.rental_items.model || existing.rental_items.subtype || '')}`;
    const it = existing.rental_items || {};
    // 기존 자산을 9개 품목으로 역분류
    const inferredType = classifyToItemType(it, existing);
    if (inferredType) itemSel.value = inferredType;
    f.brand.value = it.brand || '';
    f.model.value = it.model || '';
    f.serial.value = it.serial || '';
    f.install_date.value = (it.install_date || '').slice(0, 10);
    f.status.value = it.status || 'active';
    f.storage_gb.value = it.storage_gb != null ? it.storage_gb : '';
    f.notes.value = it.notes || '';
    f.monthly_fee.value = existing.monthly_fee != null ? existing.monthly_fee : '';
    f.bw_free.value = existing.bw_free != null ? existing.bw_free : '';
    f.co_free.value = existing.co_free != null ? existing.co_free : '';
    f.bw_rate.value = existing.bw_rate != null ? existing.bw_rate : '';
    f.co_rate.value = existing.co_rate != null ? existing.co_rate : '';
    f.start_date.value = (existing.start_date || '').slice(0, 10);
  } else {
    f.status.value = 'active';
  }
  applyAssetVisibility(f);

  body.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = body.querySelector('#asset-form-error');
    const btn = body.querySelector('#asset-form-submit');
    errEl.textContent = '';
    btn.disabled = true;
    btn.textContent = '저장 중…';

    try {
      const itemType = itemSel.value;
      const mapping = ITEM_TO_CATSUB[itemType];
      if (!mapping) throw new Error('품목을 선택하세요.');
      const category = mapping.category;
      const subtype  = mapping.subtype;
      const model = f.model.value.trim();
      if (!model) throw new Error('모델은 필수입니다.');

      const itemPayload = {
        category,
        subtype,
        brand:   f.brand.value.trim() || null,
        model,
        serial:  f.serial.value.trim() || null,
        install_date: f.install_date.value || null,
        status:  f.status.value || 'active',
        storage_gb: f.storage_gb.value ? Number(f.storage_gb.value) : null,
        notes:   f.notes.value.trim() || null,
      };
      const assignPayload = {
        start_date:   f.start_date.value || itemPayload.install_date || null,
        monthly_fee:  f.monthly_fee.value ? Number(f.monthly_fee.value) : null,
        bw_free:      f.bw_free.value ? Number(f.bw_free.value) : null,
        co_free:      f.co_free.value ? Number(f.co_free.value) : null,
        bw_rate:      f.bw_rate.value ? Number(f.bw_rate.value) : null,
        co_rate:      f.co_rate.value ? Number(f.co_rate.value) : null,
      };

      const supa = window.totalasAuth;
      if (existing) {
        // 수정: items + assignments 동시 업데이트
        const { error: itErr } = await supa
          .from('rental_items')
          .update(itemPayload)
          .eq('id', existing.item_id);
        if (itErr) throw itErr;
        const { error: asErr } = await supa
          .from('rental_assignments')
          .update(assignPayload)
          .eq('id', existing.id);
        if (asErr) throw asErr;
      } else {
        // 신규: items 먼저, 그다음 assignment
        const itemId = `it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,5)}`;
        const { error: itErr } = await supa
          .from('rental_items')
          .insert({ id: itemId, ...itemPayload });
        if (itErr) throw itErr;

        const aid = `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,5)}`;
        const { error: asErr } = await supa
          .from('rental_assignments')
          .insert({
            id: aid,
            item_id: itemId,
            customer_id: customer.id,
            ...assignPayload,
          });
        if (asErr) {
          // 롤백 (best-effort)
          await supa.from('rental_items').delete().eq('id', itemId);
          throw asErr;
        }
      }
      // 신규 자산 추가 시 — 가장 최근 계약서 items 에 자동 반영
      let ctSyncMsg = '';
      if (!existing) {
        try {
          ctSyncMsg = await syncAssetToLatestContract(customer.id, itemPayload, assignPayload);
        } catch (syncErr) {
          console.warn('계약서 동기화 실패:', syncErr.message || syncErr);
          ctSyncMsg = ' (계약서 동기화 실패)';
        }
      }

      closeModal();
      const baseMsg = existing ? '자산이 수정되었습니다.' : '자산이 추가되었습니다.';
      toast(baseMsg + ctSyncMsg, 'ok');
      await loadAll();
      renderDetail();
    } catch (err) {
      console.error(err);
      errEl.textContent = err.message || String(err);
      btn.disabled = false;
      btn.textContent = '저장';
    }
  });

  document.getElementById('rc-modal').classList.add('show');
}

// 신규 자산 → 가장 최근 계약서 items 에 추가 (added_date 기록)
async function syncAssetToLatestContract(customerId, itemPayload, assignPayload) {
  const supa = window.totalasAuth;
  if (!supa) return '';
  const list = await loadContractsFor(customerId);
  if (!list || !list.length) return '';
  const latest = list[0];
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const modelLabel = [itemPayload.brand, itemPayload.model].filter(Boolean).join(' ').trim();
  const noteParts = [];
  if (itemPayload.serial) noteParts.push(`S/N ${itemPayload.serial}`);
  if (itemPayload.subtype) noteParts.push(itemPayload.subtype);
  const newRow = {
    model: modelLabel || itemPayload.model || '',
    bw_free: Number(assignPayload.bw_free) || 0,
    co_free: Number(assignPayload.co_free) || 0,
    bw_rate: Number(assignPayload.bw_rate) || 0,
    co_rate: Number(assignPayload.co_rate) || 0,
    qty: 1,
    monthly_fee: Number(assignPayload.monthly_fee) || 0,
    note: noteParts.join(' · '),
    added_date: todayStr,
  };
  const items = Array.isArray(latest.items) ? latest.items.slice() : [];
  items.push(newRow);
  const { error } = await supa
    .from('rental_contracts')
    .update({ items, updated_at: new Date().toISOString() })
    .eq('id', latest.id);
  if (error) throw error;
  // 캐시 갱신
  latest.items = items;
  CT_STATE.byCustomer[customerId] = list;
  return ` · 계약서 ${latest.contract_no || latest.id}에 추가됨 (재출력·재서명 필요)`;
}

async function deleteAsset(customer, assignment) {
  const it = assignment.rental_items || {};
  const label = (it.model || it.subtype || '자산');
  if (!confirm(`'${label}'을 이 거래처에서 삭제하시겠습니까?\n자산도 함께 삭제됩니다.`)) return;
  try {
    const supa = window.totalasAuth;
    // 1) assignment 삭제
    const { error: aErr } = await supa
      .from('rental_assignments')
      .delete()
      .eq('id', assignment.id);
    if (aErr) throw aErr;
    // 2) item 삭제 (단순화: 함께 삭제)
    if (assignment.item_id) {
      const { error: iErr } = await supa
        .from('rental_items')
        .delete()
        .eq('id', assignment.item_id);
      // item 삭제 실패는 무시하지 않되 토스트만 — assignment는 이미 삭제됨
      if (iErr) console.warn('item 삭제 경고:', iErr.message);
    }
    toast('자산이 삭제되었습니다.', 'ok');
    await loadAll();
    renderDetail();
  } catch (err) {
    console.error(err);
    toast('삭제 실패: ' + (err.message || err), 'err');
  }
}

// ─────────────────────────────────────────────────────────────
// 토스트
// ─────────────────────────────────────────────────────────────
let _toastTimer = null;
function toast(msg, kind) {
  const el = document.getElementById('rc-toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'rc-toast show ' + (kind || '');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    el.classList.remove('show');
  }, 2400);
}

// ─────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function escapeAttr(s) { return escapeHtml(s); }

// =============================================================
// 계약서 (rental_contracts) — 4페이지 디지털 양식
// =============================================================

// 공급자(한별시스템) 고정 정보
const SUPPLIER_INFO = {
  company: '한별시스템',
  ceo: '이한별',
  biz_no: '000-00-00000',
  address: '대구광역시',
  phone: '053-000-0000',
  email: '',
};

// 품목 프리셋 (JSON 상수)
const PRESETS = {
  'PC':       { model: '',  bw_free: 0,    co_free: 0,   bw_rate: 0,  co_rate: 0,   qty: 1, monthly_fee: 0,     fixed_quota: true  },
  'monitor':  { model: '',  bw_free: 0,    co_free: 0,   bw_rate: 0,  co_rate: 0,   qty: 1, monthly_fee: 0,     fixed_quota: true  },
  '잉크젯':   { model: '',  bw_free: 500,  co_free: 200, bw_rate: 10, co_rate: 100, qty: 1, monthly_fee: 0,     install_fee: 0      },
  '레이저':   { model: '',  bw_free: 1000, co_free: 0,   bw_rate: 15, co_rate: 0,   qty: 1, monthly_fee: 0,     install_fee: 100000, removal_fee: 100000, reg_fee: 200000 },
  '복합기':   { model: '',  bw_free: 1500, co_free: 500, bw_rate: 15, co_rate: 100, qty: 1, monthly_fee: 0,     install_fee: 100000, removal_fee: 100000, reg_fee: 200000 },
  '웰리스':   { model: '',  bw_free: 0,    co_free: 0,   bw_rate: 0,  co_rate: 0,   qty: 1, monthly_fee: 0,     filter_cycle_months: 2, fixed_quota: true },
  'NAS':      { model: '',  bw_free: 0,    co_free: 0,   bw_rate: 0,  co_rate: 0,   qty: 1, monthly_fee: 0,     fixed_quota: true  },
};

// 기본 약관 (제1~10조) — 한별시스템 임대 표준약관
const DEFAULT_TERMS = [
  {
    article: 1, title: '계약의 목적',
    body: '임대인 한별시스템(이하 "을")은 임차인(이하 "갑")에게 본 계약서에 명시된 임대 물품(이하 "물품")을 임대하고, 갑은 이를 임차하여 사용한다.',
    confirmed: true,
  },
  {
    article: 2, title: '계약기간 및 갱신',
    body: '1. 계약기간은 본 계약서 표지에 명시된 기간으로 한다.\n2. 기간 만료 1개월 전까지 양 당사자 어느 일방의 서면 해지 의사 표시가 없으면 동일 조건으로 1년씩 자동 갱신된다.',
    confirmed: true,
  },
  {
    article: 3, title: '인도 및 설치',
    body: '1. 을은 갑이 지정한 장소에 물품을 설치한다.\n2. 설치비 및 철거비 부과 기준:\n   - 잉크젯: 무료\n   - 레이저·디지털복합기: 설치비 100,000원, 철거비 100,000원, 등록비 200,000원\n   - PC·모니터·웰리스·NAS: 설치비 무료 (출장비 별도)\n3. 설치 후 양 당사자가 함께 점검하며 갑은 인수 확인서에 서명한다.',
    confirmed: true,
  },
  {
    article: 4, title: '사용 및 관리',
    body: '1. 갑은 본 물품을 임대 목적 외에 사용하거나 제3자에게 양도·전대·담보 제공할 수 없다.\n2. 갑은 선량한 관리자의 주의로 물품을 사용·보관해야 한다.\n3. 갑의 고의 또는 중과실로 인한 손상은 갑이 수리비를 부담한다.',
    confirmed: true,
  },
  {
    article: 5, title: '소모품 및 유지보수',
    body: '1. 토너·잉크·부속품 등 정상 사용 시 발생하는 소모품은 을이 무상 공급한다.\n2. 정기 점검은 을의 일정에 따라 주기적으로 시행한다.\n3. 고장 신고 시 영업일 기준 24시간 이내 출장·수리한다. 단, 갑의 부주의 또는 불법 사용으로 인한 고장은 갑이 비용을 부담한다.',
    confirmed: true,
  },
  {
    article: 6, title: '월 임대료 지급',
    body: '1. 갑은 매월 자동이체 약정일에 본 계약서 표지의 월 임대료(VAT 포함)를 을의 지정 계좌로 납부한다.\n2. 추가 매수 발생 시 추가 단가에 따라 다음 달 임대료에 합산하여 청구한다.\n3. 자동이체 실패 시 갑은 7일 이내 직접 납부하며, 이를 초과할 경우 연 20%의 연체이자가 가산된다.',
    confirmed: true,
  },
  {
    article: 7, title: '보증금',
    body: '1. 보증금은 월 임대료의 2개월치를 기준으로 한다.\n2. 보증금은 계약 해지 시 미수금 및 손해배상을 차감한 후 반환한다.',
    confirmed: true,
  },
  {
    article: 8, title: '계약 해지',
    body: '1. 다음 사유 발생 시 을은 사전 통보 없이 계약을 해지할 수 있다.\n   - 월 임대료 3개월 이상 미납\n   - 임대 물품의 무단 양도·전대·담보 제공\n   - 임차인의 파산·해산·영업 중단\n2. 갑이 약정 기간 내 일방 해지 시 잔여 기간의 50%에 해당하는 위약금을 부담한다.',
    confirmed: true,
  },
  {
    article: 9, title: '손해배상',
    body: '1. 갑의 고의 또는 중과실로 인한 물품 손상·분실 시 갑이 시가로 변상한다.\n2. 천재지변·화재 등 불가항력으로 인한 손상은 양 당사자가 협의한다.',
    confirmed: true,
  },
  {
    article: 10, title: '분쟁의 해결',
    body: '1. 본 계약과 관련하여 발생하는 분쟁은 양 당사자가 협의로 해결한다.\n2. 협의가 이루어지지 않을 경우 대구지방법원을 1심 관할 법원으로 한다.',
    confirmed: true,
  },
];

const DEFAULT_EXTRAS = [
  { text: '카운터 점검 후 발생한 추가 요금은 다음 달 자동이체로 합산 청구된다.', confirmed: true },
  { text: '사업장 이전 시 30일 전 서면 통보하며, 이전 설치비 100,000원은 갑이 부담한다.', confirmed: true },
  { text: '임대 기간 중 모델 교체가 필요한 경우 양 당사자 협의로 처리한다.', confirmed: true },
  { text: '계약 종료 시 갑은 물품을 원상태로 반납하며, 정상 반납 확인 후 보증금이 반환된다.', confirmed: true },
  { text: '본 계약서에 명시되지 않은 사항은 일반 상관례 및 한별시스템 임대 표준약관에 따른다.', confirmed: true },
];

// 편집 중인 계약서 상태
const CT_STATE = {
  customer: null,
  contract: null,        // 현재 편집 객체
  signaturePads: {},     // { supplier: SignaturePad, applicant: SignaturePad }
  byCustomer: {},        // { customer_id: [contracts...] }
};

function newContractDraft(customer) {
  const id = `ct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const today = new Date();
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const start = ymd(today);
  const end = new Date(today.getFullYear() + 3, today.getMonth(), today.getDate());
  // 신규 거래처(customer===null)일 때 — 전체 계약서 수 기반 sequence
  const seq = customer
    ? String((CT_STATE.byCustomer[customer.id] || []).length + 1).padStart(2, '0')
    : '01';
  return {
    id,
    customer_id: customer ? customer.id : null,
    contract_no: `${today.getFullYear()}-${seq}`,
    contract_date: ymd(today),
    period_years: 3,
    period_start: start,
    period_end: ymd(end),
    deposit: 0,
    install_fee: 0,
    company_snapshot:      customer ? (customer.company || '') : '',
    contact_name_snapshot: customer ? (customer.contact_name || '') : '',
    biz_no_snapshot:       customer ? (customer.biz_no || '') : '',
    address_snapshot:      customer ? (customer.address || '') : '',
    phone_snapshot:        customer ? (customer.phone || customer.mobile || '') : '',
    email_snapshot:        customer ? (customer.email || '') : '',
    items: [],
    terms:  JSON.parse(JSON.stringify(DEFAULT_TERMS)),
    extras: JSON.parse(JSON.stringify(DEFAULT_EXTRAS)),
    special_terms: '',
    payment_method: 'account',
    payment_info: {
      account: { bank: '', account_no: '', holder: '', biz_no: customer ? (customer.biz_no || '') : '', draft_day: 25 },
      card:    { card_brand: '', card_no: '', expiry: '', holder: '', draft_day: 25 },
    },
    sign_supplier: '',
    sign_applicant: '',
    signature_type: 'digital',   // 'digital' | 'stamp' | 'none'
    contract_scan_path: '',      // Supabase storage path (도장 모드 — 계약서 스캔본)
    id_card_path: '',            // Supabase storage path (도장 모드 — 신분증 사진)
    signed_at: null,
    status: 'draft',
    notes: '',
  };
}

// 자동 계산 ─────────────────────────────────────────────
function calcRowTotal(row) {
  return (Number(row.qty) || 0) * (Number(row.monthly_fee) || 0);
}
function calcGrand(items) {
  const sub = items.reduce((s, r) => s + calcRowTotal(r), 0);
  const vat = Math.round(sub * 0.1);
  return { sub, vat, total: sub + vat };
}
function suggestDeposit(items) {
  const sub = items.reduce((s, r) => s + calcRowTotal(r), 0);
  return sub * 2;
}

// 계약서 목록 로드 (특정 거래처) ────────────────────────
async function loadContractsFor(customerId) {
  const supa = window.totalasAuth;
  if (!supa) return [];
  try {
    const { data, error } = await supa
      .from('rental_contracts')
      .select('*')
      .eq('customer_id', customerId)
      .order('contract_date', { ascending: false });
    if (error) throw error;
    CT_STATE.byCustomer[customerId] = data || [];
    return data || [];
  } catch (err) {
    console.warn('계약서 로드 실패:', err.message || err);
    CT_STATE.byCustomer[customerId] = [];
    return [];
  }
}

// 계약서 카드 렌더 (우측 상세 패널) ─────────────────────
function renderContractCard(customer) {
  const list = CT_STATE.byCustomer[customer.id] || [];
  const rows = list.map(ct => {
    const status = (ct.status || 'draft').toLowerCase();
    const statusLabel = ({
      'draft':      '작성중',
      'signed':     '서명완료',
      'active':     '진행중',
      'terminated': '해지',
    })[status] || status;
    const items = Array.isArray(ct.items) ? ct.items : [];
    const grand = calcGrand(items);
    return `
      <div class="rc-ct-row" data-ctid="${escapeAttr(ct.id)}">
        <div class="rc-ct-row-main">
          <div class="rc-ct-row-title">${escapeHtml(ct.contract_no || '-')} · ${escapeHtml(ct.contract_date || '-')}</div>
          <div class="rc-ct-row-sub">
            품목 ${items.length}건 · 월 합계 ${grand.total.toLocaleString()}원 (VAT포함)
            ${ct.period_start && ct.period_end ? ` · ${ct.period_start} ~ ${ct.period_end}` : ''}
          </div>
        </div>
        <span class="rc-ct-badge ${status}">${statusLabel}</span>
      </div>
    `;
  }).join('') || `<p class="muted" style="margin:0; font-size:12.5px;">아직 작성된 계약서가 없습니다.</p>`;

  return `
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:8px;">
        <h3 style="margin:0;">📄 계약서 <span class="muted-small" style="font-weight:400;">${list.length}건</span></h3>
        <button class="btn small primary" id="btn-ct-new">+ 신규 계약서 작성</button>
      </div>
      ${rows}
    </div>
  `;
}

// 계약서 에디터 열기 ────────────────────────────────────
// customer=null 이면 "신규 거래처와 함께 작성" 흐름
function openContractEditor(customer, existing) {
  CT_STATE.customer = customer;           // null 허용
  CT_STATE.isNewCustomer = !customer;     // 신규 거래처 흐름 플래그
  CT_STATE.contract = existing
    ? JSON.parse(JSON.stringify(existing))   // 깊은 복사 (수정 취소 가능하게)
    : newContractDraft(customer);
  CT_STATE.signaturePads = {};

  document.getElementById('ct-edit-backdrop').classList.add('show');
  renderContractEditor();
}

function closeContractEditor() {
  document.getElementById('ct-edit-backdrop').classList.remove('show');
  // 캔버스 정리
  CT_STATE.signaturePads = {};
  CT_STATE.contract = null;
  CT_STATE.isNewCustomer = false;
}

// 계약서 에디터 렌더 (헤더 + 4페이지) ──────────────────
function renderContractEditor() {
  const ct = CT_STATE.contract;
  const cu = CT_STATE.customer;  // null 허용 (신규 거래처 흐름)
  if (!ct) return;

  const head = document.getElementById('ct-edit-head');
  const body = document.getElementById('ct-edit-body');

  // ── 헤더 ──────────────────
  const statusLabel = ({
    'draft': '작성중', 'signed': '서명완료', 'active': '진행중', 'terminated': '해지',
  })[ct.status] || ct.status;
  const headerCompany = cu
    ? (cu.company || '-')
    : (ct.company_snapshot || '(신규 거래처)');
  head.innerHTML = `
    <div class="ct-h-left">
      <div class="ct-h-title">
        ${escapeHtml(headerCompany)}
        ${CT_STATE.isNewCustomer ? '<span class="rc-ct-badge" style="background:#fef3c7;color:#92400e;margin-left:8px;">신규</span>' : ''}
        <span class="rc-ct-badge ${escapeAttr(ct.status)}" style="margin-left:8px;">${escapeHtml(statusLabel)}</span>
      </div>
      <div class="ct-h-meta">계약번호 ${escapeHtml(ct.contract_no)} · 작성 ${escapeHtml(ct.contract_date)}</div>
    </div>
    <div class="ct-h-actions">
      <select id="ct-h-status" title="상태">
        <option value="draft"     ${ct.status === 'draft'      ? 'selected' : ''}>작성중</option>
        <option value="signed"    ${ct.status === 'signed'     ? 'selected' : ''}>서명완료</option>
        <option value="active"    ${ct.status === 'active'     ? 'selected' : ''}>진행중</option>
        <option value="terminated"${ct.status === 'terminated' ? 'selected' : ''}>해지</option>
      </select>
      <button class="btn small" id="ct-btn-print" title="계약서·약관 2매 + 자동이체 1매 = 총 7페이지">🖨 인쇄 (7매)</button>
      <button class="btn small primary" id="ct-btn-save">💾 저장</button>
      ${ct._existing ? `<button class="btn small danger" id="ct-btn-delete">🗑 삭제</button>` : ''}
      <button class="btn small ghost" id="ct-btn-close">✕ 닫기</button>
    </div>
    <div style="flex-basis:100%; font-size:11px; color:#64748b; margin-top:2px;">
      🖨 인쇄 → 계약서·약관 갑·을 2매 + 자동이체 1매 = 총 7페이지
    </div>
  `;

  // ── 본문: 4 페이지 ───────
  const newCustomerBanner = CT_STATE.isNewCustomer ? `
    <div class="ct-new-customer-banner no-print">
      <strong>신규 거래처입니다.</strong>
      회사명·담당자·사업자번호·주소 등을 페이지 1의 "임차인" 박스에 입력하세요.
      저장 시 거래처가 자동으로 등록되며, 동일한 회사명이 이미 있으면 기존 거래처에 연결됩니다.
    </div>
  ` : '';
  body.innerHTML = `
    <div class="contract-doc">
      ${newCustomerBanner}
      ${renderPage1()}
      <div class="ct-page-divider no-print">― Page 2 ―</div>
      ${renderPage2()}
      <div class="ct-page-divider no-print">― Page 3 ―</div>
      ${renderPage3()}
      <div class="ct-page-divider no-print">― Page 4 ―</div>
      ${renderPage4()}
    </div>
  `;

  // 헤더 액션
  document.getElementById('ct-h-status').addEventListener('change', (e) => { ct.status = e.target.value; });
  document.getElementById('ct-btn-close').addEventListener('click', closeContractEditor);
  document.getElementById('ct-btn-print').addEventListener('click', printContractMulti);
  document.getElementById('ct-btn-save').addEventListener('click', saveContract);
  const delBtn = document.getElementById('ct-btn-delete');
  if (delBtn) delBtn.addEventListener('click', deleteContract);

  bindEditorEvents();
  initSignaturePads();
  recalcTotals();
}

// ── 페이지 1: 표지 ─────────────────────────────────────
function renderPage1() {
  const ct = CT_STATE.contract;
  const isNew = !!CT_STATE.isNewCustomer;
  // 신규 거래처 흐름: placeholder 추가, value 는 그대로(빈 값)
  const ph = (text) => isNew ? ` placeholder="${escapeAttr(text)}"` : '';
  return `
    <section class="contract-page" data-page="1">
      <div class="ct-cover-head">
        <div class="ct-cover-title">임대(렌탈) 계약서</div>
        <div class="ct-cover-company" style="text-align:right; font-size:12px;">
          계약번호 <input type="text" class="ct-input ed" data-field="contract_no" value="${escapeAttr(ct.contract_no)}" style="width:120px; display:inline-block;">
          <br>작성일 <input type="date" class="ct-input ed" data-field="contract_date" value="${escapeAttr(ct.contract_date)}" style="width:140px; display:inline-block;">
        </div>
      </div>

      <div class="section-title" style="margin-top:12px;">계 약 당 사 자</div>

      <table class="ct-tbl">
        <colgroup><col style="width:14%"><col style="width:36%"><col style="width:14%"><col style="width:36%"></colgroup>
        <tbody>
          <tr>
            <th class="ct-vlabel" rowspan="3">임 차 인<br>(갑·신청인)</th>
            <td><label style="font-size:10px; color:#555;">회사명${isNew ? ' *' : ''}</label><input class="ct-input ed" data-field="company_snapshot" value="${escapeAttr(ct.company_snapshot)}"${ph('회사명 (필수)')}></td>
            <th>대표자</th>
            <td><input class="ct-input ed" data-field="contact_name_snapshot" value="${escapeAttr(ct.contact_name_snapshot)}"${ph('담당자/대표자명')}></td>
          </tr>
          <tr>
            <th>사업자번호</th>
            <td><input class="ct-input ed" data-field="biz_no_snapshot" value="${escapeAttr(ct.biz_no_snapshot)}"${ph('000-00-00000')}></td>
            <th>전화</th>
            <td><input class="ct-input ed" data-field="phone_snapshot" value="${escapeAttr(ct.phone_snapshot)}"${ph('연락처')}></td>
          </tr>
          <tr>
            <th>주소</th>
            <td colspan="3"><input class="ct-input ed" data-field="address_snapshot" value="${escapeAttr(ct.address_snapshot)}"${ph('사업장 주소')}></td>
          </tr>
          <tr>
            <th class="ct-vlabel" rowspan="2">임 대 인<br>(을·공급자)</th>
            <td><label style="font-size:10px; color:#555;">상호</label> ${escapeHtml(SUPPLIER_INFO.company)}</td>
            <th>대표자</th>
            <td>${escapeHtml(SUPPLIER_INFO.ceo)}</td>
          </tr>
          <tr>
            <th>사업자번호</th>
            <td>${escapeHtml(SUPPLIER_INFO.biz_no)}</td>
            <th>전화 · 주소</th>
            <td>${escapeHtml(SUPPLIER_INFO.phone)} · ${escapeHtml(SUPPLIER_INFO.address)}</td>
          </tr>
        </tbody>
      </table>

      <div class="ct-preset-row no-print">
        <strong>품목 프리셋:</strong>
        <select id="ct-preset-pick">
          <option value="">선택…</option>
          ${Object.keys(PRESETS).map(k => `<option value="${escapeAttr(k)}">${escapeHtml(k)}</option>`).join('')}
        </select>
        <button class="btn small" id="ct-add-row">+ 빈 행 추가</button>
      </div>

      <div class="section-title">렌 탈 물 품</div>
      <table class="ct-tbl ct-tbl-items">
        <colgroup>
          <col style="width:18%"><col style="width:8%"><col style="width:8%">
          <col style="width:8%"><col style="width:8%"><col style="width:7%">
          <col style="width:13%"><col style="width:13%"><col style="width:11%"><col style="width:6%">
        </colgroup>
        <thead>
          <tr>
            <th>모델</th><th>기본(흑)</th><th>기본(컬)</th>
            <th>추가단가(흑)</th><th>추가단가(컬)</th><th>수량</th>
            <th>월 렌탈료</th><th>소계</th><th>비고</th><th></th>
          </tr>
        </thead>
        <tbody id="ct-items-body">
          ${renderItemRows()}
        </tbody>
      </table>

      <div class="ct-total-box">
        <div class="ct-total-cell"><label>소계 (VAT별도)</label><div class="v" id="ct-sub">0</div></div>
        <div class="ct-total-cell"><label>VAT 10%</label><div class="v" id="ct-vat">0</div></div>
        <div class="ct-total-cell total"><label>합계금액 (VAT포함)</label><div class="v" id="ct-total">0</div></div>
      </div>

      <div class="section-title">계 약 조 건</div>
      <table class="ct-tbl">
        <colgroup><col style="width:14%"><col style="width:36%"><col style="width:14%"><col style="width:36%"></colgroup>
        <tbody>
          <tr>
            <th>계약기간(년)</th>
            <td><input type="number" class="ct-input ed" data-field="period_years" value="${escapeAttr(ct.period_years)}" min="1" max="10" style="width:60px;"> 년</td>
            <th>계약기간</th>
            <td>
              <input type="date" class="ct-input ed" data-field="period_start" value="${escapeAttr(ct.period_start)}" style="width:46%;">
              ~
              <input type="date" class="ct-input ed" data-field="period_end" value="${escapeAttr(ct.period_end)}" style="width:46%;">
            </td>
          </tr>
          <tr>
            <th>보증금 (원)</th>
            <td><input type="number" class="ct-input ed num" data-field="deposit" value="${escapeAttr(ct.deposit || 0)}"> <span class="muted-small" id="ct-deposit-hint">(월세×2 자동 제안)</span></td>
            <th>설치비 (원)</th>
            <td><input type="number" class="ct-input ed num" data-field="install_fee" value="${escapeAttr(ct.install_fee || 0)}"></td>
          </tr>
        </tbody>
      </table>
      <div class="page-footer">- 1 -</div>
    </section>
  `;
}

function renderItemRows() {
  const items = CT_STATE.contract.items || [];
  if (!items.length) {
    return `<tr><td colspan="10" style="text-align:center; color:#888; padding:14px;">상단 "품목 프리셋" 에서 선택하거나 "+ 빈 행 추가" 를 눌러 품목을 추가하세요.</td></tr>`;
  }
  return items.map((r, i) => {
    const fixed = !!r.fixed_quota;
    const dis = fixed ? 'disabled' : '';
    const sub = calcRowTotal(r);
    const addedBadge = r.added_date
      ? `<div class="ct-row-added" title="추가일 (보유자산에서 자동 반영)">+${escapeHtml(r.added_date)}</div>`
      : '';
    return `
      <tr data-row="${i}">
        <td><input class="ct-input ed" data-row-field="model" value="${escapeAttr(r.model || '')}" placeholder="${escapeAttr(r._preset || '모델')}">${addedBadge}</td>
        <td><input type="number" class="ct-input ed num" data-row-field="bw_free" value="${escapeAttr(r.bw_free ?? 0)}" ${dis}></td>
        <td><input type="number" class="ct-input ed num" data-row-field="co_free" value="${escapeAttr(r.co_free ?? 0)}" ${dis}></td>
        <td><input type="number" class="ct-input ed num" data-row-field="bw_rate" value="${escapeAttr(r.bw_rate ?? 0)}" ${dis}></td>
        <td><input type="number" class="ct-input ed num" data-row-field="co_rate" value="${escapeAttr(r.co_rate ?? 0)}" ${dis}></td>
        <td><input type="number" class="ct-input ed qty" data-row-field="qty" value="${escapeAttr(r.qty ?? 1)}" min="1"></td>
        <td><input type="number" class="ct-input ed num" data-row-field="monthly_fee" value="${escapeAttr(r.monthly_fee ?? 0)}"></td>
        <td style="text-align:right;" class="ct-row-sub">${sub.toLocaleString()}</td>
        <td><input class="ct-input ed" data-row-field="note" value="${escapeAttr(r.note || '')}"></td>
        <td><button type="button" class="ct-row-del" data-row-del="${i}" title="행 삭제">×</button></td>
      </tr>
    `;
  }).join('');
}

// ── 페이지 2: 이용약관 (제1~5조 전반) ────────────────
function renderPage2() {
  const ct = CT_STATE.contract;
  const allTerms = ct.terms || [];
  // 제1~5조 (article <= 5)
  const front = allTerms.filter(t => Number(t.article) <= 5);
  return `
    <section class="contract-page" data-page="2">
      <div class="ct-page-title">이 용 약 관 (전반)</div>
      <p class="ct-terms-pre">
        본 임대(렌탈) 계약을 체결함에 있어 임대인 <span class="ct-pre-company">${escapeHtml(SUPPLIER_INFO.company)}</span> 와(과)
        임차인 <span class="ct-pre-company">${escapeHtml(ct.company_snapshot)}</span> 은(는) 아래 약관을 성실히 준수한다.
      </p>

      <div id="ct-terms-list-front">
        ${renderTermRows(front, 0)}
      </div>

      <div class="page-footer">- 2 -</div>
    </section>
  `;
}

// ── 페이지 3: 이용약관 (제6~10조 후반) + 부가사항 + 특약 ─
function renderPage3() {
  const ct = CT_STATE.contract;
  const allTerms = ct.terms || [];
  // 제6조 이상
  const backStart = allTerms.findIndex(t => Number(t.article) >= 6);
  const back = backStart >= 0 ? allTerms.slice(backStart) : [];
  return `
    <section class="contract-page" data-page="3">
      <div class="ct-page-title">이 용 약 관 (후반) · 부 가 사 항 · 특 약</div>

      <div id="ct-terms-list-back">
        ${renderTermRows(back, backStart >= 0 ? backStart : 0)}
      </div>

      <div style="margin-top:10px;" class="no-print">
        <button class="btn small" id="ct-term-add">+ 조항 추가</button>
      </div>

      <h4 style="margin-top:14px;">부가사항</h4>
      <div id="ct-extras-list">
        ${renderExtraRows(ct.extras)}
      </div>
      <div style="margin-top:6px;" class="no-print">
        <button class="btn small" id="ct-extra-add">+ 부가사항 추가</button>
      </div>

      <h4 style="margin-top:14px;">특약 (자유 기재)</h4>
      <textarea id="ct-special" placeholder="필요 시 특약사항을 입력하세요." style="width:100%; min-height:80px; padding:8px 10px; border:1px solid #ccc; border-radius:5px; font-size:11.5px; font-family:inherit; resize:vertical;">${escapeHtml(ct.special_terms || '')}</textarea>

      <div style="margin-top:18px;">
        <p style="font-size:11.5px;">위 약관 및 부가사항에 대해 양 당사자가 충분히 협의·확인하였으며, 계약 체결에 동의함.</p>
        <div class="ct-date-line">
          계약일자: <input type="date" class="ct-input ed date" data-field="contract_date_dup" value="${escapeAttr(ct.contract_date)}">
        </div>
      </div>

      <div class="page-footer">- 3 -</div>
    </section>
  `;
}

function renderTermRows(terms, baseIndex) {
  const base = Number(baseIndex) || 0;
  if (!terms || !terms.length) {
    return `<p class="muted" style="font-size:11px;">약관이 비어 있습니다.</p>`;
  }
  return terms.map((t, i) => {
    const realIdx = base + i;
    return `
    <div class="ct-term-row" data-term="${realIdx}">
      <div class="ct-term-no">제 <input type="number" min="1" data-term-field="article" value="${escapeAttr(t.article)}" style="width:34px; padding:2px 4px; border:1px solid #ccc; border-radius:3px;"> 조</div>
      <div>
        <div class="ct-term-tt"><input type="text" data-term-field="title" value="${escapeAttr(t.title)}" placeholder="조항 제목" style="padding:3px 6px; border:1px solid #ccc; border-radius:3px;"></div>
        <textarea data-term-field="body" placeholder="조항 본문">${escapeHtml(t.body)}</textarea>
      </div>
      <div class="ct-term-chk">
        <label class="chk"><input type="checkbox" data-term-field="confirmed" ${t.confirmed ? 'checked' : ''}> 확인함</label>
      </div>
      <div class="ct-term-rm no-print"><button type="button" data-term-del="${realIdx}" title="삭제">×</button></div>
    </div>
  `;
  }).join('');
}

function renderExtraRows(extras) {
  if (!extras || !extras.length) {
    return `<p class="muted" style="font-size:11px;">부가사항이 없습니다.</p>`;
  }
  return extras.map((e, i) => `
    <div class="ct-term-row" data-extra="${i}">
      <div class="ct-term-no">${i + 1}.</div>
      <div>
        <textarea data-extra-field="text">${escapeHtml(e.text)}</textarea>
      </div>
      <div class="ct-term-chk">
        <label class="chk"><input type="checkbox" data-extra-field="confirmed" ${e.confirmed ? 'checked' : ''}> 확인함</label>
      </div>
      <div class="ct-term-rm no-print"><button type="button" data-extra-del="${i}" title="삭제">×</button></div>
    </div>
  `).join('');
}

// ── 페이지 4: 자동출금 신청서 + 서명 ─────────────────
function renderPage4() {
  const ct = CT_STATE.contract;
  const pm = ct.payment_method || 'account';
  const acc = ct.payment_info?.account || {};
  const card = ct.payment_info?.card || {};
  const sigmode = ct.signature_type || 'digital';

  return `
    <section class="contract-page ct-cms-page" data-page="4">
      <div class="ct-page-title">자동출금 이용 신청서</div>

      <div class="ct-cms-section">신청인 정보</div>
      <table class="ct-tbl">
        <colgroup><col style="width:14%"><col style="width:36%"><col style="width:14%"><col style="width:36%"></colgroup>
        <tbody>
          <tr>
            <th>회사명</th>
            <td><input class="ct-input ed" data-field="company_snapshot" value="${escapeAttr(ct.company_snapshot)}"></td>
            <th>대표자/담당자</th>
            <td><input class="ct-input ed" data-field="contact_name_snapshot" value="${escapeAttr(ct.contact_name_snapshot)}"></td>
          </tr>
          <tr>
            <th>전화</th>
            <td><input class="ct-input ed" data-field="phone_snapshot" value="${escapeAttr(ct.phone_snapshot)}"></td>
            <th>이메일</th>
            <td><input class="ct-input ed" data-field="email_snapshot" value="${escapeAttr(ct.email_snapshot)}"></td>
          </tr>
        </tbody>
      </table>

      <div class="ct-cms-section" style="margin-top:14px;">결제 수단 선택</div>
      <div class="ct-cms-paymethod" style="margin-bottom:10px; font-size:12px;">
        <label style="margin-right:18px; cursor:pointer;">
          <input type="radio" name="ct-pay" value="account" ${pm === 'account' ? 'checked' : ''}> ⚪ 예금계좌
        </label>
        <label style="cursor:pointer;">
          <input type="radio" name="ct-pay" value="card"    ${pm === 'card' ? 'checked' : ''}> ⚪ 신용카드
        </label>
      </div>

      <div class="ct-pay-block ${pm === 'account' ? '' : 'disabled'}" id="ct-pay-account">
        <h5>예금계좌 자동이체</h5>
        <div class="ct-pay-grid">
          <div><label>은행</label><input data-pay-acc="bank"        value="${escapeAttr(acc.bank || '')}"></div>
          <div><label>계좌번호</label><input data-pay-acc="account_no" value="${escapeAttr(acc.account_no || '')}"></div>
          <div><label>예금주</label><input data-pay-acc="holder"      value="${escapeAttr(acc.holder || '')}"></div>
          <div><label>사업자번호/생년월일</label><input data-pay-acc="biz_no" value="${escapeAttr(acc.biz_no || '')}"></div>
          <div><label>출금 약정일</label><input type="number" data-pay-acc="draft_day" value="${escapeAttr(acc.draft_day ?? 25)}" min="1" max="31"></div>
        </div>
      </div>

      <div class="ct-pay-block ${pm === 'card' ? '' : 'disabled'}" id="ct-pay-card">
        <h5>신용카드 자동결제</h5>
        <div class="ct-pay-grid">
          <div><label>카드사</label><input data-pay-card="card_brand" value="${escapeAttr(card.card_brand || '')}"></div>
          <div><label>카드번호</label><input data-pay-card="card_no"    value="${escapeAttr(card.card_no || '')}"></div>
          <div><label>유효기간 (MM/YY)</label><input data-pay-card="expiry" value="${escapeAttr(card.expiry || '')}"></div>
          <div><label>소지자명</label><input data-pay-card="holder"     value="${escapeAttr(card.holder || '')}"></div>
          <div><label>출금 약정일</label><input type="number" data-pay-card="draft_day" value="${escapeAttr(card.draft_day ?? 25)}" min="1" max="31"></div>
        </div>
      </div>

      <div class="caution-text" style="margin-top:10px;">
        본인은 위 결제수단으로 매월 자동출금되는 임대료 및 부대비용 청구에 동의하며, 사실과 다르거나 결제 실패로 발생하는
        모든 책임은 신청인에게 있음을 확인합니다.
      </div>

      <!-- 서명 방식 토글 -->
      <div class="ct-sign-mode no-print">
        <strong>서명 방식:</strong>
        <label style="margin-left:10px;">
          <input type="radio" name="ct-sigmode" value="digital" ${sigmode === 'digital' ? 'checked' : ''}> ✍ 전자서명
        </label>
        <label style="margin-left:14px;">
          <input type="radio" name="ct-sigmode" value="stamp" ${sigmode === 'stamp' ? 'checked' : ''}> 🔴 도장 (출력 후 직접)
        </label>
      </div>

      <!-- 전자서명 영역 (canvas 2개) -->
      <div class="ct-sign-block ct-sign-digital ${sigmode === 'digital' ? '' : 'hidden'}">
        <div class="ct-sign-wrap">
          <div class="ct-sign-box">
            <div class="ct-sign-label">
              <span>공급자 (한별시스템) 서명</span>
              <button type="button" class="ct-sign-clear no-print" data-sign-clear="supplier">✏ 다시 그리기</button>
            </div>
            <canvas class="ct-sign-canvas" id="ct-sign-supplier" data-sign-pad="supplier"></canvas>
          </div>
          <div class="ct-sign-box">
            <div class="ct-sign-label">
              <span>신청인 서명</span>
              <button type="button" class="ct-sign-clear no-print" data-sign-clear="applicant">✏ 다시 그리기</button>
            </div>
            <canvas class="ct-sign-canvas" id="ct-sign-applicant" data-sign-pad="applicant"></canvas>
          </div>
        </div>
      </div>

      <!-- 도장 모드 영역 -->
      <div class="ct-sign-block ct-sign-stamp ${sigmode === 'stamp' ? '' : 'hidden'}">
        <p class="muted" style="font-size:12px; margin:8px 0;">
          계약서를 인쇄하여 도장 또는 자필 사인을 받은 후, 스캔한 파일을 아래에 업로드하세요.
        </p>

        <div class="ct-sign-wrap">
          <div class="ct-sign-box">
            <div class="ct-sign-label"><span>공급자 (한별시스템) 도장 / 사인</span></div>
            <div class="ct-stamp-area">(아래 도장 / 자필 사인 영역)</div>
          </div>
          <div class="ct-sign-box">
            <div class="ct-sign-label"><span>신청인 도장 / 사인</span></div>
            <div class="ct-stamp-area">(아래 도장 / 자필 사인 영역)</div>
          </div>
        </div>

        <div class="ct-attach-row no-print">
          <label>📄 도장이 찍힌 계약서 스캔본 (PDF 또는 이미지)</label>
          <input type="file" id="ct-att-contract" accept="application/pdf,image/*">
          <div id="ct-att-contract-meta" class="ct-attach-meta"></div>
        </div>

        <div class="ct-attach-row no-print">
          <label>🆔 신분증 사진 (사업자등록증 또는 신분증)</label>
          <input type="file" id="ct-att-idcard" accept="image/*,application/pdf">
          <div id="ct-att-idcard-meta" class="ct-attach-meta"></div>
        </div>
      </div>

      <div class="page-footer">- 4 -</div>
    </section>
  `;
}

// ── 에디터 이벤트 바인딩 ───────────────────────────────
function bindEditorEvents() {
  const ct = CT_STATE.contract;
  const body = document.getElementById('ct-edit-body');

  // (1) 단일 필드 (data-field)
  body.querySelectorAll('[data-field]').forEach(el => {
    el.addEventListener('input', () => {
      const f = el.dataset.field;
      let v = el.value;
      if (el.type === 'number') v = v === '' ? null : Number(v);
      // contract_date_dup → contract_date 동기화
      if (f === 'contract_date_dup') {
        ct.contract_date = v;
        // 헤더의 작성일 라벨/계약번호 반영 위해 헤더만 갱신
        renderEditorHeader();
        return;
      }
      ct[f] = v;
      // period_years 변경 → 종료일 자동 재계산
      if (f === 'period_years' && ct.period_start) {
        const d = new Date(ct.period_start);
        if (!isNaN(d)) {
          d.setFullYear(d.getFullYear() + (Number(v) || 0));
          ct.period_end = d.toISOString().slice(0, 10);
          const endEl = body.querySelector('[data-field="period_end"]');
          if (endEl) endEl.value = ct.period_end;
        }
      }
      // period_start 변경 시 종료일 자동
      if (f === 'period_start' && ct.period_years) {
        const d = new Date(v);
        if (!isNaN(d)) {
          d.setFullYear(d.getFullYear() + (Number(ct.period_years) || 0));
          ct.period_end = d.toISOString().slice(0, 10);
          const endEl = body.querySelector('[data-field="period_end"]');
          if (endEl) endEl.value = ct.period_end;
        }
      }
      if (f === 'contract_date' || f === 'contract_no') {
        renderEditorHeader();
      }
    });
  });

  // (2) 품목 행 (data-row-field)
  body.querySelectorAll('[data-row-field]').forEach(el => {
    el.addEventListener('input', () => {
      const tr = el.closest('tr');
      const i = Number(tr.dataset.row);
      const f = el.dataset.rowField;
      let v = el.value;
      if (el.type === 'number') v = v === '' ? 0 : Number(v);
      ct.items[i][f] = v;
      if (f === 'qty' || f === 'monthly_fee') {
        const sub = calcRowTotal(ct.items[i]);
        const cell = tr.querySelector('.ct-row-sub');
        if (cell) cell.textContent = sub.toLocaleString();
        recalcTotals();
      }
    });
  });

  // 행 삭제
  body.querySelectorAll('[data-row-del]').forEach(b => {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.rowDel);
      ct.items.splice(i, 1);
      refreshItemsTable();
    });
  });

  // 프리셋 드롭다운
  const preset = document.getElementById('ct-preset-pick');
  if (preset) {
    preset.addEventListener('change', () => {
      const k = preset.value;
      if (!k || !PRESETS[k]) return;
      const row = { ...PRESETS[k], _preset: k };
      ct.items.push(row);
      // 레이저·복합기 → install_fee 자동 채움 (현재 비어있을 때만)
      if ((k === '레이저' || k === '복합기') && (!ct.install_fee || ct.install_fee === 0)) {
        ct.install_fee = 100000;
        const ifEl = document.querySelector('[data-field="install_fee"]');
        if (ifEl) ifEl.value = 100000;
      }
      preset.value = '';
      refreshItemsTable();
    });
  }

  // 빈 행 추가
  const addRowBtn = document.getElementById('ct-add-row');
  if (addRowBtn) {
    addRowBtn.addEventListener('click', () => {
      ct.items.push({ model: '', bw_free: 0, co_free: 0, bw_rate: 0, co_rate: 0, qty: 1, monthly_fee: 0, note: '' });
      refreshItemsTable();
    });
  }

  // (3) 약관 필드
  body.querySelectorAll('[data-term-field]').forEach(el => {
    el.addEventListener('input', () => {
      const row = el.closest('[data-term]');
      const i = Number(row.dataset.term);
      const f = el.dataset.termField;
      let v = el.value;
      if (f === 'confirmed') v = el.checked;
      else if (f === 'article') v = Number(v) || 0;
      ct.terms[i][f] = v;
    });
    el.addEventListener('change', () => {
      if (el.dataset.termField === 'confirmed') {
        const row = el.closest('[data-term]');
        ct.terms[Number(row.dataset.term)].confirmed = el.checked;
      }
    });
  });

  body.querySelectorAll('[data-term-del]').forEach(b => {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.termDel);
      ct.terms.splice(i, 1);
      refreshTermsLists();
    });
  });

  const termAdd = document.getElementById('ct-term-add');
  if (termAdd) {
    termAdd.addEventListener('click', () => {
      const next = (ct.terms[ct.terms.length - 1]?.article || ct.terms.length) + 1;
      ct.terms.push({ article: next, title: '신규 조항', body: '', confirmed: true });
      refreshTermsLists();
    });
  }

  // (4) 부가사항
  body.querySelectorAll('[data-extra-field]').forEach(el => {
    el.addEventListener('input', () => {
      const row = el.closest('[data-extra]');
      const i = Number(row.dataset.extra);
      const f = el.dataset.extraField;
      ct.extras[i][f] = (f === 'confirmed') ? el.checked : el.value;
    });
    el.addEventListener('change', () => {
      if (el.dataset.extraField === 'confirmed') {
        const row = el.closest('[data-extra]');
        ct.extras[Number(row.dataset.extra)].confirmed = el.checked;
      }
    });
  });

  body.querySelectorAll('[data-extra-del]').forEach(b => {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.extraDel);
      ct.extras.splice(i, 1);
      document.getElementById('ct-extras-list').innerHTML = renderExtraRows(ct.extras);
      bindEditorEvents();
    });
  });

  const extraAdd = document.getElementById('ct-extra-add');
  if (extraAdd) {
    extraAdd.addEventListener('click', () => {
      ct.extras.push({ text: '', confirmed: false });
      document.getElementById('ct-extras-list').innerHTML = renderExtraRows(ct.extras);
      bindEditorEvents();
    });
  }

  // (5) 특약
  const sp = document.getElementById('ct-special');
  if (sp) sp.addEventListener('input', () => { ct.special_terms = sp.value; });

  // (6) 결제수단 라디오
  body.querySelectorAll('input[name="ct-pay"]').forEach(r => {
    r.addEventListener('change', () => {
      ct.payment_method = r.value;
      document.getElementById('ct-pay-account').classList.toggle('disabled', r.value !== 'account');
      document.getElementById('ct-pay-card').classList.toggle('disabled',    r.value !== 'card');
    });
  });

  // (7) 결제정보 필드
  body.querySelectorAll('[data-pay-acc]').forEach(el => {
    el.addEventListener('input', () => {
      const f = el.dataset.payAcc;
      let v = el.value;
      if (el.type === 'number') v = v === '' ? null : Number(v);
      ct.payment_info.account = ct.payment_info.account || {};
      ct.payment_info.account[f] = v;
    });
  });
  body.querySelectorAll('[data-pay-card]').forEach(el => {
    el.addEventListener('input', () => {
      const f = el.dataset.payCard;
      let v = el.value;
      if (el.type === 'number') v = v === '' ? null : Number(v);
      ct.payment_info.card = ct.payment_info.card || {};
      ct.payment_info.card[f] = v;
    });
  });

  // (8) 서명 초기화 버튼
  body.querySelectorAll('[data-sign-clear]').forEach(b => {
    b.addEventListener('click', () => {
      const k = b.dataset.signClear;
      const pad = CT_STATE.signaturePads[k];
      if (pad) pad.clear();
      CT_STATE.contract[k === 'supplier' ? 'sign_supplier' : 'sign_applicant'] = '';
    });
  });

  // (9) 서명 방식 토글 (digital / stamp)
  body.querySelectorAll('input[name="ct-sigmode"]').forEach(r => {
    r.addEventListener('change', () => {
      ct.signature_type = r.value;
      const digitalBlock = body.querySelector('.ct-sign-digital');
      const stampBlock   = body.querySelector('.ct-sign-stamp');
      if (digitalBlock) digitalBlock.classList.toggle('hidden', r.value !== 'digital');
      if (stampBlock)   stampBlock.classList.toggle('hidden',   r.value !== 'stamp');
      // 도장 모드로 전환 시 첨부 메타 갱신
      if (r.value === 'stamp') refreshAttachmentMeta();
      // 전자서명 모드로 돌아가면 패드 재초기화
      if (r.value === 'digital') {
        setTimeout(initSignaturePads, 50);
      }
    });
  });

  // (10) 첨부 파일 업로드 (도장 모드)
  const attContract = body.querySelector('#ct-att-contract');
  if (attContract) {
    attContract.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      await handleAttachmentUpload('contract', f);
      attContract.value = '';
    });
  }
  const attIdcard = body.querySelector('#ct-att-idcard');
  if (attIdcard) {
    attIdcard.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      await handleAttachmentUpload('idcard', f);
      attIdcard.value = '';
    });
  }

  // 도장 모드면 첨부 메타 초기 렌더
  if ((ct.signature_type || 'digital') === 'stamp') {
    refreshAttachmentMeta();
  }
}

// 약관 두 영역 (전반/후반) 동기 재렌더
function refreshTermsLists() {
  const ct = CT_STATE.contract;
  if (!ct) return;
  const all = ct.terms || [];
  const front = all.filter(t => Number(t.article) <= 5);
  const backStart = all.findIndex(t => Number(t.article) >= 6);
  const back = backStart >= 0 ? all.slice(backStart) : [];
  const fEl = document.getElementById('ct-terms-list-front');
  const bEl = document.getElementById('ct-terms-list-back');
  if (fEl) fEl.innerHTML = renderTermRows(front, 0);
  if (bEl) bEl.innerHTML = renderTermRows(back, backStart >= 0 ? backStart : 0);
  bindEditorEvents();
}

function renderEditorHeader() {
  // 헤더만 살짝 갱신 (계약번호/작성일/회사명 동기화)
  const ct = CT_STATE.contract; const cu = CT_STATE.customer;
  const head = document.getElementById('ct-edit-head');
  if (!head) return;
  const meta = head.querySelector('.ct-h-meta');
  if (meta) meta.textContent = `계약번호 ${ct.contract_no} · 작성 ${ct.contract_date}`;
}

// 행 테이블만 새로 렌더
function refreshItemsTable() {
  document.getElementById('ct-items-body').innerHTML = renderItemRows();
  bindEditorEvents();
  // 보증금 자동 제안 (사용자가 직접 수정 안 했을 때 — 빈 경우에만)
  if (!CT_STATE.contract.deposit) {
    const suggest = suggestDeposit(CT_STATE.contract.items);
    if (suggest > 0) {
      CT_STATE.contract.deposit = suggest;
      const depEl = document.querySelector('[data-field="deposit"]');
      if (depEl) depEl.value = suggest;
    }
  }
  recalcTotals();
}

function recalcTotals() {
  const g = calcGrand(CT_STATE.contract.items || []);
  const subEl   = document.getElementById('ct-sub');
  const vatEl   = document.getElementById('ct-vat');
  const totalEl = document.getElementById('ct-total');
  if (subEl)   subEl.textContent   = g.sub.toLocaleString();
  if (vatEl)   vatEl.textContent   = g.vat.toLocaleString();
  if (totalEl) totalEl.textContent = g.total.toLocaleString();
}

// ── 서명 패드 (Canvas) ─────────────────────────────────
class SignaturePad {
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.drawing = false;
    this.last = null;
    this.empty = true;
    this.onChange = onChange || (() => {});
    this._setupSize();
    this._bind();
  }
  _setupSize() {
    // CSS 크기 → 실제 픽셀 (HiDPI 대응)
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width  = rect.width  * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.strokeStyle = '#0b1220';
    this.ctx.lineWidth = 2.2;
  }
  _pt(e) {
    const r = this.canvas.getBoundingClientRect();
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
    return { x: cx, y: cy };
  }
  _bind() {
    const start = (e) => {
      e.preventDefault();
      this.drawing = true;
      this.empty = false;
      this.last = this._pt(e);
    };
    const move = (e) => {
      if (!this.drawing) return;
      e.preventDefault();
      const p = this._pt(e);
      this.ctx.beginPath();
      this.ctx.moveTo(this.last.x, this.last.y);
      this.ctx.lineTo(p.x, p.y);
      this.ctx.stroke();
      this.last = p;
    };
    const end = (e) => {
      if (!this.drawing) return;
      this.drawing = false;
      this.onChange(this.toDataURL());
    };
    this.canvas.addEventListener('mousedown', start);
    this.canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    this.canvas.addEventListener('touchstart', start, { passive: false });
    this.canvas.addEventListener('touchmove',  move,  { passive: false });
    this.canvas.addEventListener('touchend',   end);
  }
  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.empty = true;
    this.onChange('');
  }
  toDataURL() {
    if (this.empty) return '';
    return this.canvas.toDataURL('image/png');
  }
  fromDataURL(url) {
    if (!url) { this.clear(); return; }
    const img = new Image();
    img.onload = () => {
      const r = this.canvas.getBoundingClientRect();
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.drawImage(img, 0, 0, r.width, r.height);
      this.empty = false;
    };
    img.src = url;
  }
}

function initSignaturePads() {
  const supCv = document.getElementById('ct-sign-supplier');
  const appCv = document.getElementById('ct-sign-applicant');
  if (!supCv || !appCv) return;
  const ct = CT_STATE.contract;
  const supPad = new SignaturePad(supCv, (data) => { ct.sign_supplier  = data; });
  const appPad = new SignaturePad(appCv, (data) => { ct.sign_applicant = data; });
  CT_STATE.signaturePads = { supplier: supPad, applicant: appPad };
  if (ct.sign_supplier)  supPad.fromDataURL(ct.sign_supplier);
  if (ct.sign_applicant) appPad.fromDataURL(ct.sign_applicant);
}

// ── 첨부 파일 업로드 / 다운로드 / 삭제 (Supabase Storage) ─────
const ATTACH_BUCKET = 'rental-contracts';

async function uploadAttachment(contract_id, kind, file) {
  const supa = window.totalasAuth;
  if (!supa) throw new Error('인증이 준비되지 않았습니다.');
  const extRaw = (file.name.split('.').pop() || 'bin').toLowerCase();
  const ext = extRaw.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
  const path = `${contract_id}/${kind}_${Date.now()}.${ext}`;
  const { error } = await supa.storage
    .from(ATTACH_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type || undefined });
  if (error) throw error;
  return path;
}

async function getSignedAttachmentUrl(path) {
  if (!path) return null;
  const supa = window.totalasAuth;
  if (!supa) return null;
  try {
    const { data, error } = await supa.storage
      .from(ATTACH_BUCKET)
      .createSignedUrl(path, 3600);
    if (error) throw error;
    return data?.signedUrl || null;
  } catch (err) {
    console.warn('signedUrl 실패:', err.message || err);
    return null;
  }
}

async function deleteAttachment(path) {
  if (!path) return;
  const supa = window.totalasAuth;
  if (!supa) return;
  try {
    await supa.storage.from(ATTACH_BUCKET).remove([path]);
  } catch (err) {
    console.warn('Storage 파일 삭제 실패:', err.message || err);
  }
}

// 업로드 핸들러 (kind: 'contract' | 'idcard')
async function handleAttachmentUpload(kind, file) {
  const ct = CT_STATE.contract;
  if (!ct) return;
  const supa = window.totalasAuth;
  if (!supa) { toast('인증이 준비되지 않았습니다.', 'err'); return; }

  // 5MB 제한 안내
  const sizeMB = file.size / 1024 / 1024;
  if (sizeMB > 20) {
    toast(`파일이 너무 큽니다 (${sizeMB.toFixed(1)}MB). 20MB 이하만 업로드 가능합니다.`, 'err');
    return;
  }

  const metaEl = document.getElementById(`ct-att-${kind}-meta`);
  if (metaEl) {
    metaEl.classList.remove('has-file');
    metaEl.innerHTML = `<span style="color:#64748b;">⏳ 업로드 중… (${file.name}, ${(sizeMB).toFixed(2)}MB)</span>`;
  }

  try {
    // 기존 파일이 있다면 삭제 시도 (best-effort)
    const oldField = kind === 'contract' ? 'contract_scan_path' : 'id_card_path';
    const oldPath = ct[oldField];
    if (oldPath) {
      await deleteAttachment(oldPath);
    }

    const path = await uploadAttachment(ct.id, kind, file);
    ct[oldField] = path;
    ct._attach_meta = ct._attach_meta || {};
    ct._attach_meta[kind] = { name: file.name, size: file.size, type: file.type };

    toast(`${kind === 'contract' ? '계약서 스캔본' : '신분증'} 업로드 완료`, 'ok');
    refreshAttachmentMeta();
  } catch (err) {
    console.error(err);
    toast(`업로드 실패: ${err.message || err}`, 'err');
    if (metaEl) metaEl.innerHTML = `<span style="color:#dc2626;">⚠ 업로드 실패: ${escapeHtml(err.message || String(err))}</span>`;
  }
}

// 첨부 메타(라벨/링크/삭제) 갱신
async function refreshAttachmentMeta() {
  const ct = CT_STATE.contract;
  if (!ct) return;

  for (const kind of ['contract', 'idcard']) {
    const field = kind === 'contract' ? 'contract_scan_path' : 'id_card_path';
    const path = ct[field];
    const el = document.getElementById(`ct-att-${kind}-meta`);
    if (!el) continue;

    if (!path) {
      el.classList.remove('has-file');
      el.innerHTML = `<span style="color:#94a3b8;">파일이 업로드되지 않았습니다.</span>`;
      continue;
    }

    const cachedMeta = ct._attach_meta?.[kind];
    const fname = cachedMeta?.name || path.split('/').pop();
    const fsize = cachedMeta?.size ? ` · ${(cachedMeta.size / 1024).toFixed(1)} KB` : '';
    el.classList.add('has-file');
    el.innerHTML = `
      ✓ 업로드 완료: <strong>${escapeHtml(fname)}</strong>${escapeHtml(fsize)}
      <a href="#" data-att-download="${escapeAttr(kind)}">🔗 다운로드</a>
      <button type="button" data-att-delete="${escapeAttr(kind)}">🗑 삭제</button>
    `;
  }

  // 다운로드 / 삭제 이벤트 바인딩
  document.querySelectorAll('[data-att-download]').forEach(a => {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      const kind = a.dataset.attDownload;
      const field = kind === 'contract' ? 'contract_scan_path' : 'id_card_path';
      const url = await getSignedAttachmentUrl(ct[field]);
      if (url) window.open(url, '_blank');
      else toast('다운로드 링크 생성 실패', 'err');
    });
  });
  document.querySelectorAll('[data-att-delete]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.attDelete;
      if (!confirm('이 파일을 삭제하시겠습니까?')) return;
      const field = kind === 'contract' ? 'contract_scan_path' : 'id_card_path';
      const path = ct[field];
      if (!path) return;
      try {
        await deleteAttachment(path);
        ct[field] = '';
        if (ct._attach_meta) delete ct._attach_meta[kind];
        toast('파일이 삭제되었습니다.', 'ok');
        refreshAttachmentMeta();
      } catch (err) {
        toast('삭제 실패: ' + (err.message || err), 'err');
      }
    });
  });
}

// ── 인쇄 (계약서·약관 2매 + 자동이체 1매 = 7페이지) ─────────
function buildPrintLayout() {
  const root = document.getElementById('ct-print-clone');
  if (!root) return false;
  root.innerHTML = '';

  // 페이지 1·2·3 을 갑/을 각 1매씩
  const labels = ['갑 (임차인) 보관용', '을 (임대인 · 한별시스템) 보관용'];
  labels.forEach(label => {
    [1, 2, 3].forEach(pageNum => {
      const orig = document.querySelector(`#ct-edit-modal .contract-page[data-page="${pageNum}"]`);
      if (!orig) return;
      const clone = orig.cloneNode(true);
      // 라벨 박스 prepend
      const tag = document.createElement('div');
      tag.className = 'ct-print-copy-label';
      tag.textContent = label;
      clone.style.position = 'relative';
      clone.prepend(tag);

      // 전자서명 캔버스 → 이미지로 복제 (페이지 1·2·3엔 캔버스 없지만 안전망)
      replaceCanvasesWithImages(orig, clone);

      root.appendChild(clone);
    });
  });

  // 페이지 4 (자동이체) — 1매만
  const p4orig = document.querySelector(`#ct-edit-modal .contract-page[data-page="4"]`);
  if (p4orig) {
    const p4 = p4orig.cloneNode(true);
    p4.style.position = 'relative';
    // 도장 모드 첨부 영역(input) 은 인쇄에서 숨김 처리 (no-print 가 이미 있음)
    replaceCanvasesWithImages(p4orig, p4);
    root.appendChild(p4);
  }

  return true;
}

// 원본의 canvas 를 이미지로 변환해 클론의 canvas 자리에 삽입
function replaceCanvasesWithImages(origNode, cloneNode) {
  const origCanvases = origNode.querySelectorAll('canvas.ct-sign-canvas');
  const cloneCanvases = cloneNode.querySelectorAll('canvas.ct-sign-canvas');
  origCanvases.forEach((oc, idx) => {
    const cc = cloneCanvases[idx];
    if (!cc) return;
    try {
      const url = oc.toDataURL('image/png');
      const img = document.createElement('img');
      img.src = url;
      img.style.width  = '100%';
      img.style.height = '150px';
      img.style.objectFit = 'contain';
      img.style.display = 'block';
      cc.parentNode.replaceChild(img, cc);
    } catch (e) {
      // taint된 캔버스 등 — 무시
    }
  });
}

function printContractMulti() {
  // 캔버스 데이터를 최신화
  const ct = CT_STATE.contract;
  if (CT_STATE.signaturePads?.supplier) {
    ct.sign_supplier = CT_STATE.signaturePads.supplier.toDataURL() || ct.sign_supplier;
  }
  if (CT_STATE.signaturePads?.applicant) {
    ct.sign_applicant = CT_STATE.signaturePads.applicant.toDataURL() || ct.sign_applicant;
  }

  const ok = buildPrintLayout();
  if (!ok) { toast('인쇄 레이아웃 생성 실패', 'err'); return; }

  document.body.classList.add('ct-printing');
  toast('인쇄 미리보기를 준비합니다… (7페이지)', 'ok');

  // 인쇄 종료 후 정리
  const cleanup = () => {
    document.body.classList.remove('ct-printing');
    const root = document.getElementById('ct-print-clone');
    if (root) root.innerHTML = '';
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);

  // 짧은 지연 — 클론 DOM이 그려질 시간 확보
  setTimeout(() => {
    window.print();
    // 일부 브라우저는 afterprint 가 안 뜸 — fallback
    setTimeout(cleanup, 1500);
  }, 100);
}

// ── 저장 / 삭제 ────────────────────────────────────────
async function saveContract() {
  const ct = CT_STATE.contract;
  const supa = window.totalasAuth;
  if (!supa) { toast('인증이 준비되지 않았습니다.', 'err'); return; }

  // 최신 서명 데이터 동기화 (간혹 onChange 누락 대비)
  if (CT_STATE.signaturePads.supplier)  ct.sign_supplier  = CT_STATE.signaturePads.supplier.toDataURL()  || ct.sign_supplier  || '';
  if (CT_STATE.signaturePads.applicant) ct.sign_applicant = CT_STATE.signaturePads.applicant.toDataURL() || ct.sign_applicant || '';

  if ((ct.status === 'signed' || ct.status === 'active') && !ct.signed_at) {
    ct.signed_at = new Date().toISOString();
  }

  // ── 신규 거래처 자동 생성/연결 ──
  // customer_id 가 없으면: 회사명 중복 확인 → 있으면 연결, 없으면 INSERT
  let autoCreatedCustomerId = null;
  if (!ct.customer_id) {
    const companyName = (ct.company_snapshot || '').trim();
    if (!companyName) {
      toast('회사명을 입력하세요. (페이지 1 임차인 박스)', 'err');
      return;
    }
    try {
      // 정확 일치 우선 — active 무관 (만기 거래처도 재활용)
      const { data: exist, error: exErr } = await supa
        .from('rental_customers')
        .select('id, company, active')
        .eq('company', companyName)
        .limit(1);
      if (exErr) throw exErr;

      if (exist && exist.length) {
        ct.customer_id = exist[0].id;
        autoCreatedCustomerId = exist[0].id;
        toast(`기존 거래처 "${exist[0].company}"에 연결되었습니다.`, 'ok');
      } else {
        // 신규 INSERT
        const newId = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        const { error: insErr } = await supa.from('rental_customers').insert({
          id:           newId,
          company:      companyName,
          contact_name: (ct.contact_name_snapshot || '').trim() || null,
          phone:        (ct.phone_snapshot || '').trim() || null,
          biz_no:       (ct.biz_no_snapshot || '').trim() || null,
          address:      (ct.address_snapshot || '').trim() || null,
          email:        (ct.email_snapshot || '').trim() || null,
          active:       true,
        });
        if (insErr) throw insErr;
        ct.customer_id = newId;
        autoCreatedCustomerId = newId;
        CT_STATE.isNewCustomer = false;
        toast('새 거래처가 추가되었습니다.', 'ok');
      }
    } catch (err) {
      console.error(err);
      toast('거래처 자동 등록 실패: ' + (err.message || err), 'err');
      return;
    }
  }

  const payload = {
    id: ct.id,
    customer_id: ct.customer_id,
    contract_no: ct.contract_no,
    contract_date: ct.contract_date,
    period_years: ct.period_years,
    period_start: ct.period_start,
    period_end:   ct.period_end,
    deposit:      ct.deposit,
    install_fee:  ct.install_fee,
    company_snapshot:      ct.company_snapshot,
    contact_name_snapshot: ct.contact_name_snapshot,
    biz_no_snapshot:       ct.biz_no_snapshot,
    address_snapshot:      ct.address_snapshot,
    phone_snapshot:        ct.phone_snapshot,
    email_snapshot:        ct.email_snapshot,
    items:         ct.items || [],
    terms:         ct.terms || [],
    extras:        ct.extras || [],
    special_terms: ct.special_terms || null,
    payment_method: ct.payment_method || 'account',
    payment_info:   ct.payment_info || {},
    sign_supplier:  ct.sign_supplier  || null,
    sign_applicant: ct.sign_applicant || null,
    signature_type: ct.signature_type || 'digital',
    contract_scan_path: ct.contract_scan_path || null,
    id_card_path:       ct.id_card_path || null,
    signed_at:      ct.signed_at,
    status:         ct.status || 'draft',
    notes:          ct.notes || null,
    updated_at:     new Date().toISOString(),
  };

  try {
    const { error } = await supa.from('rental_contracts').upsert(payload);
    if (error) throw error;
    toast('계약서가 저장되었습니다.', 'ok');
    ct._existing = true;

    // 거래처 자동 생성/연결이 일어났다면: 전체 거래처 리스트 reload + 해당 거래처 선택
    if (autoCreatedCustomerId) {
      await loadAll();
      const cust = STATE.customers.find(x => x.id === autoCreatedCustomerId);
      if (cust) {
        STATE.selectedId = autoCreatedCustomerId;
        CT_STATE.customer = cust;        // 에디터의 현재 거래처도 갱신
      } else {
        // 만기 모드라 STATE에 안 보일 수 있음 — 활성 모드로 전환
        STATE.filters.mode = 'active';
        const modeRadio = document.querySelector('input[name="rc-mode"][value="active"]');
        if (modeRadio) modeRadio.checked = true;
        await loadAll();
        const cust2 = STATE.customers.find(x => x.id === autoCreatedCustomerId);
        if (cust2) {
          STATE.selectedId = autoCreatedCustomerId;
          CT_STATE.customer = cust2;
        }
      }
      renderList();
    }

    // 거래처별 리스트 새로고침 + 상세 패널 갱신
    await loadContractsFor(ct.customer_id);
    renderDetail();
    // 신규 배지/배너 제거 (현재 서명 패드 유지 위해 헤더+배너만 정리)
    if (autoCreatedCustomerId) {
      const banner = document.querySelector('.ct-new-customer-banner');
      if (banner) banner.remove();
      // 헤더의 "신규" 배지 갱신
      const head = document.getElementById('ct-edit-head');
      if (head) {
        const newBadge = head.querySelector('.rc-ct-badge[style*="fef3c7"]');
        if (newBadge) newBadge.remove();
        const headerTitle = head.querySelector('.ct-h-title');
        if (headerTitle) {
          const firstChild = headerTitle.firstChild;
          if (firstChild && firstChild.nodeType === 3) {
            const newName = (CT_STATE.customer && CT_STATE.customer.company)
              || ct.company_snapshot || '-';
            firstChild.textContent = newName + ' ';
          }
        }
      }
    }
  } catch (err) {
    console.error(err);
    toast('저장 실패: ' + (err.message || err), 'err');
  }
}

async function deleteContract() {
  const ct = CT_STATE.contract;
  if (!ct || !ct.id) return;
  if (!confirm(`계약서 ${ct.contract_no} 을(를) 삭제하시겠습니까?`)) return;
  try {
    const { error } = await window.totalasAuth.from('rental_contracts').delete().eq('id', ct.id);
    if (error) throw error;
    toast('계약서가 삭제되었습니다.', 'ok');
    closeContractEditor();
    await loadContractsFor(ct.customer_id);
    renderDetail();
  } catch (err) {
    console.error(err);
    toast('삭제 실패: ' + (err.message || err), 'err');
  }
}

// ── 수리내역 / 판매·수리 (rental_repairs) ─────────────
const REPAIR_STATE = {
  byCustomer: {},   // { customer_id: [repairs...] }
  editingId: null,  // 인라인 수정 중인 행 id
};

// 품목 카테고리 — item_type 으로 expense / income 분류
const REPAIR_CATS = {
  expense: { types: ['출장', '여분토너', '부품교체'], sign: -1, label: '무상수리내역',     icon: '🛠', color: '#dc2626' },
  income:  { types: ['판매', '수리'],                  sign: +1, label: '유상판매수리내역', icon: '💰', color: '#059669' },
};
function modeOfType(type) {
  if (REPAIR_CATS.income.types.includes(type)) return 'income';
  return 'expense';
}

async function loadRepairsFor(customerId) {
  const supa = window.totalasAuth;
  if (!supa) return [];
  try {
    const { data, error } = await supa
      .from('rental_repairs')
      .select('*')
      .eq('customer_id', customerId)
      .order('service_date', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw error;
    REPAIR_STATE.byCustomer[customerId] = data || [];
    return data || [];
  } catch (err) {
    console.warn('수리내역 로드 실패:', err.message || err);
    REPAIR_STATE.byCustomer[customerId] = [];
    return [];
  }
}

function renderRepairCard(customer, mode) {
  const cat = REPAIR_CATS[mode];
  const all = REPAIR_STATE.byCustomer[customer.id];
  const loaded = Array.isArray(all);
  const rows = loaded ? all.filter(r => modeOfType(r.item_type) === mode) : [];
  const sum = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const sumStyle = sum < 0 ? 'color:#dc2626;' : (sum > 0 ? 'color:#059669;' : '');
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const typeOptions = cat.types.map(t => `<option value="${escapeAttr(t)}">${escapeHtml(t)}</option>`).join('');

  const inputStyle = 'font-size:12px; padding:4px 6px; border:1px solid var(--border); border-radius:4px; width:100%;';

  const dataRows = rows.length
    ? rows.map(r => {
        const amt = Number(r.amount) || 0;
        const amtColor = amt < 0 ? 'color:#dc2626;' : (amt > 0 ? 'color:#059669;' : 'color:#94a3b8;');
        // 인라인 수정 모드
        if (REPAIR_STATE.editingId === r.id) {
          const editTypeOptions = cat.types.map(t =>
            `<option value="${escapeAttr(t)}" ${t === r.item_type ? 'selected' : ''}>${escapeHtml(t)}</option>`
          ).join('');
          const absAmt = Math.abs(amt);
          return `
            <tr data-rid="${escapeAttr(r.id)}" class="rp-edit-row" style="background:#fef9c3;">
              <td><input type="date" data-rp-edit-field="service_date" value="${escapeAttr((r.service_date || '').slice(0,10))}" style="${inputStyle}"></td>
              <td><select data-rp-edit-field="item_type" style="${inputStyle}">${editTypeOptions}</select></td>
              <td><input type="text" data-rp-edit-field="work_desc" value="${escapeAttr(r.work_desc || '')}" style="${inputStyle} text-align:left;"></td>
              <td><input type="number" data-rp-edit-field="amount" value="${absAmt}" step="1" style="${inputStyle} text-align:right;"></td>
              <td class="act" style="white-space:nowrap;">
                <button class="rc-icon-btn" data-rp-act="save" data-rid="${escapeAttr(r.id)}" title="저장" style="color:#059669;">✓</button>
                <button class="rc-icon-btn" data-rp-act="cancel" title="취소">✕</button>
              </td>
            </tr>
          `;
        }
        return `
          <tr data-rid="${escapeAttr(r.id)}">
            <td class="muted-small">${escapeHtml((r.service_date || '').slice(0, 10))}</td>
            <td>${escapeHtml(r.item_type || '-')}</td>
            <td>${escapeHtml(r.work_desc || '-')}</td>
            <td style="text-align:right; font-weight:600; ${amtColor}">${amt.toLocaleString()}</td>
            <td class="act" style="white-space:nowrap;">
              <button class="rc-icon-btn" data-rp-act="edit" data-rid="${escapeAttr(r.id)}" title="수정">✏</button>
              <button class="rc-icon-btn danger" data-rp-act="del" data-rid="${escapeAttr(r.id)}" title="삭제">🗑</button>
            </td>
          </tr>
        `;
      }).join('')
    : (loaded
        ? `<tr><td colspan="5" class="muted" style="text-align:center; padding:14px; font-size:12.5px;">등록된 ${cat.label}이(가) 없습니다.</td></tr>`
        : `<tr><td colspan="5" class="muted" style="text-align:center; padding:14px; font-size:12px;">로딩 중…</td></tr>`);

  const signLabel = cat.sign < 0 ? '자동 −' : '자동 +';
  const newRow = `
    <tr class="rp-new-row" data-rp-mode="${mode}" style="background:#f8fafc;">
      <td><input type="date" data-rp-new="service_date" value="${todayStr}" style="${inputStyle}"></td>
      <td>
        <select data-rp-new="item_type" style="${inputStyle}">
          ${typeOptions}
        </select>
      </td>
      <td><input type="text" data-rp-new="work_desc" placeholder="작업내용" style="${inputStyle} padding-left:8px; text-align:left;"></td>
      <td><input type="number" data-rp-new="amount" placeholder="금액 (${signLabel})" step="1" style="${inputStyle} padding-left:8px; text-align:right;"></td>
      <td class="act"><button class="btn small primary" data-rp-act="add" data-rp-mode="${mode}" type="button">+ 추가</button></td>
    </tr>
  `;

  return `
    <div class="card rc-repair-card" data-rp-mode="${mode}">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:8px;">
        <h3 style="margin:0;">${cat.icon} ${cat.label} <span class="muted-small" style="font-weight:400;">${rows.length}건 · 합계 <b style="${sumStyle}">${sum.toLocaleString()}원</b></span></h3>
      </div>
      <div style="overflow-x:auto;">
        <table class="rc-asset-table">
          <thead>
            <tr>
              <th style="width:100px;">날짜</th>
              <th style="width:110px;">품목</th>
              <th>작업내용</th>
              <th style="width:110px; text-align:right;">금액</th>
              <th class="act">관리</th>
            </tr>
          </thead>
          <tbody>
            ${dataRows}
            ${newRow}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function addRepair(customerId, payload) {
  const supa = window.totalasAuth;
  if (!supa) throw new Error('인증되지 않은 세션입니다.');
  const id = `rp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
  const { error } = await supa.from('rental_repairs').insert({
    id, customer_id: customerId, ...payload,
  });
  if (error) throw error;
  await loadRepairsFor(customerId);
}

async function updateRepair(customerId, repairId, payload) {
  const supa = window.totalasAuth;
  if (!supa) throw new Error('인증되지 않은 세션입니다.');
  const { error } = await supa.from('rental_repairs')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', repairId);
  if (error) throw error;
  await loadRepairsFor(customerId);
}

async function deleteRepair(customerId, repairId) {
  const supa = window.totalasAuth;
  if (!supa) throw new Error('인증되지 않은 세션입니다.');
  const { error } = await supa.from('rental_repairs').delete().eq('id', repairId);
  if (error) throw error;
  await loadRepairsFor(customerId);
}

function bindRepairCards(c) {
  document.querySelectorAll('.rc-repair-card').forEach(card => {
    const mode = card.dataset.rpMode;
    const cat = REPAIR_CATS[mode];

    // 추가 버튼
    const addBtn = card.querySelector('[data-rp-act="add"]');
    if (addBtn) {
      addBtn.addEventListener('click', async () => {
        const newRow = card.querySelector('.rp-new-row');
        const dateEl = newRow.querySelector('[data-rp-new="service_date"]');
        const typeEl = newRow.querySelector('[data-rp-new="item_type"]');
        const descEl = newRow.querySelector('[data-rp-new="work_desc"]');
        const amountEl = newRow.querySelector('[data-rp-new="amount"]');
        const item_type = (typeEl.value || '').trim();
        const work_desc = (descEl.value || '').trim();
        const rawAmount = amountEl.value === '' ? 0 : Number(amountEl.value);
        if (!item_type) { toast('품목을 선택하세요.', 'err'); return; }
        if (Number.isNaN(rawAmount)) { toast('금액이 올바르지 않습니다.', 'err'); return; }
        // 카테고리 부호 자동 적용: expense → 음수, income → 양수
        const amount = rawAmount === 0 ? 0 : cat.sign * Math.abs(rawAmount);
        addBtn.disabled = true;
        addBtn.textContent = '저장 중…';
        try {
          await addRepair(c.id, {
            service_date: dateEl.value || null,
            item_type,
            work_desc: work_desc || null,
            amount,
          });
          toast(`${cat.label} 추가되었습니다.`, 'ok');
          renderDetail();
        } catch (err) {
          console.error(err);
          toast('추가 실패: ' + (err.message || err), 'err');
          addBtn.disabled = false;
          addBtn.textContent = '+ 추가';
        }
      });
    }

    // 수정 / 삭제 / 저장 / 취소 — event delegation
    card.querySelectorAll('[data-rp-act]').forEach(btn => {
      const act = btn.dataset.rpAct;
      if (act === 'add') return; // already bound
      if (act === 'edit') {
        btn.addEventListener('click', () => {
          REPAIR_STATE.editingId = btn.dataset.rid;
          renderDetail();
        });
      } else if (act === 'cancel') {
        btn.addEventListener('click', () => {
          REPAIR_STATE.editingId = null;
          renderDetail();
        });
      } else if (act === 'save') {
        btn.addEventListener('click', async () => {
          const rid = btn.dataset.rid;
          const row = card.querySelector(`tr[data-rid="${rid}"].rp-edit-row`);
          if (!row) return;
          const dateV = row.querySelector('[data-rp-edit-field="service_date"]').value;
          const typeV = row.querySelector('[data-rp-edit-field="item_type"]').value;
          const descV = row.querySelector('[data-rp-edit-field="work_desc"]').value;
          const amountRaw = row.querySelector('[data-rp-edit-field="amount"]').value;
          const editMode = modeOfType(typeV);
          const sign = REPAIR_CATS[editMode].sign;
          const amtNum = amountRaw === '' ? 0 : Number(amountRaw);
          if (Number.isNaN(amtNum)) { toast('금액이 올바르지 않습니다.', 'err'); return; }
          const amount = amtNum === 0 ? 0 : sign * Math.abs(amtNum);
          btn.disabled = true;
          try {
            await updateRepair(c.id, rid, {
              service_date: dateV || null,
              item_type: typeV,
              work_desc: (descV || '').trim() || null,
              amount,
            });
            REPAIR_STATE.editingId = null;
            toast('수정되었습니다.', 'ok');
            renderDetail();
          } catch (err) {
            console.error(err);
            toast('수정 실패: ' + (err.message || err), 'err');
            btn.disabled = false;
          }
        });
      } else if (act === 'del') {
        btn.addEventListener('click', async () => {
          const rid = btn.dataset.rid;
          if (!rid) return;
          if (!confirm('이 항목을 삭제하시겠습니까?')) return;
          try {
            await deleteRepair(c.id, rid);
            if (REPAIR_STATE.editingId === rid) REPAIR_STATE.editingId = null;
            toast('삭제되었습니다.', 'ok');
            renderDetail();
          } catch (err) {
            console.error(err);
            toast('삭제 실패: ' + (err.message || err), 'err');
          }
        });
      }
    });
  });
}

// ── 상세 패널 hook (renderDetail 후처리) ─────────────
const _originalRenderDetail = renderDetail;
renderDetail = function () {
  _originalRenderDetail();
  const c = STATE.customers.find(x => x.id === STATE.selectedId);
  if (!c) return;

  // 계약서 카드: Cross-sell 카드 바로 앞에 삽입
  // (보유자산 → 수리내역 → 기본정보 → 계약서 → Cross-sell 순)
  const detail = document.getElementById('rc-detail');
  const ctCardHTML = renderContractCard(c);
  const insightCard = Array.from(detail.querySelectorAll('.card'))
    .find(el => /Cross-sell/i.test(el.textContent || ''));
  if (insightCard) {
    insightCard.insertAdjacentHTML('beforebegin', ctCardHTML);
  } else {
    detail.insertAdjacentHTML('beforeend', ctCardHTML);
  }

  // 이벤트 바인딩 (계약서)
  const newBtn = document.getElementById('btn-ct-new');
  if (newBtn) newBtn.addEventListener('click', () => openContractEditor(c, null));

  detail.querySelectorAll('.rc-ct-row').forEach(row => {
    row.addEventListener('click', () => {
      const ctid = row.dataset.ctid;
      const existing = (CT_STATE.byCustomer[c.id] || []).find(x => x.id === ctid);
      if (!existing) return;
      const ctCopy = JSON.parse(JSON.stringify(existing));
      ctCopy._existing = true;
      openContractEditor(c, ctCopy);
    });
  });

  // 이벤트 바인딩 (수리내역 / 판매·수리)
  bindRepairCards(c);

  // 계약서 비동기 로드 (없을 때만)
  if (!CT_STATE.byCustomer[c.id]) {
    loadContractsFor(c.id).then(() => renderDetail());
  }

  // 수리내역 비동기 로드 (없을 때만)
  if (!REPAIR_STATE.byCustomer[c.id]) {
    loadRepairsFor(c.id).then(() => renderDetail());
  }
};

// ── 에디터 모달 닫기 (ESC / backdrop) ────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('ct-edit-backdrop')?.classList.contains('show')) {
    closeContractEditor();
  }
});
document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'ct-edit-backdrop') closeContractEditor();
});
