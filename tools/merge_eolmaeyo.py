"""
얼마에요 PDF → totalas 거래처 빈 필드 보강.

흐름:
1. customers/customers_list.pdf 파싱 (단어 좌표 기반 컬럼 분리)
2. totalas Supabase 거래처 fetch
3. 회사명 정규화로 매칭
4. 빈 필드만 PDF 값으로 채우는 dry-run 결과 출력
5. --apply 플래그 주면 실제 upsert

사용:
    python tools/merge_eolmaeyo.py            # dry-run
    python tools/merge_eolmaeyo.py --apply    # 실제 적용
"""
import os, re, json, sys, argparse
from pathlib import Path
from urllib import request, error
from collections import defaultdict

ROOT = Path(__file__).resolve().parent.parent
ENV  = ROOT / '.env'
PDF  = ROOT / 'customers' / 'customers_list.pdf'

# ---- .env 로드 ----
for line in ENV.read_text(encoding='utf-8').splitlines():
    m = re.match(r'^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$', line)
    if m: os.environ[m.group(1)] = m.group(2)

URL = os.environ['SUPABASE_URL'].rstrip('/')
KEY = os.environ['SUPABASE_SECRET_KEY']
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}

# ---- 컬럼 좌표 (page 1 검사 기준; 71페이지 동일 레이아웃 가정) ----
COL_BOUNDS = [
    ('no',      0,   65),
    ('company', 65,  145),
    ('biz_no',  145, 220),
    ('ceo',     220, 268),
    ('mobile',  268, 330),
    ('tel1',    330, 393),
    ('tel2',    393, 455),
    ('fax',     455, 535),
    ('note',    535, 9999),
]

BIZ_NO_RE  = re.compile(r'^\d{3}-\d{2}-\d{5}$')
PHONE_HINT = re.compile(r'^[0-9()\-]+$')
CEO_RE     = re.compile(r'^[가-힣,\s·\-]{1,15}$')  # 정상 대표자: 한글만

def assign_col(x):
    for name, lo, hi in COL_BOUNDS:
        if lo <= x < hi:
            return name
    return 'note'

def parse_pdf():
    """returns: list of dict {company, biz_no, ceo, mobile, tel1, tel2, fax, note}"""
    import pdfplumber
    rows = []
    with pdfplumber.open(str(PDF)) as pdf:
        for p in pdf.pages:
            words = p.extract_words()
            byline = defaultdict(list)
            for w in words:
                # y는 소수점 차이로 같은 라인이 분리될 수 있어 반올림
                byline[round(w['top'])].append(w)

            for y, ws in sorted(byline.items()):
                # 헤더/타이틀 라인 스킵
                texts_all = ' '.join(w['text'] for w in sorted(ws, key=lambda x: x['x0']))
                if any(s in texts_all for s in ('거래처 장부 리스트', '한별시스템', '출력일자', '페이지:', '비 고', '번호 장')):
                    continue

                cols = {k: [] for k, _, _ in COL_BOUNDS}
                for w in sorted(ws, key=lambda x: x['x0']):
                    cols[assign_col(w['x0'])].append(w['text'])
                row = {k: ' '.join(v).strip() for k, v in cols.items()}

                # 'no'에 숫자가 있어야 정상 거래처 라인
                if not row['no'] or not re.search(r'^\d+', row['no']):
                    continue
                # 회사명 정리: 빈 칸 사이 한 칸으로
                row['company'] = re.sub(r'\s+', ' ', row['company']).strip()
                rows.append(row)
    return rows

def fetch_totalas_customers():
    out = []
    fr = 0
    while True:
        req = request.Request(
            f'{URL}/rest/v1/rental_customers?select=*&order=company.asc',
            headers={**H, 'Range': f'{fr}-{fr+999}'},
        )
        with request.urlopen(req) as r:
            chunk = json.loads(r.read())
        out.extend(chunk)
        if len(chunk) < 1000: break
        fr += 1000
    return out

def norm_name(s):
    if not s: return ''
    s = str(s)
    s = re.sub(r'[（(]\s*[주복재사]\s*[)）]', '', s)   # (주)/（주）/(복) 등 제거
    s = re.sub(r'[\s\-_./,()（）\n]+', '', s)
    return s.lower()

def pick_phone(*candidates):
    """후보 중 첫 비어있지 않은 전화번호"""
    for c in candidates:
        c = (c or '').strip()
        if c and PHONE_HINT.search(c):
            return c
    return ''

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='실제 Supabase에 upsert')
    args = ap.parse_args()

    print('=== 1) PDF 파싱 ===')
    pdf_rows = parse_pdf()
    print(f'  추출: {len(pdf_rows)}건\n')

    # PDF 거래처를 정규화된 회사명 → row 매핑
    pdf_by_name = defaultdict(list)
    for r in pdf_rows:
        n = norm_name(r['company'])
        if n: pdf_by_name[n].append(r)

    print('=== 2) totalas 거래처 fetch ===')
    custs = fetch_totalas_customers()
    print(f'  대상: {len(custs)}곳\n')

    print('=== 3) 매칭 + 보강 dry-run ===')
    plan = []   # (cust_id, company, {field: (old, new)})
    no_match = []
    for c in custs:
        n = norm_name(c.get('company'))
        if not n: continue
        cands = pdf_by_name.get(n) or []
        if not cands:
            no_match.append(c['company'])
            continue
        # 여러 매칭 시 첫 번째 사용 (PDF 중복 가능성)
        pr = cands[0]

        fills = {}

        # 대표자 — 한글만 정상값으로 인정
        if not (c.get('ceo') or '').strip() and pr['ceo'] and CEO_RE.match(pr['ceo']):
            fills['ceo'] = ('', pr['ceo'])
        # 사업자번호 — XXX-XX-XXXXX 패턴만
        if not (c.get('biz_no') or '').strip() and BIZ_NO_RE.match(pr['biz_no'] or ''):
            fills['biz_no'] = ('', pr['biz_no'])
        # 전화 — 숫자/dash/괄호만
        new_phone = pick_phone(pr['mobile'], pr['tel1'], pr['tel2'])
        if not (c.get('phone') or '').strip() and new_phone and PHONE_HINT.match(new_phone):
            fills['phone'] = ('', new_phone)
        # 팩스 — 숫자/dash/괄호만 (사람 이름이 섞인 케이스 제외)
        if not (c.get('fax') or '').strip() and pr['fax'] and PHONE_HINT.match(pr['fax']):
            fills['fax'] = ('', pr['fax'])
        # 담당자 → memo에 prefix 추가 (memo 비어있을 때만)
        if not (c.get('memo') or '').strip() and (pr['note'] or '').strip():
            fills['memo'] = ('', f"담당자: {pr['note']}")

        if fills:
            plan.append({
                'id': c['id'],
                'company': c['company'],
                'fills': fills,
            })

    print(f'  매칭 가능 + 보강할 항목: {len(plan)}곳')
    print(f'  매칭 안 됨 (PDF에 동일 회사명 없음): {len(no_match)}곳\n')

    # 필드별 통계
    field_counts = defaultdict(int)
    for p in plan:
        for k in p['fills']: field_counts[k] += 1
    print('=== 4) 필드별 보강 수 ===')
    for k, v in sorted(field_counts.items(), key=lambda x: -x[1]):
        print(f'  {k:8} : {v:4}곳')

    # 샘플 10건
    print('\n=== 5) 샘플 (앞 10건) ===')
    for p in plan[:10]:
        diff = ', '.join(f'{k}="{v[1]}"' for k, v in p['fills'].items())
        print(f'  [{p["id"]}] {p["company"][:24]:24} -> {diff}')

    # 저장: dry-run 결과를 JSON으로
    out_path = ROOT / 'customers' / 'merge_plan.json'
    out_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'\n전체 계획 저장: {out_path.relative_to(ROOT)}')

    if not args.apply:
        print('\n(dry-run 모드. 적용하려면 --apply 추가)')
        return

    print('\n=== 6) Supabase 적용 ===')
    # PATCH (UPDATE)로 빈 필드만 채움 — id로 단일 row 매칭
    H2 = {**H, 'Prefer': 'return=minimal'}
    ok = 0; fail = 0
    fail_log = []
    for p in plan:
        body = {}
        for k, (_, new) in p['fills'].items():
            body[k] = new
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        url = f"{URL}/rest/v1/rental_customers?id=eq.{p['id']}"
        req = request.Request(url, data=data, headers=H2, method='PATCH')
        try:
            with request.urlopen(req): pass
            ok += 1
            print(f"  [OK] {p['company'][:30]}".encode('ascii', 'replace').decode('ascii'), flush=True)
        except error.HTTPError as e:
            try:
                msg = e.read().decode('utf-8', errors='replace')[:200]
            except Exception:
                msg = '(unreadable)'
            fail += 1
            fail_log.append((p['id'], p['company'], e.code, msg))
            print(f"  [FAIL] {p['company'][:30]} HTTP {e.code}".encode('ascii', 'replace').decode('ascii'), flush=True)
    print(f'\n적용 완료: 성공 {ok} / 실패 {fail} / 전체 {len(plan)}')
    if fail_log:
        log_path = ROOT / 'customers' / 'merge_fail.log'
        with open(log_path, 'w', encoding='utf-8') as f:
            for id_, name, code, msg in fail_log:
                f.write(f'[{id_}] {name} -> HTTP {code}: {msg}\n')
        print(f'실패 상세: {log_path.relative_to(ROOT)}')

if __name__ == '__main__':
    main()
