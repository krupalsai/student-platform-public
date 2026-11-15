/**
 * Registration route layout (14 Nov 2026, simple flow): just the page.
 *
 * This used to wrap the form in a two-column grid with an "Install Student
 * App" sidebar (desktop) and an install card (mobile). That is gone — the
 * bot's link opens the app in the browser, and no install button sits in
 * the registration flow. Install is offered by the browser itself.
 */
export default function RegisterLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
