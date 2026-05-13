-- ============================================================
-- 13_contract_attachments.sql  (2026-05-13)
-- 계약서 첨부 파일 + 서명 방식 컬럼 + Storage 버킷
-- ============================================================

-- 1) 계약서 컬럼 보강
ALTER TABLE rental_contracts
  ADD COLUMN IF NOT EXISTS contract_scan_path TEXT,       -- 도장/사인 받은 계약서 스캔본 경로 (Storage)
  ADD COLUMN IF NOT EXISTS id_card_path       TEXT,       -- 신분증 사진 경로
  ADD COLUMN IF NOT EXISTS signature_type     TEXT DEFAULT 'digital';
                                                          -- digital / stamp / none

-- 2) Storage 버킷 생성 (없을 때만)
INSERT INTO storage.buckets (id, name, public)
  VALUES ('rental-contracts', 'rental-contracts', false)
  ON CONFLICT (id) DO NOTHING;

-- 3) Storage RLS — authenticated 전체 권한 (개인 도메인 운영, 단일 조직)
DROP POLICY IF EXISTS rental_contracts_storage_all ON storage.objects;
CREATE POLICY rental_contracts_storage_all ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'rental-contracts')
  WITH CHECK (bucket_id = 'rental-contracts');

-- 확인
SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name='rental_contracts'
   AND column_name IN ('contract_scan_path', 'id_card_path', 'signature_type');

SELECT id, name, public FROM storage.buckets WHERE id='rental-contracts';
