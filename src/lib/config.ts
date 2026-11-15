/**
 * Shared, non-secret app configuration constants.
 */

/**
 * Minimum number of registered students in a batch before the certificate
 * petition can be started AND before payment opens (see
 * src/lib/services/payment-gate.ts). Students are told this after
 * registering, and the dashboard shows live progress toward it.
 *
 * FORTY, not fifty — the number requested throughout this project's briefs.
 * Two levers still override it: `batches.min_seats` per batch, or this env
 * var platform-wide without a deploy.
 */
export const PETITION_MIN_SEATS = Math.max(
  1,
  Number(process.env.PETITION_MIN_SEATS ?? process.env.NEXT_PUBLIC_PETITION_MIN_SEATS ?? 40) || 40,
);

/**
 * Registered-student count at which admins get a one-time WhatsApp alert
 * for that batch — see src/lib/batch-seat-milestone.ts. A separate concept
 * from PETITION_MIN_SEATS above (which gates payment/petition eligibility):
 * this is purely an FYI notification, and the two numbers are not required
 * to match.
 */
export const BATCH_SEAT_MILESTONE = Math.max(
  1,
  Number(process.env.BATCH_SEAT_MILESTONE ?? 35) || 35,
);
