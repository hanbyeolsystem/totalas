"""
15 SQL 을 2개로 분할 (Supabase SQL Editor 100KB 제한 회피).

15a_load.sql  → _pdf_staging (non-temp) 테이블 생성 + 1538행 INSERT 배치
15b_match.sql → 3-pass 매칭 + staging 테이블 DROP
"""
import re, sys, io, json
from pathlib import Path
import fitz

sys.stdout.reconfigure(encoding='utf-8')

ROOT  = Path(__file__).resolve().parents[1]
PDF   = ROOT / 'rental-customers' / 'customers_list.pdf'
OUT_A = ROOT / 'tools' / 'sql' / '15a_load.sql'
OUT_B = ROOT / 'tools' / 'sql' / '15b_match.sql'
PEEK  = ROOT / 'tools' / '_enrich_peek.json'

HEADERS = {'번호','장 부 명','장부명','사업자번호','대표자','핸드폰','전화 1','전화 2','전화1','전화2','팩스','담당자','비 고','비고'}

def parse_pdf():
    doc = fitz.open(str(PDF))
    rows = []
    BIZ_RE   = re.compile(r'^\d{3}-\d{2}-\d{5}$')
    NUM_RE   = re.compile(r'^\d{1,5}$')
    PHONE_RE = re.compile(r'^(0\d{1,2}[)\-]\s?\d{3,4}-?\d{4})$')
    SKIP = ('한별시스템','거래처 장부 리스트','페이지:','출력일자','담당자','대표자','사업자번호','핸드폰','전화','팩스','비 고','비고','장 부 명','장부명','번호')

    for page in doc:
        lines = [ln.strip() for ln in page.get_text().split('\n') if ln.strip()]
        skip_until = next((i for i, ln in enumerate(lines) if BIZ_RE.match(ln)), 0)
        body = lines[max(0, skip_until-1):]
        biz_idx = [i for i, ln in enumerate(body) if BIZ_RE.match(ln)]

        for j, bi in enumerate(biz_idx):
            cur = { 'biz_no': body[bi] }
            if bi >= 1:
                prev = body[bi-1]
                if re.fullmatch(r'[가-힣]{2,6}', prev) and not any(k in prev for k in SKIP):
                    cur['ceo'] = prev
            if bi + 1 < len(body):
                comp = body[bi+1]
                if not BIZ_RE.match(comp) and comp not in SKIP:
                    cur['company'] = comp
            if bi + 2 < len(body):
                no = body[bi+2]
                if NUM_RE.match(no) and len(no) <= 5:
                    cur['no'] = no
            next_bi = biz_idx[j+1] if j+1 < len(biz_idx) else len(body)
            phones = []
            for k in range(bi+3, next_bi-1 if j+1 < len(biz_idx) else next_bi):
                ln = body[k]
                if PHONE_RE.match(ln): phones.append(ln)
            mobiles = [p for p in phones if p.startswith('010')]
            others  = [p for p in phones if not p.startswith('010')]
            if mobiles: cur['mobile'] = mobiles[0]
            if len(others) >= 1: cur['phone1'] = others[0]
            if cur.get('company') and cur.get('biz_no'):
                rows.append(cur)
    return rows

def norm_company(s):
    if not s: return ''
    s = re.sub(r'\s+', '', s).replace('㈜', '(주)').replace('㈐', '(사)')
    return s.lower()

def sql_str(s):
    if s is None or s == '': return 'NULL'
    return "'" + str(s).replace("'", "''") + "'"

def main():
    rows = parse_pdf()
    seen = set(); uniq = []
    for r in rows:
        b = r.get('biz_no')
        if b and b not in seen:
            seen.add(b); uniq.append(r)
    rows = uniq
    PEEK.write_text(json.dumps({'count': len(rows), 'sample': rows[:5]}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"PDF: {len(rows)} 행")

    # ========== 15a_setup.sql (3KB) — 테이블 생성만 ==========
    setup_path = ROOT / 'tools' / 'sql' / '15a1_setup.sql'
    setup_path.write_text('\n'.join([
        '-- 15a1_setup.sql  — 스테이징 테이블 생성',
        'DROP TABLE IF EXISTS _pdf_staging;',
        'CREATE TABLE _pdf_staging (',
        '  norm_company TEXT,',
        '  ceo          TEXT,',
        '  biz_no       TEXT,',
        '  mobile       TEXT,',
        '  phone        TEXT',
        ');',
        'SELECT count(*) FROM _pdf_staging;'
    ]), encoding='utf-8')

    # ========== 15a2~15aN_chunk.sql (각 ~35KB) — 적재 청크 ==========
    BATCH = 500
    chunks = []
    for chunk_start in range(0, len(rows), BATCH):
        chunk = rows[chunk_start:chunk_start+BATCH]
        idx = len(chunks) + 2  # 15a2_, 15a3_, ...
        path = ROOT / 'tools' / 'sql' / f'15a{idx}_chunk.sql'
        body = ['-- INSERT batch ' + str(idx-1), '',
                'INSERT INTO _pdf_staging (norm_company, ceo, biz_no, mobile, phone) VALUES']
        vals = []
        for r in chunk:
            if not r.get('company'): continue
            vals.append(
                f"({sql_str(norm_company(r['company']))}, {sql_str(r.get('ceo'))}, "
                f"{sql_str(r.get('biz_no'))}, {sql_str(r.get('mobile'))}, "
                f"{sql_str(r.get('phone1'))})"
            )
        body.append(',\n'.join(vals))
        body.append(';')
        path.write_text('\n'.join(body), encoding='utf-8')
        chunks.append(path)
    OUT_A.write_text(f"-- (deprecated, 분할됨)\n-- 실행 순서: 15a1_setup.sql → 15a2~{len(chunks)+1}_chunk.sql → 15b_match.sql\n", encoding='utf-8')

    # ========== 15b_match.sql ==========
    b = [
        '-- ============================================================',
        '-- 15b_match.sql — 3-pass 매칭 + 스테이징 정리',
        '-- 사전 조건: 15a_load.sql 이 같은 DB 에 _pdf_staging 적재해 둠.',
        '-- ============================================================',
        '',
        'CREATE EXTENSION IF NOT EXISTS pg_trgm;',
        '',
        '-- 핵심명 추출 함수',
        'CREATE OR REPLACE FUNCTION _ext_core(name TEXT) RETURNS TEXT AS $f$',
        'DECLARE s TEXT;',
        'BEGIN',
        '  IF name IS NULL THEN RETURN NULL; END IF;',
        '  s := lower(name);',
        "  s := regexp_replace(s, '주식회사|유한회사|\\(주\\)|㈜|\\(사\\)|㈐|\\(복\\)|\\(재\\)|\\(유\\)', '', 'g');",
        "  s := regexp_replace(s, '[\\s·\\-\\.]+', '', 'g');",
        '  RETURN s;',
        'END;',
        '$f$ LANGUAGE plpgsql IMMUTABLE;',
        '',
        '-- PASS 1: norm_company 완전 일치',
        'UPDATE rental_customers AS rc SET',
        '  contact_name = COALESCE(rc.contact_name, p.ceo),',
        '  biz_no       = COALESCE(rc.biz_no,       p.biz_no),',
        '  mobile       = COALESCE(rc.mobile,       p.mobile),',
        '  phone        = COALESCE(rc.phone,        p.phone)',
        'FROM _pdf_staging AS p',
        "WHERE replace(replace(replace(lower(rc.company),' ',''),'㈜','(주)'),'㈐','(사)') = p.norm_company;",
        '',
        '-- PASS 2: 핵심명 완전 일치',
        'WITH pdf_core AS (',
        '  SELECT DISTINCT ON (_ext_core(norm_company))',
        '    _ext_core(norm_company) AS core, ceo, biz_no, mobile, phone',
        '  FROM _pdf_staging',
        '  WHERE LENGTH(_ext_core(norm_company)) >= 3',
        '  ORDER BY _ext_core(norm_company), ceo NULLS LAST',
        ')',
        'UPDATE rental_customers AS rc SET',
        '  contact_name = COALESCE(rc.contact_name, p.ceo),',
        '  biz_no       = COALESCE(rc.biz_no,       p.biz_no),',
        '  mobile       = COALESCE(rc.mobile,       p.mobile),',
        '  phone        = COALESCE(rc.phone,        p.phone)',
        'FROM pdf_core AS p',
        'WHERE _ext_core(rc.company) = p.core',
        '  AND (rc.contact_name IS NULL OR rc.biz_no IS NULL OR rc.mobile IS NULL OR rc.phone IS NULL);',
        '',
        '-- PASS 3: trigram 유사도 ≥ 0.6 (정보 거의 없는 행만)',
        'WITH pdf_pool AS (',
        '  SELECT _ext_core(norm_company) AS core, ceo, biz_no, mobile, phone',
        '  FROM _pdf_staging',
        '  WHERE LENGTH(_ext_core(norm_company)) >= 3',
        '), candidates AS (',
        '  SELECT DISTINCT ON (rc.id)',
        '    rc.id, p.ceo, p.biz_no, p.mobile, p.phone,',
        '    similarity(_ext_core(rc.company), p.core) AS sim',
        '  FROM rental_customers rc',
        '  JOIN pdf_pool p ON similarity(_ext_core(rc.company), p.core) >= 0.6',
        '  WHERE rc.active = TRUE',
        '    AND (rc.contact_name IS NULL AND rc.biz_no IS NULL)',
        '  ORDER BY rc.id, sim DESC',
        ')',
        'UPDATE rental_customers AS rc SET',
        '  contact_name = COALESCE(rc.contact_name, c.ceo),',
        '  biz_no       = COALESCE(rc.biz_no,       c.biz_no),',
        '  mobile       = COALESCE(rc.mobile,       c.mobile),',
        '  phone        = COALESCE(rc.phone,        c.phone)',
        'FROM candidates AS c',
        'WHERE rc.id = c.id;',
        '',
        '-- 정리',
        'DROP TABLE IF EXISTS _pdf_staging;',
        'DROP FUNCTION IF EXISTS _ext_core(TEXT);',
        '',
        '-- 확인',
        'SELECT',
        "  (SELECT COUNT(*) FROM rental_customers WHERE active=TRUE)                         AS total_active,",
        "  (SELECT COUNT(*) FROM rental_customers WHERE contact_name IS NOT NULL AND active) AS with_ceo,",
        "  (SELECT COUNT(*) FROM rental_customers WHERE biz_no IS NOT NULL AND active)       AS with_biz,",
        "  (SELECT COUNT(*) FROM rental_customers WHERE mobile IS NOT NULL AND active)       AS with_mobile,",
        "  (SELECT COUNT(*) FROM rental_customers WHERE phone IS NOT NULL AND active)        AS with_phone",
        ';',
    ]
    OUT_B.write_text('\n'.join(b), encoding='utf-8')

    print(f"15a_load.sql  {OUT_A.stat().st_size//1024} KB")
    print(f"15b_match.sql {OUT_B.stat().st_size//1024} KB")

if __name__ == '__main__':
    main()
