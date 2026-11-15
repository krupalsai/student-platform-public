"use client";
import { ui } from "@/lib/student-ui";

/** Light page title used by the student tabs: big bold title on the canvas. */
export default function StudentPageHeader({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div style={{ padding: "44px 20px 6px", display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <h1 style={{ color: ui.textPrimary, fontSize: 28, fontWeight: 700, letterSpacing: -0.6, margin: 0 }}>{title}</h1>
        {sub && <p style={{ color: ui.textSecondary, fontSize: 13, margin: "4px 0 0" }}>{sub}</p>}
      </div>
      {right}
    </div>
  );
}
