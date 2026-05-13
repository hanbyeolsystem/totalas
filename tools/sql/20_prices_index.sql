-- ============================================================
-- 20_prices_index.sql  (2026-05-13)
-- 가격표 페이지 — Supabase Storage 기반 단가표 업로드/조회.
--
-- 구성:
--   1) storage bucket 'prices' (public read, authenticated write)
--   2) DB 테이블 prices_index (label/meta/file_path/ext 메타데이터)
--
-- 한 번 실행하면 멱등 — 재실행해도 안전.
-- ============================================================

-- ===== 1. Storage bucket =====
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('prices', 'prices', TRUE, 52428800)   -- 50 MB
ON CONFLICT (id) DO UPDATE
  SET public = TRUE, file_size_limit = 52428800;

-- 기존 정책 제거 후 재생성 (멱등성)
DROP POLICY IF EXISTS "prices_public_read"   ON storage.objects;
DROP POLICY IF EXISTS "prices_auth_write"    ON storage.objects;
DROP POLICY IF EXISTS "prices_auth_update"   ON storage.objects;
DROP POLICY IF EXISTS "prices_auth_delete"   ON storage.objects;

-- 누구나 읽기 (Office Online Viewer 가 익명으로 fetch 해야 함)
CREATE POLICY "prices_public_read" ON storage.objects FOR SELECT
USING (bucket_id = 'prices');

-- 인증된 사용자만 쓰기 / 수정 / 삭제
CREATE POLICY "prices_auth_write" ON storage.objects FOR INSERT
TO authenticated WITH CHECK (bucket_id = 'prices');

CREATE POLICY "prices_auth_update" ON storage.objects FOR UPDATE
TO authenticated USING (bucket_id = 'prices')
WITH CHECK (bucket_id = 'prices');

CREATE POLICY "prices_auth_delete" ON storage.objects FOR DELETE
TO authenticated USING (bucket_id = 'prices');


-- ===== 2. DB 테이블 — 가격표 인덱스 =====
CREATE TABLE IF NOT EXISTS prices_index (
  id          BIGSERIAL PRIMARY KEY,
  label       TEXT NOT NULL,                            -- 표시명 (예: '교세라 부품 가격표')
  meta        TEXT,                                     -- 부가 설명 (예: '2026.01', '인상')
  file_path   TEXT NOT NULL UNIQUE,                     -- storage 안 경로 (예: 'kyocera_parts_2026_01.xlsx')
  ext         TEXT NOT NULL,                            -- 'xlsx' / 'xls' / 'pdf' / 'docx' 등
  sort_order  INTEGER DEFAULT 0,                        -- 정렬 우선순위 (작을수록 위)
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  created_by  UUID REFERENCES auth.users(id)
);

-- 기존 테이블이 이미 있던 경우 누락 컬럼 보강 (멱등성 보장)
ALTER TABLE prices_index ADD COLUMN IF NOT EXISTS label      TEXT;
ALTER TABLE prices_index ADD COLUMN IF NOT EXISTS meta       TEXT;
ALTER TABLE prices_index ADD COLUMN IF NOT EXISTS file_path  TEXT;
ALTER TABLE prices_index ADD COLUMN IF NOT EXISTS ext        TEXT;
ALTER TABLE prices_index ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
ALTER TABLE prices_index ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE prices_index ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE prices_index ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id);

CREATE INDEX IF NOT EXISTS idx_prices_index_sort
  ON prices_index (sort_order, created_at);

ALTER TABLE prices_index ENABLE ROW LEVEL SECURITY;

-- 인증된 사용자 전체 권한 (임대 모듈과 동일 패턴)
DROP POLICY IF EXISTS "prices_index_all" ON prices_index;
CREATE POLICY "prices_index_all" ON prices_index FOR ALL
TO authenticated USING (TRUE) WITH CHECK (TRUE);


-- ===== 3. updated_at 자동 갱신 트리거 =====
CREATE OR REPLACE FUNCTION prices_index_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prices_index_updated_at ON prices_index;
CREATE TRIGGER trg_prices_index_updated_at
  BEFORE UPDATE ON prices_index
  FOR EACH ROW EXECUTE FUNCTION prices_index_touch_updated_at();


-- ===== 확인 쿼리 (실행 후 결과 보기) =====
SELECT 'bucket'    AS kind, id   AS name FROM storage.buckets WHERE id = 'prices'
UNION ALL
SELECT 'policy',   policyname    FROM pg_policies WHERE tablename = 'objects'  AND policyname LIKE 'prices_%'
UNION ALL
SELECT 'policy',   policyname    FROM pg_policies WHERE tablename = 'prices_index'
UNION ALL
SELECT 'table',    'prices_index' WHERE EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'prices_index');
