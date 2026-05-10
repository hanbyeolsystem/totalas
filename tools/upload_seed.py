"""
seed-data.js → Supabase REST API 업로드.
사용:  python tools/upload_seed.py
필요:  .env 에 SUPABASE_URL, SUPABASE_SECRET_KEY 설정
       supabase/migrations/20260511_init_rental.sql 가 먼저 적용되어 있어야 함
"""
import os, json, re, sys
from pathlib import Path
from urllib import request, error

ROOT  = Path(__file__).resolve().parent.parent
SEED  = ROOT / 'seed-data.js'
ENV   = ROOT / '.env'

# .env 읽기
def load_env():
    if not ENV.exists():
        sys.exit(f"❌ .env 파일이 없습니다: {ENV}")
    for line in ENV.read_text(encoding='utf-8').splitlines():
        m = re.match(r'^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$', line)
        if m: os.environ[m.group(1)] = m.group(2)
load_env()

URL    = os.environ['SUPABASE_URL'].rstrip('/')
SECRET = os.environ['SUPABASE_SECRET_KEY']
HEADERS = {
    'apikey': SECRET,
    'Authorization': f'Bearer {SECRET}',
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates,return=minimal',
}

def post(table, rows, chunk=200):
    """upsert in chunks. 서버 측 PRIMARY KEY 가 정의되어야 merge-duplicates 동작."""
    if not rows: return 0
    total = 0
    for i in range(0, len(rows), chunk):
        batch = rows[i:i+chunk]
        body = json.dumps(batch, ensure_ascii=False).encode('utf-8')
        req = request.Request(f'{URL}/rest/v1/{table}', data=body, headers=HEADERS, method='POST')
        try:
            with request.urlopen(req) as r:
                pass
            total += len(batch)
            print(f"  {table}: {total}/{len(rows)}", end='\r')
        except error.HTTPError as e:
            msg = e.read().decode('utf-8', errors='replace')
            print(f"\n❌ {table} 업로드 실패: {e.code}\n{msg[:500]}")
            return total
    print()
    return total

def main():
    if not SEED.exists():
        sys.exit(f"❌ seed-data.js 가 없습니다. tools/build_seed.py 먼저 실행하세요.")

    # window.RENTAL_SEED = {...};  →  json
    text = SEED.read_text(encoding='utf-8')
    m = re.search(r'window\.RENTAL_SEED\s*=\s*(\{.*\})\s*;\s*$', text, re.S)
    if not m: sys.exit("❌ seed-data.js 형식이 맞지 않습니다.")
    seed = json.loads(m.group(1))

    customers = list(seed.get('customers', {}).values())
    printers  = list(seed.get('printers',  {}).values())
    contracts = list(seed.get('contracts', {}).values())

    # 카운터: {period: {serial: {bw,co,...}}} → flat rows
    counters = []
    for period, rows in seed.get('counters', {}).items():
        for serial, info in rows.items():
            counters.append({
                'period': period,
                'serial': serial,
                'bw':     info.get('bw'),
                'co':     info.get('co'),
                'last_update': info.get('last_update', ''),
                'source':      info.get('source', ''),
                'source_file': info.get('source_file', ''),
            })

    # 거래처 정리 — DB 컬럼만 유지
    cust_clean = []
    for c in customers:
        cust_clean.append({
            'id': c['id'],
            'company': c.get('company',''),
            'ceo': c.get('ceo',''),
            'biz_no': c.get('biz_no',''),
            'corp_no': c.get('corp_no',''),
            'biz_type': c.get('biz_type',''),
            'biz_item': c.get('biz_item',''),
            'address': c.get('address',''),
            'phone': c.get('phone',''),
            'fax': c.get('fax',''),
            'email': c.get('email',''),
            'kakao': c.get('kakao',''),
            'memo': c.get('memo',''),
            'serials': c.get('serials', []) or [],
            'base_fee': c.get('base_fee') or 0,
            'bw_free': c.get('bw_free') or 0,
            'bw_rate': c.get('bw_rate') or 0,
            'co_free': c.get('co_free') or 0,
            'co_rate': c.get('co_rate') or 0,
            'source_sheet': c.get('source_sheet', ''),
        })

    # 프린터 정리
    print_clean = []
    for p in printers:
        print_clean.append({
            'serial': p['serial'],
            'model': p.get('model',''),
            'group': p.get('group',''),
            'asset_name': p.get('asset_name',''),
            'customer_id': p.get('matched_customer_id'),
        })

    # 계약서 정리
    ct_clean = []
    for ct in contracts:
        ct_clean.append({
            'id': ct['id'],
            'customer_id': ct.get('customer_id'),
            'company': ct.get('company',''),
            'company_top': ct.get('company_top',''),
            'requester': ct.get('requester',''),
            'address': ct.get('address',''),
            'invoice_kind': ct.get('invoice_kind',''),
            'biz_no': ct.get('biz_no',''),
            'mobile': ct.get('mobile',''),
            'tel_fax': ct.get('tel_fax',''),
            'email': ct.get('email',''),
            'items': ct.get('items', []),
            'deposit': ct.get('deposit') or 0,
            'total_fee': ct.get('total_fee') or 0,
            'contract_date': ct.get('contract_date',''),
            'special': ct.get('special') or [],
            'source_file': ct.get('source_file',''),
        })

    print(f"\n=== 시드 업로드 시작 ===")
    print(f"  거래처:   {len(cust_clean)}곳")
    print(f"  프린터:   {len(print_clean)}대")
    print(f"  카운터:   {len(counters)}건")
    print(f"  계약서:   {len(ct_clean)}건\n")

    # 순서: customers → printers → counters → contracts (FK 의존성)
    n1 = post('rental_customers', cust_clean)
    n2 = post('rental_printers',  print_clean)
    n3 = post('rental_counters',  counters)
    n4 = post('rental_contracts', ct_clean)

    print(f"\n✅ 업로드 완료")
    print(f"  rental_customers:  {n1}")
    print(f"  rental_printers:   {n2}")
    print(f"  rental_counters:   {n3}")
    print(f"  rental_contracts:  {n4}")

if __name__ == '__main__':
    main()
