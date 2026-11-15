import { NextRequest, NextResponse } from "next/server";

// Lives in src/ on purpose: with a src/ app directory Next.js only runs
// middleware from src/middleware.ts. A root-level copy existed for months and
// never ran, so none of these headers ever reached production.

// ── CORS allow-list (security fix #5) ──────────────────────────────────────
// Only our two domains may read cross-origin responses. The Capacitor app
// wraps the live Vercel URL itself, so it is same-origin and unaffected.
const ALLOWED_ORIGINS = [
  "https://studentplatform.dev",
  "https://student-platform-gray.vercel.app",
];

// ── Canonical domain (9 Nov 2026 fix) ──────────────────────────────────────
// The only payment-registered domain is https://studentplatform.dev.
// student-platform-gray.vercel.app still serves the same production build,
// and any PWA/app installed from it (or any old gray link) runs every page
// — including every payment page — on gray. Razorpay's website allow-list
// then blocks checkout ("Payment blocked as website does not match
// registered website(s)"), and retrying with another UPI app cannot help:
// the block is on the page's domain, not the payment method. So page
// navigations on gray are 308-redirected to the same path on
// studentplatform.dev, via /handoff (which carries a signed-in user's
// session across — see the middleware redirect below). API routes are NOT
// redirected (webhooks and the app's own API calls keep working on either
// origin), nor are the service worker / manifest / static files (a
// redirected sw.js would break the installed PWA's worker update), nor
// POSTs (Server Actions post to the page URL and must stay same-origin).
const CANONICAL_HOST = "studentplatform.dev";
const GRAY_HOST = "student-platform-gray.vercel.app";

function isRedirectablePageNavigation(req: NextRequest): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const p = req.nextUrl.pathname;
  if (p.startsWith("/api/")) return false;
  if (p === "/sw.js" || p === "/manifest.webmanifest" || p === "/manifest.json") return false;
  if (p === "/handoff" || p.startsWith("/handoff/")) return false; // the handoff page itself must load on gray
  if (/\.[a-z0-9]+$/i.test(p)) return false; // static file assets
  return true;
}

// ── Server-side page guard (security fix #2) ───────────────────────────────
// Pages that need a signed-in session before the shell is served.
// /admin/login is the sign-in page itself, so it stays public. API routes
// are NOT redirected here — they return their own 401/403 JSON.
const PROTECTED_PAGE_PREFIXES = ["/admin", "/dashboard"];

function isProtectedPage(pathname: string): boolean {
  if (pathname === "/admin/login" || pathname.startsWith("/admin/login/")) return false;
  return PROTECTED_PAGE_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname;

  // ── Canonical domain: never serve a page from gray ─────────────────────
  // Runs before the admin guard so a gray /admin link lands on .dev /admin
  // (where the guard then applies) instead of redirecting to gray /login.
  // The redirect goes through /handoff on gray first (9 Nov 2026): a
  // signed-in user's session lives in gray's localStorage/cookie, which do
  // NOT transfer to the canonical domain (both are per-origin), so a bare
  // redirect lands the user signed out ("session expired"). /handoff mints
  // a one-time, 5-minute token for the current session and sends the
  // browser to the canonical domain with it; the canonical side redeems
  // it, sets the session cookie + localStorage token, and lands the user
  // on the page they asked for, still signed in. An unsigned-in visitor
  // gets no token and goes straight to the canonical URL.
  if (req.nextUrl.hostname === GRAY_HOST && isRedirectablePageNavigation(req)) {
    const url = req.nextUrl.clone();
    const next = req.nextUrl.pathname + req.nextUrl.search;
    url.pathname = "/handoff";
    url.search = `?next=${encodeURIComponent(next)}`;
    // 307 (temporary), not 308: the handoff is a mechanism, not a permanent
    // move, and a cached 308 would keep sending the browser straight to
    // the canonical URL and skip the handoff entirely.
    return NextResponse.redirect(url, 307);
  }

  // The admin guard used to be client-side only (AdminRoleGuard reads
  // localStorage), so an unauthenticated visitor still got the /admin and
  // /dashboard shells served. Now a request for those pages without the
  // session cookie is sent to /login on the server. This checks only that
  // a session cookie EXISTS — the role is still enforced by the APIs and
  // by AdminRoleGuard, because verifying the role needs a database lookup
  // that Edge middleware cannot do. A stale or expired cookie still lands
  // back on /login once the API says no.
  if (isProtectedPage(pathname) && !req.cookies.get("sp_session")?.value) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  const res = NextResponse.next();

  // ── CORS (security fix #5) ───────────────────────────────────────────────
  // The homepage used to answer with Access-Control-Allow-Origin: *.
  // A request from any other origin now gets NO Access-Control-Allow-Origin
  // header, so the browser blocks the cross-origin read. Preflight is
  // answered only for allow-listed origins.
  const origin = req.headers.get("origin");
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Vary", "Origin");
    if (req.method === "OPTIONS" && pathname.startsWith("/api/")) {
      res.headers.set(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      );
      res.headers.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Session-Token",
      );
      res.headers.set("Access-Control-Allow-Credentials", "true");
      res.headers.set("Access-Control-Max-Age", "86400");
      return new NextResponse(null, { status: 204, headers: res.headers });
    }
  }

  // ── Content-Security-Policy (security fix #5) ────────────────────────────
  // Was frame-ancestors only, so an injected script was not blocked by CSP.
  // Next.js itself emits inline scripts/styles (RSC payload, <style> tags),
  // so script-src/style-src keep 'unsafe-inline' — without it the app
  // would not hydrate. The two payment SDKs load their own scripts, so
  // they are allow-listed by host — removing them would break checkout.
  // frame-src uses wildcards on purpose (31-Oct-2026 fix): Razorpay's
  // checkout.js opens its payment window as an iframe on
  // https://api.razorpay.com/v1/checkout/public — NOT checkout.razorpay.com
  // (verified inside their checkout.js: the frame URL is built from the
  // api host). Allow-listing only checkout.razorpay.com made Chrome block
  // the payment window with "This content is blocked", so every student
  // payment failed at the checkout step. Same wildcard for Cashfree so a
  // host move there can never silently break checkout the same way.
  // X-Frame-Options is deliberately NOT set: it would override the
  // frame-ancestors allowance for Telegram's web client below.
  res.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com https://sdk.cashfree.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https: wss:",
      "frame-src 'self' https://*.razorpay.com https://*.cashfree.com",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
    ].join("; "),
  );
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
  // Prevent HTTP caching of page documents: Telegram's WebView and installed
  // PWAs can otherwise serve a stale JS bundle (stale auth/redirect logic)
  // after a deploy. API routes set their own caching (e.g. the CDN-cached
  // college directory), so they are left alone.
  if (!req.nextUrl.pathname.startsWith("/api/")) {
    res.headers.set("Cache-Control", "no-store, must-revalidate");
  }
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
