"""임대현황.xlsx 전체 파싱 → JSON.
헤더 위치는 동적으로 '순번' 또는 '회사명' 셀을 찾아 결정.
"""
import json
import re
from pathlib import Path
import openpyxl

XL  = Path(r"C:\Users\UserK\Desktop\클로드코드공부\임대관리\data\임대현황.xlsx")
OUT = Path(r"C:\Users\UserK\Desktop\클로드코드공부\임대관리\tools\_excel_rows.json")

wb = openpyxl.load_workbook(XL, data_only=True, read_only=True)
ws = wb["Sheet1"]
all_rows = list(ws.iter_rows(values_only=True))

# 헤더 자동 탐지
HEADER_KEYS = ["순번", "회사명", "임대기기", "임대금액"]
header_idx = None
for i, r in enumerate(all_rows):
    cells = [str(c).strip() if c is not None else "" for c in r]
    hits = sum(1 for k in HEADER_KEYS if k in cells)
    if hits >= 3:
        header_idx = i
        header = cells
        break
if header_idx is None:
    raise SystemExit("헤더를 찾지 못했습니다")

# 컬럼 인덱스 매핑
COL = {h: i for i, h in enumerate(header) if h}

def cell(r, name):
    i = COL.get(name)
    if i is None or i >= len(r): return None
    v = r[i]
    if v is None: return None
    if isinstance(v, str): return v.strip() or None
    return v

def parse_int(v):
    if v is None: return None
    if isinstance(v, (int, float)): return int(v)
    s = re.sub(r"[^\d]", "", str(v))
    return int(s) if s else None

def parse_extra_charge(s):
    """'흑:500매(10원)\n컬:500매(100원)' → {bw_free, bw_rate, co_free, co_rate}"""
    if not s: return {}
    out = {}
    text = str(s).replace(",", "")
    # 흑/컬 라인
    for m in re.finditer(r"(흑|컬|컬러)[^:]*?:\s*([\d,]+)\s*매?\s*\(?\s*(\d+)?\s*원?", text):
        kind, free, rate = m.group(1), m.group(2), m.group(3)
        key_free = "bw_free" if kind == "흑" else "co_free"
        key_rate = "bw_rate" if kind == "흑" else "co_rate"
        out[key_free] = int(free.replace(",", ""))
        if rate: out[key_rate] = int(rate)
    # '무제한' 표시
    if re.search(r"흑[^컬]*무제한", text): out["bw_free"] = -1
    if re.search(r"(컬|컬러)[^흑]*무제한", text): out["co_free"] = -1
    return out

rows = []
empty_streak = 0
for r in all_rows[header_idx + 1 :]:
    if r is None or all(c is None or (isinstance(c, str) and not c.strip()) for c in r):
        empty_streak += 1
        if empty_streak >= 3: break
        continue
    empty_streak = 0
    seq = cell(r, "순번")
    company = cell(r, "회사명")
    if not company:
        continue
    row_out = {
        "seq": parse_int(seq),
        "company_raw": company,
        "company": re.sub(r"\s+", " ", company.replace("\n", " ")).strip(),
        "device": cell(r, "임대기기"),
        "base_fee": parse_int(cell(r, "임대금액")),
        "biz_fee":  parse_int(cell(r, "사업자금액")),
        "check_day": cell(r, "카운터점검일"),
        "bill_day":  cell(r, "청구일"),
        "tax_invoice": cell(r, "계산서"),
        "pay_day":  cell(r, "입금일(익월)"),
        "extra_raw": cell(r, "추가장당"),
        "address":  cell(r, "주소"),
        "rent_date":cell(r, "임대날짜"),
        "product":  cell(r, "제품구성"),
        "pay_type": cell(r, "선후불/보증금"),
        "memo":     cell(r, "비고"),
    }
    row_out.update(parse_extra_charge(row_out["extra_raw"]))
    rows.append(row_out)

OUT.write_text(json.dumps({
    "header_row": header_idx,
    "headers": header,
    "count": len(rows),
    "rows": rows,
}, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

print(f"parsed: {len(rows)} rows → {OUT.name}")
print(f"unique company names: {len(set(r['company'] for r in rows))}")
