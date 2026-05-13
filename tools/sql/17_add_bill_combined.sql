-- ============================================================
-- 17_add_bill_combined.sql
-- 거래처 단위 "합산 청구" 옵션 추가
-- 한 거래처가 출력기기를 여러 대 사용할 때, 모든 자산의 카운터/기본매수/
-- 추가카운터를 합산하여 단일 청구 항목으로 발행할지 여부.
-- ============================================================

ALTER TABLE rental_customers
  ADD COLUMN IF NOT EXISTS bill_combined BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN rental_customers.bill_combined IS
  '여러 출력 자산 보유 시 합산 청구 여부 (TRUE: 합산, FALSE: 자산별 청구)';

-- 확인
SELECT
  COUNT(*) FILTER (WHERE bill_combined = TRUE)  AS combined_count,
  COUNT(*) FILTER (WHERE bill_combined = FALSE) AS separate_count,
  COUNT(*)                                       AS total
FROM rental_customers
WHERE active = TRUE;
