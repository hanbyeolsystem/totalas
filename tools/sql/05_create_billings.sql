-- ============================================================
-- 05_create_billings.sql  (2026-05-11)
-- 추가요금 청구 이력 테이블 신설
--   · 정책(기본매수·단가) snapshot — 단가 변동에도 재계산 동일
--   · 다중 시리얼 거래처는 details JSONB 에 시리얼별 표 박제
--   · billing_no — 화면측에서 'BL-2026-NNNN' 형식 생성
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS rental_extra_billings (
  id              TEXT        PRIMARY KEY,
  customer_id     TEXT        REFERENCES rental_customers(id) ON DELETE SET NULL,
  billing_no      TEXT        UNIQUE,                -- BL-2026-0001 형식
  period_start    TEXT        NOT NULL,              -- 'YYYY-MM'
  period_end      TEXT        NOT NULL,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 발행 시점 snapshot
  base_fee        INTEGER     DEFAULT 0,
  bw_free         INTEGER     DEFAULT 0,
  bw_rate         INTEGER     DEFAULT 0,
  co_free         INTEGER     DEFAULT 0,
  co_rate         INTEGER     DEFAULT 0,

  -- 시리얼별 월 계산 박제: { serials: [{ serial, model, rows: [{period,bw:{prev,curr,month,extra,fee}, co:{...}}] }] }
  details         JSONB       DEFAULT '{}'::jsonb,

  total_bw_fee    INTEGER     DEFAULT 0,
  total_co_fee    INTEGER     DEFAULT 0,
  total_amount    INTEGER     DEFAULT 0,             -- = base_fee + total_bw_fee + total_co_fee

  paid_at         TIMESTAMPTZ,                       -- null = 미입금
  memo            TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 인덱스
CREATE INDEX IF NOT EXISTS rental_extra_billings_customer_idx
  ON rental_extra_billings (customer_id);
CREATE INDEX IF NOT EXISTS rental_extra_billings_period_idx
  ON rental_extra_billings (period_end DESC, customer_id);
CREATE INDEX IF NOT EXISTS rental_extra_billings_unpaid_idx
  ON rental_extra_billings (customer_id) WHERE paid_at IS NULL;

-- RLS: 인증된 사용자만 접근 (다른 rental_* 테이블과 동일 정책)
ALTER TABLE rental_extra_billings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public' AND tablename='rental_extra_billings'
                    AND policyname='rental_extra_billings_authed_all') THEN
    CREATE POLICY rental_extra_billings_authed_all
      ON rental_extra_billings
      FOR ALL
      TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;
END$$;

COMMIT;

-- 확인
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'rental_extra_billings'
 ORDER BY ordinal_position;
