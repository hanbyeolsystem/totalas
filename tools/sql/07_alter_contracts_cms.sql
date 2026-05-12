-- ============================================================
-- 07_alter_contracts_cms.sql  (2026-05-12)
-- rental_contracts 에 CMS 자동이체 신청서 정보 컬럼 추가
-- ============================================================
ALTER TABLE rental_contracts
  ADD COLUMN IF NOT EXISTS cms JSONB DEFAULT '{}'::jsonb;

-- 확인
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name='rental_contracts' AND column_name='cms';
