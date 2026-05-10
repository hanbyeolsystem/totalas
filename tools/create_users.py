"""
totalas — 초기 사용자 (admin + engineer) 생성.

Auth: id → '<id>@totalas.local' 매핑.
service_role 권한이 필요함 (.env 의 SUPABASE_SECRET_KEY 사용, email_confirm 자동 통과).

실행:  python tools/create_users.py
"""
import os, json, re, sys
from pathlib import Path
from urllib import request, error

ROOT = Path(__file__).resolve().parent.parent
ENV  = ROOT / '.env'

# .env 로드
for line in ENV.read_text(encoding='utf-8').splitlines():
    m = re.match(r'^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$', line)
    if m: os.environ[m.group(1)] = m.group(2)

URL    = os.environ['SUPABASE_URL'].rstrip('/')
SECRET = os.environ['SUPABASE_SECRET_KEY']

HEADERS = {
    'apikey':        SECRET,
    'Authorization': f'Bearer {SECRET}',
    'Content-Type':  'application/json',
    'Accept':        'application/json',
}
EMAIL_DOMAIN = '@totalas.local'

# 초기 계정
USERS = [
    { 'display_id': 'hanbyeol2', 'password': 'hanbyeol2', 'role': 'admin',    'full_name': '관리자' },
    { 'display_id': 'hanbyeol',  'password': 'hanbyeol',  'role': 'engineer', 'full_name': '엔지니어' },
]

def post_json(url, body, headers=None, prefer=None):
    data = json.dumps(body).encode('utf-8')
    h = {**HEADERS, **(headers or {})}
    if prefer: h['Prefer'] = prefer
    req = request.Request(url, data=data, headers=h, method='POST')
    with request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode('utf-8') or '{}')

def get_json(url, headers=None):
    req = request.Request(url, headers={**HEADERS, **(headers or {})}, method='GET')
    with request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode('utf-8') or '[]')

def find_user(email):
    """auth.admin API: 이메일로 사용자 조회 (없으면 None)"""
    try:
        users = get_json(f'{URL}/auth/v1/admin/users?per_page=1000')
    except error.HTTPError as e:
        return None
    target = email.lower()
    pool = users.get('users') if isinstance(users, dict) else users
    for u in pool or []:
        if (u.get('email') or '').lower() == target:
            return u
    return None

def upsert_profile(user_id, display_id, role, full_name):
    body = [{
        'user_id': user_id,
        'display_id': display_id,
        'role': role,
        'full_name': full_name,
        'active': True,
    }]
    post_json(
        f'{URL}/rest/v1/rental_user_profiles',
        body,
        prefer='resolution=merge-duplicates,return=minimal',
    )

def create_or_get(u):
    email = f"{u['display_id']}{EMAIL_DOMAIN}"
    existing = find_user(email)
    if existing:
        print(f"  • {u['display_id']} 이미 존재 (id={existing['id'][:8]}...) — 비밀번호 갱신")
        # 비밀번호 + metadata 갱신
        try:
            req = request.Request(
                f"{URL}/auth/v1/admin/users/{existing['id']}",
                data=json.dumps({
                    'password': u['password'],
                    'email_confirm': True,
                    'user_metadata': {
                        'display_id': u['display_id'],
                        'role':       u['role'],
                        'full_name':  u['full_name'],
                    },
                }).encode('utf-8'),
                headers=HEADERS,
                method='PUT',
            )
            with request.urlopen(req, timeout=30) as r: r.read()
        except error.HTTPError as e:
            print(f"    ⚠ 갱신 실패 {e.code}: {e.read().decode('utf-8')[:200]}")
        upsert_profile(existing['id'], u['display_id'], u['role'], u['full_name'])
        return existing['id']

    # 새로 생성
    body = {
        'email':          email,
        'password':       u['password'],
        'email_confirm':  True,
        'user_metadata':  {
            'display_id': u['display_id'],
            'role':       u['role'],
            'full_name':  u['full_name'],
        },
    }
    res = post_json(f'{URL}/auth/v1/admin/users', body)
    user_id = res['id']
    upsert_profile(user_id, u['display_id'], u['role'], u['full_name'])
    print(f"  ✅ {u['display_id']:12} ({u['role']:8}) 생성됨")
    return user_id

def main():
    print(f"=== 초기 사용자 생성 ===\n  Supabase: {URL}\n")
    for u in USERS:
        create_or_get(u)
    print("\n=== 완료 ===")
    print("로그인:")
    for u in USERS:
        print(f"  • {u['display_id']:12} / {u['password']:12} ({u['role']})")

if __name__ == '__main__':
    main()
