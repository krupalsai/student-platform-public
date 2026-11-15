import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { uploadToCloudinary } from "@/lib/storage";
import { describeImage } from "@/lib/image-understanding";
import { ok, forbidden, serverError, badRequest } from "@/lib/api-response";
import { ALLOWED_IMAGE_MIME, IMAGE_TYPE_ERROR } from "@/lib/image-types";

/**
 * Lets the in-app "Ask a Question" flow (FAQModal, mounted on /support and
 * /register) and the Contact Support chat (/support/page.tsx) attach a
 * photo the same way the WhatsApp bot now does (item #191) — describes
 * what's in it via the shared `describeImage()`. This route does no FAQ/
 * escalation logic itself; it is purely "upload a photo, get back the
 * hosted URL (so the caller can actually DISPLAY the photo, not just
 * describe it) plus a description."
 */

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB, matching every other image upload route
const ALLOWED = ALLOWED_IMAGE_MIME as readonly string[];

// A vision call can take several seconds; give this route the same
// headroom the other upload routes already carry rather than risking
// Vercel's 10s default cutting it off mid-analysis on a slow connection.
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const { error } = await requireSession(req);
  if (error) return forbidden();

  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;

    if (!file) return badRequest("No file provided");
    if (!ALLOWED.includes(file.type)) return badRequest(IMAGE_TYPE_ERROR);
    if (file.size > MAX_SIZE) return badRequest("File too large — max 10 MB");

    const buffer = Buffer.from(await file.arrayBuffer());
    const { url } = await uploadToCloudinary("chat", buffer, `support_ask_${Date.now()}`, file.type);

    const analysis = await describeImage(url);
    // Fails soft: no analysis is a real, expected outcome (quota exhausted,
    // provider down — see TODO #19), not a request failure. The client
    // still knows the upload itself succeeded (real `url` either way) and
    // can proceed without the description rather than being blocked.
    return ok({ url, description: analysis?.description ?? null, category: analysis?.category ?? null });
  } catch (e) {
    console.error("[api/support/image-describe] failed:", (e as Error).message);
    return serverError("Could not process that photo. Please try again.");
  }
}
