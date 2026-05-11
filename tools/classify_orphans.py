"""ORPHAN 101건과 DB 동명 충돌 24건을 위험도별로 분류."""
import json
from pathlib import Path
from collections import defaultdict

ROOT = Path(r"C:\Users\UserK\Desktop\클로드코드공부\임대관리\tools")
report = json.load(open(ROOT/"_dryrun_report.json", encoding="utf-8"))
db_dict = json.load(open(ROOT/"db_customers.json", encoding="utf-8"))
db_by_id = {k: v for k, v in db_dict.items()}

# ── ORPHAN 분류 ──
# 위험도: 시리얼 보유 > ASMS 연동 > 카운터 이력 가능성
buckets = {
    "danger_serials":    [],  # 시리얼 있음 → 카운터 이력 보호 필요
    "danger_asms":       [],  # ASMS 연동 있음
    "safe_other_sheets": [],  # 무상/BNI/우리정보 출신 → 정책상 별도
    "candidate_lapse":   [],  # 임대현황 출신·시리얼 없음 → 진짜 종료된 거래처 후보
    "unknown":           [],
}
for o in report["orphan_list"]:
    d = db_by_id.get(o["id"], {})
    src   = d.get("source_sheet", "")
    sers  = d.get("serials") or []
    asms  = d.get("asms_customer_id")
    item = {
        "id": o["id"], "company": d.get("company"),
        "source_sheet": src,
        "base_fee": d.get("base_fee"),
        "serials": sers, "asms": asms,
        "memo_head": (d.get("memo") or "")[:60],
    }
    if sers:               buckets["danger_serials"].append(item)
    elif asms:             buckets["danger_asms"].append(item)
    elif src in ("무상임대현황","BNI","우리정보임대"):
                            buckets["safe_other_sheets"].append(item)
    elif src in ("임대현황","임대현황.xlsx"):
                            buckets["candidate_lapse"].append(item)
    else:                  buckets["unknown"].append(item)

# ── DB 동명 충돌 24건 — primary 후보 선정 ──
# 정책: 시리얼 많은 row > ASMS 연동 row > 가장 최근(c_xxxx 큰값) > 첫번째
def score(d):
    s = 0
    if d.get("serials"):           s += 1000 * len(d["serials"])
    if d.get("asms_customer_id"):  s += 500
    if d.get("base_fee"):          s += 10
    # id 후순(나중에 만든것) 우대
    try: s += int(str(d.get("id","c_0000")).split("_")[1])
    except: pass
    return s

collisions = []
for k, rows in report["db_collisions"].items():
    # primary 후보
    ranked = sorted(rows, key=score, reverse=True)
    primary, dups = ranked[0], ranked[1:]
    collisions.append({
        "match_key": k,
        "primary": {
            "id": primary["id"], "company": primary.get("company"),
            "serials": primary.get("serials") or [],
            "asms": primary.get("asms_customer_id"),
            "base_fee": primary.get("base_fee"),
        },
        "duplicates_to_archive": [
            {
                "id": d["id"], "company": d.get("company"),
                "serials": d.get("serials") or [],
                "base_fee": d.get("base_fee"),
                "source_sheet": d.get("source_sheet"),
            } for d in dups
        ],
    })

out = ROOT / "_dryrun_classified.json"
out.write_text(json.dumps({
    "orphans_by_bucket": buckets,
    "collisions_resolved": collisions,
    "summary": {
        "danger_serials":    len(buckets["danger_serials"]),
        "danger_asms":       len(buckets["danger_asms"]),
        "safe_other_sheets": len(buckets["safe_other_sheets"]),
        "candidate_lapse":   len(buckets["candidate_lapse"]),
        "unknown":           len(buckets["unknown"]),
        "collisions":        len(collisions),
        "dup_rows_total":    sum(len(c["duplicates_to_archive"]) for c in collisions),
    },
}, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

s = json.load(open(out, encoding="utf-8"))["summary"]
import sys
sys.stdout.reconfigure(encoding="utf-8")
print("== ORPHAN 위험도 분류 ==")
print(f"  [위] 시리얼 보유      : {s['danger_serials']:>3}건  -- 카운터 이력 보호 필수")
print(f"  [위] ASMS 연동       : {s['danger_asms']:>3}건")
print(f"  [정보] 다른 시트 거래처 : {s['safe_other_sheets']:>3}건  (무상/BNI/우리정보)")
print(f"  [OK] 종료 후보       : {s['candidate_lapse']:>3}건  (임대현황 출신, 시리얼 없음)")
print(f"  [?] 분류불가        : {s['unknown']:>3}건")
print(f"\n== DB 동명 충돌 ==")
print(f"  그룹 수: {s['collisions']}, 통합 시 archive 될 행: {s['dup_rows_total']}건")
