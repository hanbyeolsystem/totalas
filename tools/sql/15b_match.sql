-- ============================================================
-- 15b_match.sql — 3-pass 매칭 + 스테이징 정리
-- 사전 조건: 15a_load.sql 이 같은 DB 에 _pdf_staging 적재해 둠.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 핵심명 추출 함수
CREATE OR REPLACE FUNCTION _ext_core(name TEXT) RETURNS TEXT AS $f$
DECLARE s TEXT;
BEGIN
  IF name IS NULL THEN RETURN NULL; END IF;
  s := lower(name);
  s := regexp_replace(s, '주식회사|유한회사|\(주\)|㈜|\(사\)|㈐|\(복\)|\(재\)|\(유\)', '', 'g');
  s := regexp_replace(s, '[\s·\-\.]+', '', 'g');
  RETURN s;
END;
$f$ LANGUAGE plpgsql IMMUTABLE;

-- PASS 1: norm_company 완전 일치
UPDATE rental_customers AS rc SET
  contact_name = COALESCE(rc.contact_name, p.ceo),
  biz_no       = COALESCE(rc.biz_no,       p.biz_no),
  mobile       = COALESCE(rc.mobile,       p.mobile),
  phone        = COALESCE(rc.phone,        p.phone)
FROM _pdf_staging AS p
WHERE replace(replace(replace(lower(rc.company),' ',''),'㈜','(주)'),'㈐','(사)') = p.norm_company;

-- PASS 2: 핵심명 완전 일치
WITH pdf_core AS (
  SELECT DISTINCT ON (_ext_core(norm_company))
    _ext_core(norm_company) AS core, ceo, biz_no, mobile, phone
  FROM _pdf_staging
  WHERE LENGTH(_ext_core(norm_company)) >= 3
  ORDER BY _ext_core(norm_company), ceo NULLS LAST
)
UPDATE rental_customers AS rc SET
  contact_name = COALESCE(rc.contact_name, p.ceo),
  biz_no       = COALESCE(rc.biz_no,       p.biz_no),
  mobile       = COALESCE(rc.mobile,       p.mobile),
  phone        = COALESCE(rc.phone,        p.phone)
FROM pdf_core AS p
WHERE _ext_core(rc.company) = p.core
  AND (rc.contact_name IS NULL OR rc.biz_no IS NULL OR rc.mobile IS NULL OR rc.phone IS NULL);

-- PASS 3: trigram 유사도 ≥ 0.6 (정보 거의 없는 행만)
WITH pdf_pool AS (
  SELECT _ext_core(norm_company) AS core, ceo, biz_no, mobile, phone
  FROM _pdf_staging
  WHERE LENGTH(_ext_core(norm_company)) >= 3
), candidates AS (
  SELECT DISTINCT ON (rc.id)
    rc.id, p.ceo, p.biz_no, p.mobile, p.phone,
    similarity(_ext_core(rc.company), p.core) AS sim
  FROM rental_customers rc
  JOIN pdf_pool p ON similarity(_ext_core(rc.company), p.core) >= 0.6
  WHERE rc.active = TRUE
    AND (rc.contact_name IS NULL AND rc.biz_no IS NULL)
  ORDER BY rc.id, sim DESC
)
UPDATE rental_customers AS rc SET
  contact_name = COALESCE(rc.contact_name, c.ceo),
  biz_no       = COALESCE(rc.biz_no,       c.biz_no),
  mobile       = COALESCE(rc.mobile,       c.mobile),
  phone        = COALESCE(rc.phone,        c.phone)
FROM candidates AS c
WHERE rc.id = c.id;

-- 정리
DROP TABLE IF EXISTS _pdf_staging;
DROP FUNCTION IF EXISTS _ext_core(TEXT);

-- 확인
SELECT
  (SELECT COUNT(*) FROM rental_customers WHERE active=TRUE)                         AS total_active,
  (SELECT COUNT(*) FROM rental_customers WHERE contact_name IS NOT NULL AND active) AS with_ceo,
  (SELECT COUNT(*) FROM rental_customers WHERE biz_no IS NOT NULL AND active)       AS with_biz,
  (SELECT COUNT(*) FROM rental_customers WHERE mobile IS NOT NULL AND active)       AS with_mobile,
  (SELECT COUNT(*) FROM rental_customers WHERE phone IS NOT NULL AND active)        AS with_phone
;