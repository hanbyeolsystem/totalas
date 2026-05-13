"""
rental-customers/customers_list.pdf → DB 보강용 SQL 생성.

전략:
- 기존 rental_customers 에 있는 회사명은 비어 있는 필드만 COALESCE 로 보강
- 없는 회사는 신규 INSERT
- 이미 입력된 값은 절대 덮어쓰지 않음 (사용자 요청)
"""
import re, json, sys, io
from pathlib import Path
import fitz

sys.stdout.reconfigure(encoding='utf-8')

ROOT = Path(__file__).resolve().parents[1]
PDF  = ROOT / 'rental-customers' / 'customers_list.pdf'
OUT  = ROOT / 'tools' / 'sql' / '14_enrich_customers.sql'
PEEK = ROOT / 'tools' / '_enrich_peek.json'

# PDF 컬럼 라벨 (페이지 헤더에 보이는 항목들)
HEADERS = {'번호','장 부 명','장부명','사업자번호','대표자','핸드폰','전화 1','전화 2','전화1','전화2','팩스','담당자','비 고','비고'}

def parse_pdf():
    """ PyMuPDF 텍스트는 컬럼 순서(위→아래)로 떨어짐:
        한 행의 셀들이 [대표자, 사업자번호, 회사명, 번호] 로 연속 출현,
        그 뒤 [핸드폰, 전화1, 전화2, 팩스, 담당자, 비고] 가 다음 행 셀 사이에 끼어듬.
        가장 확실한 anchor 는 사업자번호 (XXX-XX-XXXXX).
        규칙: biz_no 발견 시 → 직전 1줄 = ceo, 직후 1줄 = company, 직후 2줄 = no.
              그 다음 행의 biz_no 등장 전까지의 phone-like 라인들을 분배.
    """
    doc = fitz.open(str(PDF))
    rows = []
    BIZ_RE   = re.compile(r'^\d{3}-\d{2}-\d{5}$')
    NUM_RE   = re.compile(r'^\d{1,5}$')
    # 010-1234-5678 / 053-583-2909 / 053)583-2909 / 041)428-9470 / 053)585-8888
    PHONE_RE = re.compile(r'^(0\d{1,2}[)\-]\s?\d{3,4}-?\d{4})$')
    SKIP_KEYWORDS = ('한별시스템','거래처 장부 리스트','페이지:','출력일자','담당자','대표자','사업자번호','핸드폰','전화','팩스','비 고','비고','장 부 명','장부명','번호')

    for pno, page in enumerate(doc):
        lines = [ln.strip() for ln in page.get_text().split('\n') if ln.strip()]
        # 헤더(상단 박스) 끝까지 스킵
        skip_until = 0
        for idx, ln in enumerate(lines):
            if BIZ_RE.match(ln):
                skip_until = idx
                break
        # 데이터 본문 = lines[skip_until:]
        body = lines[skip_until-1:]  # ceo 가 biz_no 한 줄 앞이므로 -1 부터

        # biz_no 위치들 수집
        biz_idx = [i for i, ln in enumerate(body) if BIZ_RE.match(ln)]

        for j, bi in enumerate(biz_idx):
            cur = { 'biz_no': body[bi] }
            # 직전 1줄: ceo (한글 2~5자)
            if bi >= 1:
                prev = body[bi-1]
                if re.fullmatch(r'[가-힣]{2,6}', prev) and not any(k in prev for k in SKIP_KEYWORDS):
                    cur['ceo'] = prev
            # 직후 1줄: company
            if bi + 1 < len(body):
                comp = body[bi+1]
                if not BIZ_RE.match(comp) and comp not in SKIP_KEYWORDS:
                    cur['company'] = comp
            # 직후 2줄: 번호
            if bi + 2 < len(body):
                no = body[bi+2]
                if NUM_RE.match(no) and len(no) <= 5:
                    cur['no'] = no
            # 이 biz_no 와 다음 biz_no 사이의 phone-like 줄 분배
            next_bi = biz_idx[j+1] if j+1 < len(biz_idx) else len(body)
            phones = []
            for k in range(bi+3, next_bi-1 if j+1 < len(biz_idx) else next_bi):
                ln = body[k]
                if PHONE_RE.match(ln):
                    phones.append(ln)
            # 한별 시스템 PDF 컬럼: 핸드폰 / 전화1 / 전화2 / 팩스 (헤더 순)
            # mobile(010-) 분리, 나머지는 phone1/phone2/fax
            mobiles = [p for p in phones if p.startswith('010')]
            others  = [p for p in phones if not p.startswith('010')]
            if mobiles: cur['mobile'] = mobiles[0]
            if len(others) >= 1: cur['phone1'] = others[0]
            if len(others) >= 2: cur['phone2'] = others[1]
            if len(others) >= 3: cur['fax']    = others[2]
            if cur.get('company') and cur.get('biz_no'):
                rows.append(cur)

    return rows

def norm_company(s):
    if not s: return ''
    s = re.sub(r'\s+', '', s)
    s = s.replace('㈜', '(주)').replace('㈐', '(사)')
    return s.lower()

def sql_str(s):
    if s is None or s == '': return 'NULL'
    return "'" + str(s).replace("'", "''") + "'"

def main():
    rows = parse_pdf()
    # 중복 biz_no 제거 (1행만 유지)
    seen = set()
    uniq = []
    for r in rows:
        b = r.get('biz_no')
        if b and b not in seen:
            seen.add(b); uniq.append(r)
    rows = uniq
    PEEK.write_text(json.dumps({'count': len(rows), 'sample': rows[:8]}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"PDF에서 {len(rows)} 행 추출 (biz_no 중복 제거)")

    lines = [
        '-- ============================================================',
        '-- 14_enrich_customers.sql  (auto from rental-customers/customers_list.pdf)',
        '-- 한별 거래처 장부 1500여건을 rental_customers 에 UPSERT.',
        '-- 정책: biz_no 기준 충돌 시 NULL 인 필드만 COALESCE 로 채움.',
        '--      기존 데이터는 절대 덮어쓰지 않음.',
        '-- ============================================================',
        '',
        '-- 1) biz_no UNIQUE 제약 (이미 있으면 무시)',
        'DO $$ BEGIN',
        "  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rental_customers_biz_no_uniq') THEN",
        '    -- 기존 중복 biz_no 가 있으면 가장 오래된 1건만 남기고 archive',
        "    UPDATE rental_customers AS rc SET active=false,",
        "      archived_at=now(), archived_reason='중복 사업자번호 통합'",
        '      WHERE id IN (',
        '        SELECT id FROM (',
        '          SELECT id, biz_no, ROW_NUMBER() OVER (PARTITION BY biz_no ORDER BY created_at) rn',
        '          FROM rental_customers WHERE biz_no IS NOT NULL',
        '        ) t WHERE rn > 1',
        '      );',
        '    ALTER TABLE rental_customers',
        '      ADD CONSTRAINT rental_customers_biz_no_uniq UNIQUE (biz_no);',
        '  END IF;',
        'END $$;',
        '',
        '-- 2) 마스터 거래처 INSERT (biz_no 충돌 시 COALESCE 보강)',
        'INSERT INTO rental_customers (id, company, contact_name, biz_no, mobile, phone, active) VALUES',
    ]
    val_rows = []
    for idx, r in enumerate(rows):
        if not r.get('biz_no'): continue
        cid_seed = f"c_pdf_{idx+1:05d}"
        val_rows.append(
            f"({sql_str(cid_seed)}, {sql_str(r.get('company'))}, "
            f"{sql_str(r.get('ceo'))}, {sql_str(r['biz_no'])}, "
            f"{sql_str(r.get('mobile'))}, {sql_str(r.get('phone1'))}, TRUE)"
        )
    lines.append(',\n'.join(val_rows))
    lines.append('ON CONFLICT (biz_no) DO UPDATE SET')
    lines.append('  company      = COALESCE(rental_customers.company,      EXCLUDED.company),')
    lines.append('  contact_name = COALESCE(rental_customers.contact_name, EXCLUDED.contact_name),')
    lines.append('  mobile       = COALESCE(rental_customers.mobile,       EXCLUDED.mobile),')
    lines.append('  phone        = COALESCE(rental_customers.phone,        EXCLUDED.phone)')
    lines.append(';')
    lines.append('')
    lines.append('-- 확인')
    lines.append("SELECT COUNT(*) AS total,")
    lines.append("       COUNT(contact_name) AS with_ceo,")
    lines.append("       COUNT(biz_no) AS with_biz,")
    lines.append("       COUNT(mobile) AS with_mobile,")
    lines.append("       COUNT(phone) AS with_phone")
    lines.append("  FROM rental_customers WHERE active=TRUE;")
    OUT.write_text('\n'.join(lines), encoding='utf-8')
    print(f"wrote {OUT.name}  ({len(rows)} rows)")

if __name__ == '__main__':
    main()
