// 한별시스템 임대관리 — 공통 앱 로직
'use strict';

// ============================================================
// STORAGE: db-supa.js 가 window.store 로 등록함 (Supabase 기반)
// ============================================================

// ============================================================
// 유틸
// ============================================================
function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function uid() { return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function nowIso() { return new Date().toISOString(); }
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

// ============================================================
// 모달
// ============================================================
function showModal(content, opts = {}) {
  const box = $('#modal-box');
  if (typeof content === 'string') box.innerHTML = content;
  else { box.innerHTML = ''; box.appendChild(content); }
  box.classList.toggle('wide', opts.wide !== false);
  $('#modal-backdrop').classList.remove('hidden');
  // close 핸들러
  box.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
}
function closeModal() {
  $('#modal-backdrop').classList.add('hidden');
}
window.addEventListener('DOMContentLoaded', () => {
  const bd = $('#modal-backdrop');
  if (bd) bd.addEventListener('click', e => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });
});

// ============================================================
// 거래처 관리 페이지 부트 (인증 + Supabase 데이터 로드 후 실행)
// ============================================================
document.addEventListener('totalas:ready', async () => {
  if (!document.querySelector('.customers-page')) return;

  try {
    showLoading('데이터 로드 중…');
    await store.load();
  } catch (err) {
    console.error('store.load() 실패:', err);
    alert('데이터 로드 실패: ' + (err.message || err));
    return;
  } finally {
    hideLoading();
  }

  bindCustomerPage();
  renderCustomerList();
  const first = Object.values(store.data.customers).sort((a, b) =>
    (a.company || '').localeCompare(b.company || '', 'ko')
  )[0];
  if (first) selectCustomer(first.id);
});

function showLoading(text = '로딩 중…') {
  let el = document.getElementById('global-loading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'global-loading';
    el.className = 'global-loading';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.display = 'flex';
}
function hideLoading() {
  const el = document.getElementById('global-loading');
  if (el) el.style.display = 'none';
}

let state = { selectedId: null, search: '', sort: 'name', bulkSelected: new Set(), showArchived: false, activeTab: 'info' };

function bindCustomerPage() {
  $('#btn-add').addEventListener('click', () => openCustomerModal(null));
  $('#btn-ocr').addEventListener('click', openOcrModal);
  $('#btn-export').addEventListener('click', exportCustomers);
  $('#btn-nas-backup')?.addEventListener('click', exportNasBackup);
  $('#btn-seed')?.addEventListener('click', refreshFromSupabase);
  $('#btn-asms-link')?.addEventListener('click', () => openAsmsModal({ pickerMode: false }));

  $('#cust-search').addEventListener('input', e => {
    state.search = e.target.value.toLowerCase().trim();
    renderCustomerList();
  });
  $('#cust-sort').addEventListener('change', e => {
    state.sort = e.target.value;
    renderCustomerList();
  });
  // archived 토글
  document.getElementById('cust-show-archived')?.addEventListener('change', async (e) => {
    state.showArchived = e.target.checked;
    if (state.showArchived && !store._archivedLoaded) {
      try {
        showLoading('종료된 거래처 로드 중…');
        await store.loadArchivedCustomers();
      } catch (err) {
        alert('종료된 거래처 로드 실패: ' + (err.message || err));
        e.target.checked = false;
        state.showArchived = false;
        return;
      } finally { hideLoading(); }
    }
    renderCustomerList();
  });

  // 헤더의 ASMS 상태 표시 갱신
  refreshAsmsStatus();
}

async function refreshAsmsStatus() {
  const label = document.getElementById('asms-status');
  if (!label || !window.asmsSync) return;
  try {
    const user = await window.asmsSync.currentUser();
    if (user) {
      label.textContent = `접수관리툴 ✓ ${user.email || ''}`;
      label.parentElement.style.borderColor = 'var(--success)';
      label.parentElement.style.color = 'var(--success)';
    } else {
      label.textContent = '접수관리툴 연동';
      label.parentElement.style.borderColor = '';
      label.parentElement.style.color = '';
    }
  } catch (e) {}
}

// ============================================================
// 거래처 리스트 렌더
// ============================================================
function renderCustomerList() {
  const ul = $('#cust-list');
  const cnt = $('#cust-count');
  let customers = Object.values(store.data.customers);
  // archived 포함 토글
  if (state.showArchived && store.data.customersArchived) {
    customers = customers.concat(Object.values(store.data.customersArchived));
  }
  const archivedCount = state.showArchived
    ? (Object.keys(store.data.customersArchived || {}).length)
    : null;
  const acEl = document.getElementById('cust-archived-count');
  if (acEl) acEl.textContent = archivedCount != null ? `(${archivedCount}곳 포함됨)` : '';

  // 검색 필터
  if (state.search) {
    customers = customers.filter(c =>
      [c.company, c.ceo, c.phone, c.address, c.memo].some(v =>
        (v || '').toLowerCase().includes(state.search)));
  }

  // 정렬
  customers.sort((a, b) => {
    if (state.sort === 'recent') return (b.created_at || '').localeCompare(a.created_at || '');
    if (state.sort === 'printers') return (b.serials?.length || 0) - (a.serials?.length || 0);
    return a.company.localeCompare(b.company, 'ko');
  });

  // 검색/정렬로 사라진 ID는 선택에서 제외 (혼란 방지)
  const visibleIds = new Set(customers.map(c => c.id));
  for (const id of Array.from(state.bulkSelected)) {
    if (!visibleIds.has(id)) state.bulkSelected.delete(id);
  }
  const selCount = state.bulkSelected.size;
  const allChecked = customers.length > 0 && customers.every(c => state.bulkSelected.has(c.id));

  cnt.innerHTML = `${customers.length}곳${selCount > 0 ? ` <strong style="color:var(--danger); margin-left:6px;">· 선택 ${selCount}</strong>` : ''}`;

  if (customers.length === 0) {
    ul.innerHTML = `<li class="cust-list-empty muted">${state.search ? '검색 결과 없음' : '등록된 거래처 없음. 우측 상단에서 추가하세요.'}</li>`;
    return;
  }

  // 일괄 선택 바 (항상 표시 — 사용자가 즉시 모두 선택 가능)
  const bulkBar = `
    <li class="cust-bulk-bar" style="display:flex; align-items:center; gap:10px; padding:8px 12px; background:#f8fafc; border-bottom:1px solid var(--border); position:sticky; top:0; z-index:1;">
      <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:12.5px;">
        <input type="checkbox" id="bulk-all" ${allChecked ? 'checked' : ''} style="width:16px; height:16px;">
        <span class="muted-small">${allChecked ? '전체 해제' : '전체 선택'}</span>
      </label>
      ${selCount > 0 ? `
        <button class="btn small ghost" id="bulk-clear" type="button">선택 해제</button>
        <button class="btn small danger" id="bulk-del" type="button" style="margin-left:auto;">🗑 ${selCount}곳 삭제</button>
      ` : ''}
    </li>
  `;

  ul.innerHTML = bulkBar + customers.map(c => {
    const isArchived = !!c.archived_at;
    return `
    <li class="cust-item ${state.selectedId === c.id ? 'selected' : ''} ${isArchived ? 'archived' : ''}" data-id="${c.id}" style="display:flex; align-items:center; gap:8px; ${isArchived ? 'opacity:0.6;' : ''}">
      <label class="cust-item-check" style="padding:4px 4px 4px 8px; cursor:pointer;">
        <input type="checkbox" data-bulk="${c.id}" ${state.bulkSelected.has(c.id) ? 'checked' : ''} ${isArchived ? 'disabled' : ''} style="width:16px; height:16px;">
      </label>
      <div style="flex:1; min-width:0;">
        <div class="cust-item-name" style="${isArchived ? 'text-decoration:line-through;' : ''}">${escapeHtml(c.company)}</div>
        <div class="cust-item-meta">
          ${isArchived ? `<span class="badge" style="background:#fee2e2; color:#991b1b;" title="${escapeHtml(c.archived_reason || '')}">📦 종료</span>` : ''}
          ${c.ceo ? `<span>${escapeHtml(c.ceo)}</span>` : ''}
          ${(c.serials?.length) ? `<span class="badge">🖨 ${c.serials.length}대</span>` : ''}
        </div>
      </div>
    </li>`;
  }).join('');

  // 체크박스: li 클릭으로 전파되지 않게
  ul.querySelectorAll('input[data-bulk]').forEach(cb => {
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', e => {
      const id = e.target.dataset.bulk;
      if (e.target.checked) state.bulkSelected.add(id);
      else state.bulkSelected.delete(id);
      renderCustomerList();
    });
  });
  ul.querySelectorAll('.cust-item-check').forEach(lab => {
    lab.addEventListener('click', e => e.stopPropagation());
  });

  // 전체 선택/해제
  document.getElementById('bulk-all')?.addEventListener('change', e => {
    if (e.target.checked) {
      for (const c of customers) state.bulkSelected.add(c.id);
    } else {
      for (const c of customers) state.bulkSelected.delete(c.id);
    }
    renderCustomerList();
  });

  // 일괄 액션
  document.getElementById('bulk-clear')?.addEventListener('click', () => {
    state.bulkSelected.clear();
    renderCustomerList();
  });
  document.getElementById('bulk-del')?.addEventListener('click', bulkDeleteCustomers);

  ul.querySelectorAll('.cust-item').forEach(li => {
    li.addEventListener('click', () => selectCustomer(li.dataset.id));
  });
}

async function bulkDeleteCustomers() {
  const ids = Array.from(state.bulkSelected);
  if (ids.length === 0) return;
  const names = ids.slice(0, 5).map(id => store.data.customers[id]?.company || id);
  const more = ids.length > 5 ? `\n· ... 외 ${ids.length - 5}곳` : '';
  const msg = `다음 ${ids.length}곳을 삭제할까요?\n\n· ${names.join('\n· ')}${more}\n\n⚠ 되돌릴 수 없습니다.\n연결된 시리얼은 매칭만 풀리고, 카운터/계약서는 그대로 유지됩니다.`;
  if (!confirm(msg)) return;

  const btn = document.getElementById('bulk-del');
  if (btn) { btn.disabled = true; btn.textContent = '삭제 중…'; }
  let ok = 0, fail = 0;
  for (const id of ids) {
    try {
      await store.deleteCustomer(id);
      ok++;
    } catch (e) {
      console.error('deleteCustomer', id, e);
      fail++;
    }
  }
  state.bulkSelected.clear();
  if (state.selectedId && !store.data.customers[state.selectedId]) {
    state.selectedId = null;
  }
  renderCustomerList();
  renderCustomerDetail(state.selectedId);
  alert(`✅ 삭제 완료: ${ok}곳${fail ? ` / 실패 ${fail}곳 (콘솔 확인)` : ''}`);
}

function selectCustomer(id) {
  state.selectedId = id;
  renderCustomerList();
  renderCustomerDetail(id);
}

// ============================================================
// 거래처 상세 렌더
// ============================================================
function renderCustomerDetail(id) {
  const c = store.data.customers[id] || (store.data.customersArchived || {})[id];
  const wrap = $('#cust-detail');
  if (!c) {
    wrap.innerHTML = `<div class="cust-empty"><div class="cust-empty-icon">👈</div><div class="cust-empty-title">거래처를 선택하거나</div><div class="cust-empty-sub muted">우측 상단에서 새 거래처 추가</div></div>`;
    return;
  }

  const isArchived = !!c.archived_at;
  const archivedBanner = isArchived ? `
    <div style="background:#fef2f2; border:1px solid #fecaca; color:#991b1b; padding:10px 14px; border-radius:8px; margin-bottom:14px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
      <span style="font-size:18px;">📦</span>
      <div style="flex:1; min-width:220px;">
        <div style="font-weight:700;">이 거래처는 종료 처리됨</div>
        <div style="font-size:12px; opacity:0.85;">사유: ${escapeHtml(c.archived_reason || '—')} · ${fmtDate(c.archived_at)}</div>
      </div>
      <button class="btn small primary" data-unarchive="${c.id}">↻ 복구</button>
    </div>
  ` : '';

  // 거래처 바뀌면 탭 초기화
  if (state._lastCustomerId !== id) {
    state.activeTab = 'info';
    state._lastCustomerId = id;
  }

  wrap.innerHTML = archivedBanner + `
    <div class="cust-detail-head">
      <div>
        <h2>${escapeHtml(c.company)}</h2>
        <div class="muted" style="font-size:12px;margin-top:2px;">
          ${c.ceo ? '대표 ' + escapeHtml(c.ceo) + ' · ' : ''}
          등록 ${fmtDate(c.created_at)}
        </div>
      </div>
      <div class="cust-detail-actions">
        ${isArchived ? '' : `<button class="btn ghost small" data-edit="${c.id}">✏️ 수정</button>`}
        ${isArchived ? '' : `<button class="btn ghost small danger" data-del="${c.id}">🗑 삭제</button>`}
      </div>
    </div>`;

  if (isArchived) {
    wrap.querySelector(`[data-unarchive="${c.id}"]`)?.addEventListener('click', async () => {
      if (!confirm(`${c.company} 거래처를 복구하시겠어요?`)) return;
      try {
        showLoading('복구 중…');
        await store.unarchiveCustomer(c.id);
        renderCustomerList();
        renderCustomerDetail(c.id);
        alert('복구되었습니다.');
      } catch (e) { alert('복구 실패: ' + (e.message || e)); }
      finally { hideLoading(); }
    });
    return;
  }

  // 탭 헤더 + 컨테이너
  const TABS = [
    { id: 'info',      icon: 'ℹ️', label: '정보' },
    { id: 'contracts', icon: '📋', label: '계약서' },
    { id: 'costs',     icon: '💰', label: '원가' },
    { id: 'visits',    icon: '🔧', label: '출장' },
    { id: 'supplies',  icon: '📦', label: '소모품' },
    { id: 'profit',    icon: '📊', label: '수익률' },
  ];
  const tabHtml = `
    <div class="cust-tabs" style="display:flex; gap:4px; flex-wrap:wrap; border-bottom:2px solid var(--border); margin:14px 0;">
      ${TABS.map(t => `
        <button class="cust-tab-btn ${state.activeTab === t.id ? 'active' : ''}"
                data-tab="${t.id}"
                style="padding:8px 14px; border:none; background:${state.activeTab === t.id ? 'var(--primary, #2563eb)' : 'transparent'}; color:${state.activeTab === t.id ? '#fff' : 'inherit'}; border-radius:6px 6px 0 0; cursor:pointer; font-size:13.5px; font-weight:${state.activeTab === t.id ? '600' : '400'};">
          <span style="margin-right:4px;">${t.icon}</span>${t.label}
        </button>`).join('')}
    </div>
    <div id="cust-tab-body"></div>
  `;
  wrap.innerHTML += tabHtml;

  wrap.querySelector('[data-edit]')?.addEventListener('click', () => openCustomerModal(id));
  wrap.querySelector('[data-del]')?.addEventListener('click', () => deleteCustomer(id));

  wrap.querySelectorAll('.cust-tab-btn').forEach(b => {
    b.addEventListener('click', () => {
      state.activeTab = b.dataset.tab;
      renderCustomerDetail(id);
    });
  });

  renderCustomerTabBody(id, c);
}

/** 활성 탭에 따른 컨텐츠 렌더 */
function renderCustomerTabBody(id, c) {
  const body = document.getElementById('cust-tab-body');
  if (!body) return;
  switch (state.activeTab) {
    case 'info':      renderTabInfo(body, id, c);      break;
    case 'contracts': renderTabContracts(body, id);    break;
    case 'costs':     renderTabCosts(body, id);        break;
    case 'visits':    renderTabVisits(body, id);       break;
    case 'supplies':  renderTabSupplies(body, id);     break;
    case 'profit':    renderTabProfit(body, id, c);    break;
  }
}

// ============================================================
// [정보] 탭 — 기존 거래처 상세 정보
// ============================================================
function renderTabInfo(body, id, c) {
  body.innerHTML = `
    <div class="cust-detail-grid">
      <section class="info-card">
        <h4>기본 정보</h4>
        <dl class="info-list">
          <dt>상호</dt><dd>${escapeHtml(c.company)}</dd>
          <dt>대표자</dt><dd>${escapeHtml(c.ceo || '—')}</dd>
          <dt>사업자등록번호</dt><dd>${escapeHtml(c.biz_no || '—')}</dd>
          <dt>법인등록번호</dt><dd>${escapeHtml(c.corp_no || '—')}</dd>
          <dt>업태</dt><dd>${escapeHtml(c.biz_type || '—')}</dd>
          <dt>종목</dt><dd>${escapeHtml(c.biz_item || '—')}</dd>
        </dl>
      </section>
      <section class="info-card">
        <h4>연락처</h4>
        <dl class="info-list">
          <dt>주소</dt><dd>${escapeHtml(c.address || '—')}</dd>
          <dt>전화</dt><dd>${escapeHtml(c.phone || '—')}</dd>
          <dt>팩스</dt><dd>${escapeHtml(c.fax || '—')}</dd>
          <dt>이메일</dt><dd>${escapeHtml(c.email || '—')}</dd>
          <dt>카카오톡</dt><dd>${escapeHtml(c.kakao || '—')}</dd>
        </dl>
      </section>
      <section class="info-card">
        <h4>임대 프린터 (${(c.serials || []).length}대)</h4>
        ${(c.serials || []).length === 0
          ? '<div class="muted" style="padding:10px 0;">연결된 프린터 없음. [카운터] 페이지에서 매칭하세요.</div>'
          : '<ul class="serial-list">' + c.serials.map(s => `<li><code>${escapeHtml(s)}</code></li>`).join('') + '</ul>'}
      </section>
      <section class="info-card">
        <h4>단가 / 청구 조건</h4>
        <dl class="info-list">
          <dt>기본료(월)</dt><dd>${(c.base_fee || 0).toLocaleString()}원</dd>
          <dt>흑백 무료</dt><dd>${(c.bw_free || 0).toLocaleString()}매</dd>
          <dt>흑백 단가</dt><dd>${(c.bw_rate || 0).toLocaleString()}원/장</dd>
          <dt>컬러 무료</dt><dd>${(c.co_free || 0).toLocaleString()}매</dd>
          <dt>컬러 단가</dt><dd>${(c.co_rate || 0).toLocaleString()}원/장</dd>
        </dl>
      </section>
      <section class="info-card span-2">
        <h4>첨부 서류 (이미지)</h4>
        <div class="att-grid" id="att-grid-${escapeHtml(id)}">
          ${ATTACHMENT_TYPES.map(t => `
            <div class="att-slot-view" data-att-type="${t.key}">
              <div class="att-slot-head"><span class="att-icon">${t.icon}</span><span class="att-label">${t.label}</span></div>
              <div class="att-slot-body" data-att-empty><div class="muted-small">미등록</div></div>
            </div>`).join('')}
        </div>
        <div style="margin-top:14px;">
          <strong style="font-size:12px;color:var(--muted);">메모</strong>
          <div style="white-space:pre-wrap;font-size:13px;margin-top:4px;">${escapeHtml(c.memo || '—')}</div>
        </div>
      </section>
    </div>
  `;
  loadAndRenderAttachments(id);
}

// ============================================================
// [계약서] 탭 — 모달로 띄움 + 파일 보관함
// ============================================================
function renderTabContracts(body, id) {
  body.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
      <h4 style="margin:0;">📋 임대 계약서</h4>
      <button class="btn small primary" id="btn-new-contract">+ 신규 계약서</button>
    </div>
    <div id="cust-contracts-${escapeHtml(id)}" style="margin-bottom:18px;"></div>

    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
      <h4 style="margin:0;">📎 계약서 파일 보관함</h4>
      <label class="btn small ghost" style="cursor:pointer;">
        + 파일 업로드
        <input type="file" id="contract-file-input" multiple accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.hwp" hidden>
      </label>
    </div>
    <div id="cust-contract-files-${escapeHtml(id)}"></div>
  `;
  document.getElementById('btn-new-contract').addEventListener('click', () => openContractModal(id, null));
  document.getElementById('contract-file-input').addEventListener('change', e => onContractFileUpload(id, e.target.files));
  renderCustomerContracts(id);
  renderCustomerContractFiles(id);
}

/** 계약서 작성/보기를 iframe 모달로 띄움. */
function openContractModal(customerId, contractId) {
  console.log('[contract] openContractModal', { customerId, contractId });
  const url = contractId
    ? `contracts.html?id=${encodeURIComponent(contractId)}&embed=1`
    : `contracts.html?customer=${encodeURIComponent(customerId)}&embed=1`;

  const backdrop = document.getElementById('modal-backdrop');
  const box      = document.getElementById('modal-box');
  if (!backdrop || !box) {
    alert('모달 시스템 누락 (modal-backdrop / modal-box). 페이지를 새로고침해주세요.');
    return;
  }

  box.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-bottom:1px solid var(--border); flex-shrink:0;">
      <h3 style="margin:0; font-size:15px;">📋 계약서 ${contractId ? '편집' : '신규 작성'}</h3>
      <button class="btn ghost small" data-close type="button">× 닫기</button>
    </div>
    <iframe src="${url}" style="flex:1; width:100%; min-height:60vh; border:none; display:block;" id="contract-iframe"></iframe>
    <div class="muted-small" style="padding:6px 12px; border-top:1px solid var(--border); background:#f8fafc; flex-shrink:0;">
      💡 계약서 작성 후 우상단 [💾 저장] 클릭, 작업이 끝나면 [× 닫기] 로 돌아가세요.
    </div>
  `;
  box.classList.add('wide');
  // 인라인 스타일 — 작은 viewport 에서도 안전, flex 컬럼으로 iframe 이 남는 공간 차지
  Object.assign(box.style, {
    padding: '0',
    width: 'min(95vw, 1200px)',
    maxWidth: '95vw',
    height: 'min(90vh, 800px)',
    maxHeight: '90vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  });
  backdrop.classList.remove('hidden');

  box.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', async () => {
    closeModal();
    box.removeAttribute('style');
    box.classList.remove('wide');
    // 닫을 때 계약서 다시 로드해서 목록 갱신
    try { await store.load(); } catch (_) {}
    renderCustomerContracts(customerId);
  }));
}

// ── 파일 보관함 (rental_archive category='contract') ──
function renderCustomerContractFiles(customerId) {
  const wrap = document.getElementById(`cust-contract-files-${customerId}`);
  if (!wrap) return;
  const files = Object.values(store.data.archive || {})
    .filter(a => a.customer_id === customerId && a.category === 'contract')
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  if (!files.length) {
    wrap.innerHTML = `<div class="muted" style="padding:14px; text-align:center; border:1px dashed var(--border); border-radius:6px; font-size:13px;">스캔본·PDF·이미지 등 계약 관련 파일을 업로드하세요.</div>`;
    return;
  }
  wrap.innerHTML = `
    <ul style="list-style:none; margin:0; padding:0;">
      ${files.map(f => `
        <li style="border:1px solid var(--border); border-radius:6px; padding:8px 12px; margin-bottom:6px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
          <span style="font-size:18px;">${guessFileIcon(f.filename || '')}</span>
          <div style="flex:1; min-width:200px;">
            <div style="font-weight:600;">${escapeHtml(f.filename || '파일')}</div>
            <div class="muted-small">${fmtFileSize(f.size_bytes)} · 업로드 ${fmtDate(f.created_at)} ${f.description ? '· ' + escapeHtml(f.description) : ''}</div>
          </div>
          <button class="btn small ghost"        data-download-file="${f.id}">⬇ 다운로드</button>
          <button class="btn small ghost danger" data-delete-file="${f.id}">🗑</button>
        </li>`).join('')}
    </ul>
  `;
  wrap.querySelectorAll('[data-download-file]').forEach(b =>
    b.addEventListener('click', () => onDownloadContractFile(b.dataset.downloadFile)));
  wrap.querySelectorAll('[data-delete-file]').forEach(b =>
    b.addEventListener('click', () => onDeleteContractFile(customerId, b.dataset.deleteFile)));
}

async function onContractFileUpload(customerId, fileList) {
  if (!fileList || !fileList.length) return;
  try {
    showLoading(`업로드 중 (0/${fileList.length})…`);
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      showLoading(`업로드 중 (${i + 1}/${fileList.length}) — ${f.name}`);
      const id = 'ar_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const path = `archive/${customerId}/${id}/${f.name}`;
      await store.uploadFile(path, f, { contentType: f.type });
      await store.upsertArchive({
        id,
        customer_id: customerId,
        category: 'contract',
        filename: f.name,
        file_path: path,
        mime_type: f.type || '',
        size_bytes: f.size,
        description: '',
      });
    }
    renderCustomerContractFiles(customerId);
  } catch (e) {
    console.error('파일 업로드 실패:', e);
    alert('업로드 실패: ' + (e.message || e));
  } finally { hideLoading(); }
}

async function onDownloadContractFile(archiveId) {
  const a = store.data.archive[archiveId];
  if (!a || !a.file_path) return;
  try {
    const blob = await store.downloadFile(a.file_path);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = a.filename || 'file';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { alert('다운로드 실패: ' + (e.message || e)); }
}

async function onDeleteContractFile(customerId, archiveId) {
  const a = store.data.archive[archiveId];
  if (!a) return;
  if (!confirm(`${a.filename} 파일을 삭제할까요? 되돌릴 수 없습니다.`)) return;
  try {
    await store.deleteArchive(archiveId);
    renderCustomerContractFiles(customerId);
  } catch (e) { alert('삭제 실패: ' + (e.message || e)); }
}

function guessFileIcon(filename) {
  const f = filename.toLowerCase();
  if (f.endsWith('.pdf')) return '📄';
  if (/\.(jpg|jpeg|png|gif|webp)$/.test(f)) return '🖼️';
  if (/\.(doc|docx)$/.test(f)) return '📝';
  if (f.endsWith('.hwp')) return '📃';
  return '📎';
}

function fmtFileSize(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

// ============================================================
// [원가] 탭 — 제품 매입 원가
// ============================================================
function renderTabCosts(body, id) {
  const items = Object.values(store.data.productCosts || {})
    .filter(r => r.customer_id === id)
    .sort((a, b) => (b.purchase_date || '').localeCompare(a.purchase_date || ''));
  const totalAmort = items.reduce((s, r) => s + (r.amortization_months > 0 ? (r.purchase_price / r.amortization_months) : 0), 0);

  body.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
      <h4 style="margin:0;">💰 제품 매입 원가 (${items.length}건)</h4>
      <button class="btn small primary" id="btn-add-cost">+ 원가 추가</button>
    </div>
    <div style="background:#f0fdf4; border:1px solid #bbf7d0; padding:10px 12px; border-radius:6px; margin-bottom:10px; font-size:13px;">
      월 감가상각 합계: <strong>${totalAmort.toLocaleString('ko-KR', {maximumFractionDigits:0})}원</strong>
      <span class="muted-small" style="margin-left:6px;">= Σ(매입가 ÷ 감가월수)</span>
    </div>
    ${items.length ? `
      <div style="overflow-x:auto;">
        <table class="cost-table" style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead><tr style="background:#f8fafc;">
            <th style="padding:8px; text-align:left; border-bottom:1px solid var(--border);">제품</th>
            <th style="padding:8px; text-align:left; border-bottom:1px solid var(--border);">시리얼</th>
            <th style="padding:8px; text-align:right; border-bottom:1px solid var(--border);">매입가</th>
            <th style="padding:8px; text-align:center; border-bottom:1px solid var(--border);">구매일</th>
            <th style="padding:8px; text-align:center; border-bottom:1px solid var(--border);">감가월</th>
            <th style="padding:8px; text-align:right; border-bottom:1px solid var(--border);">월 분할</th>
            <th style="padding:8px; border-bottom:1px solid var(--border);"></th>
          </tr></thead>
          <tbody>
            ${items.map(r => {
              const monthly = r.amortization_months > 0 ? Math.round(r.purchase_price / r.amortization_months) : 0;
              return `<tr>
                <td style="padding:6px 8px;">${escapeHtml(r.product_name)}</td>
                <td style="padding:6px 8px;">${escapeHtml(r.serial || '—')}</td>
                <td style="padding:6px 8px; text-align:right;">${(r.purchase_price||0).toLocaleString()}</td>
                <td style="padding:6px 8px; text-align:center;">${r.purchase_date || '—'}</td>
                <td style="padding:6px 8px; text-align:center;">${r.amortization_months}</td>
                <td style="padding:6px 8px; text-align:right;"><strong>${monthly.toLocaleString()}</strong></td>
                <td style="padding:6px 8px; text-align:right; white-space:nowrap;">
                  <button class="btn small ghost" data-edit-cost="${r.id}">✏️</button>
                  <button class="btn small ghost danger" data-del-cost="${r.id}">🗑</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>` : '<div class="muted" style="padding:24px; text-align:center; border:1px dashed var(--border); border-radius:6px;">등록된 원가가 없습니다.</div>'}
  `;
  body.querySelector('#btn-add-cost').addEventListener('click', () => openCostModal(id, null));
  body.querySelectorAll('[data-edit-cost]').forEach(b => b.addEventListener('click', () => openCostModal(id, b.dataset.editCost)));
  body.querySelectorAll('[data-del-cost]').forEach(b => b.addEventListener('click', () => onDeleteCost(id, b.dataset.delCost)));
}

function openCostModal(customerId, costId) {
  const r = costId ? store.data.productCosts[costId] : {};
  const printers = Object.values(store.data.printers || {}).filter(p => p.customer_id === customerId);
  const serialOpts = ['<option value="">(전체)</option>'].concat(printers.map(p => `<option value="${escapeHtml(p.serial)}" ${r.serial === p.serial ? 'selected' : ''}>${escapeHtml(p.serial)} ${p.model ? '· ' + escapeHtml(p.model) : ''}</option>`)).join('');
  const html = `
    <h3>${costId ? '✏️ 원가 수정' : '+ 원가 추가'}</h3>
    <form id="cost-form" autocomplete="off">
      <div class="form-row two">
        <label><span>제품명 *</span><input name="product_name" required value="${escapeHtml(r.product_name || '')}"></label>
        <label><span>시리얼</span><select name="serial">${serialOpts}</select></label>
      </div>
      <div class="form-row two">
        <label><span>매입가 *</span><input name="purchase_price" type="number" min="0" required value="${r.purchase_price || ''}"></label>
        <label><span>구매일</span><input name="purchase_date" type="date" value="${r.purchase_date || ''}"></label>
      </div>
      <div class="form-row two">
        <label><span>감가상각 개월수</span><input name="amortization_months" type="number" min="1" value="${r.amortization_months || 36}"></label>
        <label><span>비고</span><input name="notes" value="${escapeHtml(r.notes || '')}"></label>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-close>취소</button>
        <button type="submit" class="btn primary">저장</button>
      </div>
    </form>`;
  showModal(html, { wide: false });
  document.getElementById('cost-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      showLoading('저장 중…');
      await store.upsertProductCost({
        id: costId || undefined,
        customer_id: customerId,
        serial: fd.get('serial') || null,
        product_name: fd.get('product_name'),
        purchase_price: parseInt(fd.get('purchase_price') || 0, 10),
        purchase_date: fd.get('purchase_date') || null,
        amortization_months: parseInt(fd.get('amortization_months') || 36, 10),
        notes: fd.get('notes') || '',
      });
      closeModal();
      renderCustomerTabBody(customerId, store.data.customers[customerId]);
    } catch (err) { alert('저장 실패: ' + (err.message || err)); }
    finally { hideLoading(); }
  });
}

async function onDeleteCost(customerId, costId) {
  const r = store.data.productCosts[costId];
  if (!r) return;
  if (!confirm(`${r.product_name} 원가를 삭제할까요?`)) return;
  try { await store.deleteProductCost(costId); renderCustomerTabBody(customerId, store.data.customers[customerId]); }
  catch (e) { alert('삭제 실패: ' + (e.message || e)); }
}

// ============================================================
// [출장] 탭
// ============================================================
function renderTabVisits(body, id) {
  const items = Object.values(store.data.serviceVisits || {})
    .filter(r => r.customer_id === id)
    .sort((a, b) => (b.visit_date || '').localeCompare(a.visit_date || ''));
  const total = items.reduce((s, r) => s + (r.travel_cost || 0) + (r.labor_cost || 0), 0);

  body.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
      <h4 style="margin:0;">🔧 출장 내역 (${items.length}건)</h4>
      <button class="btn small primary" id="btn-add-visit">+ 출장 추가</button>
    </div>
    <div style="background:#fef3c7; border:1px solid #fde68a; padding:10px 12px; border-radius:6px; margin-bottom:10px; font-size:13px;">
      누적 출장비 + 공임: <strong>${total.toLocaleString()}원</strong>
    </div>
    ${items.length ? `
      <div style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead><tr style="background:#f8fafc;">
            <th style="padding:8px; text-align:center; border-bottom:1px solid var(--border);">방문일</th>
            <th style="padding:8px; text-align:left; border-bottom:1px solid var(--border);">목적</th>
            <th style="padding:8px; text-align:left; border-bottom:1px solid var(--border);">기사</th>
            <th style="padding:8px; text-align:right; border-bottom:1px solid var(--border);">출장비</th>
            <th style="padding:8px; text-align:right; border-bottom:1px solid var(--border);">공임</th>
            <th style="padding:8px; text-align:right; border-bottom:1px solid var(--border);">합계</th>
            <th style="padding:8px; border-bottom:1px solid var(--border);"></th>
          </tr></thead>
          <tbody>
            ${items.map(r => `<tr>
              <td style="padding:6px 8px; text-align:center;">${r.visit_date}</td>
              <td style="padding:6px 8px;">${escapeHtml(r.purpose || '—')}</td>
              <td style="padding:6px 8px;">${escapeHtml(r.technician || '—')}</td>
              <td style="padding:6px 8px; text-align:right;">${(r.travel_cost||0).toLocaleString()}</td>
              <td style="padding:6px 8px; text-align:right;">${(r.labor_cost||0).toLocaleString()}</td>
              <td style="padding:6px 8px; text-align:right;"><strong>${((r.travel_cost||0)+(r.labor_cost||0)).toLocaleString()}</strong></td>
              <td style="padding:6px 8px; text-align:right; white-space:nowrap;">
                <button class="btn small ghost" data-edit-visit="${r.id}">✏️</button>
                <button class="btn small ghost danger" data-del-visit="${r.id}">🗑</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '<div class="muted" style="padding:24px; text-align:center; border:1px dashed var(--border); border-radius:6px;">등록된 출장 내역이 없습니다.</div>'}
  `;
  body.querySelector('#btn-add-visit').addEventListener('click', () => openVisitModal(id, null));
  body.querySelectorAll('[data-edit-visit]').forEach(b => b.addEventListener('click', () => openVisitModal(id, b.dataset.editVisit)));
  body.querySelectorAll('[data-del-visit]').forEach(b => b.addEventListener('click', () => onDeleteVisit(id, b.dataset.delVisit)));
}

function openVisitModal(customerId, visitId) {
  const r = visitId ? store.data.serviceVisits[visitId] : {};
  const todayStr = new Date().toISOString().slice(0, 10);
  const html = `
    <h3>${visitId ? '✏️ 출장 수정' : '+ 출장 추가'}</h3>
    <form id="visit-form" autocomplete="off">
      <div class="form-row two">
        <label><span>방문일 *</span><input name="visit_date" type="date" required value="${r.visit_date || todayStr}"></label>
        <label><span>기사</span><input name="technician" value="${escapeHtml(r.technician || '')}"></label>
      </div>
      <div class="form-row">
        <label><span>목적</span><input name="purpose" placeholder="예: 토너 교체, 드럼 수리" value="${escapeHtml(r.purpose || '')}"></label>
      </div>
      <div class="form-row two">
        <label><span>출장비</span><input name="travel_cost" type="number" min="0" value="${r.travel_cost || 0}"></label>
        <label><span>공임</span><input name="labor_cost" type="number" min="0" value="${r.labor_cost || 0}"></label>
      </div>
      <div class="form-row">
        <label><span>비고</span><textarea name="notes" rows="2">${escapeHtml(r.notes || '')}</textarea></label>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-close>취소</button>
        <button type="submit" class="btn primary">저장</button>
      </div>
    </form>`;
  showModal(html, { wide: false });
  document.getElementById('visit-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      showLoading('저장 중…');
      await store.upsertServiceVisit({
        id: visitId || undefined,
        customer_id: customerId,
        visit_date: fd.get('visit_date'),
        purpose: fd.get('purpose') || '',
        technician: fd.get('technician') || '',
        travel_cost: parseInt(fd.get('travel_cost') || 0, 10),
        labor_cost: parseInt(fd.get('labor_cost') || 0, 10),
        notes: fd.get('notes') || '',
      });
      closeModal();
      renderCustomerTabBody(customerId, store.data.customers[customerId]);
    } catch (err) { alert('저장 실패: ' + (err.message || err)); }
    finally { hideLoading(); }
  });
}

async function onDeleteVisit(customerId, visitId) {
  const r = store.data.serviceVisits[visitId];
  if (!r) return;
  if (!confirm(`${r.visit_date} 출장 내역을 삭제할까요?`)) return;
  try { await store.deleteServiceVisit(visitId); renderCustomerTabBody(customerId, store.data.customers[customerId]); }
  catch (e) { alert('삭제 실패: ' + (e.message || e)); }
}

// ============================================================
// [소모품] 탭
// ============================================================
function renderTabSupplies(body, id) {
  const items = Object.values(store.data.supplies || {})
    .filter(r => r.customer_id === id)
    .sort((a, b) => (b.used_date || '').localeCompare(a.used_date || ''));
  const total = items.reduce((s, r) => s + (r.total_cost || 0), 0);

  body.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
      <h4 style="margin:0;">📦 소모품 사용 (${items.length}건)</h4>
      <button class="btn small primary" id="btn-add-supply">+ 소모품 추가</button>
    </div>
    <div style="background:#dbeafe; border:1px solid #93c5fd; padding:10px 12px; border-radius:6px; margin-bottom:10px; font-size:13px;">
      누적 소모품비: <strong>${total.toLocaleString()}원</strong>
    </div>
    ${items.length ? `
      <div style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead><tr style="background:#f8fafc;">
            <th style="padding:8px; text-align:center; border-bottom:1px solid var(--border);">사용일</th>
            <th style="padding:8px; text-align:left; border-bottom:1px solid var(--border);">소모품</th>
            <th style="padding:8px; text-align:left; border-bottom:1px solid var(--border);">시리얼</th>
            <th style="padding:8px; text-align:center; border-bottom:1px solid var(--border);">수량</th>
            <th style="padding:8px; text-align:right; border-bottom:1px solid var(--border);">단가</th>
            <th style="padding:8px; text-align:right; border-bottom:1px solid var(--border);">합계</th>
            <th style="padding:8px; border-bottom:1px solid var(--border);"></th>
          </tr></thead>
          <tbody>
            ${items.map(r => `<tr>
              <td style="padding:6px 8px; text-align:center;">${r.used_date}</td>
              <td style="padding:6px 8px;">${escapeHtml(r.product_name)}</td>
              <td style="padding:6px 8px;">${escapeHtml(r.serial || '—')}</td>
              <td style="padding:6px 8px; text-align:center;">${r.qty}</td>
              <td style="padding:6px 8px; text-align:right;">${(r.unit_cost||0).toLocaleString()}</td>
              <td style="padding:6px 8px; text-align:right;"><strong>${(r.total_cost||0).toLocaleString()}</strong></td>
              <td style="padding:6px 8px; text-align:right; white-space:nowrap;">
                <button class="btn small ghost" data-edit-supply="${r.id}">✏️</button>
                <button class="btn small ghost danger" data-del-supply="${r.id}">🗑</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '<div class="muted" style="padding:24px; text-align:center; border:1px dashed var(--border); border-radius:6px;">등록된 소모품이 없습니다.</div>'}
  `;
  body.querySelector('#btn-add-supply').addEventListener('click', () => openSupplyModal(id, null));
  body.querySelectorAll('[data-edit-supply]').forEach(b => b.addEventListener('click', () => openSupplyModal(id, b.dataset.editSupply)));
  body.querySelectorAll('[data-del-supply]').forEach(b => b.addEventListener('click', () => onDeleteSupply(id, b.dataset.delSupply)));
}

function openSupplyModal(customerId, supplyId) {
  const r = supplyId ? store.data.supplies[supplyId] : {};
  const printers = Object.values(store.data.printers || {}).filter(p => p.customer_id === customerId);
  const serialOpts = ['<option value="">(전체)</option>'].concat(printers.map(p => `<option value="${escapeHtml(p.serial)}" ${r.serial === p.serial ? 'selected' : ''}>${escapeHtml(p.serial)} ${p.model ? '· ' + escapeHtml(p.model) : ''}</option>`)).join('');
  const todayStr = new Date().toISOString().slice(0, 10);
  const html = `
    <h3>${supplyId ? '✏️ 소모품 수정' : '+ 소모품 추가'}</h3>
    <form id="supply-form" autocomplete="off">
      <div class="form-row two">
        <label><span>사용일 *</span><input name="used_date" type="date" required value="${r.used_date || todayStr}"></label>
        <label><span>시리얼</span><select name="serial">${serialOpts}</select></label>
      </div>
      <div class="form-row">
        <label><span>소모품명 *</span><input name="product_name" required placeholder="예: 교세라 토너 TK-8345" value="${escapeHtml(r.product_name || '')}"></label>
      </div>
      <div class="form-row three">
        <label><span>수량</span><input name="qty" type="number" min="1" value="${r.qty || 1}" id="sup-qty"></label>
        <label><span>단가</span><input name="unit_cost" type="number" min="0" value="${r.unit_cost || 0}" id="sup-unit"></label>
        <label><span>합계 (자동)</span><input name="total_cost" type="number" min="0" value="${r.total_cost || 0}" id="sup-total"></label>
      </div>
      <div class="form-row">
        <label><span>비고</span><input name="notes" value="${escapeHtml(r.notes || '')}"></label>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-close>취소</button>
        <button type="submit" class="btn primary">저장</button>
      </div>
    </form>`;
  showModal(html, { wide: false });
  const recalc = () => {
    const q = parseInt(document.getElementById('sup-qty').value || 0, 10);
    const u = parseInt(document.getElementById('sup-unit').value || 0, 10);
    document.getElementById('sup-total').value = q * u;
  };
  document.getElementById('sup-qty').addEventListener('input', recalc);
  document.getElementById('sup-unit').addEventListener('input', recalc);
  document.getElementById('supply-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      showLoading('저장 중…');
      const qty = parseInt(fd.get('qty') || 1, 10);
      const unit = parseInt(fd.get('unit_cost') || 0, 10);
      await store.upsertSupply({
        id: supplyId || undefined,
        customer_id: customerId,
        serial: fd.get('serial') || null,
        used_date: fd.get('used_date'),
        product_name: fd.get('product_name'),
        qty, unit_cost: unit,
        total_cost: parseInt(fd.get('total_cost') || (qty * unit), 10),
        notes: fd.get('notes') || '',
      });
      closeModal();
      renderCustomerTabBody(customerId, store.data.customers[customerId]);
    } catch (err) { alert('저장 실패: ' + (err.message || err)); }
    finally { hideLoading(); }
  });
}

async function onDeleteSupply(customerId, supplyId) {
  const r = store.data.supplies[supplyId];
  if (!r) return;
  if (!confirm(`${r.used_date} ${r.product_name} 을 삭제할까요?`)) return;
  try { await store.deleteSupply(supplyId); renderCustomerTabBody(customerId, store.data.customers[customerId]); }
  catch (e) { alert('삭제 실패: ' + (e.message || e)); }
}

// ============================================================
// [수익률] 탭 — 자동 계산
// ============================================================
function renderTabProfit(body, id, c) {
  // 임대 시작일 — c.contract_start 우선, 없으면 가장 빠른 계약 contract_date, 없으면 created_at
  let startDate = c.contract_start || c.created_at;
  for (const ct of Object.values(store.data.contracts || {})) {
    if (ct.customer_id === id && ct.contract_date) {
      if (!startDate || ct.contract_date < startDate) startDate = ct.contract_date;
    }
  }
  const start = startDate ? new Date(startDate) : new Date();
  const today = new Date();
  const months = Math.max(1, monthsBetween(start, today));

  // === 매출 ===
  const baseFee = c.base_fee || 0;
  const billings = Object.values(store.data.billings || {}).filter(b => b.customer_id === id);
  const totalExtra = billings.reduce((s, b) => s + (b.total_bw_fee || 0) + (b.total_co_fee || 0), 0);
  const monthlyExtraAvg = months ? totalExtra / months : 0;
  const monthlyRevenue = baseFee + monthlyExtraAvg;

  // === 원가 ===
  const costs = Object.values(store.data.productCosts || {}).filter(r => r.customer_id === id);
  const monthlyAmort = costs.reduce((s, r) => s + (r.amortization_months > 0 ? (r.purchase_price / r.amortization_months) : 0), 0);
  const visits = Object.values(store.data.serviceVisits || {}).filter(r => r.customer_id === id);
  const visitTotal = visits.reduce((s, r) => s + (r.travel_cost||0) + (r.labor_cost||0), 0);
  const monthlyVisit = months ? visitTotal / months : 0;
  const supplies = Object.values(store.data.supplies || {}).filter(r => r.customer_id === id);
  const supplyTotal = supplies.reduce((s, r) => s + (r.total_cost||0), 0);
  const monthlySupply = months ? supplyTotal / months : 0;
  const monthlyCost = monthlyAmort + monthlyVisit + monthlySupply;

  // === 순익 ===
  const monthlyProfit = monthlyRevenue - monthlyCost;
  const profitRate = monthlyRevenue > 0 ? (monthlyProfit / monthlyRevenue * 100) : 0;

  // 누적
  const cumRevenue = monthlyRevenue * months;
  const cumCost    = monthlyCost * months;
  const cumProfit  = cumRevenue - cumCost;

  const fmt = n => Math.round(n).toLocaleString('ko-KR');
  const rateColor = profitRate >= 30 ? '#16a34a' : profitRate >= 10 ? '#ca8a04' : '#dc2626';

  body.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:8px;">
      <h4 style="margin:0;">📊 수익률 대시보드</h4>
      <div class="muted-small">기간: ${startDate ? startDate.slice(0,10) : '?'} ~ 오늘 · <strong>${months}개월</strong></div>
    </div>

    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; margin-bottom:18px;">
      <div style="background:#dbeafe; border:1px solid #93c5fd; padding:12px 14px; border-radius:8px;">
        <div class="muted-small">월 매출</div>
        <div style="font-size:20px; font-weight:700; margin-top:4px;">${fmt(monthlyRevenue)}원</div>
        <div class="muted-small" style="margin-top:4px;">기본료 ${fmt(baseFee)} + 추가카운터 평균 ${fmt(monthlyExtraAvg)}</div>
      </div>
      <div style="background:#fee2e2; border:1px solid #fca5a5; padding:12px 14px; border-radius:8px;">
        <div class="muted-small">월 원가</div>
        <div style="font-size:20px; font-weight:700; margin-top:4px;">${fmt(monthlyCost)}원</div>
        <div class="muted-small" style="margin-top:4px;">감가 ${fmt(monthlyAmort)} + 출장 ${fmt(monthlyVisit)} + 소모품 ${fmt(monthlySupply)}</div>
      </div>
      <div style="background:#f0fdf4; border:1px solid #86efac; padding:12px 14px; border-radius:8px;">
        <div class="muted-small">월 순익</div>
        <div style="font-size:22px; font-weight:800; margin-top:4px; color:${monthlyProfit >= 0 ? '#16a34a' : '#dc2626'};">${fmt(monthlyProfit)}원</div>
      </div>
      <div style="background:#fef3c7; border:1px solid #fcd34d; padding:12px 14px; border-radius:8px;">
        <div class="muted-small">수익률</div>
        <div style="font-size:26px; font-weight:800; margin-top:4px; color:${rateColor};">${profitRate.toFixed(1)}%</div>
      </div>
    </div>

    <div style="background:#f8fafc; border:1px solid var(--border); border-radius:8px; padding:14px 16px;">
      <h4 style="margin:0 0 10px 0;">📅 누적 (${months}개월)</h4>
      <table style="width:100%; font-size:13.5px;">
        <tr><td class="muted">누적 매출</td><td style="text-align:right;"><strong>${fmt(cumRevenue)}원</strong></td></tr>
        <tr><td class="muted">누적 원가</td><td style="text-align:right;">${fmt(cumCost)}원</td></tr>
        <tr style="border-top:1px solid var(--border);"><td class="muted">누적 순익</td><td style="text-align:right; color:${cumProfit>=0?'#16a34a':'#dc2626'};"><strong>${fmt(cumProfit)}원</strong></td></tr>
      </table>
    </div>

    <details style="margin-top:14px;">
      <summary style="cursor:pointer; font-size:12.5px; color:var(--muted);">계산 근거</summary>
      <div style="font-size:12px; padding:10px; background:#f8fafc; border-radius:6px; margin-top:6px;">
        <div>• 추가카운터 평균 = 청구 이력 ${billings.length}건의 (흑+컬 추가료) 합 ÷ ${months}개월</div>
        <div>• 감가상각 = ${costs.length}건 (Σ 매입가 ÷ 감가월수)</div>
        <div>• 출장 평균 = ${visits.length}건 누적 ${fmt(visitTotal)}원 ÷ ${months}개월</div>
        <div>• 소모품 평균 = ${supplies.length}건 누적 ${fmt(supplyTotal)}원 ÷ ${months}개월</div>
      </div>
    </details>
  `;
}

function monthsBetween(d1, d2) {
  return Math.max(1, (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth()) + 1);
}

/** 거래처별 계약서 목록 렌더 (renderCustomerDetail 내부에서 호출). */
function renderCustomerContracts(customerId) {
  const wrap = document.getElementById(`cust-contracts-${customerId}`);
  if (!wrap) return;
  const list = Object.values(store.data.contracts || {})
    .filter(c => c.customer_id === customerId)
    .sort((a, b) => (b.contract_date || '').localeCompare(a.contract_date || ''));

  if (!list.length) {
    wrap.innerHTML = `<div class="muted" style="padding:14px; text-align:center; border:1px dashed var(--border); border-radius:6px;">등록된 계약서가 없습니다. [+ 신규 계약서] 를 눌러 작성하세요.</div>`;
    return;
  }
  wrap.innerHTML = `
    <ul style="list-style:none; margin:0; padding:0;">
      ${list.map(ct => {
        const items = Array.isArray(ct.items) ? ct.items.length : 0;
        return `
          <li style="border:1px solid var(--border); border-radius:6px; padding:8px 12px; margin-bottom:6px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
            <div style="flex:1; min-width:200px;">
              <div style="font-weight:600;">${escapeHtml(ct.contract_date || '날짜 미입력')} · ${escapeHtml(ct.requester || ct.company || '')}</div>
              <div class="muted-small">
                항목 ${items}건 · 월 ${(ct.total_fee || 0).toLocaleString()}원 · 보증금 ${(ct.deposit || 0).toLocaleString()}원
                ${ct.contract_months ? ' · ' + ct.contract_months + '개월' : ''}
              </div>
            </div>
            <button class="btn small ghost" data-open-contract="${escapeHtml(ct.id)}">열기</button>
          </li>`;
      }).join('')}
    </ul>
  `;
  wrap.querySelectorAll('[data-open-contract]').forEach(b =>
    b.addEventListener('click', () => openContractModal(customerId, b.dataset.openContract)));
}

async function loadAndRenderAttachments(customerId) {
  if (!window.attDB) return;
  try {
    const list = await attDB.listByCustomer(customerId);
    const byType = {};
    for (const a of list) byType[a.type] = a;
    document.querySelectorAll(`#att-grid-${customerId} [data-att-type]`).forEach(slot => {
      const type = slot.dataset.attType;
      const att = byType[type];
      const body = slot.querySelector('[data-att-empty], [data-att-filled]');
      if (att) {
        slot.classList.add('filled');
        body.removeAttribute('data-att-empty');
        body.setAttribute('data-att-filled', '');
        body.innerHTML = `<img src="${att.dataUrl}" alt="${escapeHtml(att.name)}">
          <div class="muted-small" style="margin-top:4px;">${escapeHtml(att.name)}</div>`;
        body.style.cursor = 'pointer';
        body.onclick = () => openLightbox(att);
      }
    });
  } catch (e) {
    console.error('첨부 로드 실패', e);
  }
}

function openLightbox(att) {
  const tpl = document.getElementById('tpl-lightbox').content.cloneNode(true);
  showModal(tpl, { wide: true });
  document.getElementById('lb-title').textContent = `${att.type_label || att.type} — ${att.name}`;
  document.getElementById('lb-img').src = att.dataUrl;
  document.getElementById('lb-download').onclick = () => {
    const a = document.createElement('a');
    a.href = att.dataUrl;
    a.download = att.name;
    a.click();
  };
}

// ============================================================
// 거래처 추가/수정 모달
// ============================================================
async function openCustomerModal(id) {
  const tpl = document.getElementById('tpl-cust-modal').content.cloneNode(true);
  showModal(tpl);
  const isEdit = !!id;
  $('#cust-modal-title').textContent = isEdit ? '✏️ 거래처 수정' : '+ 거래처 추가';
  const form = $('#cust-form');
  const targetId = id || uid();

  if (isEdit) {
    const c = store.data.customers[id];
    for (const k of ['company','ceo','biz_no','corp_no','biz_type','biz_item','address','phone','fax','email','kakao','memo']) {
      const inp = form.querySelector(`[name="${k}"]`);
      if (inp) inp.value = c[k] || '';
    }
    // ASMS 연동 표시
    if (c.asms_cu_number) {
      $('#asms-link-info').textContent = `🔗 접수관리툴 ${c.asms_cu_number}`;
      $('#asms-link-info').style.color = 'var(--success)';
    }
  }

  // 모달 내 "접수관리툴에서 가져오기" 버튼
  $('#btn-asms-pick')?.addEventListener('click', () => {
    openAsmsModal({
      pickerMode: true,
      onPick: rec => {
        const data = window.asmsSync.toRental(rec);
        for (const k of Object.keys(data)) {
          const inp = form.querySelector(`[name="${k}"]`);
          if (inp && data[k]) inp.value = data[k];
        }
        // asms_cu_number 는 폼에 없으니 별도 보관 (저장 시 obj에 합쳐짐)
        form.dataset.asmsCuNumber = data.asms_cu_number || '';
        $('#asms-link-info').textContent = `🔗 가져옴: ${rec.cu_name} (${rec.cu_number})`;
        $('#asms-link-info').style.color = 'var(--success)';
      },
    });
  });

  // 첨부 슬롯 4종 생성
  const slotsHost = $('#att-slots');
  const existingByType = {};
  if (isEdit) {
    try {
      const list = await attDB.listByCustomer(id);
      for (const a of list) existingByType[a.type] = a;
    } catch (e) {}
  }
  // 모달 안에서 새로 추가/제거 보류 상태 추적
  const pending = {}; // type -> {action: 'set'|'del', dataUrl, name, size}

  ATTACHMENT_TYPES.forEach(t => {
    const slot = document.createElement('div');
    slot.className = 'att-slot';
    slot.dataset.type = t.key;
    const existing = existingByType[t.key];
    slot.innerHTML = `
      <div class="att-slot-head">
        <span class="att-icon">${t.icon}</span>
        <span class="att-label">${t.label}</span>
        <button type="button" class="att-clear" title="제거" style="margin-left:auto;display:${existing ? 'inline-block' : 'none'};">✕</button>
      </div>
      <label class="att-drop">
        <div class="att-drop-inner">
          ${existing
            ? `<img src="${existing.dataUrl}" alt=""><div class="muted-small">${escapeHtml(existing.name)}</div>`
            : `<div class="muted-small">📥 클릭 / 드래그</div>`}
        </div>
        <input type="file" accept="image/*" hidden>
      </label>
    `;
    const drop = slot.querySelector('.att-drop');
    const fileInp = slot.querySelector('input[type=file]');
    const inner = slot.querySelector('.att-drop-inner');
    const clearBtn = slot.querySelector('.att-clear');

    fileInp.addEventListener('change', () => {
      if (fileInp.files.length) handleSlotFile(fileInp.files[0]);
    });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.classList.remove('drag-over');
      if (e.dataTransfer.files.length) handleSlotFile(e.dataTransfer.files[0]);
    });
    clearBtn.addEventListener('click', e => {
      e.preventDefault();
      pending[t.key] = { action: 'del' };
      inner.innerHTML = `<div class="muted-small">📥 클릭 / 드래그</div>`;
      clearBtn.style.display = 'none';
    });

    function handleSlotFile(file) {
      if (!file.type.startsWith('image/')) { alert('이미지 파일만'); return; }
      const reader = new FileReader();
      reader.onload = ev => {
        const dataUrl = ev.target.result;
        pending[t.key] = { action: 'set', dataUrl, name: file.name, size: file.size };
        inner.innerHTML = `<img src="${dataUrl}" alt=""><div class="muted-small">${escapeHtml(file.name)}</div>`;
        clearBtn.style.display = 'inline-block';
      };
      reader.readAsDataURL(file);
    }

    slotsHost.appendChild(slot);
  });

  $('#cust-save').addEventListener('click', async () => {
    const fd = new FormData(form);
    const company = (fd.get('company') || '').toString().trim();
    if (!company) { alert('상호 필수'); return; }
    const obj = {
      id: targetId,
      company,
      ceo: (fd.get('ceo') || '').toString().trim(),
      biz_no: (fd.get('biz_no') || '').toString().trim(),
      corp_no: (fd.get('corp_no') || '').toString().trim(),
      biz_type: (fd.get('biz_type') || '').toString().trim(),
      biz_item: (fd.get('biz_item') || '').toString().trim(),
      address: (fd.get('address') || '').toString().trim(),
      phone: (fd.get('phone') || '').toString().trim(),
      fax: (fd.get('fax') || '').toString().trim(),
      email: (fd.get('email') || '').toString().trim(),
      kakao: (fd.get('kakao') || '').toString().trim(),
      memo: (fd.get('memo') || '').toString(),
    };
    // ASMS 연동 식별자 보존 (가져오기 한 경우 새로 설정)
    const newAsmsCu = form.dataset.asmsCuNumber || (isEdit ? store.data.customers[id]?.asms_cu_number : '');
    if (newAsmsCu) obj.asms_cu_number = newAsmsCu;

    let saved;
    if (isEdit) {
      const merged = { ...store.data.customers[id], ...obj };
      saved = await store.upsertCustomer(merged);
    } else {
      obj.serials = [];
      obj.base_fee = 0;
      obj.bw_free = 0; obj.bw_rate = 0;
      obj.co_free = 0; obj.co_rate = 0;
      saved = await store.upsertCustomer(obj);
      state.selectedId = saved.id;
    }

    // 첨부 IndexedDB에 반영
    for (const [type, p] of Object.entries(pending)) {
      const attId = `${targetId}__${type}`;
      if (p.action === 'del') {
        await attDB.del(attId);
      } else if (p.action === 'set') {
        const t = ATTACHMENT_TYPES.find(x => x.key === type);
        await attDB.put({
          id: attId,
          customer_id: targetId,
          type,
          type_label: t ? t.label : type,
          name: p.name,
          size: p.size,
          dataUrl: p.dataUrl,
          uploaded_at: nowIso(),
        });
      }
    }

    closeModal();
    renderCustomerList();
    renderCustomerDetail(state.selectedId);
  });
}

async function deleteCustomer(id) {
  const c = store.data.customers[id];
  if (!c) return;
  if (!confirm(`'${c.company}' 거래처를 삭제할까요?\n첨부 이미지(사업자/명함/신분증/통장사본)도 함께 영구 삭제됩니다.`)) return;
  try {
    await store.deleteCustomer(id);
  } catch (err) {
    alert('삭제 실패: ' + (err.message || err));
    return;
  }
  // IndexedDB의 첨부도 삭제 (Phase 3에서 Supabase Storage로 이전 예정)
  if (window.attDB) {
    try { await attDB.delByCustomer(id); } catch (e) { console.error(e); }
  }
  if (state.selectedId === id) state.selectedId = null;
  renderCustomerList();
  renderCustomerDetail(null);
}

// ============================================================
// 명함 / 사업자등록증 OCR
// ============================================================
function openOcrModal() {
  const tpl = document.getElementById('tpl-ocr-modal').content.cloneNode(true);
  showModal(tpl);

  const drop = $('#ocr-drop');
  const fileInp = $('#ocr-file');
  const preview = $('#ocr-preview');
  const result = $('#ocr-result');
  const status = $('#ocr-status');
  const saveBtn = $('#ocr-save');
  let attachedDataUrl = null;
  let attachedName = '';

  drop.addEventListener('click', () => fileInp.click());
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('drag-over');
    if (e.dataTransfer.files.length) handleImage(e.dataTransfer.files[0]);
  });
  fileInp.addEventListener('change', () => {
    if (fileInp.files.length) handleImage(fileInp.files[0]);
  });

  async function handleImage(file) {
    if (!file.type.startsWith('image/')) { alert('이미지 파일만'); return; }
    attachedName = file.name;
    const reader = new FileReader();
    reader.onload = e => {
      attachedDataUrl = e.target.result;
      preview.innerHTML = `<img src="${attachedDataUrl}" alt="preview">`;
      result.classList.remove('hidden');
      status.textContent = '🔍 분석 중… (실제 OCR 연동은 다음 단계, 현재는 빈 양식)';
      // 실제 OCR은 다음 단계: Tesseract.js 또는 외부 API 연동.
      // 지금은 사용자가 보고 직접 입력. 자주 등장하는 패턴 정도만 추출 시도.
      tryGuessFromFilename(file.name);
      saveBtn.disabled = false;
    };
    reader.readAsDataURL(file);
  }

  function tryGuessFromFilename(name) {
    // 파일명에서 단서 추출 (예: '두일전기_명함.jpg' → 상호 추측)
    const stem = name.replace(/\.[^.]+$/, '').replace(/[_\-\s]+/g, ' ');
    const m = stem.match(/([가-힣A-Za-z0-9&]+)/);
    if (m) {
      const inp = $('#ocr-form [name="company"]');
      if (inp && !inp.value) inp.value = m[1];
    }
  }

  saveBtn.addEventListener('click', async () => {
    const form = $('#ocr-form');
    const fd = new FormData(form);
    const company = (fd.get('company') || '').toString().trim();
    if (!company) { alert('상호 필수'); return; }
    const obj = {
      id: uid(),
      company,
      ceo: (fd.get('ceo') || '').toString().trim(),
      biz_no: (fd.get('biz_no') || '').toString().trim(),
      corp_no: (fd.get('corp_no') || '').toString().trim(),
      biz_type: (fd.get('biz_type') || '').toString().trim(),
      biz_item: (fd.get('biz_item') || '').toString().trim(),
      address: (fd.get('address') || '').toString().trim(),
      phone: (fd.get('phone') || '').toString().trim(),
      fax: (fd.get('fax') || '').toString().trim(),
      email: (fd.get('email') || '').toString().trim(),
      kakao: (fd.get('kakao') || '').toString().trim(),
      memo: (fd.get('memo') || '').toString(),
      serials: [], attachments: [],
      base_fee: 0, bw_free: 0, bw_rate: 0, co_free: 0, co_rate: 0,
      contract_start: '', contract_end: '', contract_file: '',
      created_at: nowIso(), updated_at: nowIso(),
    };
    delete obj.attachments;
    const savedC = await store.upsertCustomer(obj);
    state.selectedId = savedC.id;
    // OCR로 올린 이미지를 명함 슬롯에 자동 저장
    if (attachedDataUrl) {
      const t = ATTACHMENT_TYPES.find(x => x.key === 'business_card');
      try {
        await attDB.put({
          id: `${obj.id}__business_card`,
          customer_id: obj.id,
          type: 'business_card',
          type_label: t.label,
          name: attachedName || 'business_card.png',
          size: 0,
          dataUrl: attachedDataUrl,
          uploaded_at: nowIso(),
        });
      } catch (e) { console.error(e); }
    }
    closeModal();
    renderCustomerList();
    renderCustomerDetail(obj.id);
  });
}

// ============================================================
// 내보내기 / NAS 백업
// ============================================================
function exportCustomers() {
  const blob = new Blob([JSON.stringify(store.data.customers, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const today = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `거래처_${today}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================================
// ASMS 연동 모달 (로그인 → 검색 → 가져오기)
// ============================================================
async function openAsmsModal(opts = {}) {
  if (!window.asmsSync) { alert('ASMS 연동 모듈이 로드되지 않았습니다 (인터넷 연결 확인)'); return; }
  const tpl = document.getElementById('tpl-asms-modal').content.cloneNode(true);
  showModal(tpl);

  const loginArea = $('#asms-login-area');
  const searchArea = $('#asms-search-area');
  const loginBtn = $('#asms-login-btn');
  const logoutBtn = $('#asms-logout-btn');
  const msg = $('#asms-login-msg');

  async function refreshState() {
    const user = await window.asmsSync.currentUser();
    if (user) {
      loginArea.classList.add('hidden');
      searchArea.classList.remove('hidden');
      loginBtn.style.display = 'none';
      $('#asms-user-label').textContent = `로그인됨: ${user.email || ''}`;
      // 검색 페이지면 자동으로 빈 검색 (최근 5,310 중 첫 50건)
      if (opts.pickerMode || true) doSearch('');
    } else {
      loginArea.classList.remove('hidden');
      searchArea.classList.add('hidden');
      loginBtn.style.display = '';
    }
  }
  await refreshState();

  loginBtn.addEventListener('click', async () => {
    const email = $('#asms-email').value.trim();
    const password = $('#asms-password').value;
    if (!email || !password) { msg.textContent = '이메일/비밀번호를 입력하세요'; return; }
    msg.textContent = '로그인 중…';
    try {
      await window.asmsSync.login(email, password);
      msg.textContent = '';
      await refreshState();
      refreshAsmsStatus();
    } catch (e) {
      msg.textContent = '로그인 실패: ' + (e.message || e);
    }
  });

  logoutBtn.addEventListener('click', async () => {
    await window.asmsSync.logout();
    refreshAsmsStatus();
    closeModal();
    alert('ASMS에서 로그아웃되었습니다');
  });

  let searchTimer = null;
  $('#asms-keyword').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(e.target.value), 300);
  });

  async function doSearch(kw) {
    const target = $('#asms-results');
    target.innerHTML = '<div class="muted-small" style="text-align:center; padding:20px;">검색 중…</div>';
    try {
      const rows = await window.asmsSync.search(kw, 50);
      if (!rows.length) {
        target.innerHTML = '<div class="muted-small" style="text-align:center; padding:20px;">검색 결과 없음</div>';
        return;
      }
      target.innerHTML = rows.map(r => `
        <div class="asms-row" data-cu="${escapeHtml(r.cu_number)}">
          <div class="asms-row-name">
            <strong>${escapeHtml(r.cu_name || '(이름 없음)')}</strong>
            <span class="muted-small">${escapeHtml(r.cu_number)}</span>
          </div>
          <div class="muted-small asms-row-meta">
            ${r.cu_tel ? '📞 ' + escapeHtml(r.cu_tel) + ' ' : ''}
            ${r.cu_mobile ? '📱 ' + escapeHtml(r.cu_mobile) + ' ' : ''}
            ${r.zipcode1 ? '📍 ' + escapeHtml(r.zipcode1) : ''}
          </div>
          ${r.cu_kind ? `<div class="muted-small">임대제품: ${escapeHtml(r.cu_kind)}</div>` : ''}
          <button class="btn primary small asms-pick-btn" data-cu="${escapeHtml(r.cu_number)}">${opts.pickerMode ? '✓ 이 고객으로' : '↗ 가져오기'}</button>
        </div>
      `).join('');
      target.querySelectorAll('.asms-pick-btn').forEach(b => {
        b.addEventListener('click', e => {
          e.stopPropagation();
          const cu = b.dataset.cu;
          const rec = rows.find(r => r.cu_number === cu);
          if (!rec) return;
          if (opts.pickerMode && opts.onPick) {
            opts.onPick(rec);
            closeModal();
          } else {
            // pickerMode 가 아닐 때: 신규 거래처로 즉시 등록
            importAsmsAsNewCustomer(rec);
          }
        });
      });
    } catch (e) {
      target.innerHTML = `<div style="color:var(--danger); padding:20px; text-align:center;">검색 실패: ${escapeHtml(e.message || String(e))}</div>`;
    }
  }
}

async function importAsmsAsNewCustomer(rec) {
  const data = window.asmsSync.toRental(rec);
  // 동일 cu_number 거래처 있는지 확인
  const dup = Object.values(store.data.customers).find(c => c.asms_cu_number === rec.cu_number);
  if (dup) {
    if (!confirm(`이미 등록된 고객입니다 (${dup.company}). 그래도 추가로 가져올까요?`)) return;
  }
  const newCust = {
    id: uid(),
    ...data,
    serials: [],
    base_fee: 0, bw_free: 0, bw_rate: 0, co_free: 0, co_rate: 0,
  };
  const saved = await store.upsertCustomer(newCust);
  state.selectedId = saved.id;
  closeModal();
  renderCustomerList();
  renderCustomerDetail(saved.id);
}

// NAS 백업: 거래처 메타 + 첨부 이미지를 거래처 폴더로 묶은 zip
async function exportNasBackup() {
  if (typeof JSZip === 'undefined') { alert('JSZip 로드 실패. 인터넷 연결 확인 또는 새로고침'); return; }
  const customers = Object.values(store.data.customers || {});
  if (customers.length === 0) { alert('등록된 거래처가 없습니다'); return; }

  const btn = $('#btn-nas-backup');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '🗄 백업 중…';

  try {
    const zip = new JSZip();
    const today = new Date().toISOString().slice(0, 10);
    const root = zip.folder(`임대고객관리_${today}`);

    // 거래처 마스터 JSON
    root.file('_거래처목록.json', JSON.stringify(customers, null, 2));

    // 모든 첨부 한 번에 가져오기
    const allAtts = await attDB.all();
    const byCust = {};
    for (const a of allAtts) {
      (byCust[a.customer_id] = byCust[a.customer_id] || []).push(a);
    }

    let attCount = 0;
    for (const c of customers) {
      const safeName = (c.company || '거래처').replace(/[\\/:*?"<>|]/g, '_');
      const folder = root.folder(safeName);
      // 거래처 정보 텍스트
      const info = [
        `상호: ${c.company || ''}`,
        `대표자: ${c.ceo || ''}`,
        `사업자등록번호: ${c.biz_no || ''}`,
        `법인등록번호: ${c.corp_no || ''}`,
        `업태: ${c.biz_type || ''}`,
        `종목: ${c.biz_item || ''}`,
        `주소: ${c.address || ''}`,
        `연락처: ${c.phone || ''}`,
        `팩스: ${c.fax || ''}`,
        `이메일: ${c.email || ''}`,
        `카카오톡: ${c.kakao || ''}`,
        ``,
        `메모:`,
        c.memo || '',
        ``,
        `등록일: ${c.created_at || ''}`,
        `수정일: ${c.updated_at || ''}`,
      ].join('\n');
      folder.file('정보.txt', info);

      // 첨부 이미지
      const atts = byCust[c.id] || [];
      for (const a of atts) {
        const ext = (a.name && a.name.match(/\.([a-z0-9]+)$/i)?.[1]) || 'png';
        const fname = `${a.type_label || a.type}.${ext}`;
        const blob = await (await fetch(a.dataUrl)).blob();
        folder.file(fname, blob);
        attCount++;
      }
    }

    const blob = await zip.generateAsync({ type: 'blob' }, meta => {
      btn.textContent = `🗄 압축 ${meta.percent.toFixed(0)}%`;
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `임대고객관리_${today}.zip`;
    a.click();
    URL.revokeObjectURL(url);

    setTimeout(() => alert(
      `백업 완료\n· 거래처: ${customers.length}곳\n· 첨부 이미지: ${attCount}개\n\n다운로드한 zip을 NAS의 \\\\nas\\업무공용\\임대고객관리\\ 폴더에 풀어 보관하세요.\n보안을 위해 다운로드 폴더의 zip은 옮긴 후 삭제 권장.`
    ), 200);
  } catch (e) {
    console.error(e);
    alert('백업 실패: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// ============================================================
// 시드 데이터 가져오기 (한별시스템 임대현황 + NAS 카운터)
// ============================================================
function normalizeName(s) {
  if (!s) return '';
  return String(s).replace(/[\s()\-_/\.,\n]+/g, '').toLowerCase();
}

async function refreshFromSupabase() {
  const btn = $('#btn-seed');
  if (!btn) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '🔄 새로고침 중…';
  try {
    await store.load();
    renderCustomerList();
    if (state.selectedId && store.data.customers[state.selectedId]) {
      renderCustomerDetail(state.selectedId);
    }
    btn.textContent = '✅ 완료';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1200);
  } catch (e) {
    alert('새로고침 실패: ' + (e.message || e));
    btn.textContent = orig;
    btn.disabled = false;
  }
}

