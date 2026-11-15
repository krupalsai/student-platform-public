import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  APP_ICON_192_PNG_BASE64,
  APP_ICON_512_PNG_BASE64,
  APP_ICON_512_MASKABLE_PNG_BASE64,
  APP_ICON_180_PNG_BASE64,
} from "@/lib/app-icons";

/**
 * Serves the true app icons as real PNGs at /api/app-icon?size=192|512|maskable|180.
 *
 * Why a route instead of public/icon-192.png: binary files cannot be
 * pushed to this repo with the tooling available (the MCP push path is
 * UTF-8 text only), so the PNG bytes live as base64 in src/lib/app-icons.ts
 * — the same pattern as /api/help/fix-guide. If real public/icon-*.png
 * files are ever pushed directly, this route serves those instead.
 *
 * The manifest points here (not at the old Supabase file, which was a
 * 1080x1173 JPEG declared as a 192/512 PNG — the exact mismatch that made
 * Chrome hide "Install app" on Android). Chrome fetches these URLs and
 * checks the real bytes: true PNG, exact square size, matching type.
 */
export const dynamic = "force-dynamic";

const ICONS: Record<string, { file: string; base64: string }> = {
  "192": { file: "icon-192.png", base64: APP_ICON_192_PNG_BASE64 },
  "512": { file: "icon-512.png", base64: APP_ICON_512_PNG_BASE64 },
  maskable: { file: "icon-512-maskable.png", base64: APP_ICON_512_MASKABLE_PNG_BASE64 },
  "180": { file: "icon-180.png", base64: APP_ICON_180_PNG_BASE64 },
};

export async function GET(req: NextRequest) {
  const size = new URL(req.url).searchParams.get("size") ?? "512";
  const icon = ICONS[size];
  if (!icon) return new NextResponse("Unknown icon size", { status: 404 });
  const headers = {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=86400",
  };
  try {
    const png = await readFile(join(process.cwd(), "public", icon.file));
    return new NextResponse(new Uint8Array(png), { headers });
  } catch {
    // No direct PNG in the repo yet — serve the embedded copy.
  }
  try {
    const png = Buffer.from(icon.base64, "base64");
    return new NextResponse(new Uint8Array(png), { headers });
  } catch (e) {
    console.error("[app-icon] could not serve icon", e);
    return new NextResponse("Icon unavailable", { status: 404 });
  }
}
