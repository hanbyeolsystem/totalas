# 🚀 한별시스템 통합 프로젝트 지침 (v2.0)

## 🏗 핵심 인프라 (삼각 편대)
1. **Local PC:** 작업 경로 `C:\Users\UserK\Desktop\클로드코드공부\임대관리`
2. **Database:** Supabase (실시간 데이터 및 API 관리)
3. **Hosting:** GitHub Pages (https://hanbyeolsystem.github.io/totalas/asms.html)

## 📡 데이터 및 라우팅 규칙
- **Data First:** 모든 비즈니스 데이터(현황, 거래처, 카운터, 청구)는 Supabase DB를 최우선으로 한다.
- **Hash Routing:** 웹상에서 이동 시 `#폴더명/index.html` 형태의 해시 라우팅을 반드시 준수한다.
- **NAS Backup:** 현재는 고려하지 않는다 (비활성).

## 🎯 비즈니스 목표
- 매출 30억 달성을 위한 자동화 시스템 구축.
- 모든 UI는 `asms.html` 내에서 부드럽게 통합되도록 구현한다.