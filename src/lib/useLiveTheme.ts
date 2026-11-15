"use client";

export interface LiveTheme {
  bg: string; heroBg: string; headline: string; sub: string; accent: string;
}

/** Shared palette for the admin console: iOS grey canvas, large-title header on the canvas, iOS system blue. */
const THEME: LiveTheme = {
  bg: "#f2f2f7",
  heroBg: "#f2f2f7",
  headline: "#1c1c1e",
  sub: "#6e6e73",
  accent: "#007aff",
};

export function useLiveTheme(): LiveTheme {
  return THEME;
}
