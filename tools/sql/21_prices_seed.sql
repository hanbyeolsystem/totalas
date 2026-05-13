-- ============================================================
-- 21_prices_seed.sql  (2026-05-13)
-- 기존 5개 가격표 메타데이터를 prices_index 에 시드.
-- file_path 는 GitHub Pages 절대 URL (Storage 마이그레이션 안 함).
-- UI 의 '+ 가격표 추가' 로 새로 업로드한 파일은 Storage 경로로 저장됨.
-- 멱등 — ON CONFLICT (file_path) DO NOTHING.
-- ============================================================

INSERT INTO prices_index (label, meta, file_path, ext, sort_order) VALUES
  ('교세라 부품 가격표',
   '2026.01',
   'https://hanbyeolsystem.github.io/totalas/prices/1교세라부품 가격표_2026년1월.xlsx',
   'xlsx', 1),

  ('위더스 재생토너 단가표',
   '2022.08',
   'https://hanbyeolsystem.github.io/totalas/prices/2재생토너 단가표_위더스(202208).xlsx',
   'xlsx', 2),

  ('에스와이 토너/이미지 변동단가',
   '2026.03',
   'https://hanbyeolsystem.github.io/totalas/prices/3에스와이 토너이미지변동단가(202603).pdf',
   'pdf', 3),

  ('케이지하이테크 교세라 단가표',
   'KG2024 · 카피어 11월',
   'https://hanbyeolsystem.github.io/totalas/prices/4케이지하이테크 교세라 단가표 KG2024 - 11월 카피어.xls',
   'xls', 4),

  ('시놀로지 공급 단가표',
   '2026.04.06 (전 품목 인상)',
   'https://hanbyeolsystem.github.io/totalas/prices/★ 260406_시놀로지 공급 단가표 - (전 품목) 인상.xlsx',
   'xlsx', 5)
ON CONFLICT (file_path) DO NOTHING;

SELECT id, label, meta, ext, sort_order
FROM prices_index
ORDER BY sort_order;
