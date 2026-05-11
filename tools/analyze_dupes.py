"""엑셀 파싱 결과에서 중복 회사명, 빈 base_fee 등 이상치 진단."""
import json
from collections import Counter, defaultdict
from pathlib import Path

J = Path(r"C:\Users\UserK\Desktop\클로드코드공부\임대관리\tools\_excel_rows.json")
OUT = Path(r"C:\Users\UserK\Desktop\클로드코드공부\임대관리\tools\_excel_diag.json")

data = json.loads(J.read_text(encoding="utf-8"))
rows = data["rows"]

# 회사명 중복
name_groups = defaultdict(list)
for r in rows:
    name_groups[r["company"]].append({
        "seq": r["seq"], "device": r["device"], "base_fee": r["base_fee"],
        "address": r["address"], "memo_head": (r["memo"] or "")[:40],
    })

duplicates = {k: v for k, v in name_groups.items() if len(v) > 1}

# base_fee 누락
no_fee = [{"seq": r["seq"], "company": r["company"], "device": r["device"]}
          for r in rows if not r["base_fee"]]

# 빈 회사명 / 단일 문자
short = [{"seq": r["seq"], "company": r["company"]}
         for r in rows if len(r["company"]) <= 2]

# 통계
total_fee = sum(r["base_fee"] or 0 for r in rows)
have_address = sum(1 for r in rows if r["address"])
have_device  = sum(1 for r in rows if r["device"])

report = {
    "total_rows": len(rows),
    "unique_names": len(name_groups),
    "duplicate_groups": len(duplicates),
    "duplicates": duplicates,
    "rows_without_base_fee": no_fee,
    "rows_with_short_name": short,
    "sum_base_fee": total_fee,
    "have_address": have_address,
    "have_device": have_device,
}

OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"wrote {OUT.name}")
print(f"중복그룹: {len(duplicates)}, 임대금액없음: {len(no_fee)}, 짧은이름: {len(short)}")
print(f"임대금액합계: {total_fee:,}원   주소있음: {have_address}/{len(rows)}")
