-- ============================================================
-- 01_alter_schema.sql  (2026-05-11)
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
