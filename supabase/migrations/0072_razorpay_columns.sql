-- Razorpay payment-gateway columns, mirroring the Cashfree pair (0057).
--
--   razorpay_order_id   — Razorpay's order id (returned from POST /orders).
--                         The verify callback and webhook both look up the
--                         payment row by this, so it is the join key.
--   razorpay_payment_id — Razorpay's own payment id, for support tickets.

alter table payments add column if not exists razorpay_order_id   text;
alter table payments add column if not exists razorpay_payment_id text;

create unique index if not exists payments_razorpay_order_id_idx
  on payments (razorpay_order_id)
  where razorpay_order_id is not null;
