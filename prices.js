// 한별시스템 임대관리 — 가격표 게시판
'use strict';

const priceState = {
  category: 'all',
  search: '',
  sort: 'recent',
};

const PRICE_CATS = {
  product: { label: '판매제품', icon: '🛒', color: '#0369a1', bg: '#e0f2fe' },
  part:    { label: '부품',     icon: '⚙',  color: '#a16207', bg: '#fef9c3' },
};

window.addEventListener('DOMContentLoaded', () => {
  if (!document.querySelector('.prices-page')) return;
  store.load();
  if (!store.data.prices) { store.data.prices = {}; store.save(); }
  initPricePage();
});

function initPricePage() {
  document.getElementById('btn-write').addEventListener('click', () => openPriceModal(null));
  document.getElementById('prices-search').addEventListener('input', e => {
    priceState.search = e.target.value.toLowerCase().trim();
    renderBoard();
  });
  document.getElementById('prices-sort').addEventListener('change', e => {
    priceState.sort = e.target.value;
    renderBoard();
  });
  document.querySelectorAll('.prices-tabs .cat-tab').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.prices-tabs .cat-tab').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      priceState.category = b.dataset.cat;
      renderBoard();
    });
  });
  renderBoard();
}

function renderBoard() {
  const tbody = document.getElementById('board-tbody');
  let items = Object.values(store.data.prices || {});

  // 카테고리 카운트
  const cnt = { all: items.length, product: 0, part: 0 };
  for (const it of items) {
    if (it.category === 'product') cnt.product++;
    if (it.category === 'part')    cnt.part++;
  }
  document.getElementById('cnt-all').textContent = cnt.all;
  document.getElementById('cnt-product').textContent = cnt.product;
  document.getElementById('cnt-part').textContent = cnt.part;

  // 필터
  if (priceState.category !== 'all') {
    items = items.filter(it => it.category === priceState.category);
  }
  if (priceState.search) {
    const f = priceState.search;
    items = items.filter(it =>
      [it.title, it.memo, it.author, it.file_name].some(v => (v || '').toLowerCase().includes(f))
    );
  }

  // 정렬
  if (priceState.sort === 'title') {
    items.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ko'));
  } else {
    items.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }

  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="board-empty muted">등록된 가격표가 없습니다. [+ 글쓰기]로 등록하세요.</td></tr>`;
    return;
  }

  tbody.innerHTML = items.map((it, idx) => {
    const cat = PRICE_CATS[it.category] || { label: it.category, icon: '📋', color: '#475569', bg: '#f1f5f9' };
    const num = items.length - idx;
    return `
      <tr class="board-row" data-id="${it.id}">
        <td class="board-num">${num}</td>
        <td><span class="board-cat-pill" style="background:${cat.bg};color:${cat.color};">${cat.icon} ${cat.label}</span></td>
        <td class="board-title">
          <span class="board-title-text">${escapeHtml(it.title)}</span>
          ${it.memo ? `<div class="board-memo muted-small">${escapeHtml(it.memo).slice(0, 60)}${it.memo.length > 60 ? '...' : ''}</div>` : ''}
        </td>
        <td class="board-attach">${it.blob_id ? '📎' : ''}</td>
        <td class="muted-small">${formatKoDate(it.created_at)}</td>
        <td class="board-actions">
          <button class="btn small primary" data-action="view">👁 열기</button>
          <button class="btn small ghost danger" data-action="delete" title="삭제">🗑</button>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.board-row').forEach(tr => {
    tr.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      viewPrice(tr.dataset.id);
    });
    tr.querySelector('[data-action=view]').addEventListener('click', () => viewPrice(tr.dataset.id));
    tr.querySelector('[data-action=delete]').addEventListener('click', () => deletePrice(tr.dataset.id));
  });
}

// ============================================================
// 글쓰기 / 수정 모달
// ============================================================
async function openPriceModal(id) {
  const tpl = document.getElementById('tpl-price-modal').content.cloneNode(true);
  showModal(tpl);
  const isEdit = !!id;
  const item = isEdit ? store.data.prices[id] : null;
  document.getElementById('price-modal-title').textContent = isEdit ? '✏️ 가격표 수정' : '+ 가격표 등록';

  if (isEdit) {
    document.getElementById('p-cat').value = item.category;
    document.getElementById('p-title').value = item.title || '';
    document.getElementById('p-author').value = item.author || '';
    document.getElementById('p-memo').value = item.memo || '';
  }

  const drop = document.getElementById('price-drop');
  const fileInp = document.getElementById('p-file');
  const preview = document.getElementById('price-preview');
  let pendingFile = null;
  let pendingDelete = false;

  if (item?.blob_id) {
    try {
      const rec = await blobDB.get(item.blob_id);
      if (rec) {
        preview.classList.remove('hidden');
        preview.innerHTML = `
          <div style="display:flex; align-items:center; gap:10px; padding:8px; background:#f8fafc; border-radius:6px;">
            <span style="font-size:22px;">${getFileIcon(rec.mime)}</span>
            <div style="flex:1;">
              <div>${escapeHtml(rec.name)}</div>
              <div class="muted-small">${formatBytes(rec.size)} · 기존 파일</div>
            </div>
            <button type="button" class="btn ghost small danger" id="price-file-remove">제거</button>
          </div>
        `;
        document.getElementById('price-file-remove').addEventListener('click', () => {
          pendingDelete = true;
          preview.classList.add('hidden');
          preview.innerHTML = '';
        });
      }
    } catch (e) {}
  }

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
    pendingFile = { blob: file, name: file.name, size: file.size, type: file.type };
    pendingDelete = false;
    preview.classList.remove('hidden');
    preview.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px; padding:8px; background:#f8fafc; border-radius:6px;">
        <span style="font-size:22px;">${getFileIcon(file.type)}</span>
        <div>
          <div>${escapeHtml(file.name)}</div>
          <div class="muted-small">${formatBytes(file.size)} · <em style="color:var(--success);">새 파일</em></div>
        </div>
      </div>
    `;
    if (!document.getElementById('p-title').value) {
      document.getElementById('p-title').value = file.name.replace(/\.[^.]+$/, '');
    }
  }

  document.getElementById('price-save').addEventListener('click', async () => {
    const fd = new FormData(document.getElementById('price-form'));
    const title = (fd.get('title') || '').toString().trim();
    if (!title) { alert('제목을 입력하세요'); return; }

    const targetId = id || ('pr_' + uid());
    const obj = {
      id: targetId,
      category: (fd.get('category') || 'product').toString(),
      title,
      author: (fd.get('author') || '').toString().trim(),
      memo: (fd.get('memo') || '').toString().trim(),
      blob_id: item?.blob_id || null,
      file_name: item?.file_name || '',
      file_size: item?.file_size || 0,
      file_mime: item?.file_mime || '',
      created_at: item?.created_at || nowIso(),
      updated_at: nowIso(),
    };

    if (pendingDelete && obj.blob_id) {
      try { await blobDB.del(obj.blob_id); } catch (e) {}
      obj.blob_id = null;
      obj.file_name = '';
      obj.file_size = 0;
      obj.file_mime = '';
    }
    if (pendingFile) {
      if (obj.blob_id) { try { await blobDB.del(obj.blob_id); } catch (e) {} }
      const blobId = 'price_' + uid();
      await blobDB.put({
        id: blobId,
        kind: 'price_file',
        customer_id: '',
        price_id: targetId,
        blob: pendingFile.blob,
        name: pendingFile.name,
        size: pendingFile.size,
        mime: pendingFile.type,
        uploaded_at: nowIso(),
      });
      obj.blob_id = blobId;
      obj.file_name = pendingFile.name;
      obj.file_size = pendingFile.size;
      obj.file_mime = pendingFile.type;
    }

    store.data.prices[targetId] = obj;
    store.save();
    closeModal();
    renderBoard();
  });
}

// ============================================================
// 보기 모달 — 인라인 미리보기 (PDF / 엑셀 / 이미지)
// ============================================================
async function viewPrice(id) {
  const item = store.data.prices[id];
  if (!item) return;
  const tpl = document.getElementById('tpl-price-view').content.cloneNode(true);
  showModal(tpl, { wide: true });

  const cat = PRICE_CATS[item.category] || { label: item.category, icon: '📋' };
  document.getElementById('pv-title').textContent = item.title;
  document.getElementById('pv-meta').innerHTML = `
    <span class="board-cat-pill" style="background:${cat.bg};color:${cat.color};">${cat.icon} ${cat.label}</span>
    · ${escapeHtml(item.author || '—')} · ${formatKoDateTime(item.created_at)}
    ${item.memo ? `<div style="margin-top:6px; padding:8px 10px; background:#f8fafc; border-radius:6px; color:var(--text);">${escapeHtml(item.memo)}</div>` : ''}
  `;

  const body = document.getElementById('pv-body');
  if (!item.blob_id) {
    body.innerHTML = `<div class="muted" style="text-align:center; padding:40px;">첨부 파일 없음</div>`;
    document.getElementById('pv-download').style.display = 'none';
  } else {
    try {
      const rec = await blobDB.get(item.blob_id);
      if (!rec) { body.innerHTML = '<div class="muted">파일 없음</div>'; return; }
      await renderFileInline(body, rec);
      document.getElementById('pv-download').onclick = () => {
        const url = URL.createObjectURL(rec.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = rec.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      };
    } catch (e) {
      body.innerHTML = '<div class="muted">로드 실패: ' + e.message + '</div>';
    }
  }

  document.getElementById('pv-edit').addEventListener('click', () => {
    closeModal();
    setTimeout(() => openPriceModal(id), 50);
  });
}

async function renderFileInline(container, rec) {
  const url = URL.createObjectURL(rec.blob);
  const mime = (rec.mime || '').toLowerCase();
  const name = (rec.name || '').toLowerCase();

  if (mime.startsWith('image/')) {
    container.innerHTML = `<img src="${url}" style="max-width:100%; max-height:75vh; display:block; margin:0 auto;">`;
    return;
  }
  if (mime === 'application/pdf' || name.endsWith('.pdf')) {
    container.innerHTML = `<embed src="${url}" type="application/pdf" style="width:100%; height:75vh; border:1px solid var(--border); border-radius:6px;">`;
    return;
  }
  // 엑셀: SheetJS로 첫 시트를 표로
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv') ||
      mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('csv')) {
    if (typeof XLSX === 'undefined') {
      container.innerHTML = `<div class="muted" style="padding:30px;text-align:center;">엑셀 미리보기 라이브러리 로드 실패. 다운로드해서 확인하세요.</div>`;
      return;
    }
    try {
      const buf = await rec.blob.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheets = wb.SheetNames;
      let html = '';
      if (sheets.length > 1) {
        html += `<div class="sheet-tabs">` + sheets.map((s, i) =>
          `<button class="sheet-tab ${i === 0 ? 'active' : ''}" data-sheet="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('') + `</div>`;
      }
      html += `<div id="sheet-render"></div>`;
      container.innerHTML = html;
      const target = document.getElementById('sheet-render');
      const renderSheet = name => {
        const ws = wb.Sheets[name];
        target.innerHTML = `<div class="sheet-html">${XLSX.utils.sheet_to_html(ws, { editable: false })}</div>`;
      };
      renderSheet(sheets[0]);
      container.querySelectorAll('.sheet-tab').forEach(b => {
        b.addEventListener('click', () => {
          container.querySelectorAll('.sheet-tab').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          renderSheet(b.dataset.sheet);
        });
      });
    } catch (e) {
      container.innerHTML = `<div class="muted">엑셀 읽기 실패: ${e.message}</div>`;
    }
    return;
  }
  // 그 외
  container.innerHTML = `
    <div style="padding:60px; text-align:center;">
      <div style="font-size:56px;">${getFileIcon(mime)}</div>
      <div style="margin:14px 0 4px 0; font-size:14px;">${escapeHtml(rec.name)}</div>
      <div class="muted-small">${formatBytes(rec.size)} · ${escapeHtml(rec.mime || '알 수 없음')}</div>
      <div class="muted-small" style="margin-top:10px;">미리보기 미지원 형식 — [📥 다운로드] 클릭</div>
    </div>
  `;
}

async function deletePrice(id) {
  const item = store.data.prices[id];
  if (!item) return;
  if (!confirm(`'${item.title}' 가격표를 삭제할까요?`)) return;
  if (item.blob_id) { try { await blobDB.del(item.blob_id); } catch (e) {} }
  delete store.data.prices[id];
  store.save();
  renderBoard();
}

// ============================================================
// 유틸
// ============================================================
function getFileIcon(mime) {
  if (!mime) return '📎';
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return '🖼';
  if (m === 'application/pdf') return '📕';
  if (m.includes('spreadsheet') || m.includes('excel') || m.includes('csv')) return '📊';
  if (m.includes('word') || m.includes('document')) return '📄';
  return '📎';
}
function formatBytes(b) {
  if (!b) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  return (b/1024/1024).toFixed(1) + ' MB';
}
function formatKoDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\./g, '.').replace(/ /g, '');
}
function formatKoDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
