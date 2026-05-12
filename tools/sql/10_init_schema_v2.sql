-- ============================================================
-- 10_init_schema_v2.sql  (2026-05-13, rev2)
-- 한별 임대 v2 스키마 — 4개 모듈(현황/거래처/카운터/청구) 공유.
-- rev2: 완전 재구축 위해 시작 시 기존 rental_* 모두 DROP.
-- ============================================================

-- ===== 0. 기존 객체 정리 (완전 초기화) =====
DROP TABLE IF EXISTS rental_supplies, rental_billings, rental_counters,
                     rental_assignments, rental_items, rental_customers CASCADE;

-- ===== 1. rental_customers =====
CREATE TABLE IF NOT EXISTS rental_customers (
  id              TEXT PRIMARY KEY,             -- c_0001 형식
  company         TEXT NOT NULL,
  contact_name    TEXT,
  phone           TEXT,
  mobile          TEXT,
  email           TEXT,
  biz_no          TEXT,
  address         TEXT,
  payment_type    TEXT DEFAULT '선불',          -- 선불 / 후불
  deposit         INTEGER DEFAULT 0,
  invoice_day     TEXT,                          -- 청구일 (자유 텍스트: '1일', '말일' 등)
  notes           TEXT,
  package_flags   JSONB DEFAULT '{}'::jsonb,    -- {has_pc_set:bool, nas_candidate:bool, ...}
  active          BOOLEAN DEFAULT TRUE,
  archived_at     TIMESTAMPTZ,
  archived_reason TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rc_company ON rental_customers (company);
CREATE INDEX IF NOT EXISTS idx_rc_active  ON rental_customers (active);

-- ===== 2. rental_items (자산 마스터) =====
CREATE TABLE IF NOT EXISTS rental_items (
  id            TEXT PRIMARY KEY,                -- it_0001
  category      TEXT NOT NULL,                   -- IT / 출력 / 위생
  subtype       TEXT NOT NULL,                   -- PC / monitor / NAS / 잉크젯 / 레이저 / 복합기 / 웰리스
  brand         TEXT,
  model         TEXT,
  serial        TEXT,
  install_date  DATE,
  status        TEXT DEFAULT 'active',           -- active / replaced / returned / lost
  -- age_months 는 GENERATED 불가(now() 비-IMMUTABLE). 클라이언트가 install_date 로 계산.
  storage_gb    INTEGER,                          -- NAS 전용
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ri_category ON rental_items (category, subtype);
CREATE INDEX IF NOT EXISTS idx_ri_status   ON rental_items (status);
CREATE INDEX IF NOT EXISTS idx_ri_serial   ON rental_items (serial);

-- ===== 3. rental_assignments (거래처-자산 매핑) =====
CREATE TABLE IF NOT EXISTS rental_assignments (
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL REFERENCES rental_items(id)     ON DELETE CASCADE,
  customer_id   TEXT NOT NULL REFERENCES rental_customers(id) ON DELETE CASCADE,
  start_date    DATE,
  end_date      DATE,
  monthly_fee   INTEGER DEFAULT 0,               -- 기본 임대료 (item당)
  bw_free       INTEGER DEFAULT 0,
  co_free       INTEGER DEFAULT 0,
  bw_rate       INTEGER DEFAULT 0,               -- 추가 흑백 장당
  co_rate       INTEGER DEFAULT 0,               -- 추가 컬러 장당
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ra_customer ON rental_assignments (customer_id);
CREATE INDEX IF NOT EXISTS idx_ra_item     ON rental_assignments (item_id);
CREATE INDEX IF NOT EXISTS idx_ra_active   ON rental_assignments (customer_id) WHERE end_date IS NULL;

-- ===== 4. rental_counters (월별 사용량) =====
CREATE TABLE IF NOT EXISTS rental_counters (
  id            BIGSERIAL PRIMARY KEY,
  item_id       TEXT NOT NULL REFERENCES rental_items(id) ON DELETE CASCADE,
  ym            CHAR(7) NOT NULL,                -- YYYY-MM
  bw            INTEGER DEFAULT 0,               -- 누적 흑백 (출력기기)
  color         INTEGER DEFAULT 0,               -- 누적 컬러
  uptime_hours  INTEGER,                          -- PC/NAS 향후 확장
  read_at       TIMESTAMPTZ DEFAULT now(),
  source        TEXT DEFAULT 'manual',           -- manual / snmp / api
  notes         TEXT,
  UNIQUE (item_id, ym)
);
CREATE INDEX IF NOT EXISTS idx_rcnt_ym ON rental_counters (ym);

-- ===== 5. rental_billings (월 청구 내역) =====
CREATE TABLE IF NOT EXISTS rental_billings (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES rental_customers(id) ON DELETE CASCADE,
  ym            CHAR(7) NOT NULL,
  fixed_total   INTEGER DEFAULT 0,               -- 고정 임대료 합
  usage_total   INTEGER DEFAULT 0,               -- 사용량 기반 청구 합
  total         INTEGER GENERATED ALWAYS AS (COALESCE(fixed_total,0) + COALESCE(usage_total,0)) STORED,
  items         JSONB DEFAULT '[]'::jsonb,       -- [{item_id, kind, qty, unit_price, subtotal}]
  status        TEXT DEFAULT 'draft',            -- draft / sent / paid / void
  issued_at     DATE,
  paid_at       DATE,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (customer_id, ym)
);
CREATE INDEX IF NOT EXISTS idx_rb_ym     ON rental_billings (ym);
CREATE INDEX IF NOT EXISTS idx_rb_status ON rental_billings (status);

-- ===== 6. rental_supplies (소모품 교체) =====
CREATE TABLE IF NOT EXISTS rental_supplies (
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL REFERENCES rental_items(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                   -- toner / ink / filter / belt / drum
  changed_at    DATE,
  next_due      DATE,
  cost          INTEGER DEFAULT 0,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rs_item ON rental_supplies (item_id);
CREATE INDEX IF NOT EXISTS idx_rs_kind ON rental_supplies (kind);

-- ============================================================
-- RLS: 인증된 사용자 전체 권한
-- ============================================================
ALTER TABLE rental_customers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_counters    ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_billings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_supplies    ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'rental_customers','rental_items','rental_assignments',
    'rental_counters','rental_billings','rental_supplies'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_auth_all', t);
    EXECUTE format($p$
      CREATE POLICY %I ON %I
        FOR ALL
        TO authenticated
        USING (true)
        WITH CHECK (true)
    $p$, t || '_auth_all', t);
  END LOOP;
END $$;

-- 확인
SELECT table_name
  FROM information_schema.tables
 WHERE table_schema='public' AND table_name LIKE 'rental_%'
 ORDER BY table_name;
