-- Migration 0007: Fix RLS performance warnings on profiles/payments
--
-- 1. auth_rls_initplan: wrap auth.uid() in (select auth.uid()) so it's
--    evaluated once per query instead of once per row.
-- 2. multiple_permissive_policies: the *_own policies were created without
--    a TO clause (defaulting to PUBLIC), which combined with deny_anon_*
--    caused duplicate permissive policy evaluation for the anon role.
--    Restricting *_own to `authenticated` fixes this.
--
-- See: https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select

-- profiles
DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = id);

DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;
CREATE POLICY profiles_insert_own ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = id);

DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = id)
  WITH CHECK ((select auth.uid()) = id);

-- payments
DROP POLICY IF EXISTS payments_select_own ON public.payments;
CREATE POLICY payments_select_own ON public.payments
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = student_id);

DROP POLICY IF EXISTS payments_insert_own ON public.payments;
CREATE POLICY payments_insert_own ON public.payments
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = student_id);
