-- ============================================================
-- 19_billing_options_all.sql
-- 17 + 18 통합본 — Supabase SQL Editor 에 통째로 붙여 넣고 실행.
-- IF NOT EXISTS 라서 이미 실행된 컬럼이 있어도 안전(멱등).
--
--   bill_combined   : 한 거래처의 여러 자산 합산 청구 여부
--   billing_months  : 청구 주기 (1: 월별, 3: 분기, 6: 반기, 12: 연간)
-- ============================================================

-- 합산 청구 옵션
ALTER TABLE rental_customers
  ADD COLUMN IF NOT EXISTS bill_combined BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN rental_customers.bill_combined IS
  '여러 출력 자산 보유 시 합산 청구 여부 (TRUE: 합산, FALSE: 자산별 청구)';

-- 청구 주기 옵션
ALTER TABLE rental_customers
  ADD COLUMN IF NOT EXISTS billing_months INTEGER DEFAULT 1
    CHECK (billing_months IN (1, 3, 6, 12));

COMMENT ON COLUMN rental_customers.billing_months IS
  '청구 주기(개월) — 1: 월별, 3: 분기, 6: 반기, 12: 연간 합산';

-- 확인
SELECT
  billing_months,
  COUNT(*) FILTER (WHERE bill_combined = TRUE)  AS combined_count,
  COUNT(*) FILTER (WHERE bill_combined = FALSE) AS separate_count,
  COUNT(*)                                       AS total
FROM rental_customers
WHERE active = TRUE
GROUP BY billing_months
ORDER BY billing_months;
