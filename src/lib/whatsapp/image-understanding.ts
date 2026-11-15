/**
 * Generic understanding for a photo/screenshot a student sends to the
 * WhatsApp bot with NO active flow expecting it (not a College ID
 * re-upload, not an admin-to-student relay — those already have their own
 * handlers and run before this one). Until now such an image was either
 * silently dropped (no caption -> just showed the main menu) or had its
 * caption processed as plain text while the image itself was ignored.
 *
 * The actual vision analysis (prompt, AI-boundaries rules, provider call)
 * lives in the transport-agnostic `src/lib/image-understanding.ts`, shared
 * with the in-app "Ask a Question" flow's `POST /api/support/image-describe`
 * — this file's only job is getting a WhatsApp media id into a public URL
 * that shared describer can read.
 */

import { downloadWhatsAppMedia } from "@/lib/whatsapp/media";
import { uploadToCloudinary } from "@/lib/storage";
import { describeImage, type ImageAnalysis } from "@/lib/image-understanding";

export type { ImageAnalysis, ImageCategory } from "@/lib/image-understanding";

/**
 * Downloads the WhatsApp image, runs it through the shared vision describer,
 * and returns a description safe to fold into the normal text pipeline.
 * Fails soft (returns null) on any error — no vision key, download
 * failure, bad response — so a caller can always fall back to the
 * pre-existing "ignore the image" behavior with zero risk of blocking.
 */
export interface IncomingImageAnalysis {
  url: string;
  analysis: ImageAnalysis | null;
}

/**
 * Downloads a WhatsApp image once, stores it on Cloudinary so it remains
 * available after Meta's short media-retention window, and runs the shared
 * vision analysis. The URL is returned as well as the analysis so support
 * tickets can retain the actual student photo instead of only its description.
 */
export async function analyzeIncomingImageWithUrl(mediaId: string): Promise<IncomingImageAnalysis | null> {
  try {
    const media = await downloadWhatsAppMedia(mediaId);
    if (!media?.buffer?.length) return null;

    const { url } = await uploadToCloudinary(
      "chat",
      media.buffer,
      `wa_incoming_${Date.now()}`,
      media.mimeType || "image/jpeg",
    );

    const analysis = await describeImage(url);
    return { url, analysis };
  } catch (e) {
    console.error("[wa-image-understanding] analysis failed:", (e as Error).message);
    return null;
  }
}

/** Backwards-compatible helper for callers that only need the description. */
export async function analyzeIncomingImage(mediaId: string): Promise<ImageAnalysis | null> {
  const result = await analyzeIncomingImageWithUrl(mediaId);
  return result?.analysis ?? null;
}
