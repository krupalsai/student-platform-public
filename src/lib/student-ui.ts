"use client";

/**
 * Shared visual tokens for the student app, in the iOS / App Store style:
 * system grey canvas, white rounded cards, iOS system blue as the one accent,
 * large-title headers on the canvas (no coloured banner), and rounded-square
 * icon tiles. Colour on icons comes only from the small `tints` set (iOS
 * system colours), so every screen draws from the same palette.
 */
export const ui = {
  canvas: "#f2f2f7",
  surface: "#ffffff",
  border: "#e5e5ea",
  borderStrong: "#d1d1d6",
  divider: "#ececf0",
  textPrimary: "#1c1c1e",
  // All text colours below meet WCAG AA (4.5:1) on both `surface` and `canvas`; scripts/test-accessibility.cjs pins that.
  textSecondary: "#5e5e63",
  textTertiary: "#6e6e73",
  accent: "#0066cc",
  accentSoft: "#e8f1ff",
  accentSoftBorder: "#cfe2ff",
  success: "#1f7a36",
  successSoft: "#eaf7ee",
  successSoftBorder: "#c6ebd1",
  danger: "#d70015",
  dangerSoft: "#fff0f1",
  dangerSoftBorder: "#ffd1d5",
  warning: "#a05a00",
  warningSoft: "#fff6e8",
  warningSoftBorder: "#ffe1b3",
  // Home header sits on the canvas, App Store "Today" style.
  heroBg: "#f2f2f7",
  heroText: "#1c1c1e",

  // Solid iOS system colours with white glyphs, like App Store icons.
  tints: [
    { bg: "#007aff", fg: "#ffffff" },
    { bg: "#ff2d55", fg: "#ffffff" },
    { bg: "#34c759", fg: "#ffffff" },
    { bg: "#ff9500", fg: "#ffffff" },
  ],

  radius: { card: 18, tile: 12, button: 12, pill: 999, sm: 10, icon: 11 },
  shadow: { card: "0 1px 3px rgba(0,0,0,0.04), 0 6px 20px rgba(0,0,0,0.05)" },
} as const;
