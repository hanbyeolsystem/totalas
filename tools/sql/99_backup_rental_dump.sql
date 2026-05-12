-- ============================================================
-- 99_backup_rental_dump.sql  (2026-05-12)
-- 임대 모듈 모든 테이블 데이터 1회성 dump
--
-- 사용법: Supabase SQL Editor 에서 실행 → 결과 하단의
--        "Download CSV" 버튼으로 백업 파일 저장.
-- 결과는 단일 JSON 컬럼 (`payload`) 으로 모든 테이블이 묶임.
-- ============================================================
SELECT jsonb_build_object(
  'dumped_at',          now(),
  'rental_customers',   (SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM rental_customers t),
  'rental_printers',    (SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM rental_printers  t),
  'rental_counters',    (SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM rental_counters  t),
  'rental_contracts',   (SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM rental_contracts t),
  'rental_meetings',    (SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM rental_meetings  t),
  'rental_prices',      (SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM rental_prices    t),
  'rental_archive',     (SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM rental_archive   t),
  'rental_extra_billings', (SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM rental_extra_billings t),
  'rental_product_costs',  (SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM rental_product_costs  t),
  'rental_service_visits', (SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM rental_service_visits t),
  'rental_supplies',       (SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM rental_supplies       t)
) AS payload;
