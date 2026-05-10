"""
totalas — NAS auto backup
Run: daily via Windows Task Scheduler
     Action:    python.exe
     Arguments: "C:\\Users\\UserK\\Desktop\\클로드코드공부\\임대관리\\tools\\nas_backup.py"

Output: \\192.168.0.249\data\rental-backup-YYYYMMDD-vN\
  - README.md
  - rental_*.json    (Supabase tables dump)
  - files/           (Storage rental-files mirror)
"""
import os, json, re, sys
from pathlib import Path
from datetime import datetime
from urllib import request, error, parse

ROOT     = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env'
NAS_ROOT = Path(r'\\192.168.0.249\data')

# ---- env ----
def load_env():
    if not ENV_FILE.exists():
        sys.exit(f"❌ .env not found: {ENV_FILE}")
    for line in ENV_FILE.read_text(encoding='utf-8').splitlines():
        m = re.match(r'^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$', line)
        if m: os.environ[m.group(1)] = m.group(2)
load_env()

URL    = os.environ['SUPABASE_URL'].rstrip('/')
SECRET = os.environ.get('SUPABASE_SECRET_KEY') or os.environ.get('SUPABASE_SERVICE_ROLE')
if not URL or not SECRET:
    sys.exit("❌ SUPABASE_URL / SUPABASE_SECRET_KEY missing")

HEADERS = {
    'apikey':        SECRET,
    'Authorization': f'Bearer {SECRET}',
    'Accept':        'application/json',
}

# ---- backup folder (rental-backup-YYYYMMDD-vN) ----
today = datetime.now().strftime('%Y%m%d')
existing = sorted(NAS_ROOT.glob(f'rental-backup-{today}-v*'))
next_v = 1
if existing:
    nums = [int(p.name.rsplit('-v', 1)[1]) for p in existing if p.name.rsplit('-v',1)[1].isdigit()]
    if nums: next_v = max(nums) + 1
backup_dir = NAS_ROOT / f'rental-backup-{today}-v{next_v}'
backup_dir.mkdir(parents=True, exist_ok=False)
(backup_dir / 'files').mkdir()

print(f"[+] Backup target: {backup_dir}")

# ---- helpers ----
def http_get(url, headers=None):
    req = request.Request(url, headers={**HEADERS, **(headers or {})}, method='GET')
    with request.urlopen(req, timeout=120) as r:
        return r.read()

def http_post_json(url, body, headers=None):
    data = json.dumps(body).encode('utf-8')
    h = {**HEADERS, 'Content-Type': 'application/json', **(headers or {})}
    req = request.Request(url, data=data, headers=h, method='POST')
    with request.urlopen(req, timeout=120) as r:
        return r.read()

# ---- tables ----
TABLES = [
    'rental_customers',
    'rental_printers',
    'rental_counters',
    'rental_contracts',
    'rental_meetings',
    'rental_archive',
    'rental_prices',
    'rental_customer_attachments',
]

summary = {}
for t in TABLES:
    print(f"  - {t} ...", end='', flush=True)
    try:
        # PostgREST 기본 페이지네이션 1000건. Range 헤더로 전체 받기.
        all_rows = []
        offset = 0
        page = 1000
        while True:
            url = f'{URL}/rest/v1/{t}?select=*&limit={page}&offset={offset}'
            raw = http_get(url)
            rows = json.loads(raw)
            if not rows: break
            all_rows.extend(rows)
            if len(rows) < page: break
            offset += page
        (backup_dir / f'{t}.json').write_text(
            json.dumps(all_rows, ensure_ascii=False, indent=2),
            encoding='utf-8'
        )
        summary[t] = len(all_rows)
        print(f" {len(all_rows)} rows")
    except error.HTTPError as e:
        msg = e.read().decode('utf-8', errors='replace')[:300]
        summary[t] = f"ERROR {e.code}: {msg}"
        print(f" FAIL {e.code}")
    except Exception as e:
        summary[t] = f"ERROR: {e}"
        print(f" FAIL: {e}")

# ---- Storage mirror: rental-files bucket ----
print("[+] Storage rental-files download...")
def list_storage(prefix=''):
    url = f'{URL}/storage/v1/object/list/rental-files'
    body = {'prefix': prefix, 'limit': 1000, 'offset': 0}
    return json.loads(http_post_json(url, body))

def download_storage_object(remote_path, local_path):
    url = f'{URL}/storage/v1/object/rental-files/{parse.quote(remote_path)}'
    req = request.Request(url, headers=HEADERS, method='GET')
    with request.urlopen(req, timeout=300) as r, open(local_path, 'wb') as f:
        while True:
            chunk = r.read(64 * 1024)
            if not chunk: break
            f.write(chunk)

def walk_bucket(prefix='', dest=backup_dir / 'files', count=[0]):
    try:
        items = list_storage(prefix)
    except error.HTTPError as e:
        if e.code == 400:
            return  # bucket empty
        print(f"  list fail ({prefix}): {e.code}")
        return
    except Exception as e:
        print(f"  list fail ({prefix}): {e}")
        return
    for obj in items:
        name = obj.get('name')
        if not name: continue
        # folder marker (id == None)
        if obj.get('id') is None:
            sub = dest / name
            sub.mkdir(exist_ok=True)
            walk_bucket(f'{prefix}{name}/', sub, count)
        else:
            remote = f'{prefix}{name}'
            local = dest / name
            try:
                download_storage_object(remote, local)
                count[0] += 1
            except Exception as e:
                print(f"  download fail: {remote} — {e}")
walk_bucket()

# ---- README ----
lines = [
    f"# rental-backup-{today}-v{next_v}",
    "",
    f"Created: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
    f"Source:  {URL}  (Supabase REST API, secret key auth)",
    "",
    "## Table row counts",
]
for k, v in summary.items():
    lines.append(f"- {k}: {v}")
lines += [
    "",
    "## Restore",
    "1. Apply schema: supabase/migrations/20260511_init_rental.sql",
    "2. INSERT json files into the new project",
    "3. Upload files/ to bucket rental-files",
]
(backup_dir / 'README.md').write_text('\n'.join(lines), encoding='utf-8')

print(f"\n[OK] Backup complete: {backup_dir}")
for k, v in summary.items():
    print(f"  {k}: {v}")
