-- Fix admin_payment_queue: join on profiles.batch_id instead of payments.batch_id
-- payments.batch_id is never populated by the submit API; the student batch
-- is always tracked on profiles.batch_id. This was causing the view to return
-- 0 rows, making submitted payments invisible to admins.

DROP VIEW IF EXISTS admin_payment_queue;

CREATE VIEW admin_payment_queue AS
SELECT
  pay.id                        AS payment_id,
  pay.status                    AS payment_status,
  pay.amount,
  pay.utr_number,
  pay.screenshot_path,
  pay.review_notes,
  pay.reviewed_at,
  pay.created_at                AS submitted_at,
  pay.invite_sent,
  pay.invite_sent_at,
  pay.invite_failed,
  p.id                          AS student_id,
  p.full_name,
  p.phone,
  p.college::text               AS college,
  p.roll_number,
  p.branch,
  p.year,
  p.semester,
  p.telegram_id,
  p.username                    AS telegram_username,
  b.id                          AS batch_id,
  b.name                        AS batch_name,
  b.slug                        AS batch_slug,
  b.college::text               AS batch_college,
  b.telegram_invite_link,
  pet.id                        AS petition_id,
  pet.status                    AS petition_status
FROM payments pay
JOIN  profiles  p   ON p.id  = pay.student_id
JOIN  batches   b   ON b.id  = p.batch_id
LEFT JOIN petitions pet ON pet.id = pay.petition_id
ORDER BY pay.created_at DESC;
