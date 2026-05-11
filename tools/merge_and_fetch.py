"""① 엑셀 187행 → 회사명 단위 174건으로 통합
   ② Supabase rental_customers 현재 상태 fetch (anon)
   ③ _excel_merged.json / _db_customers.json 저장."""
import json
import re
import urllib.request
import urllib.parse
from pathlib import Path

ROOT = Path(r"C:\Users\UserK\Desktop\클로드코드공부\임대관리\tools")
SRC  = ROOT / "_excel_rows.json"
OUT_X = ROOT / "_excel_merged.json"
OUT_D = ROOT / "_db_customers.json"

# Supabase 설정 (lease/config.js 와 동일)
SUPA_URL = "https://jrzesjgyrvgvwazfajec.supabase.co"
SUPA_KEY = "sb_publishable_48aFW0y4TOcwFWbFa21lOQ_x08dqBr0"

# ── ① 엑셀 통합 ───────────────────────────────────────────
def norm_name(s):
    """매칭용 정규화 — 매칭 키만 만들고, 표시는 원문 보존.
    주의: 괄호/층/지점은 청구 단위 구분일 수 있으니 살린다.
    공백·줄바꿈만 제거하고 (주)·㈜만 정규화."""
    if not s: return ""
    s = str(s).replace("\n", " ")
    s = re.sub(r"\s+", "", s)
    s = s.replace("㈜", "(주)")
    return s.lower()

def coalesce(vals):
    """리스트에서 truthy 첫 값."""
    for v in vals:
        if v not in (None, "", 0): return v
    return None

rows = json.loads(SRC.read_text(encoding="utf-8"))["rows"]
buckets = {}
for r in rows:
    key = norm_name(r["company"])
    if not key: continue
    buckets.setdefault(key, []).append(r)

merged = []
for key, grp in buckets.items():
    grp_sorted = sorted(grp, key=lambda x: x.get("seq") or 0)
    # 회사 표시명: 첫번째 row 원문 사용 (가장 작은 seq)
    display = grp_sorted[0]["company"]
    def _s(v):
        return None if v is None else str(v)
    devices = [_s(g["device"]) for g in grp_sorted if g["device"]]
    products = [_s(g["product"]) for g in grp_sorted if g["product"]]
    addrs   = list({_s(g["address"]) for g in grp_sorted if g["address"]})
    memos   = [_s(g["memo"]) for g in grp_sorted if g["memo"]]
    rent_dates = [_s(g["rent_date"]) for g in grp_sorted if g["rent_date"]]

    base_fee = sum(g["base_fee"] or 0 for g in grp_sorted)
    biz_fee  = sum(g["biz_fee"]  or 0 for g in grp_sorted)

    # 추가카운터 — 첫 base_fee 있는 row의 정책 채택 (회사 1정책 가정)
    primary = next((g for g in grp_sorted if g["base_fee"]), grp_sorted[0])

    merged.append({
        "match_key": key,
        "company":   display,
        "seqs":      [g["seq"] for g in grp_sorted],
        "lines":     len(grp_sorted),
        "address":   addrs[0] if addrs else None,
        "address_alt": addrs[1:] if len(addrs) > 1 else [],
        "base_fee":  base_fee,
        "biz_fee":   biz_fee,
        "device":    "\n".join(devices),
        "product":   " / ".join(products),
        "memo":      "\n".join(memos),
        "rent_date": " / ".join(rent_dates),
        "bw_free":   primary.get("bw_free"),
        "bw_rate":   primary.get("bw_rate"),
        "co_free":   primary.get("co_free"),
        "co_rate":   primary.get("co_rate"),
        "check_day": primary.get("check_day"),
        "bill_day":  primary.get("bill_day"),
        "pay_type":  primary.get("pay_type"),
        "source_sheet": "임대현황.xlsx",
    })

merged.sort(key=lambda x: x["seqs"][0] if x["seqs"] else 0)
OUT_X.write_text(json.dumps({"count": len(merged), "rows": merged},
                            ensure_ascii=False, indent=2, default=str),
                 encoding="utf-8")
print(f"merged: 187 → {len(merged)} customers")

# ── ② Supabase fetch ──────────────────────────────────────
def fetch_table(table, select="*"):
    out = []
    page = 1000
    start = 0
    while True:
        url = f"{SUPA_URL}/rest/v1/{table}?select={urllib.parse.quote(select)}"
        req = urllib.request.Request(url, headers={
            "apikey": SUPA_KEY,
            "Authorization": f"Bearer {SUPA_KEY}",
            "Range": f"{start}-{start + page - 1}",
            "Range-Unit": "items",
            "Prefer": "count=exact",
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read().decode("utf-8")
                data = json.loads(body)
                cr = r.headers.get("Content-Range", "")
                if start == 0:
                    print(f"  HTTP {r.status}  Content-Range: {cr}")
        except urllib.error.HTTPError as e:
            print(f"  HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:300]}")
            return None
        out.extend(data)
        if len(data) < page: break
        start += page
    return out

print("fetching rental_customers …")
customers = fetch_table("rental_customers")
if customers is None:
    print("  ⚠ fetch 실패 (RLS 차단 가능). DB 비교는 스킵.")
    OUT_D.write_text(json.dumps({"count": 0, "rows": [], "error": "fetch_failed"},
                                ensure_ascii=False, indent=2),
                     encoding="utf-8")
else:
    OUT_D.write_text(json.dumps({"count": len(customers), "rows": customers},
                                ensure_ascii=False, indent=2, default=str),
                     encoding="utf-8")
    print(f"  fetched: {len(customers)} customers")

print("done.")
