"use client";
import { ui } from "@/lib/student-ui";

/**
 * Shown when the app could not load a student's data after retrying (weak
 * network, server busy). Replaces the old behaviour of bouncing to the
 * homepage, which the installed app turned into a redirect loop.
 */
export default function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" style={{ position: "fixed", inset: 0, zIndex: 90, background: ui.canvas, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
      <div style={{ maxWidth: 320 }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 600, color: ui.textPrimary }}>Couldn&apos;t load your page</h2>
        <p style={{ margin: "0 0 20px", fontSize: 14, color: ui.textSecondary, lineHeight: 1.5 }}>
          The connection is weak or the server is busy. Your data is safe. Please try again.
        </p>
        <button onClick={onRetry} style={{ background: ui.accent, color: "#fff", border: 0, borderRadius: 12, padding: "13px 32px", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
          Try again
        </button>
      </div>
    </div>
  );
}
