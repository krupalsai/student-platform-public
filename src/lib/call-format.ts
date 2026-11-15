/**
 * Tiny formatting helpers shared by every call surface (the full-screen
 * CallOverlay and both incoming-call banners). Kept in one place rather
 * than copied a third time — the same lesson items #89/#113 already
 * learned about chat components applies here.
 */

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return parts.slice(0, 2).map(p => p[0]!.toUpperCase()).join("");
}

export function callClock(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
