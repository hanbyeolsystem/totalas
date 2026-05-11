"""
totalas — 회사명 동일 거래처 중복 정리.

각 그룹에서 점수 가장 높은 1곳을 keep, 나머지 삭제.
점수 = serials*100 + (biz_no?20) + (ceo?10) + (phone?5) + (fax?3) + (base_fee>0?15) + (address?5) + (memo길이/100)
동점 시: id 사전순 (먼저 만들어진 것 keep)

사용:
    python tools/dedupe_customers.py          # dry-run
    python tools/dedupe_customers.py --apply  # 실제 삭제
"""
import os, re, json, sys, argparse
from pathlib import Path
from urllib import request, error
from collections import defaultdict

ROOT = Path(__file__).resolve().parent.parent
ENV  = ROOT / '.env'

for line in ENV.read_text(encoding='utf-8').splitlines():
    m = re.match(r'^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$', line)
    if m: os.environ[m.group(1)] = m.group(2)

URL = os.environ['SUPABASE_URL'].rstrip('/')
KEY = os.environ['SUPABASE_SECRET_KEY']
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}

def norm_name(s):
    if not s: return ''
    s = str(s)
    s = re.sub(r'[（(]\s*[주복재사]\s*[)）]', '', s)
    s = re.sub(r'[\s\-_./,()（）\n]+', '', s)
    return s.lower()

def fetch_all():
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

def score(c):
    s = 0
    s += len(c.get('serials') or []) * 100
    s += 20 if (c.get('biz_no') or '').strip() else 0
    s += 10 if (c.get('ceo') or '').strip() else 0
    s += 5  if (c.get('phone') or '').strip() else 0
    s += 3  if (c.get('fax') or '').strip() else 0
    s += 15 if (c.get('base_fee') or 0) > 0 else 0
    s += 5  if (c.get('address') or '').strip() else 0
    s += len(c.get('memo') or '') // 100
    return s

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    custs = fetch_all()
    print(f'전체 거래처: {len(custs)}곳')

    groups = defaultdict(list)
    for c in custs:
        n = norm_name(c.get('company'))
        if n: groups[n].append(c)
    dup = {k: v for k, v in groups.items() if len(v) > 1}
    print(f'중복 그룹: {len(dup)}개')

    keep_ids = []
    safe_delete = []     # 자동 삭제: 진짜 빈 시드 (score < 6, serials=0, base_fee=0)
    risky_review = []    # 사용자 검토 필요: 시리얼 또는 base_fee 있음
    plan = []
    for name, members in dup.items():
        scored = sorted(members, key=lambda c: (-score(c), c['id']))
        winner = scored[0]
        losers = scored[1:]
        keep_ids.append(winner['id'])
        d_safe, d_risky = [], []
        for L in losers:
            ls = len(L.get('serials') or [])
            bf = L.get('base_fee') or 0
            if ls > 0 or bf > 0:
                d_risky.append(L)
                risky_review.append((winner['company'], L))
            else:
                d_safe.append(L)
                safe_delete.append(L['id'])
        plan.append({
            'company': winner['company'],
            'keep':    {'id': winner['id'], 'score': score(winner),
                        'ceo': winner.get('ceo') or '', 'biz_no': winner.get('biz_no') or '',
                        'serials': len(winner.get('serials') or []), 'base_fee': winner.get('base_fee') or 0},
            'delete_safe':  [{'id': L['id'], 'score': score(L)} for L in d_safe],
            'review_risky': [{'id': L['id'], 'score': score(L),
                              'ceo': L.get('ceo') or '', 'biz_no': L.get('biz_no') or '',
                              'serials': len(L.get('serials') or []),
                              'base_fee': L.get('base_fee') or 0,
                              'memo_len': len(L.get('memo') or '')}
                             for L in d_risky],
        })

    print(f'자동 삭제 대상 (빈 시드): {len(safe_delete)}곳')
    print(f'사용자 검토 필요 (정보 있음): {len(risky_review)}곳\n')

    if risky_review:
        print('=== [수동 검토] base_fee 또는 시리얼 있는 중복 거래처 ===')
        print('(같은 회사명의 여러 임대 계약일 수 있어 자동 삭제 안 함)')
        for name, L in risky_review:
            ls = len(L.get('serials') or [])
            bf = (L.get('base_fee') or 0)
            ml = len(L.get('memo') or '')
            print(f"   {name[:24]:24}  id={L['id']}  serials={ls}  base_fee={bf:>8,}  memo={ml}자")
        print()

    # 상위 10 그룹 요약 (자동 삭제만)
    print('=== 자동 삭제 상위 10 그룹 ===')
    plan_sorted = sorted(plan, key=lambda x: -(len(x['delete_safe'])))[:10]
    for g in plan_sorted:
        if not g['delete_safe']: continue
        kp = g['keep']
        print(f"  [{kp['id']}] {g['company'][:20]:20}  KEEP score={kp['score']:>3}")
        for d in g['delete_safe']:
            print(f"      DEL [{d['id']}]   score={d['score']:>3}")

    out_path = ROOT / 'customers' / 'dedupe_plan.json'
    out_path.parent.mkdir(exist_ok=True)
    out_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'\n전체 계획 저장: {out_path.relative_to(ROOT)}')

    if not args.apply:
        print('\n(dry-run. 적용하려면 --apply 추가 — 빈 시드만 자동 삭제, 위험 케이스는 페이지에서 직접 정리)')
        return

    print(f'\n=== 자동 삭제 실행 ({len(safe_delete)}곳) ===')
    H2 = {'apikey': KEY, 'Authorization': f'Bearer {KEY}'}
    ok = 0; fail = 0
    for cid in safe_delete:
        req = request.Request(f'{URL}/rest/v1/rental_customers?id=eq.{cid}', headers=H2, method='DELETE')
        try:
            with request.urlopen(req): pass
            ok += 1
        except error.HTTPError as e:
            fail += 1
            try: msg = e.read().decode('utf-8', errors='replace')[:120]
            except: msg = ''
            print(f'  [FAIL] {cid}: HTTP {e.code} {msg}')
    print(f'\n완료: 성공 {ok} / 실패 {fail} / 전체 {len(safe_delete)}')
    if risky_review:
        print(f'\n검토 필요: {len(risky_review)}곳 — customers.html 페이지에서 직접 확인 후 정리')

if __name__ == '__main__':
    main()
