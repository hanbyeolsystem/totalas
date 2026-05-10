// 한별시스템 임대관리 — 공통 앱 로직
'use strict';

// ============================================================
// STORAGE
// ============================================================
const STORAGE_KEY = 'rental_mgmt_v1';

const store = {
  data: null,
  load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try { this.data = JSON.parse(raw); }
      catch (e) { this.data = null; }
    }
    if (!this.data) {
      this.data = { customers: {}, printers: {}, contracts: {}, counters: {}, meta: {} };
      this.save();
    }
    // 안전장치
    this.data.customers = this.data.customers || {};
    this.data.printers  = this.data.printers  || {};
    this.data.contracts = this.data.contracts || {};
    this.data.counters  = this.data.counters  || {};
    return this.data;
  },
  save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data)); },
};

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
// 거래처 관리 페이지 부트
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  store.load();
  // 거래처 페이지 전용 바인딩
  if (document.querySelector('.customers-page')) {
    bindCustomerPage();
    renderCustomerList();
    // 첫 거래처 자동 선택
    const first = Object.values(store.data.customers).sort((a,b) => a.company.localeCompare(b.company, 'ko'))[0];
    if (first) selectCustomer(first.id);
  }
});

let state = { selectedId: null, search: '', sort: 'name' };

function bindCustomerPage() {
  $('#btn-add').addEventListener('click', () => openCustomerModal(null));
  $('#btn-ocr').addEventListener('click', openOcrModal);
  $('#btn-export').addEventListener('click', exportCustomers);
  $('#btn-nas-backup')?.addEventListener('click', exportNasBackup);
  $('#btn-seed')?.addEventListener('click', importSeedData);
  $('#btn-asms-link')?.addEventListener('click', () => openAsmsModal({ pickerMode: false }));

  $('#cust-search').addEventListener('input', e => {
    state.search = e.target.value.toLowerCase().trim();
    renderCustomerList();
  });
  $('#cust-sort').addEventListener('change', e => {
    state.sort = e.target.value;
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

  cnt.textContent = `${customers.length}곳`;

  if (customers.length === 0) {
    ul.innerHTML = `<li class="cust-list-empty muted">${state.search ? '검색 결과 없음' : '등록된 거래처 없음. 우측 상단에서 추가하세요.'}</li>`;
    return;
  }

  ul.innerHTML = customers.map(c => `
    <li class="cust-item ${state.selectedId === c.id ? 'selected' : ''}" data-id="${c.id}">
      <div class="cust-item-name">${escapeHtml(c.company)}</div>
      <div class="cust-item-meta">
        ${c.ceo ? `<span>${escapeHtml(c.ceo)}</span>` : ''}
        ${(c.serials?.length) ? `<span class="badge">🖨 ${c.serials.length}대</span>` : ''}
      </div>
    </li>
  `).join('');

  ul.querySelectorAll('.cust-item').forEach(li => {
    li.addEventListener('click', () => selectCustomer(li.dataset.id));
  });
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
  const c = store.data.customers[id];
  const wrap = $('#cust-detail');
  if (!c) {
    wrap.innerHTML = `<div class="cust-empty"><div class="cust-empty-icon">👈</div><div class="cust-empty-title">거래처를 선택하거나</div><div class="cust-empty-sub muted">우측 상단에서 새 거래처 추가</div></div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="cust-detail-head">
      <div>
        <h2>${escapeHtml(c.company)}</h2>
        <div class="muted" style="font-size:12px;margin-top:2px;">
          ${c.ceo ? '대표 ' + escapeHtml(c.ceo) + ' · ' : ''}
          등록 ${fmtDate(c.created_at)}
        </div>
      </div>
      <div class="cust-detail-actions">
        <button class="btn ghost small" data-edit="${c.id}">✏️ 수정</button>
        <button class="btn ghost small danger" data-del="${c.id}">🗑 삭제</button>
      </div>
    </div>

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
          ? '<div class="muted" style="padding:10px 0;">연결된 프린터 없음. [카운터] 탭에서 매칭하세요.</div>'
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

      <section class="info-card">
        <h4>계약</h4>
        <dl class="info-list">
          <dt>계약 시작</dt><dd>${fmtDate(c.contract_start) || '—'}</dd>
          <dt>계약 만료</dt><dd>${fmtDate(c.contract_end) || '—'}</dd>
          <dt>계약서</dt><dd>${c.contract_file ? '📎 ' + escapeHtml(c.contract_file) : '<span class="muted">미등록</span>'}</dd>
        </dl>
      </section>

      <section class="info-card span-2">
        <h4>첨부 서류 (이미지)</h4>
        <div class="att-grid" id="att-grid-${escapeHtml(id)}">
          ${ATTACHMENT_TYPES.map(t => `
            <div class="att-slot-view" data-att-type="${t.key}">
              <div class="att-slot-head">
                <span class="att-icon">${t.icon}</span>
                <span class="att-label">${t.label}</span>
              </div>
              <div class="att-slot-body" data-att-empty>
                <div class="muted-small">미등록</div>
              </div>
            </div>
          `).join('')}
        </div>
        <div style="margin-top:14px;">
          <strong style="font-size:12px;color:var(--muted);">메모</strong>
          <div style="white-space:pre-wrap;font-size:13px;margin-top:4px;">${escapeHtml(c.memo || '—')}</div>
        </div>
      </section>
    </div>
  `;

  wrap.querySelector('[data-edit]')?.addEventListener('click', () => openCustomerModal(id));
  wrap.querySelector('[data-del]')?.addEventListener('click', () => deleteCustomer(id));

  // 첨부 비동기 로드
  loadAndRenderAttachments(id);
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

    if (isEdit) {
      Object.assign(store.data.customers[id], obj);
      store.data.customers[id].updated_at = nowIso();
    } else {
      obj.serials = [];
      obj.base_fee = 0;
      obj.bw_free = 0; obj.bw_rate = 0;
      obj.co_free = 0; obj.co_rate = 0;
      obj.contract_start = ''; obj.contract_end = '';
      obj.contract_file = '';
      obj.created_at = nowIso();
      obj.updated_at = nowIso();
      store.data.customers[obj.id] = obj;
      state.selectedId = obj.id;
    }
    store.save();

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
  delete store.data.customers[id];
  store.save();
  // IndexedDB의 첨부도 삭제
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
    store.data.customers[obj.id] = obj;
    store.save();
    state.selectedId = obj.id;
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
  const id = uid();
  store.data.customers[id] = {
    id,
    ...data,
    serials: [],
    base_fee: 0, bw_free: 0, bw_rate: 0, co_free: 0, co_rate: 0,
    contract_start: '', contract_end: '', contract_file: '',
    created_at: nowIso(), updated_at: nowIso(),
  };
  store.save();
  state.selectedId = id;
  closeModal();
  renderCustomerList();
  renderCustomerDetail(id);
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

function importSeedData() {
  const seed = window.RENTAL_SEED;
  if (!seed) {
    alert('seed-data.js가 로드되지 않았습니다.\ntools/build_seed.py 실행 후 다시 시도하세요.');
    return;
  }

  const meta = seed.meta || {};
  const counts = meta.counts || {};
  const cur = store.data;
  const curCustCount = Object.keys(cur.customers || {}).length;
  const curPrintCount = Object.keys(cur.printers || {}).length;
  const curCntCount = Object.keys(cur.counters || {}).length;

  const html = `
    <h3>🌱 시드 데이터 가져오기</h3>
    <p class="muted" style="margin:0 0 14px 0; font-size:13px;">
      한별시스템 임대현황 마스터 + NAS 월별카운터에서 추출한 데이터를 가져옵니다.
    </p>
    <div class="seed-summary">
      <div class="seed-row"><span>📅 시드 빌드일</span><strong>${escapeHtml(meta.seed_built_at || '-')}</strong></div>
      <div class="seed-row"><span>👥 거래처</span><strong>${counts.customers || 0}곳</strong></div>
      <div class="seed-row"><span>🖨 시리얼</span><strong>${counts.printers || 0}대 <span class="muted-small">(매칭 ${counts.matched_serials || 0})</span></strong></div>
      <div class="seed-row"><span>📊 카운터</span><strong>${counts.counters_periods || 0}개월</strong></div>
    </div>
    <div class="seed-current muted-small" style="margin:10px 0; padding:8px 10px; background:#f7f8fa; border-radius:6px;">
      현재 보관 중: 거래처 ${curCustCount}곳 · 시리얼 ${curPrintCount}대 · 카운터 ${curCntCount}개월
    </div>
    <fieldset style="border:1px solid #e1e5ec; border-radius:6px; padding:10px 14px; margin:8px 0 14px;">
      <legend style="padding:0 6px; font-weight:600; font-size:13px;">병합 모드</legend>
      <label style="display:block; padding:4px 0;">
        <input type="radio" name="seed-mode" value="merge" checked>
        <strong>스마트 병합</strong> <span class="muted-small">(권장 / 회사명 동일 시 유지, 시리얼은 추가)</span>
      </label>
      <label style="display:block; padding:4px 0;">
        <input type="radio" name="seed-mode" value="replace">
        <strong>전체 교체</strong> <span class="muted-small" style="color:var(--danger);">(현재 거래처/카운터 모두 삭제 후 시드로 교체)</span>
      </label>
    </fieldset>
    <div class="modal-actions">
      <button class="btn ghost" data-close>취소</button>
      <button class="btn primary" id="seed-go">가져오기</button>
    </div>
  `;
  showModal(html);

  $('#seed-go').addEventListener('click', () => {
    const mode = document.querySelector('input[name="seed-mode"]:checked')?.value || 'merge';
    const result = applySeed(seed, mode);
    closeModal();
    alert(
      `✅ 시드 가져오기 완료 (${mode === 'replace' ? '전체 교체' : '스마트 병합'})\n` +
      `· 거래처 추가: ${result.addedCust}곳 / 갱신: ${result.updatedCust}곳 / 스킵: ${result.skippedCust}곳\n` +
      `· 시리얼 추가: ${result.addedPrint}대 / 갱신: ${result.updatedPrint}대\n` +
      `· 카운터 월: ${result.addedCnt}개월\n\n` +
      `📁 추출된 데이터에 OCR 첨부, 사업자번호, 대표자, 이메일은 빠져있습니다 — 거래처별로 보강해 주세요.`
    );
    renderCustomerList();
  });
}

function applySeed(seed, mode) {
  const result = { addedCust: 0, updatedCust: 0, skippedCust: 0, addedPrint: 0, updatedPrint: 0, addedCnt: 0 };
  const data = store.data;

  if (mode === 'replace') {
    data.customers = {};
    data.printers = {};
    data.counters = {};
  }

  // 회사명 인덱스
  const idxByName = {};
  for (const [id, c] of Object.entries(data.customers)) {
    idxByName[normalizeName(c.company)] = id;
  }

  // 1) 거래처
  for (const [seedId, sc] of Object.entries(seed.customers || {})) {
    const norm = normalizeName(sc.company);
    const existId = idxByName[norm];
    if (existId && mode !== 'replace') {
      // 갱신: 빈 필드 보강 + 시리얼 추가
      const ex = data.customers[existId];
      let touched = false;
      const fillFields = ['address', 'phone', 'memo', 'base_fee', 'bw_free', 'bw_rate', 'co_free', 'co_rate'];
      for (const k of fillFields) {
        if ((!ex[k] || ex[k] === 0) && sc[k]) { ex[k] = sc[k]; touched = true; }
      }
      // 시리얼 머지
      ex.serials = ex.serials || [];
      for (const s of (sc.serials || [])) {
        if (!ex.serials.includes(s)) { ex.serials.push(s); touched = true; }
      }
      if (touched) { ex.updated_at = nowIso(); result.updatedCust++; }
      else result.skippedCust++;
    } else {
      // 새로 추가
      const cleanCust = { ...sc };
      delete cleanCust._extra_charge_raw;
      data.customers[seedId] = cleanCust;
      idxByName[norm] = seedId;
      result.addedCust++;
    }
  }

  // 2) 프린터 (시리얼 마스터)
  for (const [serial, sp] of Object.entries(seed.printers || {})) {
    const matchedCid = sp.matched_customer_id && data.customers[sp.matched_customer_id]
      ? sp.matched_customer_id
      : null;
    if (data.printers[serial]) {
      const ex = data.printers[serial];
      if (!ex.model && sp.model) ex.model = sp.model;
      if (!ex.group && sp.group) ex.group = sp.group;
      if (!ex.asset_name && sp.asset_name) ex.asset_name = sp.asset_name;
      if (!ex.matched_customer_id && matchedCid) ex.matched_customer_id = matchedCid;
      result.updatedPrint++;
    } else {
      data.printers[serial] = {
        serial,
        model: sp.model || '',
        group: sp.group || '',
        asset_name: sp.asset_name || '',
        matched_customer_id: matchedCid,
      };
      result.addedPrint++;
    }
    // 매칭된 거래처에 시리얼 자동 등록
    if (matchedCid) {
      const cust = data.customers[matchedCid];
      cust.serials = cust.serials || [];
      if (!cust.serials.includes(serial)) cust.serials.push(serial);
    }
  }

  // 3) 카운터 (월별)
  for (const [period, rows] of Object.entries(seed.counters || {})) {
    if (!data.counters[period] || mode === 'replace') {
      data.counters[period] = rows;
      result.addedCnt++;
    } else {
      const cur = data.counters[period];
      let added = false;
      for (const [s, info] of Object.entries(rows)) {
        if (!cur[s]) { cur[s] = info; added = true; }
      }
      if (added) result.addedCnt++;
    }
  }

  // 메타 갱신
  data.meta = data.meta || {};
  data.meta.seed_imported_at = nowIso();
  data.meta.seed_source = seed.meta || {};

  store.save();
  return result;
}
