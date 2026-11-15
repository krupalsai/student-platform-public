-- Migration 0015: admin_payment_queue v2 + admin_payment_detail view
-- Applied to production via Supabase MCP — supersedes 0007's definition.
--
-- Why this changed from 0007:
--   - 0007's version joined on profiles.batch_id only (single JOIN to batches).
--     This failed whenever a payment recorded its own batch_id independently
--     of the student's profile (e.g. admin re-assigns batch during approval).
--   - 0007's version also referenced `petitions` and `semester`, which are
--     not used by this build of the platform.
--   - This version resolves batch via COALESCE across BOTH profiles.batch_id
--     and payments.batch_id, and adds bot_started/invite_pending/invite_link
--     so the admin UI can show bot-activation status and invite state
--     without a second query.
--
-- admin_payment_detail is identical but without ORDER BY, used for single-row
-- lookups by payment_id (GET /api/admin/payments/[id]) instead of relying on
-- a list-search workaround.

DROP VIEW IF EXISTS admin_payment_queue;
DROP VIEW IF EXISTS admin_payment_detail;

CREATE VIEW admin_payment_queue AS
SELECT
  pay.id                           AS payment_id,
  pay.status                       AS payment_status,
  pay.amount,
  pay.utr_number,
  pay.screenshot_path,
  pay.review_notes,
  pay.reviewed_at,
  pay.created_at                   AS submitted_at,
  pay.invite_sent,
  pay.invite_sent_at,
  pay.invite_failed,
  pay.invite_pending,
  pay.invite_link,
  p.id                             AS student_id,
  p.full_name,
  p.phone,
  p.college::text                  AS college,
  p.roll_number,
  p.branch,
  p.year,
  p.telegram_id,
  p.username                       AS telegram_username,
  p.bot_started,
  COALESCE(bp.id,   bpay.id)       AS batch_id,
  COALESCE(bp.name, bpay.name)     AS batch_name,
  COALESCE(bp.slug, bpay.slug)     AS batch_slug,
  COALESCE(bp.telegram_invite_link, bpay.telegram_invite_link) AS telegram_invite_link
FROM payments pay
JOIN  profiles p   ON p.id   = pay.student_id
LEFT JOIN batches bp   ON bp.id   = p.batch_id
LEFT JOIN batches bpay ON bpay.id = pay.batch_id
ORDER BY pay.created_at DESC;

GRANT SELECT ON admin_payment_queue TO service_role;

CREATE VIEW admin_payment_detail AS
SELECT
  pay.id                           AS payment_id,
  pay.status                       AS payment_status,
  pay.amount,
  pay.utr_number,
  pay.screenshot_path,
  pay.review_notes,
  pay.reviewed_at,
  pay.created_at                   AS submitted_at,
  pay.invite_sent,
  pay.invite_sent_at,
  pay.invite_failed,
  pay.invite_pending,
  pay.invite_link,
  p.id                             AS student_id,
  p.full_name,
  p.phone,
  p.college::text                  AS college,
  p.roll_number,
  p.branch,
  p.year,
  p.telegram_id,
  p.username                       AS telegram_username,
  p.bot_started,
  COALESCE(bp.id,   bpay.id)       AS batch_id,
  COALESCE(bp.name, bpay.name)     AS batch_name,
  COALESCE(bp.slug, bpay.slug)     AS batch_slug,
  COALESCE(bp.telegram_invite_link, bpay.telegram_invite_link) AS telegram_invite_link
FROM payments pay
JOIN  profiles p   ON p.id   = pay.student_id
LEFT JOIN batches bp   ON bp.id   = p.batch_id
LEFT JOIN batches bpay ON bpay.id = pay.batch_id;

GRANT SELECT ON admin_payment_detail TO service_role;

GRANT SELECT ON admin_stats TO service_role;
