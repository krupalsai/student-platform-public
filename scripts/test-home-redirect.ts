/**
 * Pins the routing rule that decides where an app open lands.
 *
 * Live-reported: students who had completed registration were sent to the
 * registration page EVERY time they opened the app. Two bugs compounded:
 *
 *   1. sp_pending_registration_token is written once at install and was
 *      cleared in exactly one place — the "not your link" escape button — so
 *      after a student finished registering it stayed in localStorage forever.
 *   2. HomeRedirect honoured that token BEFORE checking the session, returning
 *      early, so the session never got a say. And /register skips its own
 *      "already registered?" check whenever a ?token= is present — which is
 *      exactly how HomeRedirect sends people — so nothing downstream caught it
 *      either.
 *
 * The ordering is the whole fix: the hand-off can only be resolved after the
 * session check, because that is the only thing that knows whether the
 * registration is done. An assertion on ordering is precisely what a later
 * "simplify this effect" refactor would otherwise silently undo.
 *
 *   node --experimental-strip-types scripts/test-home-redirect.ts
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

const home = readFileSync("src/components/HomeRedirect.tsx", "utf8");
const register = readFileSync("src/app/register/page.tsx", "utf8");
const install = readFileSync("src/components/pwa/InstallStudentAppBody.tsx", "utf8");
const manifest = readFileSync("src/app/manifest.webmanifest/route.ts", "utf8");

let passed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
}

// ── The pending hand-off must not short-circuit ahead of the session ──────
const sessionFetch = home.indexOf('fetch("/api/auth/session"');
const firstPendingRead = home.indexOf('localStorage.getItem("sp_pending_registration_token")');

ok("the session is still checked", sessionFetch > 0);
ok("the pending hand-off is still honoured somewhere", firstPendingRead > 0);
ok(
  "no pending-token redirect runs before the session check",
  firstPendingRead > sessionFetch,
  `first pending read at ${firstPendingRead}, session fetch at ${sessionFetch} — ` +
  "reading it earlier means returning before the session can say registration is done",
);

// ── A complete profile clears the hand-off and routes normally ────────────
ok(
  "a complete profile clears the stale hand-off",
  /is_profile_complete[\s\S]{0,200}?removeItem\("sp_pending_registration_token"\)/.test(home),
  "without this, students already carrying a stale token stay stuck forever — " +
  "nothing on their device would ever clear it",
);
ok(
  "a complete profile routes via decideDestination, not /register",
  /is_profile_complete\)\s*\{[\s\S]{0,300}?decideDestination/.test(home),
);

// ── An INCOMPLETE profile must still honour the hand-off ──────────────────
// This is the case the original ordering existed for: a student mid-
// registration opening a fresh college link. Fixing the completed case must
// not take that away.
ok(
  "an incomplete profile still goes to /register with the token",
  /if \(pendingRegistrationToken\)[\s\S]{0,200}?\/register\?token=/.test(home),
);

// ── The token is also cleared at the source ───────────────────────────────
ok(
  "register clears the hand-off once the profile is confirmed complete",
  /removeItem\("sp_pending_registration_token"\)/.test(register),
);

// The escape button from item #133 must keep clearing the session too, or
// "sign in instead" silently reuses whatever account was cached on the device.
ok(
  "the not-your-link escape still clears the session, not just the token",
  /removeItem\("sp_pending_registration_token"\)[\s\S]{0,200}?removeItem\("sp_token"\)/.test(register),
);

// ── /install is the entry point the INSTALLED app actually opens ──────────
// The manifest's start_url is /install, so HomeRedirect ("/") never runs on
// an app launch. Fixing the ordering only in HomeRedirect left the real
// launch path replaying registration on every open, and it could not
// self-correct: /register's mount effect (which holds the only removeItem)
// returns early whenever a ?token= is present — the exact URL /install
// builds. Token present -> check skipped -> never cleared -> token present
// again next launch.
// start_url decides WHICH page handles an app launch, and it has already been
// both "/" and "/install". Rather than pin one value, assert it is one of the
// two pages whose session-first ordering is asserted in this file — so moving
// it to a third, unguarded page fails loudly instead of silently guarding a
// page nobody opens (exactly how item #141 shipped).
const startUrl = manifest.match(/start_url:\s*"([^"]+)"/)?.[1] ?? "";
ok(
  "the app launches through a page this test guards",
  startUrl === "/" || startUrl === "/install",
  `start_url is ${JSON.stringify(startUrl)} — add that page's ordering assertions before changing it`,
);
ok("the install hand-off still checks the session", install.includes('fetch("/api/auth/session"'));

// The FIRST redirect in the standalone branch must be the no-session case.
// Any other redirect reaching router.replace before the session is consulted
// is the original bug. A bare `const destination = pendingToken ? …` followed
// by an immediate replace is exactly what regressed here.
ok(
  "the unconditional pending-token redirect is gone",
  !/const destination = pendingToken[\s\S]{0,200}?router\.replace\(destination\)/.test(install),
  "that construct redirects on the token alone, before the session can say registration is done",
);
const installSessionFetch = install.indexOf('fetch("/api/auth/session"');
// No redirect may be chosen before the session has been consulted. (This
// replaces an earlier assertion that pinned the specific `if (!sessionToken)`
// early-return shape; the resolver now always checks the session first, which
// is strictly stronger, so the property is asserted directly instead.)
const firstReplace = install.indexOf("router.replace");
ok("the install page still redirects somewhere", firstReplace > 0);
ok(
  "the session is consulted before any redirect is chosen",
  installSessionFetch > 0 && installSessionFetch < firstReplace,
  `session fetch at ${installSessionFetch}, first redirect at ${firstReplace}`,
);
ok(
  "a complete profile clears the hand-off on app launch",
  /is_profile_complete[\s\S]{0,200}?removeItem\("sp_pending_registration_token"\)/.test(install),
  "without this the token is never cleared, because /register skips its own clear whenever ?token= is set",
);
ok(
  "a complete profile routes via decideDestination, not /register",
  /is_profile_complete\)\s*\{[\s\S]{0,300}?decideDestination/.test(install),
);
ok(
  "an incomplete profile still resumes the registration hand-off",
  /router\.replace\(toPending\(\)\)/.test(install),
  "a student mid-registration must still be taken back to the form",
);
// A failed or unreachable session check must degrade to the previous
// behaviour, never leave the student on a dead screen. (Asserted as the
// property rather than a `.catch(...)` spelling, since the resolver is async
// and uses try/catch.)
ok(
  "a failed session check is treated as no session, not an error screen",
  /catch \{[\s\S]{0,120}?\}/.test(install) && /router\.replace\(toPending\(\)\)/.test(install),
);

// ── A hand-off link must not log out the person it belongs to ────────────
// WhatsApp links live in a student's chat forever. The install page used to
// delete sp_token/sp_role for ANY ?token= in the URL, so an already-
// registered student re-tapping their OWN old link was signed out and pushed
// back into registration — and since start_url is /install, every launch
// after that repeated it. Clearing is correct ONLY when the link belongs to
// someone else (items #133/#134).
ok(
  "the session is not cleared unconditionally on a hand-off token",
  !/if \(token\) \{[\s\S]{0,300}?removeItem\("sp_token"\)/.test(install),
  "clearing before knowing whose link it is signs out the link's own owner",
);
ok(
  "the install page resolves who the link belongs to",
  install.includes("/api/registration-tokens/validate"),
);
ok(
  "the session is cleared only when the link is someone else's",
  /profile_id !== tokenProfileId[\s\S]{0,200}?removeItem\("sp_token"\)/.test(install),
  "a different owner is still a new identity context and must clear the session",
);
ok(
  "an already-registered link owner with no session is sent to sign in",
  /tokenComplete[\s\S]{0,200}?router\.replace\("\/login"\)/.test(install),
  "showing the registration form to someone already registered is the reported bug",
);
ok(
  "the token endpoint reports whether its owner already registered",
  readFileSync("src/app/api/registration-tokens/validate/route.ts", "utf8").includes("is_profile_complete: profileComplete"),
);

// The public website at "/" must stay readable in a normal browser tab: the
// browser branch returns before ANY redirect or loading overlay. Without this
// every visitor (and payment-gateway reviewers) was bounced to /login.
const browserGuard = home.indexOf("if (!standalone) return;");
ok(
  "a normal browser tab is never redirected away from the website",
  browserGuard !== -1 && browserGuard < home.indexOf("setRedirecting(true)") && browserGuard < sessionFetch,
  "redirecting browser visitors made the public website unreadable",
);

console.log(`test-home-redirect: all ${passed} assertions passed`);
