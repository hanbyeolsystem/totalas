"""엑셀 통합본(174건) 요약 — 사용자 검토용."""
import json
from pathlib import Path
from collections import Counter

J = Path(r"C:\Users\UserK\Desktop\클로드코드공부\임대관리\tools\_excel_merged.json")
data = json.loads(J.read_text(encoding="utf-8"))
rows = data["rows"]

multi = [r for r in rows if r["lines"] > 1]
single = [r for r in rows if r["lines"] == 1]

# 통합으로 인한 base_fee 합산 확인
multi_fee = sum(r["base_fee"] for r in multi)
single_fee = sum(r["base_fee"] for r in single)
total_fee = multi_fee + single_fee

# 추가카운터 정책 파싱 통계
has_bw = sum(1 for r in rows if r.get("bw_free") is not None)
has_co = sum(1 for r in rows if r.get("co_free") is not None)
has_pol = sum(1 for r in rows if any(r.get(k) is not None for k in ("bw_free","bw_rate","co_free","co_rate")))

# fee 구간
def bucket(v):
    if v == 0: return "0원(AS·서비스)"
    if v < 50000: return "1~5만"
    if v < 100000: return "5~10만"
    if v < 200000: return "10~20만"
    if v < 500000: return "20~50만"
    return "50만+"
bins = Counter(bucket(r["base_fee"]) for r in rows)

# 통합된 회사들의 예시 (lines>=2)
multi_sample = sorted(multi, key=lambda x: -x["lines"])[:12]

# 한 회사가 여러 주소를 가진 경우 (경고)
addr_warn = [{"company": r["company"], "addr": r["address"], "addr_alt": r["address_alt"]}
             for r in rows if r["address_alt"]]

report = {
    "total_customers": len(rows),
    "single_line": len(single),
    "multi_line": len(multi),
    "sum_base_fee": total_fee,
    "fee_buckets": dict(bins),
    "extra_charge_policy_count": has_pol,
    "address_conflicts": addr_warn,
    "multi_line_examples": [
        {
            "company": r["company"],
            "lines":   r["lines"],
            "seqs":    r["seqs"],
            "base_fee_sum": r["base_fee"],
            "device": r["device"].split("\n"),
        }
        for r in multi_sample
    ],
}

out = Path(r"C:\Users\UserK\Desktop\클로드코드공부\임대관리\tools\_excel_summary.json")
out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"total={len(rows)}  single={len(single)}  multi={len(multi)}")
print(f"sum_base_fee={total_fee:,}원")
print("fee buckets:", dict(bins))
print(f"extra-charge policy parsed: {has_pol}/{len(rows)}")
print(f"address conflicts: {len(addr_warn)}")
