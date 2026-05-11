-- ===========================================================
-- totalas Phase 2 — 페이지 코드가 쓰지만 init 스키마에 빠진 컬럼 보강
-- 적용: Supabase SQL Editor → Run
-- ===========================================================

-- meetings: attendees (참석자), datetime은 meeting_date를 그대로 사용
ALTER TABLE public.rental_meetings
  ADD COLUMN IF NOT EXISTS attendees text DEFAULT '';

-- prices: author (작성자), file_size (바이트)
ALTER TABLE public.rental_prices
  ADD COLUMN IF NOT EXISTS author    text    DEFAULT '',
  ADD COLUMN IF NOT EXISTS file_size bigint  DEFAULT 0;
