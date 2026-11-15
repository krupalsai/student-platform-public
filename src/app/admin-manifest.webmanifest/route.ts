import { NextResponse } from "next/server";

// Icons are the true square PNGs served by /api/app-icon (see
// src/lib/app-icons.ts) — the same fix as the student manifest: the shared
// pwa_student_icon_url setting pointed at a 1080x1173 JPEG declared as a
// 192/512 PNG, which made the app not installable in Chrome. One icon
// control in Settings serves both apps, so both manifests share these.
export const dynamic = "force-dynamic";

// public/admin-manifest.webmanifest used to be a static file, hardcoded to
// the generic /pwa-icon.svg — Save Icon in Settings updated app_settings
// and the storage object, but nothing ever read either back into the
// installed Admin app's manifest, so a freshly installed Admin app icon
// never matched what was uploaded, no matter how many times it was
// re-uploaded or the app reinstalled. Mirrors /manifest.webmanifest's
// route, reusing the same pwa_student_icon_url setting — there is only one
// icon-upload control in Settings, so both apps share it.
export async function GET() {
  try {
    const icons = [
      { src: "/api/app-icon?size=192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/api/app-icon?size=512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/api/app-icon?size=maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ];
    const manifest = {
      name: "Student Platform Admin",
      short_name: "Admin",
      description: "Student Platform administration dashboard",
      // STABLE IDENTITY — do not remove or change. Without an explicit id,
      // Chrome uses start_url as the app's identity, so any future start_url
      // change would silently orphan the installed Admin app and its links
      // would start opening in Chrome instead (the exact bug the main
      // manifest hit on 27 Oct 2026). id "/admin" pins the identity the
      // app was installed under.
      id: "/admin",
      start_url: "/admin",
      scope: "/admin",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#111827",
      icons,
    };
    return NextResponse.json(manifest, { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=60, s-maxage=60, stale-while-revalidate=300" } });
  } catch (err) { console.error("[admin manifest route]", err); return NextResponse.json({}, { status: 500 }); }
}
