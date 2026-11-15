import { NextResponse } from "next/server";

// The icons are the true square PNGs served by /api/app-icon (see
// src/lib/app-icons.ts). They used to come from the pwa_student_icon_url
// app setting, which pointed at a Supabase file declared image/png
// 192x192 and 512x512 but actually a 1080x1173 JPEG photo — Chrome checks
// the real bytes, so the app was NOT installable and "Install app" never
// appeared in Chrome's menu on Android. The setting is no longer read
// here: until the admin icon upload validates square PNGs, the manifest
// must serve icons that are known-good. Keep this route dynamic (not
// prerendered) so icon fixes apply without a rebuild.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const icons = [
      { src: "/api/app-icon?size=192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/api/app-icon?size=512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/api/app-icon?size=maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ];
    const manifest = {
      name: "Student Platform",
      short_name: "Student App",
      description: "Student Platform app",
      // /install is only the public installation handoff. It must NEVER be the
      // installed app's launch URL: Android opens start_url every time the icon
      // is tapped, which would otherwise show the install screen before every
      // dashboard visit. The normal app root already resolves the saved session
      // and any genuine pending registration handoff.
      //
      // The "?app=1" marks an installed-app launch so the root page can paint
      // its neutral loading cover from the first server byte instead of the
      // marketing site — on a slow phone the marketing page flashing inside
      // the app before the redirect commits is the cold-start blink. The
      // query changes nothing else: pathname stays "/", and the redirect
      // drops it on the first navigation.
      // STABLE IDENTITY — do not remove or change. Without an explicit id,
      // Chrome uses start_url as the app's identity. The 27 Oct 2026 blinking
      // fix changed start_url from "/" to "/?app=1", which silently changed
      // the identity: Chrome treated the manifest as a brand-new app, the
      // already-installed app was orphaned, and studentplatform.dev links
      // (including the WhatsApp sign-in links the bot used to send) started
      // opening in Chrome instead of the installed app. id "/" is the
      // identity the app was installed under before that change, so this
      // restores it — and any future start_url change can no longer break
      // link handling again.
      id: "/",
      start_url: "/?app=1",
      scope: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#111827",
      icons,
    };
    return NextResponse.json(manifest, { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=60, s-maxage=60, stale-while-revalidate=300" } });
  } catch (err) { console.error("[manifest route]", err); return NextResponse.json({}, { status: 500 }); }
}
