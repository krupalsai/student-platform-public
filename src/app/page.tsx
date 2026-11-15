import MarketingHome from "@/components/MarketingHome";
import HomeRedirect from "@/components/HomeRedirect";

// This page is a Server Component so the marketing content is present in
// the initial server-rendered HTML — required for Cashfree/PhonePe merchant
// verification, SEO, and any plain-browser visitor.
//
// HomeRedirect is a client component rendered as a sibling (not a wrapper)
// so it never blocks, delays, or hides MarketingHome. It only checks, after
// mount, whether the visitor is inside the installed PWA / Telegram, or
// already has a session — and silently redirects them if so. Everyone else
// (including a signed-out student who lands on "/") just sees the marketing
// page underneath, unaffected. Explicit sign-out routes students straight to
// /login (see dashboard/profile), so this component is not relied on for
// that case — it only handles someone typing "/" manually or bookmarking it.
//
// Installed-app launches arrive as /?app=1 (manifest start_url). For those,
// the marketing page is NOT what the student should see for even one
// frame: on a slow phone the JavaScript arrives seconds after the HTML,
// and the marketing site flashing inside the app before the redirect
// commits is the cold-start blink. So an app launch paints the same
// neutral "Loading…" cover HomeRedirect shows, from the first server
// byte — identical styling, so the hand-off to the client cover is
// invisible. HomeRedirect removes this cover for a plain browser tab
// that somehow lands on the URL, and its "Show the website instead"
// escape removes it too; a navigation away unmounts it with the page.
// Reading searchParams makes this route dynamic (per-request render);
// the marketing content is unchanged and still server-rendered.
export default async function Home({ searchParams }: { searchParams?: Promise<{ app?: string }> }) {
  const isAppLaunch = (await searchParams)?.app === "1";
  if (isAppLaunch) {
    return (
      <>
        <div id="sp-launch-cover" style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", gap: 14, alignItems: "center", justifyContent: "center", background: "#f8f8fbf2", zIndex: 999 }}><p style={{ color: "#6b7280", fontSize: 14, fontWeight: 600 }}>Loading Student Platform…</p></div>
        <HomeRedirect />
      </>
    );
  }
  return (
    <>
      <MarketingHome />
      <HomeRedirect />
    </>
  );
}
