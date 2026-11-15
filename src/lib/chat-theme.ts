/**
 * Shared visual language for both chat surfaces (/discussion and
 * /admin/group-chat/[batchId]).
 *
 * Item #89 gave the chat WhatsApp's *structure* — day dividers, sender
 * grouping, an auto-growing composer, status ticks — but it still read as
 * "plain" next to the real thing, because the things that actually make a
 * chat LOOK like a chat were missing: a patterned wallpaper behind the
 * messages, bubble tails, and shadow-instead-of-border on the bubbles.
 *
 * Deliberately NOT WhatsApp's own green or its doodle artwork: the palette
 * stays this app's blue (item #78) and the pattern below is drawn here, so
 * this reads as a familiar chat surface without lifting someone else's
 * brand or assets.
 */

const ACCENT = "#1d4ed8";

/**
 * The wallpaper. A tiled SVG of faint dots, rings and strokes over a soft
 * blue-grey ground — busy enough to read as "wallpaper" at a glance, faint
 * enough (4-6% alpha) that message text never fights it. Inlined as a data
 * URI so it costs no extra request and can never 404 behind a bubble.
 */
const PATTERN = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="112" height="112" viewBox="0 0 112 112">
    <g fill="none" stroke="#1d4ed8" stroke-opacity="0.06" stroke-width="1.6" stroke-linecap="round">
      <circle cx="18" cy="20" r="7"/>
      <path d="M44 14h16M44 20h10"/>
      <circle cx="88" cy="26" r="4.5"/>
      <path d="M74 52c4-5 11-5 15 0"/>
      <circle cx="30" cy="60" r="4"/>
      <path d="M52 66h14M52 72h8"/>
      <circle cx="96" cy="82" r="6.5"/>
      <path d="M14 90c5-6 13-6 18 0"/>
      <path d="M60 96h12"/>
    </g>
    <g fill="#1d4ed8" fill-opacity="0.05">
      <circle cx="62" cy="36" r="2.4"/>
      <circle cx="10" cy="46" r="2"/>
      <circle cx="42" cy="88" r="2.2"/>
      <circle cx="86" cy="62" r="2"/>
    </g>
  </svg>`.replace(/\s+/g, " "),
);

/** Drop straight onto the scrolling message area's `style`. */
export const CHAT_SURFACE: React.CSSProperties = {
  backgroundColor: "#eceff4",
  backgroundImage: `url("data:image/svg+xml,${PATTERN}")`,
  backgroundRepeat: "repeat",
  backgroundSize: "112px 112px",
};

/** Bubble fills — an incoming bubble carries no border, only a shadow, exactly so its tail can be a clean triangle. */
export const BUBBLE = {
  mine: ACCENT,
  theirs: "#ffffff",
  shadow: "0 1px 1.5px rgba(15,23,42,0.16)",
} as const;

/**
 * Per-sender name colours for incoming messages, the way a group chat
 * distinguishes people at a glance. Picked deterministically from the sender
 * id so one person keeps the same colour for everyone, across reloads.
 * Every entry is checked for contrast on the white incoming bubble.
 */
const NAME_COLORS = [
  "#b45309", "#0f766e", "#a21caf", "#1d4ed8",
  "#b91c1c", "#4d7c0f", "#7c3aed", "#0e7490",
];

export function senderColor(senderId: string): string {
  let h = 0;
  for (let i = 0; i < senderId.length; i++) h = (h * 31 + senderId.charCodeAt(i)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
}
