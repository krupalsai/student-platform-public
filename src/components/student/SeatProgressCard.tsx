"use client";
import { Users, CheckCircle2 } from "lucide-react";
import { ui } from "@/lib/student-ui";

/**
 * Seat progress toward the petition minimum. Extracted from
 * dashboard/page.tsx so both Home (condensed context) and the new Batch
 * tab (full detail) can render it without duplicating the markup.
 *
 * The exact count is shown ONLY to paid students (payment approved).
 * Unpaid students see only "Few seats left" — no numbers, no progress
 * bar, no "N more needed" — so the real seat count never leaks to
 * someone who hasn't paid yet.
 *
 * The count itself is paid-only: it counts students whose payment is
 * approved, never a random registration. A registered-but-unpaid student
 * is not added to it, and the "You're counted in this batch" line is
 * shown only to paid students — unpaid students read "You're registered
 * in this batch" instead.
 */
export default function SeatProgressCard({ data, showCount = false }: { data: any; showCount?: boolean }) {
  // `accepting` is false once the batch is closed/archived. Older API
  // responses omit it, so treat "missing" as accepting rather than hiding
  // the card from every student during a rollout.
  if (!data?.has_batch) return null;
  if (data.accepting === false) return null;
  const paid: number = data.paid_count ?? data.registered_count ?? 0;
  const minSeats: number   = data.min_seats ?? 50;
  const reached: boolean   = !!data.reached;
  const remaining: number  = data.remaining ?? Math.max(0, minSeats - paid);
  const pct = Math.min(100, Math.round((paid / minSeats) * 100));

  return (
    <div style={{
      background: ui.surface, borderRadius: ui.radius.card, padding: "16px",
      border: `1px solid ${ui.border}`, boxShadow: ui.shadow.card,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span style={{ width:30, height:30, borderRadius:ui.radius.sm, background: ui.canvas, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
          {reached
            ? <CheckCircle2 size={15} strokeWidth={1.8} color={ui.success} />
            : <Users size={15} strokeWidth={1.8} color={ui.textSecondary} />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 13.5, fontWeight: 600, color: ui.textPrimary, margin: 0 }}>
            {data.batch_name ?? "Your Batch"}
          </p>
          <p style={{ fontSize: 11, color: ui.textTertiary, margin: "2px 0 0" }}>
            {showCount ? "You're counted in this batch" : "You're registered in this batch"}{data.college ? ` · ${data.college}` : ""}
          </p>
        </div>
        {showCount ? (
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <p style={{ fontSize: 18, fontWeight: 600, color: reached ? ui.success : ui.textPrimary, margin: 0, lineHeight: 1 }}>
              {paid}<span style={{ fontSize: 12, color: ui.textTertiary, fontWeight: 500 }}> / {minSeats}</span>
            </p>
            <p style={{ fontSize: 10, color: ui.textTertiary, margin: "2px 0 0" }}>seats</p>
          </div>
        ) : !reached ? (
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: ui.textPrimary, margin: 0, lineHeight: 1.3 }}>Few seats left</p>
          </div>
        ) : null}
      </div>

      {showCount && (
        <div style={{ height: 6, borderRadius: 4, background: ui.canvas, overflow: "hidden" }}>
          <div style={{
            height: "100%", width: `${pct}%`, borderRadius: 4,
            background: reached ? ui.success : ui.textTertiary,
            transition: "width 0.5s ease",
          }} />
        </div>
      )}

      <p style={{ fontSize: 12, color: ui.textSecondary, margin: "10px 0 0", lineHeight: 1.5 }}>
        {showCount
          ? reached
            ? `We've reached the minimum of ${minSeats} paid students — the petition process can begin. Stay tuned for updates here.`
            : `The certificate petition can only start once we reach a minimum of ${minSeats} paid students. ${remaining} more ${remaining === 1 ? "student is" : "students are"} needed — please share with your classmates so we can begin sooner.`
          : reached
            ? `The minimum is reached — the petition process can begin. Stay tuned for updates here.`
            : `Few seats left — we could stop the batch at any moment. Please share with your classmates so we can begin sooner.`}
      </p>
    </div>
  );
}
