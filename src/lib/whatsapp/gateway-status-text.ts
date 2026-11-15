/**
 * Gateway-status questions — pure matcher + answer builder, no I/O.
 *
 * Live failure 2026-10-27: the admin asked "Did cashfree pg is working"
 * and the bot replied with the Platform Status snapshot (Students: 102,
 * Pending payments: 0, Approved: 59, Active batches: 4). The rule layer had
 * no gateway vocabulary, so the message fell through to the Groq classifier,
 * which mapped "is working" to STATUS_REQUEST, and the router's admin-branch
 * fallback ran the STATUS command. The grounded-answer path was no better:
 * there is no FAQ row about which gateway is live, so the model answered
 * from the nearest payment FAQ ("Payments go through Razorpay") — an answer
 * that goes stale the moment the admin flips the switch.
 *
 * The fix: detect the question by rule (this file) and answer from the live
 * gateway switches (gateway-status.ts), never from a static FAQ. A FAQ can
 * never be the source of truth for a switch the admin flips.
 */

/** The live gateway, as decided by getActivePaymentGateway(). */
export type LiveGateway = "razorpay" | "cashfree" | "phonepe" | null;

export type GatewayAudience = "admin" | "student";

const GATEWAY_NAMES = ["cashfree", "razorpay", "phonepe"];

/**
 * True when the message asks whether a payment gateway is working / live /
 * down — as opposed to asking about the sender's OWN payment, which is a
 * different intent (personal payment status) and must never be stolen by
 * this matcher.
 */
export function isGatewayStatusQuestion(raw: string): boolean {
  const t = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return false;

  // Personal payment questions are a different intent — never steal them.
  if (/\bmy payment\b/.test(t)) return false;
  if (/\bi (paid|have paid|did pay)\b/.test(t)) return false;
  if (/\bpayment (status|failed|pending|done|approved|received|verified|confirmed|success)\b/.test(t)) return false;
  if (/\b(amount|money) (deducted|debited|cut)\b/.test(t)) return false;

  const namesGateway = GATEWAY_NAMES.some((n) => new RegExp(`\\b${n}\\b`).test(t));
  const genericGateway = /\b(pg|payment gateway|gateway)\b/.test(t);
  const statusWord =
    /\b(work|works|working|live|down|active|accept|accepting|up|running|open|enabled|disabled|on|off|fail|failed|issue|problem)\b/.test(t);
  const whichGateway = /\bwhich\b.*\bgateway\b/.test(t) || /\bwhich payment\b/.test(t);
  if (whichGateway) return true;
  if ((namesGateway || genericGateway) && statusWord) return true;

  // Bare availability questions — "are payments working", "accepting
  // payments" — ask about the platform, not the sender's own payment.
  if (/^accepting payments\b/.test(t)) return true;
  if (/^(are|is)\b/.test(t) && /\bpayments?\b/.test(t) && /\b(working|accepting|open|live|down)\b/.test(t)) return true;

  return false;
}

/**
 * The direct answer, composed from live state — never from a static FAQ.
 * `cashfreeBroken` means a recent "transactions are not enabled" failure
 * was recorded for Cashfree (system_errors, api/cashfree/initiate): the
 * merchant account is not activated yet, so Cashfree cannot take payments
 * even though the switch is on.
 */
export function buildGatewayStatusAnswer(
  active: LiveGateway,
  cashfreeBroken: boolean,
  audience: GatewayAudience,
): string {
  if (audience === "admin") {
    if (active === "razorpay") {
      return "Yes — payments are working through Razorpay (UPI, debit card, credit card). Cashfree is switched off.";
    }
    if (active === "cashfree") {
      if (cashfreeBroken) {
        return "Cashfree is the selected gateway, but it is NOT working — the Cashfree merchant account is not activated yet (their error: 'transactions are not enabled for your payment gateway account', ticket 8583165). Payments through Cashfree will fail. Razorpay is switched off right now — switch it back on in admin Settings to take payments again.";
      }
      return "Cashfree is the selected gateway. No recent Cashfree failure is recorded — if a payment fails, check the error in system_errors.";
    }
    if (active === "phonepe") {
      return "PhonePe is the selected gateway.";
    }
    return "No payment gateway is switched on right now, so payments are unavailable. Switch one on in admin Settings.";
  }

  // Student audience: no ticket numbers, no internal state.
  if (active === "razorpay") {
    return "Yes — payments are working through Razorpay. You can pay on the Payments tab in the Student App with UPI, debit card, or credit card.";
  }
  if (active === "cashfree") {
    if (cashfreeBroken) {
      return "Payments are not working right now — the payment gateway is still being set up. Please try again later.";
    }
    return "Payments go through Cashfree right now. You can pay on the Payments tab in the Student App.";
  }
  if (active === "phonepe") {
    return "Payments go through PhonePe right now. You can pay on the Payments tab in the Student App.";
  }
  return "Payments are unavailable right now. Please check back later.";
}
