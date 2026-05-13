-- ============================================================
-- 22_archive_init.sql  (2026-05-13)
-- 고객자료실 — customer_archives + software_licenses + Storage bucket
--
-- 구성:
--   1) storage bucket 'archives' (private — 인증된 사용자만 read)
--   2) customer_archives (NAS설정/소프트웨어/계약서/사진/기타 파일)
--   3) software_licenses (소프트웨어 만기 추적)
--
-- 멱등 — 재실행 안전.
-- 자료는 민감할 수 있어 private bucket. JS 는 createSignedUrl 로 임시 URL 생성.
-- ============================================================

-- ===== 1. Storage bucket 'archives' (private) =====
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('archives', 'archives', FALSE, 104857600)   -- 100 MB, 비공개
ON CONFLICT (id) DO UPDATE
  SET public = FALSE, file_size_limit = 104857600;

DROP POLICY IF EXISTS "archives_auth_read"   ON storage.objects;
DROP POLICY IF EXISTS "archives_auth_write"  ON storage.objects;
DROP POLICY IF EXISTS "archives_auth_update" ON storage.objects;
DROP POLICY IF EXISTS "archives_auth_delete" ON storage.objects;

CREATE POLICY "archives_auth_read" ON storage.objects FOR SELECT
TO authenticated USING (bucket_id = 'archives');

CREATE POLICY "archives_auth_write" ON storage.objects FOR INSERT
TO authenticated WITH CHECK (bucket_id = 'archives');

CREATE POLICY "archives_auth_update" ON storage.objects FOR UPDATE
TO authenticated USING (bucket_id = 'archives')
WITH CHECK (bucket_id = 'archives');

CREATE POLICY "archives_auth_delete" ON storage.objects FOR DELETE
TO authenticated USING (bucket_id = 'archives');


-- ===== 2. customer_archives — 고객별 자료 파일 =====
CREATE TABLE IF NOT EXISTS customer_archives (
  id                  BIGSERIAL PRIMARY KEY,
  customer_name       TEXT NOT NULL,
  rental_customer_id  TEXT REFERENCES rental_customers(id) ON DELETE SET NULL,
  category            TEXT NOT NULL,                  -- 'NAS설정'/'소프트웨어'/'계약서'/'사진'/'기타'
  label               TEXT NOT NULL,
  file_path           TEXT NOT NULL UNIQUE,
  ext                 TEXT NOT NULL,
  file_size           BIGINT,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  created_by          UUID REFERENCES auth.users(id)
);

-- 기존 테이블 보강
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS customer_name      TEXT;
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS rental_customer_id TEXT;
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS category           TEXT;
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS label              TEXT;
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS file_path          TEXT;
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS ext                TEXT;
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS file_size          BIGINT;
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS notes              TEXT;
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS created_at         TIMESTAMPTZ DEFAULT now();
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ DEFAULT now();
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS created_by         UUID REFERENCES auth.users(id);

CREATE INDEX IF NOT EXISTS idx_archives_customer     ON customer_archives (customer_name);
CREATE INDEX IF NOT EXISTS idx_archives_category     ON customer_archives (category);
CREATE INDEX IF NOT EXISTS idx_archives_rental_cust  ON customer_archives (rental_customer_id);

ALTER TABLE customer_archives ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "archives_all" ON customer_archives;
CREATE POLICY "archives_all" ON customer_archives FOR ALL
TO authenticated USING (TRUE) WITH CHECK (TRUE);


-- ===== 3. software_licenses — 소프트웨어 만기 추적 =====
CREATE TABLE IF NOT EXISTS software_licenses (
  id                  BIGSERIAL PRIMARY KEY,
  customer_name       TEXT NOT NULL,
  rental_customer_id  TEXT REFERENCES rental_customers(id) ON DELETE SET NULL,
  software_name       TEXT NOT NULL,
  vendor              TEXT,
  license_key         TEXT,
  seats               INTEGER DEFAULT 1,
  purchase_date       DATE,
  expiry_date         DATE NOT NULL,
  amount              INTEGER,                        -- 원
  alert_days          INTEGER DEFAULT 30,             -- D-N 이내면 알림 강조
  status              TEXT DEFAULT 'active',          -- active / expired / cancelled
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  created_by          UUID REFERENCES auth.users(id)
);

ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS customer_name      TEXT;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS rental_customer_id TEXT;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS software_name      TEXT;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS vendor             TEXT;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS license_key        TEXT;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS seats              INTEGER DEFAULT 1;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS purchase_date      DATE;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS expiry_date        DATE;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS amount             INTEGER;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS alert_days         INTEGER DEFAULT 30;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS status             TEXT DEFAULT 'active';
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS notes              TEXT;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS created_at         TIMESTAMPTZ DEFAULT now();
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ DEFAULT now();
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS created_by         UUID REFERENCES auth.users(id);

CREATE INDEX IF NOT EXISTS idx_licenses_customer ON software_licenses (customer_name);
CREATE INDEX IF NOT EXISTS idx_licenses_expiry   ON software_licenses (expiry_date);
CREATE INDEX IF NOT EXISTS idx_licenses_status   ON software_licenses (status);

ALTER TABLE software_licenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "licenses_all" ON software_licenses;
CREATE POLICY "licenses_all" ON software_licenses FOR ALL
TO authenticated USING (TRUE) WITH CHECK (TRUE);


-- ===== 4. updated_at 자동 갱신 트리거 =====
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customer_archives_touch ON customer_archives;
CREATE TRIGGER trg_customer_archives_touch
  BEFORE UPDATE ON customer_archives
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_software_licenses_touch ON software_licenses;
CREATE TRIGGER trg_software_licenses_touch
  BEFORE UPDATE ON software_licenses
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ===== 5. 확인 쿼리 =====
SELECT 'bucket' AS kind, id AS name FROM storage.buckets WHERE id = 'archives'
UNION ALL
SELECT 'table',  tablename FROM pg_tables
  WHERE tablename IN ('customer_archives', 'software_licenses')
UNION ALL
SELECT 'policy', policyname FROM pg_policies
  WHERE (tablename = 'objects' AND policyname LIKE 'archives_auth_%')
     OR policyname IN ('archives_all', 'licenses_all');
