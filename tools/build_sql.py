"""검수용 SQL 5종 생성:
   01_alter_schema.sql  — archived_at / archived_reason 컬럼 추가
   02_patch.sql         — 174건 PATCH (사실관계 필드만 + memo append)
   03_collisions.sql    — 24그룹 동명충돌: 자식 재배치 + 잉여 archive
   04_archive_orphans.sql — ORPHAN 79건 archive
   99_verify.sql        — 실행 전후 비교용 검증 쿼리

모두 BEGIN/COMMIT 트랜잭션 안에 감쌈 → 중간 실패 시 ROLLBACK.
"""
import json
from datetime import date
from pathlib import Path

ROOT = Path(r"C:\Users\UserK\Desktop\클로드코드공부\임대관리\tools")
SQL_DIR = ROOT / "sql"
SQL_DIR.mkdir(exist_ok=True)

EX  = json.load(open(ROOT/"_excel_merged.json", encoding="utf-8"))["rows"]
DB_DICT = json.load(open(ROOT/"db_customers.json", encoding="utf-8"))
DB  = list(DB_DICT.values())
CLS = json.load(open(ROOT/"_dryrun_classified.json", encoding="utf-8"))
REP = json.load(open(ROOT/"_dryrun_report.json", encoding="utf-8"))

today = "2026-05-11"
import re
def norm_name(s):
    if not s: return ""
    s = str(s).replace("\n", " ")
    s = re.sub(r"\s+", "", s)
    s = s.replace("㈜", "(주)")
    return s.lower()

db_by_key = {}
for d in DB:
    db_by_key.setdefault(norm_name(d.get("company")), []).append(d)
ex_by_key = {r["match_key"]: r for r in EX}

# classify_orphans.py 의 score() 와 동일한 primary 선정 기준
def primary_score(d):
    s = 0
    if d.get("serials"):           s += 1000 * len(d["serials"])
    if d.get("asms_customer_id"):  s += 500
    if d.get("base_fee"):          s += 10
    try: s += int(str(d.get("id","c_0000")).split("_")[1])
    except: pass
    return s

# 충돌 그룹의 primary id 집합 (PATCH 는 primary 에만 적용)
COLL_PRIMARY_BY_KEY = {}
for c in CLS["collisions_resolved"]:
    COLL_PRIMARY_BY_KEY[c["match_key"]] = c["primary"]["id"]

def q(v):
    """SQL 리터럴 — '는 '' 로 escape, None은 NULL."""
    if v is None: return "NULL"
    if isinstance(v, bool): return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)): return str(v)
    s = str(v).replace("'", "''")
    return "'" + s + "'"

def estr(v):
    """E'...' 형식 — 줄바꿈 보존."""
    if v is None: return "NULL"
    s = str(v).replace("\\", "\\\\").replace("'", "''")\
              .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return "E'" + s + "'"

# ── 01: 스키마 추가 ─────────────────────────────────────────
sql01 = f"""-- ============================================================
-- 01_alter_schema.sql  ({today})
-- rental_customers 에 archive 컬럼 추가
-- ============================================================
BEGIN;

ALTER TABLE rental_customers
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_reason TEXT;

-- 빠른 필터를 위한 부분 인덱스
CREATE INDEX IF NOT EXISTS rental_customers_active_idx
  ON rental_customers (id) WHERE archived_at IS NULL;

COMMIT;

-- 확인
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_name = 'rental_customers' AND column_name LIKE 'archived%';
"""
(SQL_DIR/"01_alter_schema.sql").write_text(sql01, encoding="utf-8")

# ── 02: PATCH 174건 ────────────────────────────────────────
patch_lines = [f"-- ============================================================",
               f"-- 02_patch.sql  ({today})",
               f"-- 174건 PATCH — 엑셀 임대현황.xlsx 기준 (PATCH 모드)",
               f"--   덮어쓰기 필드: base_fee/company/address/bw_*/co_*/source_sheet",
               f"--   memo: 엑셀 비고가 새 정보면 append, 기존 memo 보존",
               f"-- ============================================================",
               f"BEGIN;", ""]

PATCH_FIELDS_OVERWRITE = ["base_fee","company","address",
                          "bw_free","bw_rate","co_free","co_rate"]
MEMO_MARKER = f"[{today} 임대현황.xlsx 비고]"
UNLIMITED = 999999  # 시드와 일관: "무제한" = 999999

n_patched, n_memo_append = 0, 0
for ex in EX:
    db_rows = db_by_key.get(ex["match_key"], [])
    if not db_rows: continue
    # 충돌 그룹이면 classify_orphans 와 동일 기준의 primary 사용
    if ex["match_key"] in COLL_PRIMARY_BY_KEY:
        target_id = COLL_PRIMARY_BY_KEY[ex["match_key"]]
        db = next((d for d in db_rows if d["id"] == target_id), db_rows[0])
    else:
        db = db_rows[0]
    sets = []
    for f in PATCH_FIELDS_OVERWRITE:
        v = ex.get(f)
        if v in (None, 0, ""): continue
        if v == -1 and f in ("bw_free","co_free"):
            v = UNLIMITED  # "무제한" 표준화
        if str(db.get(f) or "").strip() == str(v).strip(): continue
        sets.append(f"{f} = {q(v)}")
    # source_sheet 통일
    if (db.get("source_sheet") or "") != "임대현황.xlsx":
        sets.append(f"source_sheet = {q('임대현황.xlsx')}")
    # memo append (엑셀 memo가 있고 DB memo에 같은 내용이 아직 없으면)
    ex_memo = (ex.get("memo") or "").strip()
    db_memo = (db.get("memo") or "")
    if ex_memo and ex_memo not in db_memo and MEMO_MARKER not in db_memo:
        new_memo = (db_memo.rstrip() + "\n\n" + MEMO_MARKER + "\n" + ex_memo).strip()
        sets.append(f"memo = {estr(new_memo)}")
        n_memo_append += 1
    if not sets:
        continue
    sets.append("updated_at = NOW()")
    patch_lines.append(
        f"UPDATE rental_customers SET {', '.join(sets)} WHERE id = {q(db['id'])};"
    )
    n_patched += 1

patch_lines += ["", f"-- 총 {n_patched}건 PATCH, memo append: {n_memo_append}건",
                "COMMIT;", "",
                "-- 검증",
                "SELECT COUNT(*) AS patched_today",
                "  FROM rental_customers",
                f" WHERE source_sheet = '임대현황.xlsx'",
                "   AND updated_at >= NOW() - INTERVAL '5 minutes';"]
(SQL_DIR/"02_patch.sql").write_text("\n".join(patch_lines), encoding="utf-8")

# ── 03: 동명충돌 24그룹 ─────────────────────────────────────
coll_lines = [f"-- ============================================================",
              f"-- 03_collisions.sql  ({today})",
              f"-- DB 동명충돌 24그룹: 자식 데이터 customer_id 재배치 → 잉여 archive",
              f"-- 자식 테이블: rental_printers, rental_contracts, rental_meetings, rental_archive",
              f"-- ============================================================",
              f"BEGIN;", ""]

all_dup_ids = []
for c in CLS["collisions_resolved"]:
    primary = c["primary"]["id"]
    dups    = [d["id"] for d in c["duplicates_to_archive"]]
    if not dups: continue
    coll_lines.append(f"-- [{c['match_key']}]  primary={primary}, archive={dups}")
    dup_list = ", ".join(q(x) for x in dups)
    coll_lines += [
        f"UPDATE rental_printers  SET customer_id = {q(primary)} WHERE customer_id IN ({dup_list});",
        f"UPDATE rental_contracts SET customer_id = {q(primary)} WHERE customer_id IN ({dup_list});",
        f"UPDATE rental_meetings  SET customer_id = {q(primary)} WHERE customer_id IN ({dup_list});",
        f"UPDATE rental_archive   SET customer_id = {q(primary)} WHERE customer_id IN ({dup_list});",
        f"UPDATE rental_customers SET archived_at = NOW(),",
        f"       archived_reason = {q(f'동명충돌 통합 ({today}) primary={primary}')}",
        f" WHERE id IN ({dup_list});",
        "",
    ]
    all_dup_ids.extend(dups)

coll_lines += [f"-- 총 archive 대상: {len(all_dup_ids)}건",
               "COMMIT;", "",
               "-- 검증",
               "SELECT id, company, archived_reason FROM rental_customers",
               f" WHERE id IN ({', '.join(q(x) for x in all_dup_ids[:10])})",
               " ORDER BY id;"]
(SQL_DIR/"03_collisions.sql").write_text("\n".join(coll_lines), encoding="utf-8")

# ── 04: ORPHAN archive (시리얼 25 + 종료후보 54 = 79건) ─────
orphan_ids_serial = [x["id"] for x in CLS["orphans_by_bucket"]["danger_serials"]]
orphan_ids_lapse  = [x["id"] for x in CLS["orphans_by_bucket"]["candidate_lapse"]]

orph_lines = [f"-- ============================================================",
              f"-- 04_archive_orphans.sql  ({today})",
              f"-- 엑셀에 없는 거래처 archive",
              f"--   시리얼 보유 25건  — 카운터 이력 보존, archived만 표시",
              f"--   종료 후보  54건  — 임대현황 출신·시리얼 없음",
              f"--   다른 시트   22건  — 보존 (active 유지, archive 안함)",
              f"-- ============================================================",
              f"BEGIN;", ""]

if orphan_ids_serial:
    orph_lines.append(f"-- A) 시리얼 보유 ORPHAN — {len(orphan_ids_serial)}건")
    ids = ",\n  ".join(q(x) for x in orphan_ids_serial)
    orph_lines += [
        f"UPDATE rental_customers",
        f"   SET archived_at = NOW(),",
        f"       archived_reason = {q(f'시리얼 보유·임대현황.xlsx 미포함 ({today}) — 카운터 이력 보존')}",
        f" WHERE id IN (\n  {ids}\n);",
        ""
    ]
if orphan_ids_lapse:
    orph_lines.append(f"-- B) 종료 후보 ORPHAN — {len(orphan_ids_lapse)}건")
    ids = ",\n  ".join(q(x) for x in orphan_ids_lapse)
    orph_lines += [
        f"UPDATE rental_customers",
        f"   SET archived_at = NOW(),",
        f"       archived_reason = {q(f'임대현황.xlsx 미포함 ({today})')}",
        f" WHERE id IN (\n  {ids}\n);",
        ""
    ]

orph_lines += ["COMMIT;", "",
               "-- 검증",
               "SELECT COUNT(*) AS archived_today",
               "  FROM rental_customers",
               f" WHERE archived_at >= NOW() - INTERVAL '5 minutes'",
               f"   AND archived_reason LIKE '%{today}%';"]
(SQL_DIR/"04_archive_orphans.sql").write_text("\n".join(orph_lines), encoding="utf-8")

# ── 99: 검증 ────────────────────────────────────────────────
verify = f"""-- ============================================================
-- 99_verify.sql  ({today})
-- 실행 전 / 실행 후 비교용 (각 단계마다 돌려보세요)
-- ============================================================

-- (1) 전체 거래처 카운트
SELECT 'total' AS label, COUNT(*) AS cnt FROM rental_customers
UNION ALL SELECT 'active', COUNT(*) FROM rental_customers WHERE archived_at IS NULL
UNION ALL SELECT 'archived', COUNT(*) FROM rental_customers WHERE archived_at IS NOT NULL;

-- (2) source_sheet 별 활성 거래처 분포
SELECT COALESCE(source_sheet, '(없음)') AS source_sheet, COUNT(*) AS active
  FROM rental_customers
 WHERE archived_at IS NULL
 GROUP BY 1 ORDER BY 2 DESC;

-- (3) 임대료 합계 (활성 거래처)
SELECT SUM(base_fee) AS sum_active_base_fee,
       COUNT(*)       AS active_count
  FROM rental_customers
 WHERE archived_at IS NULL
   AND source_sheet = '임대현황.xlsx';
-- 기대값: 174건, 15,863,000원

-- (4) 자식 데이터 — 고아 customer_id 검사
SELECT 'orphan_printer_cust_id' AS label, COUNT(*) AS cnt FROM rental_printers p
 WHERE customer_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM rental_customers c WHERE c.id = p.customer_id)
UNION ALL
SELECT 'orphan_contract_cust_id', COUNT(*) FROM rental_contracts c
 WHERE customer_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM rental_customers x WHERE x.id = c.customer_id)
UNION ALL
SELECT 'orphan_meeting_cust_id', COUNT(*) FROM rental_meetings m
 WHERE customer_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM rental_customers x WHERE x.id = m.customer_id)
UNION ALL
SELECT 'orphan_archive_cust_id', COUNT(*) FROM rental_archive a
 WHERE customer_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM rental_customers x WHERE x.id = a.customer_id);
-- 기대값: 모두 0

-- (5) archive 사유별 분포
SELECT archived_reason, COUNT(*) AS cnt FROM rental_customers
 WHERE archived_at IS NOT NULL
 GROUP BY 1 ORDER BY 2 DESC;
"""
(SQL_DIR/"99_verify.sql").write_text(verify, encoding="utf-8")

# 정합성 검증 — PATCH id ∩ archive id 가 비어야 함
patched_ids = set()
for ex in EX:
    db_rows = db_by_key.get(ex["match_key"], [])
    if not db_rows: continue
    if ex["match_key"] in COLL_PRIMARY_BY_KEY:
        tid = COLL_PRIMARY_BY_KEY[ex["match_key"]]
        patched_ids.add(next((d["id"] for d in db_rows if d["id"]==tid), db_rows[0]["id"]))
    else:
        patched_ids.add(db_rows[0]["id"])

archive_ids = set(all_dup_ids) | set(orphan_ids_serial) | set(orphan_ids_lapse)
conflict = patched_ids & archive_ids

# 보고
print(f"== SQL 생성 완료 → {SQL_DIR} ==")
for p in sorted(SQL_DIR.glob("*.sql")):
    print(f"  {p.name:30s}  {p.stat().st_size:>6} bytes")
print(f"\nPATCH 대상: {n_patched}건  (memo append: {n_memo_append}건)")
print(f"동명충돌 archive: {len(all_dup_ids)}건")
print(f"ORPHAN archive: 시리얼 {len(orphan_ids_serial)} + 종료후보 {len(orphan_ids_lapse)} = {len(orphan_ids_serial)+len(orphan_ids_lapse)}건")
print(f"\n정합성 검증: PATCH ∩ ARCHIVE = {len(conflict)}건 (0이어야 OK)")
if conflict:
    print(f"  ⚠ 충돌 ID: {sorted(conflict)}")
