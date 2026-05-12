-- ============================================================
-- 06_create_costs.sql  (2026-05-12)  v3 — 통합 실행판
--   · 누락 가능 컬럼 보강 (rental_meetings, rental_prices)
--   · 원가/수익률 분석 3개 테이블 신설
--   · 모든 문장 IF NOT EXISTS — 재실행 안전
-- ============================================================

-- ───────────────────────────────────────────────────────────
-- [A] 기존 테이블 누락 컬럼 보강
-- ───────────────────────────────────────────────────────────
ALTER TABLE public.rental_meetings
  ADD COLUMN IF NOT EXISTS attendees TEXT DEFAULT '';

ALTER TABLE public.rental_prices
  ADD COLUMN IF NOT EXISTS author    TEXT   DEFAULT '',
  ADD COLUMN IF NOT EXISTS file_size BIGINT DEFAULT 0;

-- ───────────────────────────────────────────────────────────
-- [B] 신규 1) 제품 매입 원가
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rental_product_costs (
  id                  TEXT PRIMARY KEY,
  customer_id         TEXT REFERENCES rental_customers(id) ON DELETE CASCADE,
  serial              TEXT,
  product_name        TEXT NOT NULL,
  purchase_price      INTEGER NOT NULL DEFAULT 0,
  purchase_date       DATE,
  amortization_months INTEGER NOT NULL DEFAULT 36,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rental_product_costs_customer_idx
  ON rental_product_costs (customer_id);
CREATE INDEX IF NOT EXISTS rental_product_costs_serial_idx
  ON rental_product_costs (serial) WHERE serial IS NOT NULL;

-- ───────────────────────────────────────────────────────────
-- [B] 신규 2) 출장 내역
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rental_service_visits (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT REFERENCES rental_customers(id) ON DELETE CASCADE,
  visit_date    DATE NOT NULL,
  purpose       TEXT,
  technician    TEXT,
  travel_cost   INTEGER NOT NULL DEFAULT 0,
  labor_cost    INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rental_service_visits_customer_idx
  ON rental_service_visits (customer_id, visit_date DESC);

-- ───────────────────────────────────────────────────────────
-- [B] 신규 3) 소모품 사용
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rental_supplies (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT REFERENCES rental_customers(id) ON DELETE CASCADE,
  serial        TEXT,
  used_date     DATE NOT NULL,
  product_name  TEXT NOT NULL,
  qty           INTEGER NOT NULL DEFAULT 1,
  unit_cost     INTEGER NOT NULL DEFAULT 0,
  total_cost    INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rental_supplies_customer_idx
  ON rental_supplies (customer_id, used_date DESC);
CREATE INDEX IF NOT EXISTS rental_supplies_serial_idx
  ON rental_supplies (serial) WHERE serial IS NOT NULL;

-- ───────────────────────────────────────────────────────────
-- [C] RLS 활성화 + 정책
-- ───────────────────────────────────────────────────────────
ALTER TABLE rental_product_costs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_service_visits  ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_supplies        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rental_product_costs_authed_all ON rental_product_costs;
CREATE POLICY rental_product_costs_authed_all
  ON rental_product_costs FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rental_service_visits_authed_all ON rental_service_visits;
CREATE POLICY rental_service_visits_authed_all
  ON rental_service_visits FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rental_supplies_authed_all ON rental_supplies;
CREATE POLICY rental_supplies_authed_all
  ON rental_supplies FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ───────────────────────────────────────────────────────────
-- [D] 검증 — rental_* 테이블 전체 목록 (신규 3개 포함되어야 함)
-- ───────────────────────────────────────────────────────────
SELECT tablename
  FROM pg_tables
 WHERE schemaname='public' AND tablename LIKE 'rental_%'
 ORDER BY tablename;
