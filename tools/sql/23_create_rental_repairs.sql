-- ============================================================
-- 23_create_rental_repairs.sql  (2026-05-14)
-- rental_repairs — 거래처별 수리내역
-- 품목(출장/부품교체/토너 등) · 작업내용 · 금액(±)
-- ⚠️ 시작 시 DROP CASCADE — 재실행하면 기존 데이터 삭제됨
-- ============================================================

DROP TABLE IF EXISTS rental_repairs CASCADE;

CREATE TABLE rental_repairs (
  id           TEXT PRIMARY KEY,                                       -- rp_xxx
  customer_id  TEXT NOT NULL REFERENCES rental_customers(id) ON DELETE CASCADE,
  service_date DATE NOT NULL DEFAULT current_date,
  item_type    TEXT NOT NULL,                                          -- 출장 / 부품교체 / 토너 / 기타
  work_desc    TEXT,                                                   -- 작업내용 (자유 입력)
  amount       INTEGER NOT NULL DEFAULT 0,                             -- 금액 (음수 허용)
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_rental_repairs_customer ON rental_repairs (customer_id);
CREATE INDEX idx_rental_repairs_date     ON rental_repairs (service_date DESC);

-- RLS — authenticated 전체권한 (다른 rental_* 테이블과 동일)
ALTER TABLE rental_repairs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rental_repairs_auth_all ON rental_repairs;
CREATE POLICY rental_repairs_auth_all ON rental_repairs
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- 확인
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'rental_repairs'
 ORDER BY ordinal_position;
