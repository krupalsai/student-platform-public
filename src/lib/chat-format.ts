/** Shared formatting helpers for the Batch Discussion chat (student + admin views). */

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Today" / "Yesterday" / a real date, for the WhatsApp-style day divider. */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (sameCalendarDay(d, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameCalendarDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString("en-IN", {
    day: "numeric", month: "short",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

/** Two messages count as the same "run" (no repeated name/avatar) when same sender, same day, within 3 minutes. */
export function isSameGroup(
  a: { sender_id: string; created_at: string; sender_role?: string },
  b: { sender_id: string; created_at: string; sender_role?: string },
): boolean {
  // A system notice carries the payer's own sender_id (see
  // services/payment-announcements.ts), so without this a student's real
  // message right after their own "just paid" notice would be treated as a
  // continuation and lose its name and avatar.
  if (a.sender_role === "system" || b.sender_role === "system") return false;
  if (a.sender_id !== b.sender_id) return false;
  const da = new Date(a.created_at), db_ = new Date(b.created_at);
  if (!sameCalendarDay(da, db_)) return false;
  return Math.abs(db_.getTime() - da.getTime()) < 3 * 60 * 1000;
}
