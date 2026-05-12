-- ============================================================
-- 99_drop_rental_all.sql  (2026-05-12)
-- 임대 모듈 관련 모든 객체 제거.
--
-- ⚠ 실행 전 99_backup_rental_dump.sql 결과 CSV 를 저장했는지 확인.
-- 이후 복구 불가.
-- ============================================================

-- 데이터 테이블 (의존성 cascade)
DROP TABLE IF EXISTS rental_supplies        CASCADE;
DROP TABLE IF EXISTS rental_service_visits  CASCADE;
DROP TABLE IF EXISTS rental_product_costs   CASCADE;
DROP TABLE IF EXISTS rental_extra_billings  CASCADE;
DROP TABLE IF EXISTS rental_archive         CASCADE;
DROP TABLE IF EXISTS rental_prices          CASCADE;
DROP TABLE IF EXISTS rental_meetings        CASCADE;
DROP TABLE IF EXISTS rental_contracts       CASCADE;
DROP TABLE IF EXISTS rental_counters        CASCADE;
DROP TABLE IF EXISTS rental_printers        CASCADE;
DROP TABLE IF EXISTS rental_customers       CASCADE;

-- 혹시 남아 있을 임시·중간 객체
DROP VIEW     IF EXISTS rental_customer_summary CASCADE;
DROP FUNCTION IF EXISTS rental_normalize_name   CASCADE;

-- 확인
SELECT table_name
  FROM information_schema.tables
 WHERE table_schema='public' AND table_name LIKE 'rental_%';
-- 결과 0행이면 모두 제거 완료.

-- Storage 버킷 'rental-files' 는 SQL 로 자동 삭제되지 않음.
-- Dashboard → Storage → rental-files → ... → Delete bucket 으로 수동 제거.
