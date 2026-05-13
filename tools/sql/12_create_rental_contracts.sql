-- ============================================================
-- 12_create_rental_contracts.sql  (2026-05-13, rev2)
-- rental_contracts — 임대계약서 (PDF 4페이지 양식과 동치)
-- 1p 표지 · 2~3p 이용약관 · 4p 자동출금 이용신청서
-- rev2: 잔존 객체 충돌 회피 위해 시작 시 DROP CASCADE
-- ============================================================

DROP TABLE IF EXISTS rental_contracts CASCADE;

CREATE TABLE IF NOT EXISTS rental_contracts (
  id              TEXT PRIMARY KEY,                          -- ct_xxx
  customer_id     TEXT NOT NULL REFERENCES rental_customers(id) ON DELETE CASCADE,
  contract_no     TEXT,                                       -- HB-2026-001 등
  contract_date   DATE,
  period_years    INTEGER DEFAULT 3,
  period_start    DATE,
  period_end      DATE,
  deposit         INTEGER DEFAULT 0,
  install_fee     INTEGER DEFAULT 0,
  -- 거래처 스냅샷 (변경되어도 계약서엔 발행 시점 정보 보존)
  company_snapshot      TEXT,
  contact_name_snapshot TEXT,
  biz_no_snapshot       TEXT,
  address_snapshot      TEXT,
  phone_snapshot        TEXT,
  email_snapshot        TEXT,
  -- 항목 (행 추가·삭제 가능)
  items           JSONB DEFAULT '[]'::jsonb,
    -- [{ model, bw_free, co_free, bw_rate, co_rate, qty, monthly_fee, note }]
  -- 약관 (제1~10조 + 부가사항, 체크박스 + 본문 수정 가능)
  terms           JSONB DEFAULT '[]'::jsonb,
    -- [{ article, title, body, confirmed }]
  extras          JSONB DEFAULT '[]'::jsonb,
    -- 부가사항 [{ text, confirmed }]
  special_terms   TEXT,
  -- 자동출금 / 결제
  payment_method  TEXT DEFAULT 'account',                     -- account / card
  payment_info    JSONB DEFAULT '{}'::jsonb,
    -- account: { bank, account_no, holder, biz_no, draft_day }
    -- card:    { card_brand, card_no, expiry, holder, cvc_mask, draft_day }
  -- 서명 (Canvas → PNG base64 data URL)
  sign_supplier   TEXT,
  sign_applicant  TEXT,
  signed_at       TIMESTAMPTZ,
  -- 상태
  status          TEXT DEFAULT 'draft',                       -- draft / signed / active / terminated
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rcontract_customer   ON rental_contracts (customer_id);
CREATE INDEX IF NOT EXISTS idx_rcontract_status     ON rental_contracts (status);
CREATE INDEX IF NOT EXISTS idx_rcontract_date       ON rental_contracts (contract_date DESC);

-- RLS
ALTER TABLE rental_contracts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rental_contracts_auth_all ON rental_contracts;
CREATE POLICY rental_contracts_auth_all ON rental_contracts
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- 확인
SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name='rental_contracts'
 ORDER BY ordinal_position;
