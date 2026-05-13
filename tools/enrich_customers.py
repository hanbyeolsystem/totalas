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
OUT  = ROOT / 'tools' / 'sql' / '15_enrich_customers_fuzzy.sql'
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
    # biz_no 중복 제거
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
        '-- 15_enrich_customers_fuzzy.sql  (auto from customers_list.pdf)',
        '-- 3-pass 매칭으로 임대거래처 정보 보강.',
        '-- 정책: 신규 INSERT 없음, NULL 필드만 COALESCE.',
        '--      이미 입력된 값은 절대 덮어쓰지 않음.',
        '-- ============================================================',
        '',
        'CREATE EXTENSION IF NOT EXISTS pg_trgm;',
        '',
        '-- 1) PDF 데이터 적재',
        'CREATE TEMP TABLE _pdf_customers (',
        '  norm_company TEXT,',
        '  ceo          TEXT,',
        '  biz_no       TEXT,',
        '  mobile       TEXT,',
        '  phone        TEXT',
        ') ON COMMIT DROP;',
        '',
        'INSERT INTO _pdf_customers (norm_company, ceo, biz_no, mobile, phone) VALUES',
    ]
    val_rows = []
    for r in rows:
        if not r.get('company'): continue
        norm = norm_company(r['company'])
        val_rows.append(
            f"({sql_str(norm)}, {sql_str(r.get('ceo'))}, "
            f"{sql_str(r.get('biz_no'))}, {sql_str(r.get('mobile'))}, "
            f"{sql_str(r.get('phone1'))})"
        )
    lines.append(',\n'.join(val_rows))
    lines.append(';')
    lines.append('')
    lines.append('-- 2) 정규화 핵심 회사명 추출 함수 (접두·공백·기호 제거)')
    lines.append("CREATE OR REPLACE FUNCTION _ext_core(name TEXT) RETURNS TEXT AS $f$")
    lines.append('DECLARE s TEXT;')
    lines.append('BEGIN')
    lines.append('  IF name IS NULL THEN RETURN NULL; END IF;')
    lines.append('  s := lower(name);')
    lines.append("  s := regexp_replace(s, '주식회사|유한회사|\\(주\\)|㈜|\\(사\\)|㈐|\\(복\\)|\\(재\\)|\\(유\\)', '', 'g');")
    lines.append("  s := regexp_replace(s, '[\\s·\\-\\.]+', '', 'g');")
    lines.append('  RETURN s;')
    lines.append('END;')
    lines.append('$f$ LANGUAGE plpgsql IMMUTABLE;')
    lines.append('')
    lines.append('-- ==== PASS 1: norm_company 완전 일치 (14 와 동일) ====')
    lines.append('UPDATE rental_customers AS rc SET')
    lines.append('  contact_name = COALESCE(rc.contact_name, p.ceo),')
    lines.append('  biz_no       = COALESCE(rc.biz_no,       p.biz_no),')
    lines.append('  mobile       = COALESCE(rc.mobile,       p.mobile),')
    lines.append('  phone        = COALESCE(rc.phone,        p.phone)')
    lines.append('FROM _pdf_customers AS p')
    lines.append("WHERE replace(replace(replace(lower(rc.company),' ',''),'㈜','(주)'),'㈐','(사)') = p.norm_company;")
    lines.append('')
    lines.append('-- ==== PASS 2: 핵심 회사명 (접두 제거) 완전 일치 ====')
    lines.append('WITH pdf_core AS (')
    lines.append('  SELECT DISTINCT ON (_ext_core(norm_company))')
    lines.append('    _ext_core(norm_company) AS core, ceo, biz_no, mobile, phone')
    lines.append('  FROM _pdf_customers')
    lines.append('  WHERE LENGTH(_ext_core(norm_company)) >= 3')
    lines.append('  ORDER BY _ext_core(norm_company), ceo NULLS LAST')
    lines.append(')')
    lines.append('UPDATE rental_customers AS rc SET')
    lines.append('  contact_name = COALESCE(rc.contact_name, p.ceo),')
    lines.append('  biz_no       = COALESCE(rc.biz_no,       p.biz_no),')
    lines.append('  mobile       = COALESCE(rc.mobile,       p.mobile),')
    lines.append('  phone        = COALESCE(rc.phone,        p.phone)')
    lines.append('FROM pdf_core AS p')
    lines.append('WHERE _ext_core(rc.company) = p.core')
    lines.append('  AND (rc.contact_name IS NULL OR rc.biz_no IS NULL OR rc.mobile IS NULL OR rc.phone IS NULL);')
    lines.append('')
    lines.append('-- ==== PASS 3: trigram 유사도 ≥ 0.6 (이미 절반 이상 보강된 행 skip) ====')
    lines.append('WITH pdf_pool AS (')
    lines.append('  SELECT _ext_core(norm_company) AS core, ceo, biz_no, mobile, phone')
    lines.append('  FROM _pdf_customers')
    lines.append('  WHERE LENGTH(_ext_core(norm_company)) >= 3')
    lines.append('), candidates AS (')
    lines.append('  SELECT DISTINCT ON (rc.id)')
    lines.append('    rc.id, p.ceo, p.biz_no, p.mobile, p.phone,')
    lines.append('    similarity(_ext_core(rc.company), p.core) AS sim')
    lines.append('  FROM rental_customers rc')
    lines.append('  JOIN pdf_pool p ON similarity(_ext_core(rc.company), p.core) >= 0.6')
    lines.append('  WHERE rc.active = TRUE')
    lines.append('    AND (rc.contact_name IS NULL AND rc.biz_no IS NULL)')
    lines.append('  ORDER BY rc.id, sim DESC')
    lines.append(')')
    lines.append('UPDATE rental_customers AS rc SET')
    lines.append('  contact_name = COALESCE(rc.contact_name, c.ceo),')
    lines.append('  biz_no       = COALESCE(rc.biz_no,       c.biz_no),')
    lines.append('  mobile       = COALESCE(rc.mobile,       c.mobile),')
    lines.append('  phone        = COALESCE(rc.phone,        c.phone)')
    lines.append('FROM candidates AS c')
    lines.append('WHERE rc.id = c.id;')
    lines.append('')
    lines.append('DROP FUNCTION IF EXISTS _ext_core(TEXT);')
    lines.append('')
    lines.append('-- 확인')
    lines.append('SELECT')
    lines.append("  (SELECT COUNT(*) FROM rental_customers WHERE active=TRUE)                              AS total_active,")
    lines.append("  (SELECT COUNT(*) FROM rental_customers WHERE contact_name IS NOT NULL AND active)      AS with_ceo,")
    lines.append("  (SELECT COUNT(*) FROM rental_customers WHERE biz_no IS NOT NULL AND active)            AS with_biz,")
    lines.append("  (SELECT COUNT(*) FROM rental_customers WHERE mobile IS NOT NULL AND active)            AS with_mobile,")
    lines.append("  (SELECT COUNT(*) FROM rental_customers WHERE phone IS NOT NULL AND active)             AS with_phone")
    lines.append(';')
    OUT.write_text('\n'.join(lines), encoding='utf-8')
    print(f"wrote {OUT.name}  ({len(rows)} rows)")

if __name__ == '__main__':
    main()
