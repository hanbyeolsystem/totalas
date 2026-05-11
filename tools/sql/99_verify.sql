-- ============================================================
-- 99_verify.sql  (2026-05-11)
-- 실행 전 / 실행 후 비교용 (각 단계마다 돌려보세요)
-- ============================================================

-- (1) 전체 거래처 카운트
SELECT 'total' AS label, COUNT(*) AS cnt FROM rental_customers
UNION ALL SELECT 'active', COUNT(*) FROM rental_customers WHERE archived_at IS NULL
UNION ALL SELECT 'archived', COUNT(*) FROM rental_customers WHERE archived_at IS NOT NULL;

-- (2) source_sheet 별 활성 거래처 분포
SELECT COALESCE(source_sheet, '(없음)') AS source_sheet, COUNT(*) AS active
  FROM rental_customers
 WHERE archived_at IS NULL
 GROUP BY 1 ORDER BY 2 DESC;

-- (3) 임대료 합계 (활성 거래처)
SELECT SUM(base_fee) AS sum_active_base_fee,
       COUNT(*)       AS active_count
  FROM rental_customers
 WHERE archived_at IS NULL
   AND source_sheet = '임대현황.xlsx';
-- 기대값: 174건, 15,863,000원

-- (4) 자식 데이터 — 고아 customer_id 검사
SELECT 'orphan_printer_cust_id' AS label, COUNT(*) AS cnt FROM rental_printers p
 WHERE customer_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM rental_customers c WHERE c.id = p.customer_id)
UNION ALL
SELECT 'orphan_contract_cust_id', COUNT(*) FROM rental_contracts c
 WHERE customer_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM rental_customers x WHERE x.id = c.customer_id)
UNION ALL
SELECT 'orphan_meeting_cust_id', COUNT(*) FROM rental_meetings m
 WHERE customer_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM rental_customers x WHERE x.id = m.customer_id)
UNION ALL
SELECT 'orphan_archive_cust_id', COUNT(*) FROM rental_archive a
 WHERE customer_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM rental_customers x WHERE x.id = a.customer_id);
-- 기대값: 모두 0

-- (5) archive 사유별 분포
SELECT archived_reason, COUNT(*) AS cnt FROM rental_customers
 WHERE archived_at IS NOT NULL
 GROUP BY 1 ORDER BY 2 DESC;
