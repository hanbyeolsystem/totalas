"""
임시 테이블 없이 CTE + VALUES 로 한 번에 3-pass 매칭.
- 단일 UPDATE 문 → 단일 트랜잭션
- 한 파일 ~85KB
"""
import re, sys, json
from pathlib import Path
import fitz

sys.stdout.reconfigure(encoding='utf-8')

ROOT  = Path(__file__).resolve().parents[1]
PDF   = ROOT / 'rental-customers' / 'customers_list.pdf'
OUT_A = ROOT / 'tools' / 'sql' / '16a_enrich.sql'
OUT_B = ROOT / 'tools' / 'sql' / '16b_enrich.sql'

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
            next_bi = biz_idx[j+1] if j+1 < len(biz_idx) else len(body)
            phones = []
            for k in range(bi+2, next_bi-1 if j+1 < len(biz_idx) else next_bi):
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
    print(f"PDF: {len(rows)} rows")

    def make_sql(chunk_rows, half_label):
        lines = [
            f'-- 16{half_label}_enrich.sql  — CTE + VALUES 인라인 3-pass 매칭 ({len(chunk_rows)} 행)',
            'CREATE EXTENSION IF NOT EXISTS pg_trgm;',
            '',
            'CREATE OR REPLACE FUNCTION pg_temp.ext_core(name TEXT) RETURNS TEXT AS $f$',
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
            'WITH pdf AS (',
            '  SELECT * FROM (VALUES',
        ]
        val_rows = []
        for r in chunk_rows:
            if not r.get('company'): continue
            val_rows.append(
                f"  ({sql_str(norm_company(r['company']))}, {sql_str(r.get('ceo'))}, "
                f"{sql_str(r.get('biz_no'))}, {sql_str(r.get('mobile'))}, "
                f"{sql_str(r.get('phone1'))})"
            )
        lines.append(',\n'.join(val_rows))
        lines.extend([
            '  ) AS t (norm_company, ceo, biz_no, mobile, phone)',
            '),',
            'cand AS (',
            '  SELECT rc.id, p.ceo, p.biz_no, p.mobile, p.phone,',
            '    CASE',
            "      WHEN replace(replace(replace(lower(rc.company),' ',''),'㈜','(주)'),'㈐','(사)') = p.norm_company THEN 1",
            "      WHEN LENGTH(pg_temp.ext_core(rc.company)) >= 3 AND pg_temp.ext_core(rc.company) = pg_temp.ext_core(p.norm_company) THEN 2",
            "      WHEN LENGTH(pg_temp.ext_core(rc.company)) >= 3 AND similarity(pg_temp.ext_core(rc.company), pg_temp.ext_core(p.norm_company)) >= 0.6 THEN 3",
            '      ELSE 99',
            '    END AS rank',
            '  FROM rental_customers rc',
            '  CROSS JOIN pdf p',
            '  WHERE rc.active = TRUE',
            '),',
            'best AS (',
            '  SELECT DISTINCT ON (id) id, ceo, biz_no, mobile, phone, rank',
            '  FROM cand',
            '  WHERE rank < 99',
            '  ORDER BY id, rank, biz_no NULLS LAST',
            ')',
            'UPDATE rental_customers AS rc SET',
            '  contact_name = COALESCE(rc.contact_name, b.ceo),',
            '  biz_no       = COALESCE(rc.biz_no,       b.biz_no),',
            '  mobile       = COALESCE(rc.mobile,       b.mobile),',
            '  phone        = COALESCE(rc.phone,        b.phone)',
            'FROM best AS b',
            'WHERE rc.id = b.id;',
            '',
            'SELECT',
            "  (SELECT COUNT(*) FROM rental_customers WHERE active=TRUE)                         AS total_active,",
            "  (SELECT COUNT(*) FROM rental_customers WHERE contact_name IS NOT NULL AND active) AS with_ceo,",
            "  (SELECT COUNT(*) FROM rental_customers WHERE biz_no IS NOT NULL AND active)       AS with_biz,",
            "  (SELECT COUNT(*) FROM rental_customers WHERE mobile IS NOT NULL AND active)       AS with_mobile,",
            "  (SELECT COUNT(*) FROM rental_customers WHERE phone IS NOT NULL AND active)        AS with_phone",
            ';',
        ])
        return '\n'.join(lines)

    half = len(rows) // 2
    OUT_A.write_text(make_sql(rows[:half], 'a'), encoding='utf-8')
    OUT_B.write_text(make_sql(rows[half:], 'b'), encoding='utf-8')
    print(f"wrote 16a_enrich.sql  {OUT_A.stat().st_size//1024} KB ({half} 행)")
    print(f"wrote 16b_enrich.sql  {OUT_B.stat().st_size//1024} KB ({len(rows)-half} 행)")

if __name__ == '__main__':
    main()
