"""
모든 인증 필요 페이지에 auth 스크립트 주입 + 사이드바에 admin-users 링크 추가.
실행: python tools/inject_auth.py
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES = [
    'index.html', 'customers.html', 'contracts.html', 'counters.html',
    'prices.html', 'meetings.html', 'archive.html', 'asms.html', 'errorcode.html',
]

AUTH_SCRIPTS = """<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="config.js"></script>
<script src="auth.js"></script>
"""

ADMIN_LINK = '<a href="admin-users.html" data-role-only="admin"><span class="nav-icon">👑</span><span>사용자 관리</span></a>'

def inject_head_scripts(html):
    """auth.js 가 이미 있으면 skip. 없으면 </head> 직전 삽입."""
    if 'auth.js' in html: return html
    # </head> 직전
    return html.replace('</head>', AUTH_SCRIPTS + '</head>', 1)

def inject_admin_link(html):
    if 'admin-users.html' in html: return html
    # 마지막 nav anchor (고객자료실) 뒤에 admin 링크 추가
    pattern = re.compile(r'(<a href="archive\.html"[^>]*>.*?고객자료실</span>\s*</a>)', re.S)
    if pattern.search(html):
        return pattern.sub(r'\1\n      ' + ADMIN_LINK, html, count=1)
    return html

for name in PAGES:
    p = ROOT / name
    if not p.exists():
        print(f"  ⚠ {name} 없음, skip"); continue
    src = p.read_text(encoding='utf-8')
    new = inject_head_scripts(src)
    new = inject_admin_link(new)
    if new != src:
        p.write_text(new, encoding='utf-8')
        print(f"  ✅ {name}")
    else:
        print(f"  =  {name} (변경 없음)")
print("\n완료")
