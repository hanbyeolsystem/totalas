"""
NAS 세부현황 폴더 추출(seed_contracts.json) → totalas 거래처 빈 필드 보강.
주로 주소(PDF에 없던 핵심)와 이메일/휴대폰/사업자번호 등 보강.

매칭: 회사명 정규화. 빈 필드만 채움 (기존 값 절대 덮어쓰기 X).

사용:
    python tools/merge_nas_details.py           # dry-run
    python tools/merge_nas_details.py --apply   # 실제 적용
"""
import os, re, json, sys, argparse
from pathlib import Path
from urllib import request, error
from collections import defaultdict

ROOT = Path(__file__).resolve().parent.parent
ENV  = ROOT / '.env'
NAS  = ROOT / 'tools' / 'seed_contracts.json'

for line in ENV.read_text(encoding='utf-8').splitlines():
    m = re.match(r'^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$', line)
    if m: os.environ[m.group(1)] = m.group(2)

URL = os.environ['SUPABASE_URL'].rstrip('/')
KEY = os.environ['SUPABASE_SECRET_KEY']
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'}

BIZ_RE = re.compile(r'\d{3}-\d{2}-\d{5}')
PHONE_RE = re.compile(r'(\d{2,4}[\-)\s]?\d{3,4}[\-\s]?\d{4})')

def norm_name(s):
    if not s: return ''
    s = re.sub(r'[（(]\s*[주복재사]\s*[)）]', '', str(s))
    s = re.sub(r'[\s\-_./,()（）\n]+', '', s)
    return s.lower()

def split_tel_fax(s):
    """'053-741-8267 / 053-741-8260' → (tel, fax). 한 개면 (값, '')"""
    if not s: return ('', '')
    s = str(s).strip()
    parts = re.split(r'[/]', s)
    nums = []
    for p in parts:
        ph = PHONE_RE.search(p)
        if ph: nums.append(ph.group(1))
    if len(nums) >= 2: return (nums[0], nums[1])
    if len(nums) == 1: return (nums[0], '')
    return ('', '')

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
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    nas = json.load(open(NAS, encoding='utf-8'))
    nas_rows = nas['rows']
    print(f'NAS 추출: {len(nas_rows)}건')

    nas_by_name = defaultdict(list)
    for r in nas_rows:
        n = norm_name(r.get('company'))
        if n: nas_by_name[n].append(r)

    custs = fetch_custs()
    print(f'totalas 거래처: {len(custs)}곳\n')

    plan = []
    no_match = []
    for c in custs:
        n = norm_name(c.get('company'))
        cands = nas_by_name.get(n) or []
        if not cands:
            no_match.append(c['company'])
            continue
        nr = cands[0]

        fills = {}

        # address (최우선)
        if not (c.get('address') or '').strip() and (nr.get('address') or '').strip():
            fills['address'] = nr['address']

        # biz_no
        nb = nr.get('biz_no') or ''
        if not (c.get('biz_no') or '').strip():
            m = BIZ_RE.search(nb)
            if m: fills['biz_no'] = m.group(0)

        # ceo (NAS의 requester)
        rq = (nr.get('requester') or '').strip()
        if not (c.get('ceo') or '').strip() and re.match(r'^[가-힣,\s·\-]{1,15}$', rq):
            fills['ceo'] = rq

        # phone (mobile 우선)
        new_phone = ''
        mb = (nr.get('mobile') or '').strip()
        if mb:
            ph = PHONE_RE.search(mb)
            if ph: new_phone = ph.group(1)
        if not new_phone:
            tel, _ = split_tel_fax(nr.get('tel_fax'))
            if tel: new_phone = tel
        if not (c.get('phone') or '').strip() and new_phone:
            fills['phone'] = new_phone

        # fax (tel_fax에서 두 번째)
        _, fax = split_tel_fax(nr.get('tel_fax'))
        if not (c.get('fax') or '').strip() and fax:
            fills['fax'] = fax

        # email
        em = (nr.get('email') or '').strip()
        if not (c.get('email') or '').strip() and em and '@' in em:
            fills['email'] = em

        if fills:
            plan.append({'id': c['id'], 'company': c['company'], 'fills': fills})

    print(f'보강 가능: {len(plan)}곳')
    print(f'매칭 안 됨: {len(no_match)}곳\n')

    field_count = defaultdict(int)
    for p in plan:
        for k in p['fills']: field_count[k] += 1
    print('=== 필드별 보강 ===')
    for k, v in sorted(field_count.items(), key=lambda x: -x[1]):
        print(f'  {k:8} : {v:4}곳')

    print('\n=== 샘플 10건 ===')
    for p in plan[:10]:
        diff = ', '.join(f'{k}={v!r}' for k, v in p['fills'].items())
        # 콘솔 안전 출력
        line = f"  [{p['id']}] {p['company'][:24]:24} -> {diff}"
        print(line.encode('ascii', 'replace').decode('ascii'))

    out_path = ROOT / 'customers' / 'nas_merge_plan.json'
    out_path.parent.mkdir(exist_ok=True)
    out_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'\n계획 저장: {out_path.relative_to(ROOT)}')

    if not args.apply:
        print('\n(dry-run. 적용하려면 --apply 추가)')
        return

    print('\n=== 적용 ===')
    H2 = {**H, 'Prefer': 'return=minimal'}
    ok = 0; fail = 0
    fail_log = []
    for p in plan:
        body = p['fills']
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        url = f"{URL}/rest/v1/rental_customers?id=eq.{p['id']}"
        req = request.Request(url, data=data, headers=H2, method='PATCH')
        try:
            with request.urlopen(req): pass
            ok += 1
        except error.HTTPError as e:
            fail += 1
            try: msg = e.read().decode('utf-8', errors='replace')[:120]
            except: msg = ''
            fail_log.append((p['id'], p['company'], e.code, msg))
    print(f'완료: 성공 {ok} / 실패 {fail} / 전체 {len(plan)}')
    if fail_log:
        log = ROOT / 'customers' / 'nas_merge_fail.log'
        with open(log, 'w', encoding='utf-8') as f:
            for id_, name, code, msg in fail_log:
                f.write(f'[{id_}] {name} -> HTTP {code}: {msg}\n')
        print(f'실패 상세: {log.relative_to(ROOT)}')

if __name__ == '__main__':
    main()
