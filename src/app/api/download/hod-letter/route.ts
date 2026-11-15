import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/download/hod-letter
 *
 * Serves the HOD letter template image with a forced
 * Content-Disposition: attachment header. When a real <a href> or
 * window.location navigation hits this URL, the browser's download
 * manager saves the file directly — no share sheet, no "Open in/Copy
 * Link" menu, because the server tells it explicitly to download,
 * not render.
 *
 * This works around the Android WebView blob: URL limitation because
 * this is a real HTTP(S) URL from our own origin — WebView download
 * managers CAN handle real URLs with attachment headers.
 */
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const imageRes = await fetch(`${origin}/route-map/hod-letter-example.jpg`);

  if (!imageRes.ok) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const buffer = await imageRes.arrayBuffer();

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Disposition": 'attachment; filename="HOD-letter-template.jpg"',
      "Cache-Control": "no-store",
    },
  });
}
