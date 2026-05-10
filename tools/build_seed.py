"""
seed_customers.json + seed_counters.json → seed-data.js
임대관리 사이트에서 즉시 import 가능한 형태.
"""
import json, re
from pathlib import Path

ROOT = Path(r'C:\Users\UserK\Desktop\클로드코드공부\임대관리')
SEED_C  = ROOT / 'tools' / 'seed_customers.json'
SEED_K  = ROOT / 'tools' / 'seed_counters.json'
SEED_CT = ROOT / 'tools' / 'seed_contracts.json'
OUT     = ROOT / 'seed-data.js'

def normalize(s):
    if not s: return ''
    return re.sub(r'[\s()\-_/\.,]+', '', str(s)).lower()

def main():
    cust_data = json.loads(SEED_C.read_text(encoding='utf-8'))
    cnt_data  = json.loads(SEED_K.read_text(encoding='utf-8'))
    ct_data   = json.loads(SEED_CT.read_text(encoding='utf-8')) if SEED_CT.exists() else {'rows': []}

    # 거래처: id 부여 + 임대관리 형식
    customers = {}
    by_company = {}  # 정규화된 회사명 → customer_id
    for i, row in enumerate(cust_data['rows']):
        company = (row.get('company') or '').strip()
        if not company: continue
        # 동일 회사명 중복 (지점이 다른 경우): 제품 / 주소로 구분
        key = normalize(company) + '|' + normalize(row.get('device', ''))
        if key in by_company:
            # 보강만 (메모 누적)
            existing = customers[by_company[key]]
            existing['memo'] = (existing.get('memo', '') + '\n--\n' + (row.get('memo') or '')).strip()
            continue

        cid = f"c_{i:04d}"
        by_company[key] = cid
        # source_sheet 따라 메모에 표시
        memo_parts = []
        if row.get('source_sheet') and row['source_sheet'] != '임대현황':
            memo_parts.append(f"[{row['source_sheet']}]")
        if row.get('device'): memo_parts.append(f"임대기기: {row['device']}")
        if row.get('rent_date'): memo_parts.append(f"임대일: {row['rent_date']}")
        if row.get('composition'): memo_parts.append(f"제품구성: {row['composition']}")
        if row.get('prepay_deposit'): memo_parts.append(f"선후불/보증금: {row['prepay_deposit']}")
        if row.get('extra_charge_text'): memo_parts.append(f"추가장당: {row['extra_charge_text']}")
        if row.get('check_day'): memo_parts.append(f"카운터점검일: {row['check_day']}")
        if row.get('bill_day_text'): memo_parts.append(f"청구일: {row['bill_day_text']}")
        if row.get('deposit_day'): memo_parts.append(f"입금일: {row['deposit_day']}")
        if row.get('memo'): memo_parts.append(f"비고: {row['memo']}")

        customers[cid] = {
            'id': cid,
            'company': company,
            'ceo': '',
            'biz_no': '',
            'corp_no': '',
            'biz_type': '',
            'biz_item': '',
            'address': row.get('address') or '',
            'phone': row.get('phone') or '',
            'fax': '',
            'email': '',
            'kakao': '',
            'memo': '\n'.join(memo_parts),
            'serials': [],
            'base_fee': row.get('base_fee') or 0,
            'bw_free': row.get('bw_free') or 0,
            'bw_rate': row.get('bw_rate') or 0,
            'co_free': row.get('co_free') or 0,
            'co_rate': row.get('co_rate') or 0,
            'contract_start': '',
            'contract_end': '',
            'contract_file': '',
            'created_at': '2026-05-11T00:00:00.000Z',
            'updated_at': '2026-05-11T00:00:00.000Z',
            'source_sheet': row.get('source_sheet'),
            '_extra_charge_raw': row.get('extra_charge_text', ''),
        }

    # 시리얼 마스터: 카운터에 등장한 모든 시리얼
    printers = {}
    for s, info in cnt_data.get('printers', {}).items():
        printers[s] = {
            'serial': s,
            'model': info.get('model', ''),
            'group': info.get('group', ''),
            'group_path': '',
            'asset_name': info.get('asset_name', ''),
            'ip': '',
            'matched_customer_id': None,
        }

    # 시리얼 ↔ 거래처 매칭 시도 (그룹/자산명 = 회사명)
    company_index = {}  # normalize(company) -> id
    for cid, c in customers.items():
        company_index[normalize(c['company'])] = cid

    META_GRP = {'1임대제품', '한별시스템', ''}
    matched = 0
    for s, p in printers.items():
        grp = (p.get('group') or '').strip()
        asset = (p.get('asset_name') or '').strip()
        cand = asset if (grp in META_GRP or grp.startswith('한별시스템')) else grp
        if not cand: continue
        cn = normalize(cand)
        # 정확 매칭
        cid = company_index.get(cn)
        # 부분 매칭
        if not cid:
            for k, v in company_index.items():
                if cn and (cn in k or k in cn) and len(cn) >= 3:
                    cid = v; break
        if cid:
            p['matched_customer_id'] = cid
            arr = customers[cid]['serials']
            if s not in arr: arr.append(s)
            matched += 1

    # 카운터 데이터 그대로
    counters = cnt_data.get('counters', {})

    # 계약서: 회사명 매칭으로 거래처에 연결
    contracts = {}
    contract_match = 0
    contract_orphan = 0
    for i, row in enumerate(ct_data.get('rows', [])):
        cid = company_index.get(normalize(row.get('company', '')))
        if not cid:
            # 부분 매칭 시도
            cn = normalize(row.get('company', ''))
            if cn and len(cn) >= 3:
                for k, v in company_index.items():
                    if cn in k or k in cn:
                        cid = v; break
        ctid = f"ct_{i:04d}"
        contracts[ctid] = {
            'id': ctid,
            'customer_id': cid,
            **row,
        }
        if cid: contract_match += 1
        else: contract_orphan += 1

    bundle = {
        'customers': customers,
        'printers': printers,
        'counters': counters,
        'meeting': {},
        'contracts': contracts,
        'prices': {},
        'meta': {
            'seed_built_at': '2026-05-11',
            'sources': {
                'rental_master': '한별시스템 임대현황.xlsx (임대현황+무상+BNI+우리정보)',
                'counters_nas': 'NAS 월별카운터/한별카운터*.xlsx (71개월)',
                'contracts_nas': 'NAS 세부현황/*.xlsx (거래처별 계약서)',
            },
            'counts': {
                'customers': len(customers),
                'printers': len(printers),
                'counters_periods': len(counters),
                'matched_serials': matched,
                'contracts': len(contracts),
                'contracts_matched': contract_match,
                'contracts_orphan': contract_orphan,
            },
        },
    }

    OUT.write_text(
        '// 자동 생성: tools/build_seed.py — 임대관리 시드 데이터\n' +
        '// 한별시스템 임대현황 + NAS 월별카운터 통합\n' +
        'window.RENTAL_SEED = ' + json.dumps(bundle, ensure_ascii=False, indent=2) + ';\n',
        encoding='utf-8'
    )

    print(f"=== 시드 빌드 완료 ===")
    print(f"  거래처:     {len(customers)}곳")
    print(f"  시리얼:     {len(printers)}대 (매칭 {matched}개)")
    print(f"  카운터 월:  {len(counters)}개월")
    print(f"  계약서:     {len(contracts)}건 (매칭 {contract_match}, 미매칭 {contract_orphan})")
    print(f"\n출력: {OUT}")

if __name__ == '__main__':
    main()
