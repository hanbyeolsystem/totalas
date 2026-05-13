-- ============================================================
-- 18_add_billing_period.sql
-- 거래처 단위 "청구 주기" 옵션 추가
--   1  = 월별   (기본)
--   3  = 3개월 (분기 합산 청구)
--   6  = 6개월 (반기 합산 청구)
--   12 = 1년    (연간 합산 청구)
-- N개월 합산 시: 청구 마감월의 카운터 - (마감월 - N개월)의 카운터 = N개월 누적 사용량
-- 기본매수도 N배로 확장 (예: 3개월 거래처면 bw_free × 3)
-- ============================================================

ALTER TABLE rental_customers
  ADD COLUMN IF NOT EXISTS billing_months INTEGER DEFAULT 1
    CHECK (billing_months IN (1, 3, 6, 12));

COMMENT ON COLUMN rental_customers.billing_months IS
  '청구 주기(개월) — 1: 월별, 3: 분기, 6: 반기, 12: 연간 합산';

-- 확인
SELECT
  billing_months,
  COUNT(*) AS customers
FROM rental_customers
WHERE active = TRUE
GROUP BY billing_months
ORDER BY billing_months;
