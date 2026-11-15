/**
 * "Stuck? Fix it in 2 minutes" — the guide photo + per-problem fixes.
 *
 * The photo lives in the repo as base64 (see src/lib/fix-guide-image.ts —
 * binary files cannot be pushed with this repo's current tooling, so the
 * bytes travel as text) and is served as a real PNG at /api/help/fix-guide.
 * Meta fetches that URL itself for WhatsApp image messages, so it must stay
 * public and stable.
 *
 * Quota note: every photo send is one WhatsApp service message against the
 * 1,000/month free tier. The photo goes out ONLY when a student explicitly
 * asks for help, picks a fix option, or reports one of the three problems
 * below — never unprompted, and never in a loop (bot replies do not
 * re-enter the router).
 */

import {
  sendWhatsAppImage,
  sendWhatsAppList,
  type WaMenuRow,
} from "@/lib/whatsapp/client";

/** Public URL of the guide photo, as served by /api/help/fix-guide. */
export const FIX_GUIDE_IMAGE_URL =
  (process.env.NEXT_PUBLIC_APP_URL ?? "https://studentplatform.dev").replace(
    /\/$/,
    "",
  ) + "/api/help/fix-guide";

export type FixKey = "otp" | "not_registered" | "clear_data";

export interface FixOption {
  /** Row id used by the WhatsApp list and by handleMenuSelection. */
  id: `fix_${FixKey}`;
  key: FixKey;
  /** Row title (also what the student can type — the matcher understands it). */
  title: string;
  description: string;
  /** Short steps sent as the photo caption for this one problem. */
  steps: string;
}

export const FIX_OPTIONS: FixOption[] = [
  {
    id: "fix_otp",
    key: "otp",
    title: "OTP not coming",
    description: "Get your code on WhatsApp",
    steps:
      "OTP code not coming:\n" +
      "1. Message VERIFY to this bot.\n" +
      "2. I'll reply with a 6-digit login code.\n" +
      "3. Type that code in the Student App to sign in.",
  },
  {
    id: "fix_not_registered",
    key: "not_registered",
    title: "Not registered",
    description: "Register on WhatsApp",
    steps:
      "“Number not registered”:\n" +
      "1. On the login page tap “Register on WhatsApp”.\n" +
      "2. Reply “Register” here.\n" +
      "3. I'll give you your registration link.",
  },
  {
    id: "fix_clear_data",
    key: "clear_data",
    title: "Clear site data",
    description: "Delete data, log in again",
    steps:
      "Still stuck? Clear site data:\n" +
      "1. Long-press the Student App icon.\n" +
      "2. Tap “Site settings”.\n" +
      "3. Tap “Delete data and reset permissions”.\n" +
      "4. Open the app, log in again, allow notifications.",
  },
];

const FIX_BY_KEY: Record<FixKey, FixOption> = {
  otp: FIX_OPTIONS[0],
  not_registered: FIX_OPTIONS[1],
  clear_data: FIX_OPTIONS[2],
};

/**
 * Which of the three guide problems a student's message is reporting, or null.
 * Checked before the AI brain in the WhatsApp "genuine" flow and at the top
 * of handleFreeTextQuestion (the AI-down fallback), so a problem report gets
 * the photo even when every AI provider is down.
 *
 * Deliberately narrow: "I want to register" is a registration request, not a
 * problem (only "not registered" matches), and anything about a fee/payment
 * stays with the payment flow even if it says "stuck".
 */
export function matchFixProblem(raw: string): FixKey | null {
  const lower = raw.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
  if (!lower) return null;
  if (
    lower.includes("not registered") ||
    lower.includes("not register") ||
    lower.includes("number is not registered") ||
    lower.includes("mobile number is not registered")
  ) {
    return "not_registered";
  }
  if (
    lower.includes("clear site data") ||
    lower.includes("clear data") ||
    lower.includes("delete data") ||
    lower.includes("site settings") ||
    lower.includes("reset permission")
  ) {
    return "clear_data";
  }
  if (
    /\botp\b/.test(lower) ||
    lower.includes("otp not") ||
    lower.includes("otp didn't") ||
    lower.includes("otp didnt") ||
    lower.includes("no otp") ||
    lower.includes("code not coming") ||
    lower.includes("code didn't") ||
    lower.includes("code didnt") ||
    lower.includes("code not received") ||
    lower.includes("not getting code") ||
    lower.includes("not received code") ||
    lower.includes("verification code")
  ) {
    return "otp";
  }
  // A fee/payment problem is not an app problem, even if the student says "stuck".
  if (/\b(fee|fees|payment|paid|pay|amount|refund|upi|transaction)\b/.test(lower)) {
    return null;
  }
  return null;
}

/**
 * "App not working" / "app not opening" — the generic report that used to
 * match NOTHING here and fell through to the AI brain (down since Oct) and
 * then to "ask inside the Student App", the very app that wasn't working.
 * That dead end is why students walked up to Krupal in person instead.
 *
 * Covers English + Telugu/Tanglish, the way students actually write it.
 * Checked AFTER matchFixProblem (OTP / not-registered / clear-data keep
 * their exact fixes) and NEVER for fee/payment reports — a payment problem
 * stays with the payment flow even when the student says "not working".
 */
export function matchAppProblem(raw: string): boolean {
  const lower = raw.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
  if (!lower) return false;
  // A fee/payment problem is not an app problem, even if it says "not working".
  if (/\b(fee|fees|payment|paid|pay|amount|refund|upi|transaction)\b/.test(lower)) {
    return false;
  }
  // OTP/code reports already have their own fix above; don't steal them.
  if (/\botp\b/.test(lower) || lower.includes("code not") || lower.includes("code didn't") || lower.includes("code didnt")) {
    return false;
  }
  return (
    lower.includes("app not working") ||
    lower.includes("app is not working") ||
    lower.includes("app not opening") ||
    lower.includes("app is not opening") ||
    lower.includes("app not open") ||
    lower.includes("app doesn't open") ||
    lower.includes("app doesnt open") ||
    lower.includes("app won't open") ||
    lower.includes("app wont open") ||
    lower.includes("app not loading") ||
    lower.includes("app is not loading") ||
    lower.includes("app not load") ||
    lower.includes("app loading") ||
    lower.includes("app stuck") ||
    lower.includes("app is stuck") ||
    lower.includes("app hangs") ||
    lower.includes("app hang") ||
    lower.includes("app crash") ||
    lower.includes("app crashing") ||
    lower.includes("app keeps closing") ||
    lower.includes("app closes") ||
    lower.includes("app blank") ||
    lower.includes("blank screen") ||
    lower.includes("white screen") ||
    lower.includes("black screen") ||
    lower.includes("not opening") ||
    lower.includes("not working") ||
    lower.includes("not loading") ||
    lower.includes("open avvatledu") ||
    lower.includes("open avvatledhu") ||
    lower.includes("open kavatledu") ||
    lower.includes("open kavatledhu") ||
    lower.includes("open avvadam ledhu") ||
    lower.includes("open avvatla") ||
    lower.includes("work avvatledu") ||
    lower.includes("work avvatledhu") ||
    lower.includes("work avvatla") ||
    lower.includes("pani cheyatledu") ||
    lower.includes("pani cheyadam ledhu") ||
    lower.includes("app sarigga ledu") ||
    lower.includes("app ravatledu") ||
    // The side menu / settings never appearing (the Vivo stuck-launch
    // report, 14 Nov 2026): the app opens to a dead screen, so the menu
    // is the symptom the student names, not a separate problem.
    lower.includes("menu not showing") ||
    lower.includes("menu not coming") ||
    lower.includes("menu not visible") ||
    lower.includes("menu not opening") ||
    lower.includes("menu button") ||
    lower.includes("side menu") ||
    lower.includes("no menu") ||
    lower.includes("settings not showing") ||
    lower.includes("settings not opening") ||
    lower.includes("options not showing") ||
    lower.includes("menu ravatledu") ||
    lower.includes("menu kanipinchadam ledhu") ||
    // A Vivo report: bare "vivo" alone is not a problem (a model name),
    // but Vivo + app/open/work/menu means the stuck-launch case.
    (lower.includes("vivo") &&
      (lower.includes("app") || lower.includes("open") || lower.includes("work") || lower.includes("menu")))
  );
}

/** Sends the full guide photo (default caption points at the fix options). */
export async function sendFixGuidePhoto(to: string): Promise<boolean> {
  return sendWhatsAppImage(
    to,
    FIX_GUIDE_IMAGE_URL,
    "Stuck? This photo fixes the 3 most common problems — pick yours below and I'll send just that fix.",
  );
}

/** The prefilled question options shown on "help" — one row per guide problem. */
export async function sendFixOptions(to: string): Promise<boolean> {
  const rows: WaMenuRow[] = FIX_OPTIONS.map((o) => ({
    id: o.id,
    title: o.title,
    description: o.description,
  }));
  return sendWhatsAppList(
    to,
    "What is the problem? Choose one and I'll send the fix:",
    "Fix a problem",
    rows,
  );
}

/** Sends the guide photo with just this problem's short steps as its caption. */
export async function sendFixFor(to: string, key: FixKey): Promise<boolean> {
  return sendWhatsAppImage(to, FIX_GUIDE_IMAGE_URL, FIX_BY_KEY[key].steps);
}
