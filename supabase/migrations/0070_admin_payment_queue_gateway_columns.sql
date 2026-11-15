-- Expose payment_method / cashfree_order_id / phonepe_merchant_txn_id on
-- admin_payment_queue so the admin Payment History UI can label each
-- payment by its real gateway instead of assuming every row is Cashfree.
--
-- Root cause: the view predates the Cashfree migration and was never
-- widened when payment_method/cashfree_order_id were added to `payments`.
-- The admin/payments page therefore had no way to tell a Cashfree payment
-- apart from an old PhonePe or manual-UPI one and hardcoded a blanket
-- "Cashfree payments · automatically verified" label + "Approved
-- automatically" badge on every row -- factually wrong for the 23
-- approved PhonePe payments and the 3 approved manual-UPI payments (which
-- went through actual human review, not gateway auto-approval) already in
-- prod.
--
-- CREATE OR REPLACE VIEW appends the new columns at the end without
-- dropping the view, so the existing service_role SELECT grant (items
-- #40/#41) is preserved -- confirmed via information_schema after
-- applying this directly through the Supabase MCP.

CREATE OR REPLACE VIEW admin_payment_queue AS
 SELECT pay.id AS payment_id,
    pay.status AS payment_status,
    pay.amount,
    pay.utr_number,
    pay.screenshot_path,
    pay.review_notes,
    pay.reviewed_at,
    pay.created_at AS submitted_at,
    pay.invite_sent,
    pay.invite_sent_at,
    pay.invite_failed,
    pay.invite_pending,
    pay.invite_link,
    p.id AS student_id,
    p.full_name,
    p.phone,
    p.college,
    p.roll_number,
    p.branch,
    p.year,
    p.telegram_id,
    p.username AS telegram_username,
    p.bot_started,
    COALESCE(bp.id, bpay.id) AS batch_id,
    COALESCE(bp.name, bpay.name) AS batch_name,
    COALESCE(bp.slug, bpay.slug) AS batch_slug,
    COALESCE(bp.telegram_invite_link, bpay.telegram_invite_link) AS telegram_invite_link,
    pay.reviewed_by,
        CASE
            WHEN pay.status = 'approved'::payment_status THEN row_number() OVER (PARTITION BY (COALESCE(bp.id, bpay.id)), (pay.status = 'approved'::payment_status) ORDER BY pay.created_at)
            ELSE NULL::bigint
        END AS payment_order,
        CASE
            WHEN pay.status = 'approved'::payment_status THEN count(*) FILTER (WHERE pay.status = 'approved'::payment_status) OVER (PARTITION BY (COALESCE(bp.id, bpay.id)))
            ELSE NULL::bigint
        END AS batch_approved_total,
    pay.payment_method,
    pay.cashfree_order_id,
    pay.phonepe_merchant_txn_id
   FROM payments pay
     JOIN profiles p ON p.id = pay.student_id
     LEFT JOIN batches bp ON bp.id = p.batch_id
     LEFT JOIN batches bpay ON bpay.id = pay.batch_id
  ORDER BY pay.created_at DESC;
