-- ============================================================
-- 08_alter_contracts_terms_jsonb.sql  (2026-05-12, rev2)
-- rental_contracts.terms_checked / extras_checked
-- boolean[] → JSONB ([{text, checked}, ...]) 변환
--
-- 배경: Phase 1 자유 편집 도입으로 각 항목에 text+checked 가
--      함께 저장됨. boolean[] 컬럼에는 객체 cast 가 실패한다.
--
-- 변경: ALTER ... TYPE USING 식은 서브쿼리 불가 (rev1 실패).
--      2단계로 분리 — 먼저 to_jsonb 로 [true,false,...] 보관,
--      이어서 UPDATE 로 각 원소 → {text, checked} 객체 래핑.
-- ============================================================

-- ===== terms_checked =====
ALTER TABLE rental_contracts
  ALTER COLUMN terms_checked DROP DEFAULT;

ALTER TABLE rental_contracts
  ALTER COLUMN terms_checked TYPE JSONB
  USING (
    CASE
      WHEN terms_checked IS NULL THEN '[]'::jsonb
      ELSE to_jsonb(terms_checked)
    END
  );

ALTER TABLE rental_contracts
  ALTER COLUMN terms_checked SET DEFAULT '[]'::jsonb;

-- boolean array → [{text, checked}] 래핑
UPDATE rental_contracts
SET terms_checked = COALESCE((
  SELECT jsonb_agg(
           jsonb_build_object(
             'text', '(이전 항목 ' || (i)::text || ')',
             'checked', (e #>> '{}')::boolean
           )
         )
  FROM jsonb_array_elements(terms_checked) WITH ORDINALITY AS t(e, i)
), '[]'::jsonb)
WHERE jsonb_typeof(terms_checked) = 'array'
  AND jsonb_array_length(terms_checked) > 0
  AND jsonb_typeof(terms_checked->0) = 'boolean';


-- ===== extras_checked =====
ALTER TABLE rental_contracts
  ALTER COLUMN extras_checked DROP DEFAULT;

ALTER TABLE rental_contracts
  ALTER COLUMN extras_checked TYPE JSONB
  USING (
    CASE
      WHEN extras_checked IS NULL THEN '[]'::jsonb
      ELSE to_jsonb(extras_checked)
    END
  );

ALTER TABLE rental_contracts
  ALTER COLUMN extras_checked SET DEFAULT '[]'::jsonb;

UPDATE rental_contracts
SET extras_checked = COALESCE((
  SELECT jsonb_agg(
           jsonb_build_object(
             'text', '(이전 항목 ' || (i)::text || ')',
             'checked', (e #>> '{}')::boolean
           )
         )
  FROM jsonb_array_elements(extras_checked) WITH ORDINALITY AS t(e, i)
), '[]'::jsonb)
WHERE jsonb_typeof(extras_checked) = 'array'
  AND jsonb_array_length(extras_checked) > 0
  AND jsonb_typeof(extras_checked->0) = 'boolean';


-- 확인
SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name='rental_contracts'
   AND column_name IN ('terms_checked', 'extras_checked');

-- 샘플 데이터 확인 (최근 5건)
SELECT id, jsonb_array_length(terms_checked) AS t_len,
            jsonb_array_length(extras_checked) AS e_len,
            terms_checked -> 0 AS first_term
  FROM rental_contracts
  ORDER BY created_at DESC NULLS LAST
  LIMIT 5;
