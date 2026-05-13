-- 15a1_setup.sql  — 스테이징 테이블 생성
DROP TABLE IF EXISTS _pdf_staging;
CREATE TABLE _pdf_staging (
  norm_company TEXT,
  ceo          TEXT,
  biz_no       TEXT,
  mobile       TEXT,
  phone        TEXT
);
SELECT count(*) FROM _pdf_staging;