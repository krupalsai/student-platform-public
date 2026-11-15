"use client";

import { Check, CircleHelp, Clock, Gavel } from "lucide-react";
import { ui } from "@/lib/student-ui";

/**
 * CaseClarityBits — shared plain-words UI for the case-clarity upgrade.
 * Same `ui` tokens and lucide icons as the rest of the student app,
 * mobile-first, no new dependencies.
 */

/** Green-soft banner for a disposed case: headline + plain-words meaning. */
export function DisposedBanner({
  title,
  meaning,
}: {
  title: string;
  meaning: string | null;
}) {
  return (
    <div
      style={{
        background: ui.successSoft,
        border: `1px solid ${ui.successSoftBorder}`,
        borderRadius: ui.radius.button,
        padding: "11px 13px",
        display: "flex",
        gap: 10,
      }}
    >
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: ui.radius.sm,
          background: ui.success,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Gavel size={15} strokeWidth={2} color="#fff" />
      </div>
      <div style={{ minWidth: 0 }}>
        <p style={{ fontSize: 13, fontWeight: 700, color: ui.success, margin: 0 }}>
          {title}
        </p>
        {meaning && (
          <p style={{ fontSize: 12, color: ui.textSecondary, margin: "4px 0 0", lineHeight: 1.5 }}>
            {meaning}
          </p>
        )}
      </div>
    </div>
  );
}

/** Small honesty line under the status pill: "No new update since …". */
export function FreshnessLine({
  text,
  checkedText,
}: {
  text: string;
  checkedText?: string | null;
}) {
  return (
    <p
      style={{
        fontSize: 11,
        color: ui.textTertiary,
        margin: "7px 0 0",
        display: "flex",
        alignItems: "center",
        gap: 5,
        lineHeight: 1.4,
      }}
    >
      <Clock size={11} strokeWidth={1.8} style={{ flexShrink: 0 }} />
      <span>
        {text}
        {checkedText ? ` · ${checkedText}` : ""}
      </span>
    </p>
  );
}

/** "What we know" / "What we don't know yet" — the confusion killer. */
export function KnownUnknownPanel({
  known,
  unknown,
}: {
  known: string[];
  unknown: string[];
}) {
  if (!known.length && !unknown.length) return null;
  return (
    <div
      style={{
        marginTop: 14,
        border: `1px solid ${ui.border}`,
        borderRadius: ui.radius.button,
        overflow: "hidden",
      }}
    >
      {known.length > 0 && (
        <div style={{ padding: "10px 13px", background: ui.surface }}>
          <p
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: ui.textTertiary,
              textTransform: "uppercase",
              letterSpacing: 0.8,
              margin: "0 0 7px",
            }}
          >
            What we know
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {known.map((k, i) => (
              <div key={i} style={{ display: "flex", gap: 8 }}>
                <Check size={13} strokeWidth={2.5} color={ui.success} style={{ flexShrink: 0, marginTop: 2 }} />
                <p style={{ fontSize: 12, color: ui.textSecondary, margin: 0, lineHeight: 1.5 }}>{k}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {unknown.length > 0 && (
        <div
          style={{
            padding: "10px 13px",
            background: ui.warningSoft,
            borderTop: known.length ? `1px solid ${ui.divider}` : "none",
          }}
        >
          <p
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: ui.warning,
              textTransform: "uppercase",
              letterSpacing: 0.8,
              margin: "0 0 7px",
            }}
          >
            What we don&apos;t know yet
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {unknown.map((u, i) => (
              <div key={i} style={{ display: "flex", gap: 8 }}>
                <CircleHelp size={13} strokeWidth={2} color={ui.warning} style={{ flexShrink: 0, marginTop: 2 }} />
                <p style={{ fontSize: 12, color: ui.textSecondary, margin: 0, lineHeight: 1.5 }}>{u}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
