/**
 * Short in-app sounds for the Student App — no audio file, Web Audio draws the
 * tone (same approach as useRingtone, which only covers incoming calls).
 *
 * What this is for: a message or reply that arrives while the app is OPEN on
 * screen (Batch Discussion, Support). When the app is closed the phone's own
 * notification makes the sound, and this stays silent: it never plays while the
 * page is hidden, so one message never sounds twice.
 *
 * Guard rails, because a student can be sitting in a lecture:
 *  - a switch in Profile turns it off for good (kept on this device);
 *  - quiet (a soft two-note "pop"), never more than one per 1.2 seconds, so a
 *    burst of messages makes one sound;
 *  - browsers only allow sound after the person has touched the page once, so
 *    the first tap wakes the audio engine; before that nothing plays.
 */

const KEY = "sp_sound"; // "off" when the student switched sounds off; absent = on
const MIN_GAP_MS = 1200;
/** A sound that could only start long after it was asked for would be a surprise — drop it. */
const MAX_START_DELAY_MS = 1500;
const UNLOCK_EVENTS = ["pointerdown", "touchend", "keydown", "click"] as const;

let ctx: AudioContext | null = null;
let lastPlayedAt = 0;
let unlockInstalled = false;

function store(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null; // blocked storage (private mode, site data off)
  }
}

/** Sounds are ON unless the student turned them off on this device. */
export function soundEnabled(): boolean {
  try {
    return store()?.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSoundEnabled(on: boolean): void {
  try {
    const s = store();
    if (!s) return;
    if (on) s.removeItem(KEY);
    else s.setItem(KEY, "off");
  } catch {
    /* storage unavailable: the switch simply won't be remembered */
  }
}

function audioContextClass(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const w = window as typeof window & { webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function getContext(): AudioContext | null {
  if (ctx && ctx.state !== "closed") return ctx;
  const Ctor = audioContextClass();
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** One soft sine note with a quick attack and a smooth fade (no click at either end). */
function note(c: AudioContext, frequency: number, start: number, length: number, peak: number) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.value = frequency; // set up front, so the note is in tune from its very first sample
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(start);
  osc.stop(start + length + 0.02);
}

/**
 * Wake the audio engine on the first touch. iOS only allows it from inside a
 * touch handler; Chrome allows it once the page has been touched. Safe to call
 * from several screens — it installs once and removes itself after the first
 * touch. If sounds are off it leaves the engine alone.
 */
export function installAudioUnlock(): void {
  if (unlockInstalled || typeof window === "undefined") return;
  unlockInstalled = true;
  const unlock = () => {
    if (soundEnabled()) {
      const c = getContext();
      if (c && c.state === "suspended") void c.resume().catch(() => {});
    }
    for (const e of UNLOCK_EVENTS) window.removeEventListener(e, unlock, true);
    unlockInstalled = false; // a later screen may install it again if the engine fell asleep
  };
  for (const e of UNLOCK_EVENTS) window.addEventListener(e, unlock, true);
}

/**
 * Play the "new message" sound. Returns true when a sound was started (or is
 * about to), false when it deliberately stayed silent.
 *
 * `test` is for the "Play a test" button: same sound, but not held back by the
 * 1.2 second gap (the switch and the visible-page rules still apply).
 */
export function playChime(opts: { test?: boolean } = {}): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (!soundEnabled()) return false;
  // Hidden page = the phone's own notification covers it; never both.
  if (document.visibilityState !== "visible") return false;
  const now = Date.now();
  if (!opts.test && now - lastPlayedAt < MIN_GAP_MS) return false;
  const c = getContext();
  if (!c) return false;
  lastPlayedAt = now;

  const play = () => {
    const t = c.currentTime + 0.01;
    note(c, 784, t, 0.14, 0.14); //  G5
    note(c, 1047, t + 0.11, 0.24, 0.14); // C6
  };
  try {
    if (c.state === "suspended") {
      // Not touched yet (or the phone put the engine to sleep): ask once, play
      // only if it wakes up right away.
      void c.resume().then(() => { if (Date.now() - now < MAX_START_DELAY_MS) play(); }).catch(() => {});
    } else {
      play();
    }
  } catch {
    return false;
  }
  return true;
}
