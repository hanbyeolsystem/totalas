// ===========================================================
// 한별시스템 임대관리 — 계약서 페이지
// NAS 세부현황 242건 형식 (신청정보 / 계약내용 / 약관 / CMS / 특약)
// ===========================================================
'use strict';

const DEFAULT_TERMS = [
  '약정기간내 중도해지시 남은 기간의 50%가 위약금으로 발생 된다.',
  '중도해지시 설치비 및 철거비 5만원, 등록비 10만원 청구된다. (단, 레이저는 설치비/철거비 10만원, 등록비 20만원 청구)',
  '기계 이전시 기본 3만원 청구된다. (단, 거리에 따라 차등적용된다.)',
  '만료일 15일 이전에 계약 해지여부를 통보하지 않을 경우 본 계약과 동일한 조건으로 1년 단위로 자동연장된다.',
  '첨부된 이용약관자료를 모두 이해 하였습니다.',
];
const DEFAULT_EXTRAS = [
  '월 제공매수 초과 시에는 초과사용 임대료가 추가 청구된다는 내용에 대해 설명받았습니다.',
  '프린터 사용법 및 주의사항을 안내받았습니다.',
  '프린터 연결 사용 시 인터넷환경, 공유기 상태에 따라 출력이 원활치않을 수 있기 때문에 당사 서비스팀의 진단 후 A/S 진행여부가 결정됨을 안내받았습니다.',
  'pc포맷, 바이러스로 인한 케이블 임의 제거로 pc문제로 인한 출장시, 회당 출장비 3만원 이상의 출장비가 부과된다.',
];

let ctState = { selectedId: null, search: '', sort: 'name' };

window.addEventListener('DOMContentLoaded', () => {
  store.load();
  if (!document.querySelector('.contracts-page')) return;
  bindContractPage();
  renderContractList();
  renderEmptyDoc();
});

function bindContractPage() {
  $('#btn-new').addEventListener('click', () => {
    ctState.selectedId = null;
    renderDoc(blankContract());
    setStatus('새 계약서 — 저장하면 거래처에 연결됩니다');
    renderContractList();
  });
  $('#btn-save').addEventListener('click', saveCurrentContract);
  $('#btn-print').addEventListener('click', () => window.print());
  $('#btn-delete').addEventListener('click', deleteCurrentContract);
  $('#btn-fill-from-customer').addEventListener('click', openCustomerPicker);
  $('#btn-import-seed').addEventListener('click', importContractSeed);
  $('#ct-search').addEventListener('input', e => {
    ctState.search = e.target.value.toLowerCase().trim();
    renderContractList();
  });
  $('#ct-sort').addEventListener('change', e => {
    ctState.sort = e.target.value;
    renderContractList();
  });
}

function setStatus(msg) {
  const el = $('#ct-status-label');
  if (el) el.textContent = msg;
}

// ============================================================
// 계약서 목록
// ============================================================
function renderContractList() {
  const ul = $('#ct-list');
  const all = Object.values(store.data.contracts || {});
  const filtered = all.filter(c => {
    if (!ctState.search) return true;
    const hay = `${c.company || ''} ${c.requester || ''} ${c.address || ''}`.toLowerCase();
    return hay.includes(ctState.search);
  });
  filtered.sort((a, b) => {
    if (ctState.sort === 'recent') {
      return (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || '');
    }
    if (ctState.sort === 'fee') {
      return (b.total_fee || 0) - (a.total_fee || 0);
    }
    return (a.company || '').localeCompare(b.company || '', 'ko');
  });

  $('#ct-count').textContent = `${filtered.length}건${all.length !== filtered.length ? ` / 전체 ${all.length}` : ''}`;

  ul.innerHTML = filtered.map(c => {
    const date = c.contract_date || '';
    const fee = (c.total_fee || 0).toLocaleString();
    const itemSummary = (c.items || []).filter(it => it.product).map(it => it.product).join(', ').slice(0, 40);
    return `
      <li class="ct-item ${c.id === ctState.selectedId ? 'active' : ''}" data-id="${c.id}">
        <div class="ct-item-head">
          <strong>${escapeHtml(c.company || '(이름없음)')}</strong>
          <span class="muted-small">${escapeHtml(date)}</span>
        </div>
        <div class="ct-item-sub muted-small">${fee}원 · ${escapeHtml(itemSummary || '품목 없음')}</div>
      </li>
    `;
  }).join('') || '<li class="ct-item-empty muted-small">계약서가 없습니다. 우측 상단 "+ 새 계약서" 또는 "🌱 시드 가져오기"를 사용하세요.</li>';

  ul.querySelectorAll('.ct-item').forEach(li => {
    li.addEventListener('click', () => loadContract(li.dataset.id));
  });
}

function loadContract(id) {
  const c = store.data.contracts[id];
  if (!c) return;
  ctState.selectedId = id;
  renderDoc(c);
  setStatus(`${c.company} — ${c.contract_date || '날짜 미입력'}`);
  renderContractList();
}

// ============================================================
// 빈 계약서 / 시드 객체 → 폼 초기값
// ============================================================
function blankContract() {
  return {
    id: null,
    customer_id: null,
    company: '',
    company_top: '',
    requester: '',
    address: '',
    invoice_kind: '□  전자세금계산서',
    biz_no: '',
    mobile: '',
    tel_fax: '',
    email: '',
    items: [
      { no: 1, product: '', bw_free: 0, co_free: 0, bw_rate: 0, co_rate: 0, qty: 1, install: '무료', fee: 0, vat_note: 'VAT별도' },
      { no: 2, product: '', bw_free: 0, co_free: 0, bw_rate: 0, co_rate: 0, qty: 0, install: '', fee: 0, vat_note: '' },
      { no: 3, product: '', bw_free: 0, co_free: 0, bw_rate: 0, co_rate: 0, qty: 0, install: '', fee: 0, vat_note: '' },
      { no: 4, product: '', bw_free: 0, co_free: 0, bw_rate: 0, co_rate: 0, qty: 0, install: '', fee: 0, vat_note: '' },
    ],
    deposit: 0,
    total_fee: 0,
    contract_date: new Date().toISOString().slice(0,10),
    contract_months: 36,
    pay_day: 25,
    terms_checked: [true, true, true, true, true],
    extras_checked: [true, true, true, true],
    special: ['', ''],
    bank: { name: '농협', acct: '010-4585-6890-09', holder: '김상환(한별시스템)' },
  };
}

// ============================================================
// 계약서 본문 렌더 (편집 가능)
// ============================================================
function renderEmptyDoc() {
  $('#contract-doc').innerHTML = `
    <div class="ct-empty-doc">
      <div class="ct-empty-icon">📋</div>
      <h2>계약서를 선택하거나 새로 만드세요</h2>
      <p class="muted">좌측 목록에서 거래처를 클릭하거나 우측 상단 "+ 새 계약서" 버튼을 눌러주세요.</p>
      <button class="btn primary" onclick="document.getElementById('btn-new').click()">+ 새 계약서 작성</button>
    </div>
  `;
}

function renderDoc(c) {
  const items = padItems(c.items || []);
  const html = `
    <!-- ============ 페이지 1: 표지 ============ -->
    <section class="contract-page ct-cover">
      <div class="ct-cover-head">
        <div class="ct-cover-company"><input class="ct-input ed company-top" data-bind="company_top" value="${escapeAttr(c.company_top || c.company)}" placeholder="회사명"></div>
        <div class="ct-cover-title">렌탈(임대) 계약서 V.1</div>
      </div>
      <div class="ct-cover-noti">★ 모든 임대료는 선불입니다 ★</div>

      <table class="ct-tbl ct-tbl-info">
        <colgroup><col style="width:8%"><col style="width:14%"><col style="width:30%"><col style="width:18%"><col style="width:30%"></colgroup>
        <tr>
          <th rowspan="4" class="ct-vlabel">신<br>청<br>정<br>보</th>
          <th>회사상호</th><td><input class="ct-input ed" data-bind="company" value="${escapeAttr(c.company)}"></td>
          <th>주민등록번호 / (사업자번호)</th><td><input class="ct-input ed" data-bind="biz_no" value="${escapeAttr(c.biz_no)}"></td>
        </tr>
        <tr>
          <th>요청자성함</th><td><input class="ct-input ed" data-bind="requester" value="${escapeAttr(c.requester)}"></td>
          <th>휴대폰 번호</th><td><input class="ct-input ed" data-bind="mobile" value="${escapeAttr(c.mobile)}"></td>
        </tr>
        <tr>
          <th>설치주소</th><td><input class="ct-input ed" data-bind="address" value="${escapeAttr(c.address)}"></td>
          <th>전화 / 팩스</th><td><input class="ct-input ed" data-bind="tel_fax" value="${escapeAttr(c.tel_fax)}"></td>
        </tr>
        <tr>
          <th>발 행 구 분</th><td><input class="ct-input ed" data-bind="invoice_kind" value="${escapeAttr(c.invoice_kind)}"></td>
          <th>이메일주소</th><td><input class="ct-input ed" data-bind="email" value="${escapeAttr(c.email)}"></td>
        </tr>
      </table>

      <table class="ct-tbl ct-tbl-items">
        <colgroup>
          <col style="width:5%"><col style="width:5%"><col style="width:22%"><col style="width:9%"><col style="width:9%"><col style="width:9%"><col style="width:9%"><col style="width:7%"><col style="width:8%"><col style="width:11%"><col style="width:6%">
        </colgroup>
        <thead>
          <tr>
            <th rowspan="2" class="ct-vlabel">계<br>약<br>내<br>용</th>
            <th rowspan="2">#</th>
            <th rowspan="2">렌탈물품</th>
            <th colspan="2">기본매수(무료)</th>
            <th colspan="2">추가장당(원)</th>
            <th rowspan="2">수량</th>
            <th rowspan="2">설치비</th>
            <th rowspan="2">월 렌탈료</th>
            <th rowspan="2">VAT</th>
          </tr>
          <tr><th>흑백</th><th>컬러</th><th>흑백</th><th>컬러</th></tr>
        </thead>
        <tbody id="ct-items-tbody">
          ${items.map((it, i) => itemRowHtml(it, i)).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="2" class="ct-deposit-cell">보증금</td>
            <td><input class="ct-input ed num" data-bind="deposit" type="number" value="${c.deposit || 0}"></td>
            <td colspan="5" class="ct-deposit-note">(기본 2개월치) / 최초설치비 : 무료</td>
            <td class="ct-total-label">합계금액</td>
            <td><input class="ct-input ed num" data-bind="total_fee" id="ct-total-input" type="number" value="${c.total_fee || 0}"></td>
            <td>VAT별도</td>
          </tr>
        </tfoot>
      </table>

      <table class="ct-tbl ct-tbl-terms">
        <colgroup><col style="width:8%"><col><col style="width:10%"></colgroup>
        ${DEFAULT_TERMS.map((t, i) => `
          <tr>
            ${i === 0 ? `<th rowspan="${DEFAULT_TERMS.length}" class="ct-vlabel">약<br>관</th>` : ''}
            <td class="ct-term-text">* ${escapeHtml(t)}</td>
            <td class="ct-check-cell">
              <label><input type="checkbox" data-bind="terms_checked.${i}" ${c.terms_checked?.[i] !== false ? 'checked' : ''}> 확인함 ■</label>
            </td>
          </tr>
        `).join('')}
        ${DEFAULT_EXTRAS.map((t, i) => `
          <tr>
            ${i === 0 ? `<th rowspan="${DEFAULT_EXTRAS.length}" class="ct-vlabel">기<br>타</th>` : ''}
            <td class="ct-term-text">▪ ${escapeHtml(t)}</td>
            <td class="ct-check-cell">
              <label><input type="checkbox" data-bind="extras_checked.${i}" ${c.extras_checked?.[i] !== false ? 'checked' : ''}> 확인함 ■</label>
            </td>
          </tr>
        `).join('')}
      </table>

      <table class="ct-tbl ct-tbl-docs">
        <colgroup><col style="width:18%"><col></colgroup>
        <tr>
          <th rowspan="3" class="ct-vlabel">구 비 서 류<br><span class="muted-small">(계약 당일 제출필수)</span></th>
          <td>▶ 본인인 경우: 1.신분증 사본 2.통장사본 3.사업자등록증 사본(사업자에 한함) 4.명함</td>
        </tr>
        <tr><td>▶ 신청인과 다른 경우: 대리인 신분증 포함</td></tr>
        <tr><td>▶ 법인인 경우: 1.대표자 신분증 사본 2.통장사본 3.사업자등록증 사본 4.요청자명함</td></tr>
      </table>

      <p class="ct-agree-text">한별시스템의 이용약관, 자동이체 신청동의 및 부가사항을 읽고 확인했으며, 위와 같이 프린터 임대서비스 이용을 신청합니다.</p>

      <p class="ct-date-line"><input class="ct-input ed date" type="date" data-bind="contract_date" value="${escapeAttr(c.contract_date)}"></p>

      <table class="ct-tbl ct-tbl-sign">
        <colgroup><col style="width:25%"><col><col style="width:25%"><col></colgroup>
        <tr>
          <th>컨설팅 담당자</th>
          <td class="ct-sign-cell">(인) 또는 서명</td>
          <th>서비스 공급자</th>
          <td>한별시스템</td>
        </tr>
      </table>
      <p class="ct-bank-line">대표번호 053-588-7119 [담당자 010-4585-6890]&nbsp;&nbsp;
        <input class="ct-input ed" data-bind="bank.name" value="${escapeAttr(c.bank?.name || '농협')}" style="width:60px">
        <input class="ct-input ed" data-bind="bank.acct" value="${escapeAttr(c.bank?.acct || '010-4585-6890-09')}" style="width:170px">
        <input class="ct-input ed" data-bind="bank.holder" value="${escapeAttr(c.bank?.holder || '김상환(한별시스템)')}" style="width:170px">
      </p>

      <div class="ct-page-footer no-print">— 페이지 1/3 —</div>
    </section>

    <!-- ============ 페이지 2: 이용약관 ============ -->
    <section class="contract-page ct-terms-page">
      <h2 class="ct-page-title">서비스 이용약관 V.1</h2>
      <p class="ct-terms-pre">
        <strong class="ct-pre-company">${escapeHtml(c.company || '(임차인)')}</strong> (이하 "갑"이라 한다)와<br>
        한별시스템(이하 "을"이라 한다)은 "을" 소유 복사기의 임대차계약을 다음과 같이 체결한다.
      </p>

      <h4>제1조【계약의 목적】</h4>
      <p>"을" 소유의 복사기를 "갑"에게 임대하고 "갑"은 이를 임차하여 임대료를 지급할 것을 약정한다.</p>

      <h4>제2조【계약기간】</h4>
      <ol>
        <li>본 임대차의 계약기간은 계약서 표지에서 정한 바에 따른다.</li>
        <li>기간만료 전 1개월 전까지 서면의 의한 계약종료의 의사표시를 하지 않는 한 계약기간은 1년간 자동적으로 갱신된다.</li>
      </ol>

      <h4>제3조【복사기의 인도/철거】</h4>
      <ol>
        <li>'갑'은 '을'이 지정하는 장소에서 '을' 또는 '을'이 지정하는 자에게 물품을 인도하기로 하며, 인도 및 철거에 소요되는 제비용은 '을'이 부담한다.</li>
      </ol>
      <p class="ct-note">※ 단, 레이저프린터와 복사기의 인도 및 철거에 소요되는 제비용은 설치비 및 철거비 각 10만원, 등록비 20만원으로 한다.</p>

      <h4>제4조【유지보수】</h4>
      <p>"을" 소유의 복사기를 "갑"에게 임대함에 있어 계약기간 중 복사기를 양호한 상태로 유지시키기 위하여 "을"의 책임 하에 다음 각 호의 유지보수를 행한다.</p>
      <ol>
        <li>"을"은 렌탈복사기에 대한 보수 및 점검을 실시하여 소모품 및 부품의 교환 또는 수리를 하여 최상의 운용 상태와 충분한 기능을 발휘할 수 있도록 한다.</li>
        <li>"을"은 복사용지를 제외한 부품 및 소모품을 무상공급 A/S를 한다. 단, 천재지변은 예외로 한다.</li>
        <li>복사기의 고장 등 기능 이상 시 "을"은 즉시 사용 가능한 상태로 조치한다.</li>
        <li>유지보수 시간은 '갑'의 근무시간 내로 한다.</li>
      </ol>

      <h4>제5조【준수사항】</h4>
      <ol>
        <li>"갑"은 "을"의 복사기에 대해 제3자 등 어떠한 권리도 설정하지 않을 것을 확약한다.</li>
        <li>"갑"은 복사기를 임의로 개조하거나 제3자에게 대여할 수 없다.</li>
        <li>"갑"은 "을"과의 서면합의 없이 임대장소(설치장소)를 변경할 수 없다.</li>
        <li>"갑"은 회사 이전 혹은 이사로 인한 이전설치 요구시 비용이 발생된다.</li>
      </ol>

      <h4>제6조【물품의 회수 및 반환】</h4>
      <ol>
        <li>'갑'이 물품회수를 요청할 경우, '갑'의 미납요금과 위약금 그리고 추가청구 금액 등의 미납금액이 모두 결제가 완료 된 후에 물품을 회수한다.</li>
        <li>임대 만기 이후 보증금은 고객에게 반환된다.</li>
      </ol>

      <h4>제7조【임대료】</h4>
      <ol>
        <li>렌탈계약서에 기재된 약정계약기간 동안 렌탈할 것을 전제로 월 렌탈료를 정한다.</li>
        <li>초기 1회분 입금 이후 렌탈계약서에 표기된 약정일에 '갑'이 지정하는 계좌로부터 '을'의 계좌로 자동이체 한다.</li>
        <li>"갑"이 위 1항의 임대료의 지급을 2회 이상 연속하여 연체하였을 때에는 "을"은 사전 최고 없이 이 계약을 해지할 수 있다. 해지통지를 받았을 때 "갑"은 7일 이내에 복사기를 "을"에게 반환 한다.</li>
        <li>자동이체 미출금 시 매 2일 단위로 재출금을 요청하며 최대 3번까지 청구한다. 지정계좌에 잔액부족 및 기타 사유로 인한 렌탈료 미납 시에는 자동이체약관에 의거하여 처리한다.</li>
        <li>임대료 선금과 추가요금 후불로 처리된다. 자동이체 출금시 추가된 요금이 자동출금 된다.</li>
        <li>"갑"이 위 3항을 진행함과 동시에 개인정보를 제3자에게 제공한다. (1.개인정보 제공받는자: 채권추심팀 / 2.수집항목: 이름, 연락처, 은행명, 계좌번호, 예금주명, 주민번호 앞자리)</li>
      </ol>

      <h4>제8조【계약의 중도 해지】</h4>
      <ol>
        <li>'갑'에게 다음 각호의 사유가 발생한 때에 '을'은 사전 최고 없이 계약을 해지할 수 있다.
          <ol type="1">
            <li>렌탈료의 납부를 2회 이상 연체한 때</li>
            <li>어음 또는 수표가 부도되어 은행의 거래정지 처분이 있거나 조세공과금의 체납으로 독촉 또는 체납처분을 받은 때</li>
            <li>사업이 휴업 또는 폐업되거나 회사가 해산한 때 또는 파산, 화의, 정리 등을 신청하거나 기타 신용을 상실한 때</li>
            <li>물품을 제3자에게 양도, 담보제공, 처분, 임대 또는 점유를 이전한 때</li>
            <li>이 계약의 내용을 위반하여 '갑'의 구두 또는 서면 최고를 받고도 7일 이내에 시정하지 아니한 때</li>
          </ol>
        </li>
        <li>계약이 중도 해지되는 경우 '을'은 '갑'에게 계약서상에 기재된 위약금을 지불하여야 한다.
          <p class="ct-note">[남은기간 50% + 설치비 + 철거비 + 등록비] 청구 된다. 중도 해지일이 약정기간 이내인 경우 '을'이 지불한 보증금은 '갑'에게 귀속된다.</p>
        </li>
      </ol>

      <h4>제9조【연체료 및 지연배상금】</h4>
      <ol>
        <li>렌탈료 납부의무 이행을 지연한 경우 '을'의 법무팀 또는 채권팀에서 '갑'의 렌탈료 납부의무 이행을 촉구하기 위하여 계약서에 기재된 연락처로 연락을 취할 수 있다.</li>
        <li>'을'이 이 계약에 따라 '갑'에게 이행하여야 할 채무를 불이행할 경우 이행의무가 발생한 날부터 완제하는 날까지 채무액에 대하여 연 24%의 지연 이자를 부가하여 납부하여야 한다.</li>
        <li>전 2항의 연체료 및 지연이자는 따로 일괄하여 일할 계산하되 1년은 365일로 하여 백원미만은 버린다.</li>
      </ol>

      <h4>제10조【분쟁의 해결】</h4>
      <p>본 계약과 관련하여 발생하는 모든 분쟁은 "갑"과 "을"이 협의하여 해결한다. 단, 본 계약으로 인한 분쟁이 발생하여 소송이 필요한 경우 주소지 관할법원으로 한다.</p>

      <div class="ct-page-footer no-print">— 페이지 2/3 —</div>
    </section>

    <!-- ============ 페이지 3: 자동이체 약관 + 부가사항 + 특약 ============ -->
    <section class="contract-page ct-terms-page">
      <h2 class="ct-page-title">자동이체 약관</h2>
      <ol class="ct-cms-list">
        <li>예금주는 렌탈료 납입 약정일을 기준으로 대출금융기관이 지정하는 계좌이체일(휴일인 경우 익일 영업일)에 대출금융기관에서 청구하는 금액을 본인계좌에서 출금하여 납부할 것을 약속합니다.</li>
        <li>자동납부를 위하여 지정계좌의 예금을 출금함에 있어 예금약관이나 약정시의 규정에 불구하고 예금청구나 수표 없이 금융기관이 자동 계좌 이체 절차에 의하여 출금하여도 이의가 없습니다.</li>
        <li>약정일이 동일한 다수의 자동이체 청구가 있는 경우 출금 우선순위는 금융기관 임의로 정하여도 이의가 없습니다.</li>
        <li>본 자동납부 신청에 의한 이체개시일은 대출금융기관의 사정에 의하여 조정될 수 있습니다.</li>
        <li>자동납부신청에 의한 지정계좌에서 출금은 대출금융기관의 청구대로 출금하되 청구금액에 이의가 있을 경우에는 본인의 책임하에 대출금융기관과 직접 협의 조정하겠습니다.</li>
        <li>자동납부금액은 해당 납부일에 정하여진 은행 영업시간 내에 입금된 예금에 한하여 출금 처리되며, 약정일에 지정계좌의 잔고부족 시에는 매 2일 단위로 재 출금을 시도합니다.</li>
        <li>미수금은 계약기간이 종료된 후라도 자동이체로 출금 처리됩니다.</li>
        <li>미사용 계좌를 자동이체 신청하여 출금 오류가 2회 이상 반복될 경우 오류에 대한 책임으로써 비용을 청구할 수 있습니다.</li>
      </ol>

      <h2 class="ct-page-title" style="margin-top:14mm;">부가사항</h2>
      <ol class="ct-cms-list">
        <li>잉크젯의 경우 월 제공매수(한면)에 해당하는 기본 월 렌탈료는 월납 선불제이며 월 초과출력에 대한 초과 렌탈료는 조회 시점에 일괄 후불 청구되며 모든 렌탈료(기본 월 렌탈료 및 월 초과 렌탈료)는 자동이체로 처리된다.</li>
        <li>잉크젯의 경우 월 제공매수(한면)는 '을'이 기본 월 사용량을 확인한 후 선택하여 신청하기 때문에 출력량은 매월 조회 하지 않고 기기변경 및 교체, A/S 등으로 방문할 경우 또는 명의변경 및 재계약 등의 사유 발생시 일괄 조회한다.</li>
        <li>복사기의 경우 매월 자동관리 프로그램으로 월별 관리가 들어가며, 추가요금 발생시 자동이체로 추가요금이 정산됩니다.</li>
      </ol>

      <h2 class="ct-page-title" style="margin-top:14mm;">제11조【특약사항】</h2>
      <ol class="ct-special">
        <li><input class="ct-input ed wide" data-bind="special.0" value="${escapeAttr((c.special || [])[0] || '')}" placeholder="특약사항 1"></li>
        <li><input class="ct-input ed wide" data-bind="special.1" value="${escapeAttr((c.special || [])[1] || '')}" placeholder="특약사항 2 (없으면 비워두세요)"></li>
      </ol>

      <p class="ct-end-text">이를 증명하기 위해 "갑"과 "을"은 계약서 2통을 작성하여, 각각 서명날인 후 각1통씩을 보관한다.</p>

      <table class="ct-tbl ct-tbl-final-sign">
        <colgroup><col style="width:25%"><col></colgroup>
        <tr>
          <th>임차인 (갑)</th>
          <td class="ct-sign-cell"><strong class="ct-sign-name">${escapeHtml(c.company || '')}</strong> &nbsp;&nbsp; (인)</td>
        </tr>
        <tr>
          <th>임대인 (을)</th>
          <td class="ct-sign-cell"><strong>한별시스템</strong> &nbsp;&nbsp; (인)</td>
        </tr>
      </table>

      <div class="ct-page-footer no-print">— 페이지 3/3 —</div>
    </section>
  `;
  $('#contract-doc').innerHTML = html;
  bindFormEvents();
  recalcTotal();
}

function itemRowHtml(it, i) {
  return `
    <tr data-item="${i}">
      ${i === 0 ? `<th rowspan="4" class="ct-vlabel">계<br>약<br>내<br>용</th>` : ''}
      <td class="ct-num">${i + 1}</td>
      <td><input class="ct-input ed" data-item-field="product" value="${escapeAttr(it.product)}" placeholder="모델명"></td>
      <td><input class="ct-input ed num" data-item-field="bw_free" type="number" value="${it.bw_free || 0}"></td>
      <td><input class="ct-input ed num" data-item-field="co_free" type="number" value="${it.co_free || 0}"></td>
      <td><input class="ct-input ed num" data-item-field="bw_rate" type="number" value="${it.bw_rate || 0}"></td>
      <td><input class="ct-input ed num" data-item-field="co_rate" type="number" value="${it.co_rate || 0}"></td>
      <td><input class="ct-input ed num qty" data-item-field="qty" type="number" value="${it.qty || 0}"></td>
      <td><input class="ct-input ed" data-item-field="install" value="${escapeAttr(it.install)}" placeholder="무료"></td>
      <td><input class="ct-input ed num" data-item-field="fee" type="number" value="${it.fee || 0}"></td>
      <td><input class="ct-input ed" data-item-field="vat_note" value="${escapeAttr(it.vat_note)}"></td>
    </tr>
  `;
}

function padItems(items) {
  const out = items.slice(0, 4).map((it, i) => ({ no: i+1, ...it }));
  while (out.length < 4) out.push({ no: out.length+1, product: '', bw_free: 0, co_free: 0, bw_rate: 0, co_rate: 0, qty: 0, install: '', fee: 0, vat_note: '' });
  return out;
}

function bindFormEvents() {
  // 합계 자동 계산
  document.querySelectorAll('[data-item-field="fee"]').forEach(el => {
    el.addEventListener('input', recalcTotal);
  });
  // 회사명 변경 → 페이지 2,3 갑 이름 동기화
  const companyInput = document.querySelector('[data-bind="company"]');
  if (companyInput) {
    companyInput.addEventListener('input', e => {
      const v = e.target.value;
      const top = document.querySelector('[data-bind="company_top"]');
      if (top && !top.dataset.userEdited) top.value = v;
      const pre = document.querySelector('.ct-pre-company');
      if (pre) pre.textContent = v || '(임차인)';
      const sign = document.querySelector('.ct-sign-name');
      if (sign) sign.textContent = v || '';
    });
  }
  const topInput = document.querySelector('[data-bind="company_top"]');
  if (topInput) topInput.addEventListener('input', () => topInput.dataset.userEdited = '1');
}

function recalcTotal() {
  let total = 0;
  document.querySelectorAll('[data-item-field="fee"]').forEach(el => {
    total += parseFloat(el.value) || 0;
  });
  const totalInput = $('#ct-total-input');
  if (totalInput && !totalInput.dataset.userEdited) totalInput.value = total;
}

// ============================================================
// 폼 → 데이터 수집
// ============================================================
function collectFormData() {
  const c = ctState.selectedId
    ? JSON.parse(JSON.stringify(store.data.contracts[ctState.selectedId]))
    : blankContract();

  c.terms_checked  = c.terms_checked  || [true, true, true, true, true];
  c.extras_checked = c.extras_checked || [true, true, true, true];
  c.special        = c.special        || ['', ''];
  c.bank           = c.bank           || {};

  document.querySelectorAll('[data-bind]').forEach(el => {
    const key = el.dataset.bind;
    let val;
    if (el.type === 'checkbox') val = el.checked;
    else if (el.type === 'number') val = parseFloat(el.value) || 0;
    else val = el.value;

    const parts = key.split('.');
    let obj = c;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      const next = parts[i+1];
      if (!obj[p] || typeof obj[p] !== 'object') {
        obj[p] = /^\d+$/.test(next) ? [] : {};
      }
      obj = obj[p];
    }
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(last)) obj[parseInt(last)] = val;
    else obj[last] = val;
  });

  c.items = [];
  document.querySelectorAll('[data-item]').forEach((tr, i) => {
    const item = { no: i + 1 };
    tr.querySelectorAll('[data-item-field]').forEach(el => {
      const f = el.dataset.itemField;
      item[f] = el.type === 'number' ? (parseFloat(el.value) || 0) : el.value;
    });
    c.items.push(item);
  });

  return c;
}

function saveCurrentContract() {
  const c = collectFormData();

  if (!c.company || !c.company.trim()) {
    alert('회사상호를 입력해주세요.');
    return;
  }

  const now = nowIso();
  if (!c.id || !ctState.selectedId) {
    c.id = 'ct_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    c.created_at = now;
  }
  c.updated_at = now;

  if (!c.customer_id) {
    const norm = normalizeName(c.company);
    for (const [cid, cust] of Object.entries(store.data.customers)) {
      if (normalizeName(cust.company) === norm) {
        c.customer_id = cid; break;
      }
    }
  }

  store.data.contracts[c.id] = c;
  store.save();
  ctState.selectedId = c.id;

  setStatus(`✅ 저장됨 — ${c.company} (${fmtDate(c.updated_at)})`);
  renderContractList();
}

function deleteCurrentContract() {
  if (!ctState.selectedId) {
    alert('선택된 계약서가 없습니다.');
    return;
  }
  const c = store.data.contracts[ctState.selectedId];
  if (!c) return;
  if (!confirm(`"${c.company}" 계약서를 삭제하시겠습니까?\n\n이 작업은 되돌릴 수 없습니다.`)) return;
  delete store.data.contracts[ctState.selectedId];
  store.save();
  ctState.selectedId = null;
  renderContractList();
  renderEmptyDoc();
  setStatus('삭제되었습니다');
}

// ============================================================
// 거래처에서 자동 채우기
// ============================================================
function openCustomerPicker() {
  const tpl = document.getElementById('tpl-customer-pick');
  const node = tpl.content.cloneNode(true);
  showModal(node);

  const list = $('#cp-list');
  const all = Object.values(store.data.customers).sort((a,b) => (a.company||'').localeCompare(b.company||'', 'ko'));
  function render(filter = '') {
    const f = filter.toLowerCase().trim();
    const filtered = f ? all.filter(c =>
      (c.company || '').toLowerCase().includes(f) || (c.address || '').toLowerCase().includes(f)
    ) : all;
    list.innerHTML = filtered.slice(0, 200).map(c => `
      <div class="cp-row" data-cid="${c.id}">
        <strong>${escapeHtml(c.company)}</strong>
        <span class="muted-small">${escapeHtml(c.address || '')}</span>
      </div>
    `).join('') || '<div class="muted-small" style="text-align:center;padding:20px;">결과 없음</div>';
    list.querySelectorAll('.cp-row').forEach(row => {
      row.addEventListener('click', () => {
        fillFromCustomer(store.data.customers[row.dataset.cid]);
        closeModal();
      });
    });
  }
  render();
  $('#cp-search').addEventListener('input', e => render(e.target.value));
  setTimeout(() => $('#cp-search')?.focus(), 50);
}

function fillFromCustomer(cust) {
  if (!cust) return;
  const isEditing = !!ctState.selectedId || $('#contract-doc .contract-page');

  if (!isEditing || !$('#contract-doc .contract-page')) {
    const blank = blankContract();
    blank.company = cust.company || '';
    blank.company_top = cust.company || '';
    blank.address = cust.address || '';
    blank.mobile = cust.phone || '';
    blank.tel_fax = cust.fax || '';
    blank.email = cust.email || '';
    blank.biz_no = cust.biz_no || '';
    blank.requester = cust.ceo || '';
    blank.customer_id = cust.id;
    if (cust.base_fee) {
      blank.items[0].fee = cust.base_fee;
      blank.items[0].bw_free = cust.bw_free || 0;
      blank.items[0].co_free = cust.co_free || 0;
      blank.items[0].bw_rate = cust.bw_rate || 0;
      blank.items[0].co_rate = cust.co_rate || 0;
      blank.total_fee = cust.base_fee;
    }
    renderDoc(blank);
    setStatus(`거래처 "${cust.company}" 정보로 새 계약서를 작성합니다 — 저장 버튼을 눌러주세요`);
    return;
  }

  const setField = (bind, val) => {
    const el = document.querySelector(`[data-bind="${bind}"]`);
    if (el && val) {
      el.value = val;
      el.dispatchEvent(new Event('input'));
    }
  };
  setField('company', cust.company);
  setField('company_top', cust.company);
  setField('address', cust.address);
  setField('mobile', cust.phone);
  setField('tel_fax', cust.fax);
  setField('email', cust.email);
  setField('biz_no', cust.biz_no);
  setField('requester', cust.ceo);
  setStatus(`거래처 "${cust.company}" 정보를 신청정보에 채웠습니다 — 저장하지 않으면 사라집니다`);
}

// ============================================================
// 시드 가져오기 (NAS 세부현황 242건)
// ============================================================
function importContractSeed() {
  const seed = window.RENTAL_SEED;
  if (!seed || !seed.contracts) {
    alert('시드 데이터가 없습니다.\ntools/build_seed.py 실행 후 다시 시도하세요.');
    return;
  }
  const seedContracts = Object.values(seed.contracts);
  const existCount = Object.keys(store.data.contracts || {}).length;
  if (!confirm(
    `📋 NAS 세부현황 ${seedContracts.length}건의 계약서를 가져옵니다.\n\n` +
    `현재 보관 ${existCount}건 (회사명 동일 시 갱신, 신규는 추가).\n\n` +
    `계속하시겠습니까?`
  )) return;

  let added = 0, updated = 0;
  for (const sc of seedContracts) {
    const existId = Object.entries(store.data.contracts).find(
      ([id, c]) => normalizeName(c.company) === normalizeName(sc.company)
    )?.[0];

    const now = nowIso();
    const ct = {
      ...sc,
      contract_months: sc.contract_months || 36,
      pay_day: sc.pay_day || 25,
      terms_checked: sc.terms_checked || [true, true, true, true, true],
      extras_checked: sc.extras_checked || [true, true, true, true],
      special: sc.special && sc.special.length ? sc.special : ['', ''],
      bank: sc.bank || { name: '농협', acct: '010-4585-6890-09', holder: '김상환(한별시스템)' },
      updated_at: now,
    };
    if (existId) {
      ct.id = existId;
      ct.created_at = store.data.contracts[existId].created_at || now;
      store.data.contracts[existId] = ct;
      updated++;
    } else {
      ct.id = sc.id || ('ct_' + Date.now().toString(36) + Math.random().toString(36).slice(2,5));
      ct.created_at = now;
      store.data.contracts[ct.id] = ct;
      added++;
    }
  }
  store.save();
  alert(`✅ 시드 가져오기 완료\n· 신규: ${added}건\n· 갱신: ${updated}건\n\n좌측 목록에서 확인하세요.`);
  renderContractList();
}

// ============================================================
// 유틸
// ============================================================
function escapeAttr(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function normalizeName(s) {
  if (!s) return '';
  return String(s).replace(/[\s()\-_/\.,\n]+/g, '').toLowerCase();
}
