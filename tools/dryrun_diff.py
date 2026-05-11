"""드라이런 보고서:
   엑셀 통합 174건 ↔ DB 현재 거래처 매칭 결과를 3분류로 출력.

분류:
  ADD     — 엑셀에는 있는데 DB에 없음 (신규 INSERT)
  PATCH   — 양쪽 있음. PATCH 모드 — 엑셀 필드만 갱신, DB 풍부정보 보존.
  ORPHAN  — DB에는 있는데 엑셀에 없음 (삭제 후보 → archived 플래그 권장)

PATCH 대상은 필드별 diff를 표시 (변경되는 필드만).
"""
import json
import re
from pathlib import Path
from collections import defaultdict

ROOT = Path(r"C:\Users\UserK\Desktop\클로드코드공부\임대관리\tools")
EX = json.loads((ROOT/"_excel_merged.json").read_text(encoding="utf-8"))["rows"]
DB_RAW = json.loads((ROOT/"db_customers.json").read_text(encoding="utf-8"))
# 사용자 export 포맷 다양 — 표준화
if isinstance(DB_RAW, list):
    DB = DB_RAW
elif isinstance(DB_RAW, dict) and "rows" in DB_RAW:
    DB = DB_RAW["rows"]
elif isinstance(DB_RAW, dict):
    DB = list(DB_RAW.values())  # {id: row} 형태
else:
    raise SystemExit("db_customers.json 포맷 인식 불가")

print(f"엑셀: {len(EX)}건, DB: {len(DB)}건")

# ── 매칭 키 정규화 (엑셀과 동일 규칙) ──
def norm(s):
    if not s: return ""
    s = str(s).replace("\n", " ")
    s = re.sub(r"\s+", "", s)
    s = s.replace("㈜", "(주)")
    return s.lower()

ex_by_key = {r["match_key"]: r for r in EX}
db_by_key = defaultdict(list)
for r in DB:
    db_by_key[norm(r.get("company"))].append(r)

# DB에서 동일 정규화 키가 여러 row인 경우 — 별도 보고
db_collisions = {k: v for k, v in db_by_key.items() if len(v) > 1}

# ── 분류 ──
ADD, PATCH, ORPHAN = [], [], []

# PATCH 대상에서 갱신할 엑셀 필드만 정의
PATCH_FIELDS = {
    "company":   ("company",  lambda x: x),
    "address":   ("address",  lambda x: x),
    "base_fee":  ("base_fee", lambda x: int(x or 0)),
    "memo":      ("memo",     lambda x: x),
    "bw_free":   ("bw_free",  lambda x: int(x) if x is not None else None),
    "bw_rate":   ("bw_rate",  lambda x: int(x) if x is not None else None),
    "co_free":   ("co_free",  lambda x: int(x) if x is not None else None),
    "co_rate":   ("co_rate",  lambda x: int(x) if x is not None else None),
    "source_sheet": ("source_sheet", lambda x: x),
}

def normalize_v(v):
    if v is None or v == "": return None
    if isinstance(v, str): return v.strip() or None
    return v

for key, ex in ex_by_key.items():
    db_rows = db_by_key.get(key, [])
    if not db_rows:
        ADD.append(ex)
        continue
    # 충돌 시 첫번째 매칭 (drift 보고에 표시)
    db = db_rows[0]
    diff = {}
    for ex_field, (db_field, _cast) in PATCH_FIELDS.items():
        ex_v = normalize_v(ex.get(ex_field))
        db_v = normalize_v(db.get(db_field))
        # PATCH 모드: 엑셀에 값이 있을 때만 덮어쓰기 (빈값으로 덮어쓰지 않음)
        if ex_v in (None, 0): continue
        # base_fee 는 0 도 의미 있을 수 있으나 PATCH 모드라 0 skip
        if ex_v != db_v:
            diff[db_field] = {"db": db_v, "excel": ex_v}
    PATCH.append({
        "match_key": key,
        "company": ex["company"],
        "db_id": db.get("id"),
        "db_company": db.get("company"),
        "fields_changed": list(diff.keys()),
        "diff": diff,
        "no_change": not diff,
    })

for key, dbs in db_by_key.items():
    if key not in ex_by_key:
        for d in dbs:
            ORPHAN.append({
                "match_key": key,
                "id": d.get("id"),
                "company": d.get("company"),
                "base_fee": d.get("base_fee"),
                "serials_count": len(d.get("serials") or []),
                "asms_customer_id": d.get("asms_customer_id"),
            })

# ── 보고서 ──
report = {
    "summary": {
        "excel_total": len(EX),
        "db_total":    len(DB),
        "add":     len(ADD),
        "patch":   len(PATCH),
        "patch_with_changes": sum(1 for p in PATCH if not p["no_change"]),
        "patch_no_change":    sum(1 for p in PATCH if p["no_change"]),
        "orphan":  len(ORPHAN),
        "db_name_collisions": len(db_collisions),
    },
    "add_list":    [{"company": r["company"], "base_fee": r["base_fee"],
                     "address": r["address"], "lines": r["lines"]} for r in ADD],
    "patch_list":  PATCH,
    "orphan_list": ORPHAN,
    "db_collisions": db_collisions,
}

out = ROOT / "_dryrun_report.json"
out.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

# 콘솔 요약
s = report["summary"]
print("\n========== 드라이런 요약 ==========")
print(f"  ADD    (신규 INSERT) : {s['add']:>4}건")
print(f"  PATCH  (양쪽 매칭)   : {s['patch']:>4}건")
print(f"     └ 실제 변경 있음 : {s['patch_with_changes']:>4}건")
print(f"     └ 변경 없음      : {s['patch_no_change']:>4}건")
print(f"  ORPHAN (DB만 존재)   : {s['orphan']:>4}건  ← 삭제 후보")
print(f"  DB 동명 충돌         : {s['db_name_collisions']:>4}건")
print(f"\n  상세: {out}")
