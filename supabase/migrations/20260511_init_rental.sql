-- ===========================================================
-- totalas 임대관리 — 초기 스키마
-- 날짜: 2026-05-11
-- Supabase 프로젝트: jrzesjgyrvgvwazfajec (ASMS 공용)
-- ===========================================================

-- 1) 거래처
CREATE TABLE IF NOT EXISTS public.rental_customers (
  id              text PRIMARY KEY,           -- 'c_0000' 같은 시드 id 그대로 사용
  company         text NOT NULL,
  ceo             text DEFAULT '',
  biz_no          text DEFAULT '',
  corp_no         text DEFAULT '',
  biz_type        text DEFAULT '',
  biz_item        text DEFAULT '',
  address         text DEFAULT '',
  phone           text DEFAULT '',
  fax             text DEFAULT '',
  email           text DEFAULT '',
  kakao           text DEFAULT '',
  memo            text DEFAULT '',
  serials         text[] DEFAULT '{}'::text[],
  base_fee        integer DEFAULT 0,
  bw_free         integer DEFAULT 0,
  bw_rate         integer DEFAULT 0,
  co_free         integer DEFAULT 0,
  co_rate         integer DEFAULT 0,
  contract_start  date,
  contract_end    date,
  source_sheet    text DEFAULT '',
  asms_customer_id text,                      -- ASMS customers.id 연결 (옵션)
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rental_customers_company ON public.rental_customers (company);

-- 2) 시리얼/프린터 마스터
CREATE TABLE IF NOT EXISTS public.rental_printers (
  serial          text PRIMARY KEY,
  model           text DEFAULT '',
  "group"         text DEFAULT '',
  asset_name      text DEFAULT '',
  customer_id     text REFERENCES public.rental_customers(id) ON DELETE SET NULL,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rental_printers_customer ON public.rental_printers (customer_id);

-- 3) 월별 카운터 (period × serial)
CREATE TABLE IF NOT EXISTS public.rental_counters (
  period          text NOT NULL,              -- '2026-04' 형식
  serial          text NOT NULL REFERENCES public.rental_printers(serial) ON DELETE CASCADE,
  bw              bigint,
  co              bigint,
  last_update     text DEFAULT '',
  source          text DEFAULT '',
  source_file     text DEFAULT '',
  created_at      timestamptz DEFAULT now(),
  PRIMARY KEY (period, serial)
);
CREATE INDEX IF NOT EXISTS idx_rental_counters_serial ON public.rental_counters (serial);

-- 4) 계약서
CREATE TABLE IF NOT EXISTS public.rental_contracts (
  id              text PRIMARY KEY,
  customer_id     text REFERENCES public.rental_customers(id) ON DELETE SET NULL,
  company         text NOT NULL,
  company_top     text DEFAULT '',
  requester       text DEFAULT '',
  address         text DEFAULT '',
  invoice_kind    text DEFAULT '',
  biz_no          text DEFAULT '',
  mobile          text DEFAULT '',
  tel_fax         text DEFAULT '',
  email           text DEFAULT '',
  items           jsonb DEFAULT '[]'::jsonb,  -- [{no,product,bw_free,co_free,bw_rate,co_rate,qty,install,fee,vat_note}]
  deposit         integer DEFAULT 0,
  total_fee       integer DEFAULT 0,
  contract_date   text DEFAULT '',
  contract_months integer DEFAULT 36,
  pay_day         integer DEFAULT 25,
  terms_checked   boolean[] DEFAULT '{}'::boolean[],
  extras_checked  boolean[] DEFAULT '{}'::boolean[],
  special         text[] DEFAULT '{}'::text[],
  bank            jsonb DEFAULT '{}'::jsonb,
  source_file     text DEFAULT '',
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rental_contracts_customer ON public.rental_contracts (customer_id);

-- 5) 음성미팅
CREATE TABLE IF NOT EXISTS public.rental_meetings (
  id              text PRIMARY KEY,
  customer_id     text REFERENCES public.rental_customers(id) ON DELETE SET NULL,
  title           text DEFAULT '',
  memo            text DEFAULT '',
  audio_path      text DEFAULT '',            -- Storage 'rental-files/meetings/...' 경로
  duration_sec    integer DEFAULT 0,
  meeting_date    timestamptz,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rental_meetings_customer ON public.rental_meetings (customer_id);

-- 6) 고객자료실
CREATE TABLE IF NOT EXISTS public.rental_archive (
  id              text PRIMARY KEY,
  customer_id     text REFERENCES public.rental_customers(id) ON DELETE CASCADE,
  category        text NOT NULL,              -- 'contract'|'manual'|'promo'|'biz_doc'|'etc'
  filename        text NOT NULL,
  file_path       text NOT NULL,              -- Storage 'rental-files/archive/...' 경로
  mime_type       text DEFAULT '',
  size_bytes      bigint DEFAULT 0,
  description     text DEFAULT '',
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rental_archive_customer ON public.rental_archive (customer_id);

-- 7) 가격표 게시판
CREATE TABLE IF NOT EXISTS public.rental_prices (
  id              text PRIMARY KEY,
  category        text NOT NULL,              -- '판매제품' | '부품'
  title           text NOT NULL,
  description     text DEFAULT '',
  file_path       text DEFAULT '',            -- Storage 'rental-files/prices/...'
  filename        text DEFAULT '',
  mime_type       text DEFAULT '',
  pinned          boolean DEFAULT false,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- 8) 거래처 첨부 (사업자등록증 / 명함 / 신분증 / 통장사본)
CREATE TABLE IF NOT EXISTS public.rental_customer_attachments (
  id              text PRIMARY KEY,
  customer_id     text NOT NULL REFERENCES public.rental_customers(id) ON DELETE CASCADE,
  kind            text NOT NULL,              -- 'business_license'|'business_card'|'id_card'|'bankbook'
  file_path       text NOT NULL,              -- Storage 'rental-files/customers/<cid>/<kind>.<ext>'
  mime_type       text DEFAULT '',
  size_bytes      bigint DEFAULT 0,
  uploaded_at     timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rental_attachments_customer ON public.rental_customer_attachments (customer_id);

-- ===========================================================
-- 9) updated_at 자동 갱신 트리거
-- ===========================================================
CREATE OR REPLACE FUNCTION public.tg_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['rental_customers','rental_printers','rental_contracts','rental_meetings','rental_prices'])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON public.%I;', t, t);
    EXECUTE format('CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();', t, t);
  END LOOP;
END $$;

-- ===========================================================
-- 10) RLS — ASMS와 동일 정책 (인증된 사용자만 read/write)
-- ===========================================================
ALTER TABLE public.rental_customers              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rental_printers               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rental_counters               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rental_contracts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rental_meetings               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rental_archive                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rental_prices                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rental_customer_attachments   ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'rental_customers','rental_printers','rental_counters','rental_contracts',
    'rental_meetings','rental_archive','rental_prices','rental_customer_attachments'])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "auth_all" ON public.%I;', t);
    EXECUTE format('CREATE POLICY "auth_all" ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true);', t);
  END LOOP;
END $$;

-- ===========================================================
-- 11) Storage bucket — rental-files
--     SQL로는 INSERT만 가능, 실제 publik 정책은 대시보드에서 확인 권장
-- ===========================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('rental-files', 'rental-files', false)
ON CONFLICT (id) DO NOTHING;

-- bucket RLS: 인증된 사용자만 read/write
DROP POLICY IF EXISTS "rental_files_auth_select" ON storage.objects;
DROP POLICY IF EXISTS "rental_files_auth_insert" ON storage.objects;
DROP POLICY IF EXISTS "rental_files_auth_update" ON storage.objects;
DROP POLICY IF EXISTS "rental_files_auth_delete" ON storage.objects;

CREATE POLICY "rental_files_auth_select" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'rental-files');
CREATE POLICY "rental_files_auth_insert" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'rental-files');
CREATE POLICY "rental_files_auth_update" ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'rental-files') WITH CHECK (bucket_id = 'rental-files');
CREATE POLICY "rental_files_auth_delete" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'rental-files');
