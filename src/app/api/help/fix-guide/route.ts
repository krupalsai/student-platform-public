import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FIX_GUIDE_PNG_BASE64 } from "@/lib/fix-guide-image";

/**
 * Serves the "Stuck? Fix it in 2 minutes" guide photo as a real PNG at
 * /api/help/fix-guide — the stable public URL the in-app Support page and
 * the WhatsApp bot both use.
 *
 * Why a route instead of public/help/student-fix-guide.png: binary files
 * cannot be pushed to this repo with the tooling available (the stored
 * GitHub token is rejected 401 and the MCP push path is UTF-8 text only),
 * so the photo's bytes live as base64 in src/lib/fix-guide-image.ts. If a
 * real public/help/student-fix-guide.png is ever pushed directly, this
 * route serves that file instead and nothing else needs to change.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const png = await readFile(
      join(process.cwd(), "public", "help", "student-fix-guide.png"),
    );
    return new NextResponse(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    // No direct PNG in the repo yet — serve the embedded copy.
  }
  try {
    const png = Buffer.from(FIX_GUIDE_PNG_BASE64, "base64");
    return new NextResponse(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (e) {
    console.error("[help/fix-guide] could not serve guide photo", e);
    return new NextResponse("Guide photo unavailable", { status: 404 });
  }
}
