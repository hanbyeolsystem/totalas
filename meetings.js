// 한별시스템 임대관리 — 음성미팅관리 페이지
'use strict';

const meetingState = {
  selectedId: null,
  search: '',
  filterCust: '',
};

window.addEventListener('DOMContentLoaded', () => {
  if (!document.querySelector('.meetings-page')) return;
  store.load();
  if (!store.data.meetings) { store.data.meetings = {}; store.save(); }
  initMeetingPage();
});

function initMeetingPage() {
  bindMeetingPage();
  populateCustomerFilter();
  renderMeetingList();
}

function bindMeetingPage() {
  document.getElementById('btn-add-meeting').addEventListener('click', () => openMeetingModal(null));
  document.getElementById('btn-record').addEventListener('click', openRecordModal);
  document.getElementById('meeting-search').addEventListener('input', e => {
    meetingState.search = e.target.value.toLowerCase().trim();
    renderMeetingList();
  });
  document.getElementById('meeting-filter-cust').addEventListener('change', e => {
    meetingState.filterCust = e.target.value;
    renderMeetingList();
  });
}

function populateCustomerFilter() {
  const sel = document.getElementById('meeting-filter-cust');
  const customers = Object.values(store.data.customers || {})
    .sort((a, b) => (a.company || '').localeCompare(b.company || '', 'ko'));
  for (const c of customers) {
    const op = document.createElement('option');
    op.value = c.id;
    op.textContent = c.company;
    sel.appendChild(op);
  }
}

function customerOptions(selected) {
  const customers = Object.values(store.data.customers || {})
    .sort((a, b) => (a.company || '').localeCompare(b.company || '', 'ko'));
  return ['<option value="">— 거래처 선택 —</option>']
    .concat(customers.map(c => `<option value="${escapeHtml(c.id)}"${c.id === selected ? ' selected' : ''}>${escapeHtml(c.company)}</option>`))
    .join('');
}

// ============================================================
// 리스트
// ============================================================
function renderMeetingList() {
  const ul = document.getElementById('meeting-list');
  const cnt = document.getElementById('meeting-count');
  let meetings = Object.values(store.data.meetings || {});

  if (meetingState.filterCust) {
    meetings = meetings.filter(m => m.customer_id === meetingState.filterCust);
  }
  if (meetingState.search) {
    const f = meetingState.search;
    meetings = meetings.filter(m => {
      const cust = store.data.customers[m.customer_id]?.company || '';
      return [m.title, m.memo, m.attendees, cust].some(v => (v || '').toLowerCase().includes(f));
    });
  }
  meetings.sort((a, b) => (b.datetime || '').localeCompare(a.datetime || ''));
  cnt.textContent = `${meetings.length}건`;

  if (meetings.length === 0) {
    ul.innerHTML = `<li class="cust-list-empty muted">${meetingState.search || meetingState.filterCust ? '검색 결과 없음' : '미팅 기록 없음'}</li>`;
    return;
  }

  ul.innerHTML = meetings.map(m => {
    const cust = store.data.customers[m.customer_id];
    const dt = m.datetime ? formatKoDateTime(m.datetime) : '';
    const hasAudio = !!m.audio_blob_id;
    const hasMemo  = !!(m.memo && m.memo.trim());
    return `
      <li class="meeting-item ${meetingState.selectedId === m.id ? 'selected' : ''}" data-id="${m.id}">
        <div class="meeting-item-title">${escapeHtml(m.title || '(제목 없음)')}</div>
        <div class="meeting-item-cust">${escapeHtml(cust?.company || '— 거래처 미지정 —')}</div>
        <div class="meeting-item-meta">
          <span>${dt}</span>
          ${hasAudio ? '<span class="badge audio">🎙 음성</span>' : ''}
          ${hasMemo  ? '<span class="badge memo">📝 메모</span>' : ''}
        </div>
      </li>
    `;
  }).join('');

  ul.querySelectorAll('.meeting-item').forEach(li => {
    li.addEventListener('click', () => selectMeeting(li.dataset.id));
  });
}

function selectMeeting(id) {
  meetingState.selectedId = id;
  renderMeetingList();
  renderMeetingDetail(id);
}

// ============================================================
// 상세
// ============================================================
async function renderMeetingDetail(id) {
  const m = store.data.meetings[id];
  const wrap = document.getElementById('meeting-detail');
  if (!m) {
    wrap.innerHTML = `<div class="cust-empty"><div class="cust-empty-icon">🎙</div><div class="cust-empty-title">미팅 선택 안 됨</div></div>`;
    return;
  }
  const cust = store.data.customers[m.customer_id];
  let audioHtml = '';
  if (m.audio_blob_id) {
    try {
      const rec = await blobDB.get(m.audio_blob_id);
      if (rec?.blob) {
        const url = URL.createObjectURL(rec.blob);
        audioHtml = `
          <section class="info-card">
            <h4>🎙 음성</h4>
            <audio controls src="${url}" style="width:100%;"></audio>
            <div class="muted-small" style="margin-top:6px;">
              ${escapeHtml(rec.name || '')} · ${formatBytes(rec.size || 0)}
              <a href="${url}" download="${escapeHtml(rec.name || 'meeting.mp3')}" class="link" style="margin-left:8px;">📥 다운로드</a>
            </div>
          </section>
        `;
      }
    } catch (e) { console.error(e); }
  }

  wrap.innerHTML = `
    <div class="cust-detail-head">
      <div>
        <h2>${escapeHtml(m.title || '(제목 없음)')}</h2>
        <div class="muted" style="font-size:12px;margin-top:2px;">
          📅 ${formatKoDateTime(m.datetime)} ·
          🏢 <a href="customers.html" style="color:var(--primary);">${escapeHtml(cust?.company || '거래처 미지정')}</a>
          ${m.attendees ? ' · 👥 ' + escapeHtml(m.attendees) : ''}
        </div>
      </div>
      <div class="cust-detail-actions">
        <button class="btn ghost small" id="m-edit">✏️ 수정</button>
        <button class="btn ghost small danger" id="m-del">🗑 삭제</button>
      </div>
    </div>
    <div class="cust-detail-grid">
      ${audioHtml}
      <section class="info-card ${audioHtml ? '' : 'span-2'}">
        <h4>📝 메모</h4>
        <div style="white-space:pre-wrap; font-size:13.5px; line-height:1.7;">${escapeHtml(m.memo || '— 메모 없음 —')}</div>
      </section>
    </div>
  `;
  document.getElementById('m-edit').addEventListener('click', () => openMeetingModal(id));
  document.getElementById('m-del').addEventListener('click', () => deleteMeeting(id));
}

async function deleteMeeting(id) {
  const m = store.data.meetings[id];
  if (!m) return;
  if (!confirm(`'${m.title}' 미팅 기록을 삭제할까요? (음성 파일도 함께 삭제됨)`)) return;
  if (m.audio_blob_id) {
    try { await blobDB.del(m.audio_blob_id); } catch (e) {}
  }
  delete store.data.meetings[id];
  store.save();
  if (meetingState.selectedId === id) meetingState.selectedId = null;
  renderMeetingList();
  renderMeetingDetail(null);
}

// ============================================================
// 추가/수정 모달
// ============================================================
async function openMeetingModal(id) {
  const tpl = document.getElementById('tpl-meeting-modal').content.cloneNode(true);
  showModal(tpl);
  const isEdit = !!id;
  document.getElementById('meeting-modal-title').textContent = isEdit ? '✏️ 미팅 수정' : '+ 미팅 기록 추가';
  const meeting = isEdit ? store.data.meetings[id] : null;

  document.getElementById('m-cust').innerHTML = customerOptions(meeting?.customer_id || '');
  if (meetingState.filterCust && !isEdit) {
    document.getElementById('m-cust').value = meetingState.filterCust;
  }
  document.getElementById('m-datetime').value = meeting?.datetime || nowLocalDt();
  document.getElementById('m-title').value = meeting?.title || '';
  document.getElementById('meeting-form').querySelector('[name=attendees]').value = meeting?.attendees || '';
  document.getElementById('m-memo').value = meeting?.memo || '';

  const drop = document.getElementById('audio-drop');
  const fileInp = document.getElementById('audio-file');
  const preview = document.getElementById('audio-preview');
  let pendingAudio = null;     // {blob, name, size, type}
  let pendingDelete = false;

  // 기존 음성 표시
  if (meeting?.audio_blob_id) {
    try {
      const rec = await blobDB.get(meeting.audio_blob_id);
      if (rec?.blob) {
        const url = URL.createObjectURL(rec.blob);
        preview.classList.remove('hidden');
        preview.innerHTML = `
          <audio controls src="${url}" style="width:100%;margin-top:6px;"></audio>
          <div class="muted-small" style="margin-top:4px;">${escapeHtml(rec.name)} · ${formatBytes(rec.size)}
            <button class="btn ghost small danger" id="audio-remove" style="margin-left:8px;">제거</button>
          </div>
        `;
        document.getElementById('audio-remove').addEventListener('click', () => {
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
    if (e.dataTransfer.files.length) handleAudio(e.dataTransfer.files[0]);
  });
  fileInp.addEventListener('change', () => {
    if (fileInp.files.length) handleAudio(fileInp.files[0]);
  });

  function handleAudio(file) {
    if (!file.type.startsWith('audio/')) { alert('음성 파일만 업로드 가능'); return; }
    pendingAudio = { blob: file, name: file.name, size: file.size, type: file.type };
    pendingDelete = false;
    const url = URL.createObjectURL(file);
    preview.classList.remove('hidden');
    preview.innerHTML = `
      <audio controls src="${url}" style="width:100%;margin-top:6px;"></audio>
      <div class="muted-small" style="margin-top:4px;">${escapeHtml(file.name)} · ${formatBytes(file.size)} <em style="color:var(--success);">(새 파일)</em></div>
    `;
  }

  document.getElementById('meeting-save').addEventListener('click', async () => {
    const fd = new FormData(document.getElementById('meeting-form'));
    const customer_id = (fd.get('customer_id') || '').toString();
    const title = (fd.get('title') || '').toString().trim();
    const datetime = (fd.get('datetime') || '').toString();
    if (!customer_id) { alert('거래처를 선택하세요'); return; }
    if (!title) { alert('제목 필수'); return; }

    const targetId = id || ('mt_' + uid());
    const obj = {
      id: targetId,
      customer_id,
      datetime,
      title,
      attendees: (fd.get('attendees') || '').toString().trim(),
      memo: (fd.get('memo') || '').toString(),
      audio_blob_id: meeting?.audio_blob_id || null,
      created_at: meeting?.created_at || nowIso(),
      updated_at: nowIso(),
    };

    // 음성 처리
    if (pendingDelete && obj.audio_blob_id) {
      try { await blobDB.del(obj.audio_blob_id); } catch (e) {}
      obj.audio_blob_id = null;
    }
    if (pendingAudio) {
      // 기존 것 제거
      if (obj.audio_blob_id) { try { await blobDB.del(obj.audio_blob_id); } catch (e) {} }
      const blobId = 'audio_' + uid();
      await blobDB.put({
        id: blobId,
        kind: 'meeting_audio',
        customer_id,
        meeting_id: targetId,
        blob: pendingAudio.blob,
        name: pendingAudio.name,
        size: pendingAudio.size,
        mime: pendingAudio.type,
        uploaded_at: nowIso(),
      });
      obj.audio_blob_id = blobId;
    }

    store.data.meetings[targetId] = obj;
    store.save();
    meetingState.selectedId = targetId;
    closeModal();
    renderMeetingList();
    renderMeetingDetail(targetId);
  });
}

// ============================================================
// 직접 녹음 모달
// ============================================================
function openRecordModal() {
  const tpl = document.getElementById('tpl-record-modal').content.cloneNode(true);
  showModal(tpl);
  document.getElementById('rec-cust').innerHTML = customerOptions(meetingState.filterCust);

  let mediaRecorder = null;
  let chunks = [];
  let startTs = 0;
  let timer = null;
  let recordedBlob = null;

  const startBtn = document.getElementById('rec-start');
  const stopBtn = document.getElementById('rec-stop');
  const saveBtn = document.getElementById('rec-save');
  const status = document.getElementById('rec-status');
  const timeDiv = document.getElementById('rec-time');
  const preview = document.getElementById('rec-preview');

  startBtn.addEventListener('click', async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      chunks = [];
      mediaRecorder.ondataavailable = e => chunks.push(e.data);
      mediaRecorder.onstop = () => {
        recordedBlob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        const url = URL.createObjectURL(recordedBlob);
        preview.classList.remove('hidden');
        preview.innerHTML = `<audio controls src="${url}" style="width:100%;margin-top:8px;"></audio><div class="muted-small" style="margin-top:4px;">${formatBytes(recordedBlob.size)}</div>`;
        saveBtn.disabled = false;
        stream.getTracks().forEach(t => t.stop());
      };
      mediaRecorder.start();
      startTs = Date.now();
      status.textContent = '🔴 녹음 중';
      status.style.color = 'var(--danger)';
      startBtn.disabled = true;
      stopBtn.disabled = false;
      timer = setInterval(() => {
        const sec = Math.floor((Date.now() - startTs) / 1000);
        const mm = String(Math.floor(sec/60)).padStart(2,'0');
        const ss = String(sec%60).padStart(2,'0');
        timeDiv.textContent = `${mm}:${ss}`;
      }, 200);
    } catch (e) {
      alert('마이크 접근 실패: ' + e.message);
    }
  });

  stopBtn.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      clearInterval(timer);
      status.textContent = '✅ 녹음 완료';
      status.style.color = 'var(--success)';
      startBtn.disabled = false;
      stopBtn.disabled = true;
    }
  });

  saveBtn.addEventListener('click', async () => {
    const customer_id = document.getElementById('rec-cust').value;
    const title = document.getElementById('rec-title').value.trim() || `녹음 ${new Date().toLocaleString('ko-KR')}`;
    if (!customer_id) { alert('거래처를 선택하세요'); return; }
    if (!recordedBlob) { alert('녹음된 파일이 없습니다'); return; }

    const meetingId = 'mt_' + uid();
    const blobId = 'audio_' + uid();
    const ext = (recordedBlob.type.split('/')[1] || 'webm').split(';')[0];
    await blobDB.put({
      id: blobId,
      kind: 'meeting_audio',
      customer_id,
      meeting_id: meetingId,
      blob: recordedBlob,
      name: `녹음_${new Date().toISOString().slice(0,16).replace(/[:T]/g,'-')}.${ext}`,
      size: recordedBlob.size,
      mime: recordedBlob.type,
      uploaded_at: nowIso(),
    });
    store.data.meetings[meetingId] = {
      id: meetingId,
      customer_id,
      datetime: nowLocalDt(),
      title,
      attendees: '',
      memo: '',
      audio_blob_id: blobId,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    store.save();
    meetingState.selectedId = meetingId;
    closeModal();
    renderMeetingList();
    renderMeetingDetail(meetingId);
  });
}

// ============================================================
// 유틸
// ============================================================
function nowLocalDt() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function formatKoDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  return (b/1024/1024).toFixed(1) + ' MB';
}
