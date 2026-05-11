// 한별시스템 임대관리 — 임대카운터 페이지
// xlsx 업로드 → 자동 등록 + 변경사항 알림 + 월별 시리얼 표 관리
'use strict';

const counterState = {
  mode: 'bw',          // 'bw' | 'co'
  filter: '',
  onlyBillable: false,
};

document.addEventListener('totalas:ready', async () => {
  if (!document.querySelector('.counters-page')) return;
  try {
    if (typeof showLoading === 'function') showLoading('카운터 로드 중…');
    await store.load();
  } catch (err) {
    console.error('store.load() 실패:', err);
    alert('데이터 로드 실패: ' + (err.message || err));
    return;
  } finally {
    if (typeof hideLoading === 'function') hideLoading();
  }
  initCounterPage();
});

function initCounterPage() {
  bindUpload();
  bindToolbar();
  bindAddPeriod();
  bindExport();
  renderStats();
  renderCounterTable();
}

// ============================================================
// 업로드
// ============================================================
function bindUpload() {
  const drop = document.getElementById('counter-drop-zone');
  const trigger = document.getElementById('btn-upload-trigger');
  const fileInp = document.getElementById('counter-file');

  trigger.addEventListener('click', () => fileInp.click());
  fileInp.addEventListener('change', () => {
    if (fileInp.files.length) handleCounterXlsx(fileInp.files[0]);
    fileInp.value = '';
  });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('drag-over');
    if (e.dataTransfer.files.length) handleCounterXlsx(e.dataTransfer.files[0]);
  });
}

async function handleCounterXlsx(file) {
  if (!file.name.toLowerCase().endsWith('.xlsx')) {
    alert('xlsx 파일만 지원합니다.');
    return;
  }
  if (typeof XLSX === 'undefined') {
    alert('SheetJS 로드 실패. 인터넷 연결 확인 후 새로고침');
    return;
  }

  let rows;
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  } catch (e) {
    alert('파일 파싱 실패: ' + e.message);
    return;
  }

  // 보고서 생성일 (Row 3 col E)
  let reportDate = rows[2]?.[4];
  let usagePeriod = null;
  if (reportDate) {
    const m = String(reportDate).match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) {
      const y = parseInt(m[1]), mo = parseInt(m[2]);
      const useY = mo === 1 ? y - 1 : y;
      const useM = mo === 1 ? 12 : mo - 1;
      usagePeriod = `${useY}-${String(useM).padStart(2, '0')}`;
    }
  }
  if (!usagePeriod) {
    usagePeriod = prompt('보고서 생성일을 인식하지 못했습니다. 사용월을 입력하세요 (YYYY-MM):', '2026-04');
    if (!usagePeriod || !/^\d{4}-\d{2}$/.test(usagePeriod)) return;
  }

  // 변경 추적
  const oldSerials = new Set(Object.keys(store.data.printers || {}));
  const oldGroups = new Set();
  for (const p of Object.values(store.data.printers || {})) {
    const g = (p.group || '').trim();
    if (g && g !== '1임대제품' && !g.startsWith('한별시스템')) oldGroups.add(g);
  }
  const oldCustomerNames = new Set(Object.values(store.data.customers || {}).map(c => c.company));

  const counterMap = {};
  const newSerials = [];
  const groupToSerials = {};

  for (let i = 8; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const serial = r[3];
    if (!serial) continue;
    const sKey = String(serial).trim();
    const bw = parseInt(r[13]);
    const co = (r[14] === ' ' || r[14] == null) ? null : parseInt(r[14]);
    const model = (r[2] || '').toString().trim();
    const group = (r[0] || '').toString().trim();
    const asset = (r[5] || '').toString().trim();

    counterMap[sKey] = {
      bw: isNaN(bw) ? null : bw,
      co: (co != null && !isNaN(co)) ? co : null,
      last_update: r[9] ? String(r[9]) : '',
      source: 'counter_report',
      source_file: file.name,
    };

    if (!oldSerials.has(sKey)) {
      newSerials.push({ serial: sKey, model, group, asset_name: asset });
    }
    if (group && group !== '1임대제품' && !group.startsWith('한별시스템')) {
      if (!groupToSerials[group]) groupToSerials[group] = [];
      groupToSerials[group].push({ serial: sKey, model, asset });
    }

    // 프린터 마스터 자동 추가 (Supabase 적용은 아래 일괄 처리)
    if (!store.data.printers[sKey]) {
      store.data.printers[sKey] = {
        serial: sKey, model, group, asset_name: asset,
        matched_customer_id: null,
      };
    }
  }

  // 신규 거래처(그룹) = 처음 보는 그룹 + 거래처 마스터에도 없음
  const newGroups = [];
  for (const [grp, sers] of Object.entries(groupToSerials)) {
    if (!oldGroups.has(grp) && !oldCustomerNames.has(grp)) {
      newGroups.push({ group: grp, serials: sers });
    }
  }

  const wasOverwritten = !!store.data.counters[usagePeriod];

  // Supabase에 저장: 새 프린터 → upsert, 카운터 → batch upsert
  try {
    if (typeof showLoading === 'function') showLoading('카운터 저장 중…');
    for (const ns of newSerials) {
      await store.upsertPrinter({
        serial: ns.serial, model: ns.model, group: ns.group, asset_name: ns.asset_name,
        matched_customer_id: null,
      });
    }
    await store.upsertCounterBatch(usagePeriod, counterMap);
  } catch (err) {
    alert('저장 실패: ' + (err.message || err));
    if (typeof hideLoading === 'function') hideLoading();
    return;
  } finally {
    if (typeof hideLoading === 'function') hideLoading();
  }

  renderStats();
  renderCounterTable();

  showImportReport({
    period: usagePeriod,
    fileName: file.name,
    totalSerials: Object.keys(counterMap).length,
    wasOverwritten,
    newSerials,
    newGroups,
  });
}

// ============================================================
// 업로드 결과 모달
// ============================================================
function showImportReport(r) {
  const newSerHTML = r.newSerials.length === 0
    ? '<div class="muted-small" style="padding:6px 0;">없음</div>'
    : `<div class="table-scroll" style="max-height:200px;"><table class="data-table"><thead><tr><th>시리얼</th><th>모델</th><th>그룹</th><th>자산명</th></tr></thead><tbody>${
      r.newSerials.map(s => `<tr><td><code>${escapeHtml(s.serial)}</code></td><td>${escapeHtml(s.model)}</td><td>${escapeHtml(s.group)}</td><td>${escapeHtml(s.asset_name)}</td></tr>`).join('')
    }</tbody></table></div>`;

  const newGrpHTML = r.newGroups.length === 0
    ? '<div class="muted-small" style="padding:6px 0;">없음</div>'
    : r.newGroups.map((g, i) => `
      <div style="border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin-bottom:6px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
          <div>
            <strong>${escapeHtml(g.group)}</strong>
            <span class="muted-small"> · ${g.serials.length}대</span>
          </div>
          <button class="btn small primary" data-add-grp="${i}">+ 거래처 자동 등록</button>
        </div>
        <div class="muted-small" style="margin-top:4px;">
          ${g.serials.map(s => `${escapeHtml(s.model)} ${escapeHtml(s.serial)}${s.asset?' ('+escapeHtml(s.asset)+')':''}`).join(' · ')}
        </div>
      </div>
    `).join('');

  const html = `
    <h3>📥 카운터 파일 적용 결과</h3>
    <div style="background:#f0fdf4; border:1px solid #bbf7d0; padding:10px 14px; border-radius:8px; margin-bottom:14px; font-size:13px;">
      <strong>사용월:</strong> ${escapeHtml(r.period)} · <strong>${r.totalSerials}대</strong> 데이터 로드<br>
      <span class="muted-small">파일: ${escapeHtml(r.fileName)}</span>
      ${r.wasOverwritten ? '<br><span style="color:#92400e;">⚠ 같은 월 데이터를 덮어썼습니다</span>' : ''}
    </div>

    <h4 style="margin:14px 0 6px 0; font-size:13px;">🆕 신규 시리얼 — ${r.newSerials.length}개 ${r.newSerials.length>0?'<span class="muted-small" style="font-weight:400;">(자동 등록됨)</span>':''}</h4>
    ${newSerHTML}

    <h4 style="margin:14px 0 6px 0; font-size:13px;">🏢 신규 업체(그룹) — ${r.newGroups.length}곳</h4>
    ${newGrpHTML}
    ${r.newGroups.length>0 ? '<p class="muted-small" style="margin:4px 0 0 0;">→ "거래처 자동 등록" 클릭하면 거래처 마스터에 추가됩니다 (단가는 임대거래처 탭에서 입력)</p>' : ''}

    <div class="modal-actions" style="position:sticky; bottom:0; background:#fff; padding-top:8px;">
      <button class="btn primary" data-close>확인</button>
    </div>
  `;
  showModal(html, { wide: true });

  document.querySelectorAll('button[data-add-grp]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.addGrp);
      const grp = r.newGroups[idx];
      const newId = uid();
      btn.disabled = true; btn.textContent = '등록 중…';
      try {
        await store.upsertCustomer({
          id: newId,
          company: grp.group,
          serials: grp.serials.map(s => s.serial),
        });
        for (const s of grp.serials) {
          if (store.data.printers[s.serial]) {
            await store.upsertPrinter({
              ...store.data.printers[s.serial],
              matched_customer_id: newId,
            });
          }
        }
      } catch (err) {
        alert('등록 실패: ' + (err.message || err));
        btn.disabled = false; btn.textContent = '+ 거래처 자동 등록';
        return;
      }
      btn.textContent = '✓ 등록됨';
      btn.style.opacity = '0.6';
      renderCounterTable();
      renderStats();
    });
  });
}

// ============================================================
// 통계
// ============================================================
function renderStats() {
  const periods = Object.keys(store.data.counters || {}).sort();
  const allSerials = new Set();
  for (const p of periods) {
    for (const s of Object.keys(store.data.counters[p] || {})) allSerials.add(s);
  }
  document.getElementById('stat-periods').textContent = periods.length;
  document.getElementById('stat-period-range').textContent =
    periods.length ? `${periods[0]} ~ ${periods[periods.length-1]}` : '—';
  document.getElementById('stat-serials').innerHTML = `${allSerials.size}<span class="unit">대</span>`;
  const matched = Array.from(allSerials).filter(s => store.data.printers[s]?.matched_customer_id).length;
  document.getElementById('stat-matched').textContent = `매칭 ${matched} / 미매칭 ${allSerials.size - matched}`;

  const latest = periods[periods.length - 1] || '—';
  document.getElementById('stat-latest').textContent = latest;
  document.getElementById('stat-latest-count').textContent =
    periods.length ? `${Object.keys(store.data.counters[latest]).length}대` : '0대';

  const sizeKb = (JSON.stringify(store.data).length / 1024).toFixed(1);
  document.getElementById('stat-size').innerHTML = `${sizeKb}<span class="unit">KB</span>`;
}

// ============================================================
// 도구바
// ============================================================
function bindToolbar() {
  document.getElementById('counter-mode').addEventListener('change', e => {
    counterState.mode = e.target.value;
    renderCounterTable();
  });
  document.getElementById('filter-serial').addEventListener('input', e => {
    counterState.filter = e.target.value.toLowerCase().trim();
    renderCounterTable();
  });
  document.getElementById('only-billable').addEventListener('change', e => {
    counterState.onlyBillable = e.target.checked;
    renderCounterTable();
  });
}

// ============================================================
// 빈 월 추가
// ============================================================
function bindAddPeriod() {
  document.getElementById('btn-add-period').addEventListener('click', () => {
    const p = prompt('새 월을 추가합니다 (YYYY-MM):', new Date().toISOString().slice(0, 7));
    if (!p || !/^\d{4}-\d{2}$/.test(p)) { alert('형식 오류 (예: 2026-05)'); return; }
    if (store.data.counters[p]) { alert('이미 존재하는 월입니다'); return; }
    // DB row는 첫 카운터 입력 시 자동 생성 — 메모리에만 빈 컬럼 표시
    store.data.counters[p] = {};
    renderStats();
    renderCounterTable();
  });
}

// ============================================================
// 내보내기
// ============================================================
function bindExport() {
  document.getElementById('btn-export-counters').addEventListener('click', () => {
    const data = {
      counters: store.data.counters,
      printers: store.data.printers,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const today = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `카운터_${today}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

// ============================================================
// 표 렌더링
// ============================================================
function renderCounterTable() {
  const periods = Object.keys(store.data.counters || {}).sort();
  const allSerials = new Set();
  for (const p of periods) {
    for (const s of Object.keys(store.data.counters[p] || {})) allSerials.add(s);
  }
  let serials = Array.from(allSerials);

  if (counterState.onlyBillable) {
    serials = serials.filter(s => store.data.printers[s]?.matched_customer_id);
  }
  if (counterState.filter) {
    const f = counterState.filter;
    serials = serials.filter(s => {
      const p = store.data.printers[s] || {};
      const cust = p.matched_customer_id ? store.data.customers[p.matched_customer_id] : null;
      const hay = `${s} ${p.model || ''} ${p.group || ''} ${p.asset_name || ''} ${cust?.company || ''}`.toLowerCase();
      return hay.includes(f);
    });
  }
  serials.sort();

  const table = document.getElementById('counter-table');
  if (periods.length === 0) {
    table.innerHTML = '<thead><tr><th>데이터 없음 — 위에 카운터 xlsx를 드래그하거나 [+ 빈 월 추가]</th></tr></thead>';
    return;
  }

  // 거래처 옵션
  const custOptions = ['<option value="">— 매칭 없음 —</option>']
    .concat(Object.values(store.data.customers || {})
      .sort((a, b) => (a.company || '').localeCompare(b.company || '', 'ko'))
      .map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.company)}</option>`))
    .join('');

  let html = '<thead><tr><th>시리얼 / 거래처</th>';
  for (const p of periods) {
    html += `<th class="num">${escapeHtml(p)}<button class="del-btn" data-period-del="${escapeHtml(p)}" title="이 월 전체 삭제" style="margin-left:4px;font-size:11px;">🗑</button></th>`;
  }
  html += '<th></th></tr></thead><tbody>';

  for (const serial of serials) {
    const printer = store.data.printers[serial] || {};
    const matchedId = printer.matched_customer_id || '';
    const cust = matchedId ? store.data.customers[matchedId] : null;
    html += `<tr data-serial="${escapeHtml(serial)}">
      <td>
        <div><code style="font-size:11.5px;">${escapeHtml(serial)}</code></div>
        <div class="muted-small">${escapeHtml(printer.model || '')}${printer.asset_name ? ' · ' + escapeHtml(printer.asset_name) : ''}</div>
        <select class="cust-select cell-edit" data-serial="${escapeHtml(serial)}" style="width:140px;font-size:11px;margin-top:3px;">
          ${custOptions.replace(`value="${escapeHtml(matchedId)}"`, `value="${escapeHtml(matchedId)}" selected`)}
        </select>
      </td>`;
    for (const p of periods) {
      const cell = (store.data.counters[p] || {})[serial] || {};
      const v = cell[counterState.mode];
      html += `<td class="num"><input class="cell-edit num counter-cell" data-period="${escapeHtml(p)}" data-serial="${escapeHtml(serial)}" value="${v == null ? '' : v}" placeholder="—"></td>`;
    }
    html += `<td><button class="del-btn" data-serial-del="${escapeHtml(serial)}" title="이 시리얼 행 삭제">🗑</button></td>`;
    html += '</tr>';
  }
  html += '</tbody>';
  table.innerHTML = html;

  // 셀 변경 (자동 저장)
  table.querySelectorAll('input.counter-cell').forEach(inp => {
    inp.addEventListener('change', async () => {
      const period = inp.dataset.period;
      const serial = inp.dataset.serial;
      const raw = inp.value.trim().replace(/,/g, '');
      const v = raw === '' ? null : (parseInt(raw) || 0);
      const prev = (store.data.counters[period] || {})[serial] || {};
      const merged = {
        bw: prev.bw ?? null,
        co: prev.co ?? null,
        last_update: prev.last_update || '',
        source: prev.source || 'manual',
        source_file: prev.source_file || '',
      };
      merged[counterState.mode] = v;
      try {
        await store.upsertCounter(period, serial, merged);
        inp.classList.add('saved');
        setTimeout(() => inp.classList.remove('saved'), 800);
      } catch (err) {
        alert('저장 실패: ' + (err.message || err));
        inp.value = prev[counterState.mode] == null ? '' : prev[counterState.mode];
      }
    });
  });

  // 거래처 매칭 변경
  table.querySelectorAll('select.cust-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      const serial = sel.dataset.serial;
      const newCustId = sel.value || null;
      if (!store.data.printers[serial]) return;
      const oldCustId = store.data.printers[serial].matched_customer_id;
      if (oldCustId === newCustId) return;

      sel.disabled = true;
      try {
        // 기존 거래처에서 시리얼 제거
        if (oldCustId && store.data.customers[oldCustId]) {
          const oldCust = store.data.customers[oldCustId];
          const next = (oldCust.serials || []).filter(s => s !== serial);
          await store.upsertCustomer({ ...oldCust, serials: next });
        }
        // 새 거래처에 시리얼 추가
        if (newCustId && store.data.customers[newCustId]) {
          const newCust = store.data.customers[newCustId];
          const arr = newCust.serials || [];
          if (!arr.includes(serial)) {
            await store.upsertCustomer({ ...newCust, serials: [...arr, serial] });
          }
        }
        // 프린터 매칭 변경
        await store.upsertPrinter({
          ...store.data.printers[serial],
          matched_customer_id: newCustId,
        });
      } catch (err) {
        alert('매칭 변경 실패: ' + (err.message || err));
        sel.value = oldCustId || '';
        sel.disabled = false;
        return;
      }
      sel.disabled = false;
      renderStats();
    });
  });

  // 시리얼 행 삭제
  table.querySelectorAll('button[data-serial-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const s = btn.dataset.serialDel;
      if (!confirm(`시리얼 ${s} 의 모든 월별 카운터 데이터를 삭제합니다. 시리얼 마스터도 제거됩니다.`)) return;
      btn.disabled = true;
      try {
        await store.deleteCounterSerial(s);
        const cust = store.data.printers[s]?.matched_customer_id;
        if (cust && store.data.customers[cust]) {
          const c = store.data.customers[cust];
          const next = (c.serials || []).filter(x => x !== s);
          await store.upsertCustomer({ ...c, serials: next });
        }
        await store.deletePrinter(s);
      } catch (err) {
        alert('삭제 실패: ' + (err.message || err));
        btn.disabled = false;
        return;
      }
      renderStats();
      renderCounterTable();
    });
  });

  // 월 전체 삭제
  table.querySelectorAll('button[data-period-del]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const p = btn.dataset.periodDel;
      if (!confirm(`${p} 카운터 데이터를 모두 삭제할까요?`)) return;
      btn.disabled = true;
      try {
        await store.deleteCounterPeriod(p);
      } catch (err) {
        alert('삭제 실패: ' + (err.message || err));
        btn.disabled = false;
        return;
      }
      renderStats();
      renderCounterTable();
    });
  });
}
