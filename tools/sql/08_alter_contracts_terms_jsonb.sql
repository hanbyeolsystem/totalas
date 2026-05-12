-- ============================================================
-- 08_alter_contracts_terms_jsonb.sql  (2026-05-12)
-- rental_contracts.terms_checked / extras_checked
-- boolean[] → JSONB ([{text, checked}, ...]) 로 변환
--
-- 배경: Phase 1 자유 편집 도입으로 각 항목에 text+checked 가
--      함께 저장됨. 기존 boolean[] 에서는 객체 cast 가 실패한다.
-- 변환 정책: 기존 boolean[] 항목 → [{text:'(이전 항목)', checked:b}]
--           (텍스트 손실 없음 — 신규 저장 시 사용자 입력 텍스트로 갱신됨)
-- ============================================================

-- 1) terms_checked
ALTER TABLE rental_contracts
  ALTER COLUMN terms_checked DROP DEFAULT;

ALTER TABLE rental_contracts
  ALTER COLUMN terms_checked TYPE JSONB
  USING (
    CASE
      WHEN terms_checked IS NULL THEN '[]'::jsonb
      ELSE (
        SELECT jsonb_agg(jsonb_build_object('text', '(이전 항목 ' || (i+1)::text || ')', 'checked', b))
        FROM unnest(terms_checked) WITH ORDINALITY AS t(b, i)
      )
    END
  );

ALTER TABLE rental_contracts
  ALTER COLUMN terms_checked SET DEFAULT '[]'::jsonb;


-- 2) extras_checked
ALTER TABLE rental_contracts
  ALTER COLUMN extras_checked DROP DEFAULT;

ALTER TABLE rental_contracts
  ALTER COLUMN extras_checked TYPE JSONB
  USING (
    CASE
      WHEN extras_checked IS NULL THEN '[]'::jsonb
      ELSE (
        SELECT jsonb_agg(jsonb_build_object('text', '(이전 항목 ' || (i+1)::text || ')', 'checked', b))
        FROM unnest(extras_checked) WITH ORDINALITY AS t(b, i)
      )
    END
  );

ALTER TABLE rental_contracts
  ALTER COLUMN extras_checked SET DEFAULT '[]'::jsonb;


-- 확인
SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name='rental_contracts'
   AND column_name IN ('terms_checked', 'extras_checked');
