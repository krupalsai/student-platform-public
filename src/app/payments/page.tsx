"use client";
import { useState } from "react";
import { CheckCircle2, Clock } from "lucide-react";
import StudentPageHeader from "@/components/student/StudentPageHeader";
import StudentBottomNav from "@/components/student/StudentBottomNav";
import CoachMarkTour from "@/components/CoachMarkTour";
import RazorpayCheckoutButton from "@/components/RazorpayCheckoutButton";
import { useStudentData } from "@/lib/hooks/useStudentData";
import { ui } from "@/lib/student-ui";
import LoadFailed from "@/components/student/LoadFailed";

/** Student payment status for the Razorpay payment flow. */
/** "Opens 15 Oct" while item 2's start date is ahead; "Opens soon" without one. */
function opensLabel(opensAt?: string | null) {
  const t = opensAt ? Date.parse(opensAt) : NaN;
  if (!Number.isFinite(t) || Date.now() >= t) return "Opens soon";
  return `Opens ${new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}`;
}

export default function PaymentsPage() {
  const {
    loading, loadError, reload, payment, batch, ps, payStatus, isApproved, previewMode,
    navigate, authHeader, profile, extraFee, setExtraFee, nothingToPay,
  } = useStudentData();
  const [cancelling, setCancelling] = useState(false);

  const isPgPending = payStatus === "pg_pending";
  const pgPendingStaleMs = 21 * 60 * 1000;
  const isPgPendingStale = isPgPending && payment?.created_at
    ? (Date.now() - new Date(payment.created_at).getTime()) > pgPendingStaleMs
    : false;

  async function handleCancelPayment() {
    if (previewMode || !payment?.id) return;
    if (!confirm("Cancel this payment attempt so you can try again?")) return;
    setCancelling(true);
    try {
      const res = await fetch("/api/payments/cancel", {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ payment_id: payment.id }),
      });
      const j = await res.json();
      if (!j.success) {
        alert(j.error ?? "Could not cancel. Please try again.");
        if (j.error?.toLowerCase().includes("refresh")) window.location.reload();
        return;
      }
      window.location.reload();
    } catch {
      alert("Network error. Please try again.");
    } finally {
      setCancelling(false);
    }
  }

  // Rejected students are sent here by the dashboard to resubmit their payment.
  const needsPayment = payStatus === "pending" || payStatus === "pg_failed" || payStatus === "rejected" || isPgPendingStale;

  return (
    <main style={{ minHeight: "100vh", background: ui.canvas, paddingBottom: 108 }}>
      {loadError && <LoadFailed onRetry={reload} />}
      <StudentPageHeader title="Payments" sub="Your fee status and payment history" />

      <div style={{ padding: "20px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        {/* The fee is an order of two items, each paid on its own (like two items in one cart). */}
        {!loading && extraFee && extraFee.status !== "none" && Number(batch?.fee_amount ?? 0) > 0 && (() => {
          const mainAmount = Number(isApproved && payment?.amount ? payment.amount : batch.fee_amount);
          const extraAmount = Number(extraFee.amount ?? 0);
          const rows = [
            { name: "Batch fee", amount: mainAmount, done: isApproved, note: isApproved ? "Paid" : "Pay below" },
            {
              name: extraFee.label, amount: extraAmount, done: !!extraFee.paid,
              note: extraFee.paid ? "Paid" : extraFee.status === "due" ? "Pay below" : isApproved ? opensLabel(extraFee.opensAt) : "After item 1",
            },
          ];
          const paidTotal = rows.filter(r => r.done).reduce((a, r) => a + r.amount, 0);
          const total = mainAmount + extraAmount;
          return (
            <div style={{ background: ui.surface, borderRadius: ui.radius.card, border: `1px solid ${ui.border}`, boxShadow: ui.shadow.card, overflow: "hidden" }}>
              <div style={{ padding: "14px 16px", borderBottom: `1px solid ${ui.divider}`, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <p style={{ fontSize: 15, fontWeight: 700, color: ui.textPrimary, margin: 0 }}>Your order</p>
                <p style={{ fontSize: 12, color: ui.textTertiary, margin: 0 }}>2 items · paid separately</p>
              </div>
              {rows.map((r, i) => (
                <div key={i} style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 12, borderBottom: `1px solid ${ui.divider}` }}>
                  <div style={{ width: 30, height: 30, borderRadius: ui.radius.sm, background: r.done ? ui.success : ui.canvas, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    {r.done ? <CheckCircle2 size={16} strokeWidth={2} color="#fff" /> : <Clock size={15} strokeWidth={2} color={ui.textTertiary} />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 14, fontWeight: 600, color: ui.textPrimary, margin: 0 }}>{i + 1}. {r.name}</p>
                    <p style={{ fontSize: 12, color: r.done ? ui.success : ui.textSecondary, margin: "2px 0 0" }}>{r.note}</p>
                  </div>
                  <p style={{ fontSize: 14, fontWeight: 600, color: ui.textPrimary, margin: 0 }}>₹{r.amount.toLocaleString("en-IN")}</p>
                </div>
              ))}
              <div style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", background: ui.canvas }}>
                <p style={{ fontSize: 13, color: ui.textSecondary, margin: 0 }}>Paid ₹{paidTotal.toLocaleString("en-IN")} of ₹{total.toLocaleString("en-IN")}</p>
                <p style={{ fontSize: 15, fontWeight: 700, color: ui.textPrimary, margin: 0 }}>Total ₹{total.toLocaleString("en-IN")}</p>
              </div>
              {/* Why there are two items — shown from the start, not only once item 2 is payable. */}
              {!extraFee.paid && extraFee.note && (
                <p style={{ fontSize: 12.5, color: ui.textSecondary, margin: 0, padding: "12px 16px", lineHeight: 1.5, borderTop: `1px solid ${ui.divider}` }}>{extraFee.note}</p>
              )}
            </div>
          );
        })()}

        <div style={{ background: ui.surface, borderRadius: ui.radius.card, border: `1px solid ${ui.border}`, boxShadow: ui.shadow.card, overflow: "hidden" }}>
          <div style={{ padding: 16, display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${ui.divider}` }}>
            <span style={{ width: 7, height: 7, borderRadius: 999, background: ps.dot, flexShrink: 0 }} />
            <p style={{ fontSize: 14, fontWeight: 600, color: ui.textPrimary, margin: 0 }}>{ps.label}</p>
          </div>

          {loading ? (
            <div style={{ padding: 16 }}><div style={{ height: 16, width: "50%", background: ui.canvas, borderRadius: 6 }} /></div>
          ) : (
            <>
              {isApproved && (
                <div style={{ margin: 16, background: ui.successSoft, border: `1px solid ${ui.successSoftBorder}`, borderRadius: ui.radius.button, padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                  <CheckCircle2 size={16} strokeWidth={1.8} color={ui.success} />
                  <p style={{ color: ui.success, fontWeight: 600, fontSize: 13.5, margin: 0 }}>Payment Approved</p>
                </div>
              )}

              {isPgPending && !isPgPendingStale && (
                <div style={{ margin: 16, background: ui.accentSoft, border: `1px solid ${ui.accentSoftBorder}`, borderRadius: ui.radius.button, padding: "12px 14px" }}>
                  <p style={{ color: ui.accent, fontWeight: 600, fontSize: 13, margin: 0 }}>Payment processing</p>
                  <p style={{ color: ui.accent, fontSize: 12, margin: "4px 0 0", opacity: 0.8 }}>We're confirming your payment. Your status will update automatically.</p>
                </div>
              )}

              {payStatus === "pg_failed" && (
                <div style={{ margin: 16, background: ui.dangerSoft, border: `1px solid ${ui.dangerSoftBorder}`, borderRadius: ui.radius.button, padding: "12px 14px" }}>
                  <p style={{ color: ui.danger, fontWeight: 600, fontSize: 13, margin: 0 }}>Payment failed</p>
                  <p style={{ color: ui.danger, fontSize: 12, margin: "4px 0 0" }}>The payment was not completed. You can try again.</p>
                </div>
              )}

              {isPgPending && !isPgPendingStale && (
                <div style={{ padding: "0 16px 14px", textAlign: "center" }}>
                  <button onClick={handleCancelPayment} disabled={cancelling}
                    style={{ background: "none", border: "none", color: ui.accent, fontWeight: 500, fontSize: 13, cursor: "pointer", textDecoration: "underline", opacity: cancelling ? 0.5 : 1 }}>
                    {cancelling ? "Cancelling…" : "Didn't complete payment? Cancel & try again"}
                  </button>
                </div>
              )}

              {needsPayment && batch && (
                <div style={{ padding: "0 16px 16px" }}>
                  {isPgPendingStale && (
                    <p style={{ fontSize: 12, color: ui.warning, background: ui.warningSoft, border: `1px solid ${ui.warningSoftBorder}`, borderRadius: ui.radius.sm, padding: "8px 12px", marginBottom: 8 }}>
                      We could not confirm this payment attempt yet. Please do not pay again if your bank shows a debit.
                    </p>
                  )}
                  <button onClick={() => navigate(`/pay/${batch.slug}`)} data-tour="pay-button"
                    style={{ width: "100%", background: ui.accent, color: "#fff", border: "none", borderRadius: ui.radius.button, padding: 13, fontWeight: 600, fontSize: 14.5, cursor: "pointer" }}>
                    Pay Contribution
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* The batch's separate second payment — only once an admin switches it on and the main fee is approved. */}
        {!loading && extraFee?.applies && (
          <div style={{ background: ui.surface, borderRadius: ui.radius.card, border: `1px solid ${ui.border}`, boxShadow: ui.shadow.card, overflow: "hidden" }}>
            <div style={{ padding: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, borderBottom: `1px solid ${ui.divider}` }}>
              <p style={{ fontSize: 14, fontWeight: 600, color: ui.textPrimary, margin: 0 }}>{extraFee.label}</p>
              <p style={{ fontSize: 14, fontWeight: 700, color: ui.textPrimary, margin: 0 }}>₹{Number(extraFee.amount ?? 0).toLocaleString("en-IN")}</p>
            </div>
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
              {extraFee.paid ? (
                <div style={{ background: ui.successSoft, border: `1px solid ${ui.successSoftBorder}`, borderRadius: ui.radius.button, padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                  <CheckCircle2 size={16} strokeWidth={1.8} color={ui.success} />
                  <p style={{ color: ui.success, fontWeight: 600, fontSize: 13.5, margin: 0 }}>Paid</p>
                </div>
              ) : (
                <>
                  <p style={{ fontSize: 12.5, color: ui.textSecondary, margin: 0, lineHeight: 1.5 }}>{extraFee.note}</p>
                  {previewMode ? (
                    <p style={{ fontSize: 12, color: ui.textTertiary, margin: 0 }}>Admin preview — payment disabled.</p>
                  ) : (
                    <RazorpayCheckoutButton
                      amountRupees={Number(extraFee.amount ?? 0)}
                      name={profile?.full_name}
                      phone={profile?.phone}
                      createUrl="/api/extra-fee/create-order"
                      verifyUrl="/api/extra-fee/verify"
                      description={extraFee.label}
                      onPaid={() => setExtraFee({ ...extraFee, paid: true, due: false, status: "paid" })}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <StudentBottomNav previewMode={previewMode} hidePayments={nothingToPay} />

      {!loading && !previewMode && (
        <CoachMarkTour tourKey="payments" steps={[
          { selector: '[data-tour="pay-button"]', title: "Pay or resubmit here", text: "Tap this button to pay your batch fee, or resubmit if it was rejected." },
        ]} />
      )}
    </main>
  );
}
