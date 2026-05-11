"""
fuzzy_candidates.json의 by_biz(사업자번호 매칭) 후보를 적용.
totalas 거래처에 NAS 빈 필드 보강 (회사명은 절대 변경 안 함).

사용:
    python tools/merge_by_biz.py            # dry-run
    python tools/merge_by_biz.py --apply
"""
import os, re, json, sys, argparse
from pathlib import Path
from urllib import request, error

ROOT = Path(__file__).resolve().parent.parent
ENV  = ROOT / '.env'
CAND = ROOT / 'customers' / 'fuzzy_candidates.json'
NAS  = ROOT / 'tools' / 'seed_contracts.json'

for line in ENV.read_text(encoding='utf-8').splitlines():
    m = re.match(r'^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$', line)
    if m: os.environ[m.group(1)] = m.group(2)

URL = os.environ['SUPABASE_URL'].rstrip('/')
KEY = os.environ['SUPABASE_SECRET_KEY']
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}

PHONE_RE = re.compile(r'(\d{2,4}[\-)\s]?\d{3,4}[\-\s]?\d{4})')

def split_tel_fax(s):
    if not s: return ('', '')
    parts = re.split(r'[/]', str(s))
    nums = []
    for p in parts:
        ph = PHONE_RE.search(p)
        if ph: nums.append(ph.group(1))
    if len(nums) >= 2: return (nums[0], nums[1])
    if len(nums) == 1: return (nums[0], '')
    return ('', '')

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--source', choices=['by_biz', 'by_contain', 'by_fuzzy', 'all'], default='by_biz')
    args = ap.parse_args()

    all_cand = json.load(open(CAND, encoding='utf-8'))
    if args.source == 'all':
        cand = all_cand['by_biz'] + all_cand['by_contain'] + all_cand['by_fuzzy']
    else:
        cand = all_cand[args.source]
    nas = json.load(open(NAS, encoding='utf-8'))['rows']
    nas_by_name = {r['company']: r for r in nas}

    # totalas 현재 데이터 fetch (id list만)
    ids = [c['id'] for c in cand]
    if not ids:
        print('대상 없음'); return
    qs = ','.join(f'"{i}"' for i in ids)
    req = request.Request(
        f'{URL}/rest/v1/rental_customers?select=*&id=in.({qs})',
        headers={**H}
    )
    with request.urlopen(req) as r:
        custs = {c['id']: c for c in json.loads(r.read())}

    plan = []
    for cd in cand:
        c = custs.get(cd['id'])
        if not c: continue
        nr = nas_by_name.get(cd['nas_name'])
        if not nr: continue

        fills = {}
        # address
        if not (c.get('address') or '').strip() and (nr.get('address') or '').strip():
            fills['address'] = nr['address']
        # ceo (NAS requester)
        rq = (nr.get('requester') or '').strip()
        if not (c.get('ceo') or '').strip() and re.match(r'^[가-힣,\s·\-]{1,15}$', rq):
            fills['ceo'] = rq
        # phone
        new_phone = ''
        ph = PHONE_RE.search(nr.get('mobile') or '')
        if ph: new_phone = ph.group(1)
        if not new_phone:
            tel, _ = split_tel_fax(nr.get('tel_fax'))
            if tel: new_phone = tel
        if not (c.get('phone') or '').strip() and new_phone:
            fills['phone'] = new_phone
        # fax
        _, fax = split_tel_fax(nr.get('tel_fax'))
        if not (c.get('fax') or '').strip() and fax:
            fills['fax'] = fax
        # email
        em = (nr.get('email') or '').strip()
        if not (c.get('email') or '').strip() and em and '@' in em:
            fills['email'] = em

        if fills:
            plan.append({'id': cd['id'], 'cust_name': cd['cust_name'], 'nas_name': cd['nas_name'], 'fills': fills})

    print(f'적용 대상: {len(plan)}곳 (사업자번호 매칭 {len(cand)}곳 중 빈 필드 있는 곳)\n')
    for p in plan:
        line = f"  [{p['id']}] {p['cust_name'][:24]:24} <- {p['nas_name'][:24]:24}  fills={list(p['fills'].keys())}"
        print(line.encode('ascii', 'replace').decode('ascii'))

    if not args.apply:
        print('\n(dry-run. --apply 추가하면 실제 적용)')
        return

    print('\n=== 적용 ===')
    H2 = {**H, 'Prefer': 'return=minimal'}
    ok = 0; fail = 0
    for p in plan:
        data = json.dumps(p['fills'], ensure_ascii=False).encode('utf-8')
        url = f"{URL}/rest/v1/rental_customers?id=eq.{p['id']}"
        req = request.Request(url, data=data, headers=H2, method='PATCH')
        try:
            with request.urlopen(req): pass
            ok += 1
        except error.HTTPError as e:
            fail += 1
            try: msg = e.read().decode('utf-8', errors='replace')[:120]
            except: msg = ''
            print(f'  FAIL {p["id"]}: HTTP {e.code} {msg}')
    print(f'\n완료: 성공 {ok} / 실패 {fail} / 전체 {len(plan)}')

if __name__ == '__main__':
    main()
