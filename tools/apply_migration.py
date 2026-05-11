"""
totalas — Supabase 마이그레이션 SQL 자동 적용.

사용:
    python tools/apply_migration.py
        → supabase/migrations/20260511_phase2_extras.sql 적용

    python tools/apply_migration.py supabase/migrations/<파일명>.sql
        → 지정한 파일 적용

요구:
    .env에 SUPABASE_DB_URL 추가 (Dashboard → Settings → Database → Connection string → URI)
    pip install psycopg2-binary
"""
import os, re, sys, argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV  = ROOT / '.env'

# .env 로드
if ENV.exists():
    for line in ENV.read_text(encoding='utf-8').splitlines():
        m = re.match(r'^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$', line)
        if m: os.environ[m.group(1)] = m.group(2)

DB_URL = os.environ.get('SUPABASE_DB_URL')
if not DB_URL:
    sys.exit(
        "[X] .env에 SUPABASE_DB_URL이 없습니다.\n"
        "    Supabase Dashboard -> Settings -> Database -> Connection string -> URI\n"
        "    형식: postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
    )

try:
    import psycopg2
except ImportError:
    sys.exit("[X] psycopg2가 없습니다.\n    설치: pip install psycopg2-binary")

parser = argparse.ArgumentParser()
parser.add_argument('migration', nargs='?',
                    default='supabase/migrations/20260511_phase2_extras.sql')
args = parser.parse_args()

sql_path = ROOT / args.migration
if not sql_path.exists():
    sys.exit(f"[X] 파일 없음: {sql_path}")

sql = sql_path.read_text(encoding='utf-8')
host_part = DB_URL.split('@', 1)[1].split('/', 1)[0] if '@' in DB_URL else '(unknown)'
print(f"=== 적용 ===\n  파일: {sql_path.name}\n  대상: {host_part}\n")

conn = psycopg2.connect(DB_URL)
try:
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()
    print("[OK] 적용 완료")
finally:
    conn.close()
