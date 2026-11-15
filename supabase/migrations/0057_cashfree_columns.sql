-- Cashfree payment-gateway columns, mirroring the PhonePe pair.
--
-- Kept as their own columns rather than reusing phonepe_merchant_txn_id: a row
-- must say which gateway it came from without inference, and both integrations
-- exist in the code at once (PhonePe is switched off, not deleted).
--
--   cashfree_order_id   — OUR generated id, sent as Cashfree's order_id. The
--                         webhook returns it as data.order.order_id, so it is
--                         the join key between their event and our row.
--   cashfree_payment_id — Cashfree's own cf_payment_id, for support tickets.

alter table payments add column if not exists cashfree_order_id   text;
alter table payments add column if not exists cashfree_payment_id text;

-- Webhook lookup is by order id on every incoming event, and the initiate
-- route looks up a student's most recent pending order.
create unique index if not exists payments_cashfree_order_id_idx
  on payments (cashfree_order_id)
  where cashfree_order_id is not null;
