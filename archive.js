// 한별시스템 임대관리 — 고객자료실
'use strict';

const archiveState = {
  selectedCustId: null,
  selectedCategory: 'all',
  search: '',
};

window.addEventListener('DOMContentLoaded', () => {
  if (!document.querySelector('.archive-page')) return;
  store.load();
  initArchivePage();
});

function initArchivePage() {
  document.getElementById('btn-add-file').addEventListener('click', () => openFileModal(null));
  document.getElementById('archive-search').addEventListener('input', e => {
    archiveState.search = e.target.value.toLowerCase().trim();
    renderCustomerList();
  });
  renderCustomerList();
  // 첫 거래처 자동 선택
  const first = Object.values(store.data.customers || {}).sort((a, b) => (a.company || '').localeCompare(b.company || '', 'ko'))[0];
  if (first) selectCustomer(first.id);
}

function customerOptions(selected) {
  const customers = Object.values(store.data.customers || {})
    .sort((a, b) => (a.company || '').localeCompare(b.company || '', 'ko'));
  return ['<option value="">— 거래처 선택 —</option>']
    .concat(customers.map(c => `<option value="${escapeHtml(c.id)}"${c.id === selected ? ' selected' : ''}>${escapeHtml(c.company)}</option>`))
    .join('');
}

function categoryOptions(selected) {
  return ARCHIVE_CATEGORIES.map(c =>
    `<option value="${c.key}"${c.key === selected ? ' selected' : ''}>${c.icon} ${c.label}</option>`
  ).join('');
}

// ============================================================
// 좌측: 거래처 목록 (자료 개수 포함)
// ============================================================
async function renderCustomerList() {
  const ul = document.getElementById('archive-cust-list');
  const cnt = document.getElementById('archive-cust-count');

  // 모든 자료 조회 → 거래처별 개수
  const all = await blobDB.allByKind('customer_file');
  const countByCust = {};
  for (const f of all) {
    countByCust[f.customer_id] = (countByCust[f.customer_id] || 0) + 1;
  }

  let customers = Object.values(store.data.customers || {});
  if (archiveState.search) {
    const f = archiveState.search;
    customers = customers.filter(c => (c.company || '').toLowerCase().includes(f) || (c.ceo || '').toLowerCase().includes(f));
  }
  customers.sort((a, b) => (a.company || '').localeCompare(b.company || '', 'ko'));
  cnt.textContent = `${customers.length}곳`;

  if (customers.length === 0) {
    ul.innerHTML = `<li class="cust-list-empty muted">${archiveState.search ? '검색 결과 없음' : '거래처를 먼저 등록하세요'}</li>`;
    return;
  }

  ul.innerHTML = customers.map(c => `
    <li class="cust-item ${archiveState.selectedCustId === c.id ? 'selected' : ''}" data-id="${c.id}">
      <div class="cust-item-name">${escapeHtml(c.company)}</div>
      <div class="cust-item-meta">
        ${c.ceo ? `<span>${escapeHtml(c.ceo)}</span>` : ''}
        ${countByCust[c.id] ? `<span class="badge">📁 ${countByCust[c.id]}</span>` : '<span class="muted-small">자료 없음</span>'}
      </div>
    </li>
  `).join('');

  ul.querySelectorAll('.cust-item').forEach(li => {
    li.addEventListener('click', () => selectCustomer(li.dataset.id));
  });
}

function selectCustomer(id) {
  archiveState.selectedCustId = id;
  archiveState.selectedCategory = 'all';
  renderCustomerList();
  renderDetail();
}

// ============================================================
// 우측: 거래처 상세 (카테고리 탭 + 자료 목록)
// ============================================================
async function renderDetail() {
  const wrap = document.getElementById('archive-detail');
  const id = archiveState.selectedCustId;
  if (!id) {
    wrap.innerHTML = `<div class="cust-empty"><div class="cust-empty-icon">📁</div><div class="cust-empty-title">거래처 선택 안 됨</div></div>`;
    return;
  }
  const c = store.data.customers[id];
  if (!c) return;

  const files = (await blobDB.listByCustomer(id)).filter(f => f.kind === 'customer_file');
  const countByCat = {};
  for (const f of files) {
    countByCat[f.category] = (countByCat[f.category] || 0) + 1;
  }

  // 카테고리 탭 빌드
  const catTabs = [{ key: 'all', label: '전체', icon: '📋' }, ...ARCHIVE_CATEGORIES].map(cat =>
    `<button class="cat-tab ${archiveState.selectedCategory === cat.key ? 'active' : ''}" data-cat="${cat.key}">
      ${cat.icon} ${cat.label} <span class="cat-count">${cat.key === 'all' ? files.length : (countByCat[cat.key] || 0)}</span>
    </button>`
  ).join('');

  // 필터된 파일
  let viewFiles = archiveState.selectedCategory === 'all' ? files : files.filter(f => f.category === archiveState.selectedCategory);
  viewFiles.sort((a, b) => (b.uploaded_at || '').localeCompare(a.uploaded_at || ''));

  const filesHtml = viewFiles.length === 0
    ? `<div class="muted" style="text-align:center; padding:40px 0;">자료 없음 — 우측 상단 [+ 자료 추가]</div>`
    : viewFiles.map(f => {
        const cat = ARCHIVE_CATEGORIES.find(x => x.key === f.category) || { icon: '📎', label: f.category };
        return `
          <div class="file-row" data-id="${f.id}">
            <div class="file-row-icon">${getFileIcon(f.mime, cat.icon)}</div>
            <div class="file-row-body">
              <div class="file-row-name">${escapeHtml(f.title || f.name)}</div>
              <div class="file-row-meta muted-small">
                <span class="cat-badge">${cat.icon} ${cat.label}</span>
                · ${escapeHtml(f.name)} · ${formatBytes(f.size)} · ${fmtDate(f.uploaded_at)}
              </div>
              ${f.memo ? `<div class="muted-small" style="margin-top:3px;">${escapeHtml(f.memo)}</div>` : ''}
            </div>
            <div class="file-row-actions">
              <button class="btn ghost small" data-action="view" data-id="${f.id}">👁 보기</button>
              <button class="btn ghost small" data-action="download" data-id="${f.id}">📥</button>
              <button class="btn ghost small danger" data-action="delete" data-id="${f.id}">🗑</button>
            </div>
          </div>
        `;
      }).join('');

  wrap.innerHTML = `
    <div class="cust-detail-head">
      <div>
        <h2>${escapeHtml(c.company)}</h2>
        <div class="muted" style="font-size:12px;margin-top:2px;">자료 ${files.length}개</div>
      </div>
      <div class="cust-detail-actions">
        <button class="btn primary small" id="add-file-here">+ 자료 추가</button>
      </div>
    </div>

    <div class="cat-tabs">${catTabs}</div>

    <div class="file-list">${filesHtml}</div>
  `;

  wrap.querySelectorAll('.cat-tab').forEach(b => {
    b.addEventListener('click', () => {
      archiveState.selectedCategory = b.dataset.cat;
      renderDetail();
    });
  });
  wrap.querySelector('#add-file-here').addEventListener('click', () => openFileModal(null, { customer_id: id }));
  wrap.querySelectorAll('[data-action]').forEach(b => {
    b.addEventListener('click', () => handleFileAction(b.dataset.action, b.dataset.id));
  });
}

async function handleFileAction(action, id) {
  if (action === 'view') return viewFile(id);
  if (action === 'download') return downloadFile(id);
  if (action === 'delete') return deleteFile(id);
}

async function viewFile(id) {
  const rec = await blobDB.get(id);
  if (!rec) return;
  const tpl = document.getElementById('tpl-file-view').content.cloneNode(true);
  showModal(tpl, { wide: true });
  document.getElementById('fv-title').textContent = `${rec.title || rec.name}`;
  const url = URL.createObjectURL(rec.blob);
  const body = document.getElementById('fv-body');
  if (rec.mime?.startsWith('image/')) {
    body.innerHTML = `<img src="${url}" style="max-width:100%; max-height:70vh;">`;
  } else if (rec.mime === 'application/pdf') {
    body.innerHTML = `<embed src="${url}" type="application/pdf" style="width:100%; height:70vh;">`;
  } else {
    body.innerHTML = `
      <div style="padding:40px; text-align:center;">
        <div style="font-size:48px;">${getFileIcon(rec.mime, '📎')}</div>
        <div style="margin:10px 0;">${escapeHtml(rec.name)}</div>
        <div class="muted-small">${formatBytes(rec.size)}</div>
        <div class="muted-small" style="margin-top:8px;">미리보기 미지원 형식 — 다운로드해서 확인하세요</div>
      </div>
    `;
  }
  document.getElementById('fv-download').onclick = () => downloadFile(id);
}

async function downloadFile(id) {
  const rec = await blobDB.get(id);
  if (!rec) return;
  const url = URL.createObjectURL(rec.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = rec.name || 'file';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function deleteFile(id) {
  const rec = await blobDB.get(id);
  if (!rec) return;
  if (!confirm(`'${rec.title || rec.name}' 파일을 삭제할까요?`)) return;
  await blobDB.del(id);
  renderCustomerList();
  renderDetail();
}

// ============================================================
// 추가 모달
// ============================================================
function openFileModal(id, defaults = {}) {
  const tpl = document.getElementById('tpl-file-modal').content.cloneNode(true);
  showModal(tpl);
  document.getElementById('f-cust').innerHTML = customerOptions(defaults.customer_id || archiveState.selectedCustId);
  document.getElementById('f-cat').innerHTML = categoryOptions(archiveState.selectedCategory === 'all' ? 'contract' : archiveState.selectedCategory);

  const drop = document.getElementById('file-drop');
  const fileInp = document.getElementById('f-file');
  const preview = document.getElementById('file-preview');
  let pending = null;

  drop.addEventListener('click', () => fileInp.click());
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('drag-over');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInp.addEventListener('change', () => {
    if (fileInp.files.length) handleFile(fileInp.files[0]);
  });

  function handleFile(file) {
    pending = { blob: file, name: file.name, size: file.size, type: file.type };
    preview.classList.remove('hidden');
    preview.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px; padding:8px; background:#f8fafc; border-radius:6px;">
        <span style="font-size:24px;">${getFileIcon(file.type, '📎')}</span>
        <div>
          <div>${escapeHtml(file.name)}</div>
          <div class="muted-small">${formatBytes(file.size)} · ${escapeHtml(file.type || '알 수 없음')}</div>
        </div>
      </div>
    `;
    if (!document.getElementById('f-title').value) {
      document.getElementById('f-title').value = file.name.replace(/\.[^.]+$/, '');
    }
  }

  document.getElementById('file-save').addEventListener('click', async () => {
    const fd = new FormData(document.getElementById('file-form'));
    const customer_id = (fd.get('customer_id') || '').toString();
    const category = (fd.get('category') || '').toString();
    if (!customer_id) { alert('거래처를 선택하세요'); return; }
    if (!category) { alert('카테고리를 선택하세요'); return; }
    if (!pending) { alert('파일을 업로드하세요'); return; }

    const fileId = 'cf_' + uid();
    await blobDB.put({
      id: fileId,
      kind: 'customer_file',
      customer_id,
      category,
      title: (fd.get('title') || '').toString().trim() || pending.name,
      name: pending.name,
      size: pending.size,
      mime: pending.type,
      blob: pending.blob,
      memo: (fd.get('memo') || '').toString().trim(),
      uploaded_at: nowIso(),
    });
    archiveState.selectedCustId = customer_id;
    archiveState.selectedCategory = category;
    closeModal();
    renderCustomerList();
    renderDetail();
  });
}

// ============================================================
// 유틸
// ============================================================
function getFileIcon(mime, fallback) {
  if (!mime) return fallback || '📎';
  if (mime.startsWith('image/')) return '🖼';
  if (mime === 'application/pdf') return '📕';
  if (mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('csv')) return '📊';
  if (mime.includes('word') || mime.includes('document')) return '📄';
  if (mime.includes('zip') || mime.includes('compressed')) return '🗜';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.startsWith('video/')) return '🎬';
  return fallback || '📎';
}
function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  return (b/1024/1024).toFixed(1) + ' MB';
}
