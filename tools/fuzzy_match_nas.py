"""
회사명 정규화로 매칭 안 된 totalas 거래처와 NAS 세부현황 거래처를
사업자번호 + 부분 문자열 + 편집 거리로 재매칭 시도.

dry-run만; 결과 customers/fuzzy_candidates.json
"""
import os, re, json, sys
from pathlib import Path
from urllib import request
from collections import defaultdict
from difflib import SequenceMatcher

ROOT = Path(__file__).resolve().parent.parent
ENV  = ROOT / '.env'
NAS  = ROOT / 'tools' / 'seed_contracts.json'

for line in ENV.read_text(encoding='utf-8').splitlines():
    m = re.match(r'^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$', line)
    if m: os.environ[m.group(1)] = m.group(2)

URL = os.environ['SUPABASE_URL'].rstrip('/')
KEY = os.environ['SUPABASE_SECRET_KEY']
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}'}

BIZ_RE = re.compile(r'\d{3}-\d{2}-\d{5}')

def norm_name(s):
    if not s: return ''
    s = re.sub(r'[（(]\s*[주복재사]\s*[)）]', '', str(s))
    s = re.sub(r'[\s\-_./,()（）\n]+', '', s)
    return s.lower()

def norm_loose(s):
    """더 느슨한 정규화: 한글만 추출, 1글자 토큰 제거"""
    if not s: return ''
    s = re.sub(r'[（(]\s*[주복재사]\s*[)）]', '', str(s))
    return re.sub(r'[^가-힣a-zA-Z0-9]+', '', s).lower()

def similarity(a, b):
    return SequenceMatcher(None, a, b).ratio()

def fetch_custs():
    out = []; fr = 0
    while True:
        req = request.Request(
            f'{URL}/rest/v1/rental_customers?select=*&order=id.asc',
            headers={**H, 'Range': f'{fr}-{fr+999}'}
        )
        with request.urlopen(req) as r:
            chunk = json.loads(r.read())
        out.extend(chunk)
        if len(chunk) < 1000: break
        fr += 1000
    return out

def main():
    nas = json.load(open(NAS, encoding='utf-8'))['rows']
    custs = fetch_custs()

    # 1차 정규화 매칭 (이미 처리된 곳)
    nas_norm = {norm_name(r.get('company')): r for r in nas if norm_name(r.get('company'))}
    cust_norm = {norm_name(c.get('company')): c for c in custs if norm_name(c.get('company'))}

    matched = set(nas_norm.keys()) & set(cust_norm.keys())
    cust_unmatched = [c for c in custs if norm_name(c.get('company')) not in matched]
    nas_unmatched  = [r for r in nas if norm_name(r.get('company')) not in matched]

    print(f'totalas: {len(custs)}곳 / 정규화 매칭됨 {len(matched)} / 매칭 안 됨 {len(cust_unmatched)}')
    print(f'NAS:     {len(nas)}건 / 매칭 안 됨 {len(nas_unmatched)}건\n')

    # 사업자번호 인덱스 (NAS)
    nas_by_biz = {}
    for r in nas_unmatched:
        b = BIZ_RE.search(r.get('biz_no') or '')
        if b: nas_by_biz[b.group(0)] = r

    # NAS의 loose name 인덱스
    nas_loose_idx = defaultdict(list)
    for r in nas_unmatched:
        nl = norm_loose(r.get('company'))
        if nl: nas_loose_idx[nl].append(r)

    # 매칭 후보 분류
    by_biz = []      # 사업자번호 매칭 (가장 정확)
    by_contain = []  # 부분 포함
    by_fuzzy = []    # 편집 거리 0.85+
    no_cand = []

    for c in cust_unmatched:
        cand = None; reason = None; nr = None

        # 1) 사업자번호 매칭
        cb = BIZ_RE.search(c.get('biz_no') or '')
        if cb and cb.group(0) in nas_by_biz:
            nr = nas_by_biz[cb.group(0)]
            reason = f"biz_no={cb.group(0)}"
            by_biz.append((c, nr, reason))
            continue

        # 2) 부분 포함 매칭 (한쪽이 다른 쪽의 부분 문자열)
        cl = norm_loose(c.get('company'))
        best = None; best_score = 0
        if cl:
            for nl, rows in nas_loose_idx.items():
                if not nl: continue
                # 짧은 쪽이 긴 쪽에 포함되는 경우
                if (cl in nl and len(cl) >= 3) or (nl in cl and len(nl) >= 3):
                    sc = min(len(cl), len(nl)) / max(len(cl), len(nl))
                    if sc > best_score:
                        best = rows[0]; best_score = sc; reason = f"contain (len_ratio={sc:.2f})"
        if best:
            by_contain.append((c, best, reason))
            continue

        # 3) fuzzy (SequenceMatcher) 0.80+
        best = None; best_score = 0
        if cl:
            for r in nas_unmatched:
                nl = norm_loose(r.get('company'))
                if not nl: continue
                s = similarity(cl, nl)
                if s > best_score:
                    best = r; best_score = s
            if best_score >= 0.80:
                by_fuzzy.append((c, best, f"fuzzy={best_score:.2f}"))
                continue

        no_cand.append(c)

    print('=== 매칭 후보 ===')
    print(f'  사업자번호 매칭:   {len(by_biz)}곳 (가장 확실)')
    print(f'  부분 포함 매칭:    {len(by_contain)}곳 (대부분 안전)')
    print(f'  Fuzzy 0.80+ 매칭: {len(by_fuzzy)}곳 (검토 필요)')
    print(f'  후보 없음:         {len(no_cand)}곳\n')

    print('=== 사업자번호 매칭 샘플 (안전) ===')
    for c, nr, reason in by_biz[:15]:
        line = f"  [{c['id']}] {(c['company'] or '')[:24]:24} <- {nr['company'][:24]:24}  ({reason})"
        print(line.encode('ascii', 'replace').decode('ascii'))

    print('\n=== 부분 포함 매칭 샘플 (검토 권장) ===')
    for c, nr, reason in by_contain[:15]:
        line = f"  [{c['id']}] {(c['company'] or '')[:24]:24} <- {nr['company'][:24]:24}  ({reason})"
        print(line.encode('ascii', 'replace').decode('ascii'))

    print('\n=== Fuzzy 매칭 샘플 (사용자 확인 필요) ===')
    for c, nr, reason in by_fuzzy[:15]:
        line = f"  [{c['id']}] {(c['company'] or '')[:24]:24} <- {nr['company'][:24]:24}  ({reason})"
        print(line.encode('ascii', 'replace').decode('ascii'))

    # 저장
    out = {
        'by_biz':     [{'id': c['id'], 'cust_name': c['company'], 'nas_name': n['company'], 'reason': r}
                       for c, n, r in by_biz],
        'by_contain': [{'id': c['id'], 'cust_name': c['company'], 'nas_name': n['company'], 'reason': r}
                       for c, n, r in by_contain],
        'by_fuzzy':   [{'id': c['id'], 'cust_name': c['company'], 'nas_name': n['company'], 'reason': r}
                       for c, n, r in by_fuzzy],
        'no_cand':    [c['company'] for c in no_cand],
    }
    out_path = ROOT / 'customers' / 'fuzzy_candidates.json'
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'\n저장: {out_path.relative_to(ROOT)}')

if __name__ == '__main__':
    main()
