-- ===========================================================
-- totalas — 사용자 프로필 + 권한
-- 적용: Supabase SQL Editor에 붙여넣고 Run
-- ===========================================================

-- rental_user_profiles
-- id 매핑 (display_id) + role + 관리 정보
CREATE TABLE IF NOT EXISTS public.rental_user_profiles (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_id  text UNIQUE NOT NULL,                 -- 'hanbyeol2' 같은 짧은 로그인 id
  full_name   text DEFAULT '',
  role        text NOT NULL CHECK (role IN ('admin','engineer')),
  active      boolean DEFAULT true,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rental_user_profiles_display_id ON public.rental_user_profiles (display_id);

-- updated_at 자동 갱신
DROP TRIGGER IF EXISTS trg_rental_user_profiles_updated_at ON public.rental_user_profiles;
CREATE TRIGGER trg_rental_user_profiles_updated_at
  BEFORE UPDATE ON public.rental_user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

ALTER TABLE public.rental_user_profiles ENABLE ROW LEVEL SECURITY;

-- 모든 인증 사용자: 다른 사람 프로필 read 가능 (UI에서 이름 표시 등)
DROP POLICY IF EXISTS "p_profiles_select" ON public.rental_user_profiles;
CREATE POLICY "p_profiles_select" ON public.rental_user_profiles
  FOR SELECT TO authenticated USING (true);

-- 본인 프로필 update 가능 (이름 변경 등)
DROP POLICY IF EXISTS "p_profiles_update_self" ON public.rental_user_profiles;
CREATE POLICY "p_profiles_update_self" ON public.rental_user_profiles
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND role = (SELECT role FROM public.rental_user_profiles WHERE user_id = auth.uid()));

-- admin role 만 INSERT/DELETE 가능 (다른 사람 추가/제거)
-- INSERT/DELETE에 같은 정책을 따로 둠 (UPDATE는 본인 자체 수정으로 분리)
DROP POLICY IF EXISTS "p_profiles_admin_insert" ON public.rental_user_profiles;
CREATE POLICY "p_profiles_admin_insert" ON public.rental_user_profiles
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.rental_user_profiles WHERE user_id = auth.uid() AND role = 'admin')
  );

DROP POLICY IF EXISTS "p_profiles_admin_delete" ON public.rental_user_profiles;
CREATE POLICY "p_profiles_admin_delete" ON public.rental_user_profiles
  FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.rental_user_profiles WHERE user_id = auth.uid() AND role = 'admin')
  );

-- 도우미: 현재 사용자 role
CREATE OR REPLACE FUNCTION public.current_role_rental()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT role FROM public.rental_user_profiles WHERE user_id = auth.uid()
$$;

-- 도우미: 현재 사용자가 admin?
CREATE OR REPLACE FUNCTION public.is_admin_rental()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.rental_user_profiles WHERE user_id = auth.uid() AND role = 'admin')
$$;
