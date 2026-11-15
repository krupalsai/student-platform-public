-- rls_auto_enable is an event trigger function, not a user-callable RPC.
-- Revoke public execute to clear the Supabase security WARN advisors.
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM authenticated;
