-- Security hardening: fix mutable search_path + restrict anon execute
-- Addresses Supabase WARN advisors:
--   function_search_path_mutable (set_updated_at, sync_petition_on_payment, cleanup_expired_sessions)
--   anon_security_definer_function_executable (cleanup_expired_sessions)

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_petition_on_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'approved' AND OLD.status != 'approved' THEN
    UPDATE petitions SET status = 'pending_review', updated_at = now()
    WHERE id = NEW.petition_id AND status = 'pending_payment';
  END IF;
  IF NEW.status IN ('rejected','reupload_requested') AND OLD.status = 'submitted' THEN
    UPDATE petitions SET status = 'pending_payment', updated_at = now()
    WHERE id = NEW.petition_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_expired_sessions()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE deleted_count INTEGER;
BEGIN
  DELETE FROM sessions WHERE expires_at < NOW() - INTERVAL '1 day';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_expired_sessions() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_sessions() FROM anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_sessions() FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.cleanup_expired_sessions() TO service_role;
