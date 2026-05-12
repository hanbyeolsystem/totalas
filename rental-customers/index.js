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
  filters: {
    q: '',
    sort: 'name',
    onlyNas: false,
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
  document.getElementById('btn-add').addEventListener('click', () => openForm(null));

  const backdrop = document.getElementById('rc-modal');
  backdrop.addEventListener('click', (e) => {
    if (e.target.id === 'rc-modal') closeModal();
  });
}

// ─────────────────────────────────────────────────────────────
// 데이터 로드
// ─────────────────────────────────────────────────────────────
async function loadAll() {
  const supa = window.totalasAuth;
  const listEl = document.getElementById('rc-cust-list');
  listEl.innerHTML = `<div class="muted" style="text-align:center; padding:20px; font-size:12px;">로딩 중…</div>`;

  try {
    // 1. 거래처 + 할당(자산) JOIN
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
      .eq('active', true)
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
  document.getElementById('s-total').textContent = cs.length;
  document.getElementById('s-total-sub').textContent = `총 자산 ${cs.reduce((s,c) => s + c._assignments.length, 0)}건`;

  const pcSetCandidate = cs.filter(c => c._hasPC && !c._hasMonitor).length;
  document.getElementById('s-pc-set').textContent = pcSetCandidate;

  const wellisCandidate = cs.filter(c => c._hasOutput && !c._hasWellis).length;
  document.getElementById('s-wellness').textContent = wellisCandidate;

  const nas = cs.filter(c => c._isNasCandidate).length;
  document.getElementById('s-nas').textContent = nas;
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

  listEl.innerHTML = arr.map(c => {
    const tags = [];
    if (c._isNasCandidate) tags.push(`<span class="rc-tag nas">NAS 후보</span>`);
    if (c._score >= 50) tags.push(`<span class="rc-tag score-hot">🔥 ${c._score}</span>`);
    else if (c._score >= 25) tags.push(`<span class="rc-tag score-mid">${c._score}</span>`);
    else if (c._score > 0) tags.push(`<span class="rc-tag score-low">${c._score}</span>`);
    return `
      <div class="rc-cust-item ${STATE.selectedId === c.id ? 'active' : ''}" data-id="${escapeAttr(c.id)}">
        <div class="rc-cust-name">${escapeHtml((c.company || '').split('\n')[0])}</div>
        <div class="rc-cust-sub">자산 ${c._assignments.length}건 · ${escapeHtml((c.address || '').slice(0, 24))}</div>
        <div class="rc-cust-tags">${tags.join('')}</div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.rc-cust-item').forEach(el => {
    el.addEventListener('click', () => {
      STATE.selectedId = el.dataset.id;
      renderList();
      renderDetail();
    });
  });
}

// ─────────────────────────────────────────────────────────────
// 우측 상세 패널
// ─────────────────────────────────────────────────────────────
function renderDetail() {
  const detail = document.getElementById('rc-detail');
  const c = STATE.customers.find(x => x.id === STATE.selectedId);
  if (!c) {
    detail.innerHTML = `<div class="card rc-detail-empty"><p style="font-size:14px; margin:0;">좌측에서 거래처를 선택하세요.</p></div>`;
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
      <h3>📦 보유 자산 <span class="muted-small" style="font-weight:400;">${sorted.length}건</span></h3>
      ${sorted.length ? `
        <div style="overflow-x:auto;">
          <table class="rc-asset-table">
            <thead>
              <tr>
                <th>분류</th><th>품목</th><th>모델</th><th>시리얼</th>
                <th>설치일</th><th>월 임대료</th><th>상태</th>
              </tr>
            </thead>
            <tbody>
              ${sorted.map(a => {
                const it = a.rental_items;
                const cat = categoryOf(it.subtype);
                return `<tr>
                  <td><span class="rc-cat-pill rc-cat-${cat}">${cat}</span></td>
                  <td>${escapeHtml(it.subtype || '-')}</td>
                  <td>${escapeHtml((it.brand || '') + ' ' + (it.model || ''))}</td>
                  <td class="muted-small">${escapeHtml(it.serial || '-')}</td>
                  <td class="muted-small">${escapeHtml((it.install_date || '').slice(0, 10))}</td>
                  <td style="text-align:right;">${a.monthly_fee ? Number(a.monthly_fee).toLocaleString() : '-'}</td>
                  <td>${escapeHtml(it.status || '-')}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      ` : `<p class="muted" style="margin:0; font-size:12.5px;">등록된 자산이 없습니다.</p>`}
    </div>
  `;

  // 4) AS 주기 표
  const asRows = buildAsRows(c);
  const asCard = `
    <div class="card">
      <h3>🛠 AS 주기 계획</h3>
      ${asRows.length ? `
        <table class="rc-as-table">
          <thead>
            <tr><th>품목</th><th>주기</th><th>점검 작업</th><th>다음 점검 (추정)</th></tr>
          </thead>
          <tbody>
            ${asRows.map(r => `
              <tr>
                <td>${escapeHtml(r.subtype)} <span class="muted-small">×${r.count}</span></td>
                <td>${r.months}개월</td>
                <td>${escapeHtml(r.task)}</td>
                <td class="${r.overdue ? '' : 'muted-small'}" ${r.overdue ? 'style="color:#dc2626;font-weight:600;"' : ''}>${escapeHtml(r.nextDate)} ${r.overdue ? '(지연)' : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : `<p class="muted" style="margin:0; font-size:12.5px;">자산이 없어 AS 주기를 표시할 수 없습니다.</p>`}
    </div>
  `;

  detail.innerHTML = infoCard + insightCard + assetCard + asCard;

  document.getElementById('btn-edit').addEventListener('click', () => openForm(c));
  document.getElementById('btn-delete').addEventListener('click', () => deleteCustomer(c));
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
}

// ─────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function escapeAttr(s) { return escapeHtml(s); }
