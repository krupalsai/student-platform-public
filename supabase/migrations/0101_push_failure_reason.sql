-- 0101_push_failure_reason.sql
--
-- Record WHY a push subscription failed, so the next systemic break is
-- diagnosable from data alone. On 29 Oct 2026 thirty subscriptions were
-- flagged failed_at with no reason stored, and nothing in the database
-- could tell a wrong VAPID key (reason "unauthorized") from dead endpoints
-- (reason "expired") from a push-service outage. The code that writes this
-- column (markPushSubscriptionFailed) treats the write as best effort, so
-- this migration is safe to apply after the deploy — and the deploy is safe
-- before it is applied.
--
-- Apply in the Supabase dashboard SQL editor (one paste, one run).
ALTER TABLE public.push_subscriptions
  ADD COLUMN IF NOT EXISTS last_failure_reason text;
