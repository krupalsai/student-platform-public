"use client";

/**
 * The install gate is GONE (14 Nov 2026, Krupal: simple flow).
 *
 * The app works in the browser — registration, login and every app screen.
 * A student who taps the bot's link lands straight in the app in whatever
 * browser opened it. Install is optional and offered by the browser itself
 * (Chrome's Install banner/menu), never forced by a page here.
 *
 * This component stays as a no-op so layout.tsx and every other importer
 * keep working unchanged. It was a client-side product rule, not access
 * control — the APIs still authorise every request on their own, so
 * removing the redirect changes no access control.
 */
export default function StudentAppOnlyGate() {
  return null;
}
