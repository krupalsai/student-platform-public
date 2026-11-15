// Storage abstraction layer — Cloudinary (primary) with Supabase fallback
// for files uploaded before the migration.
//
// Upload flow (new):
//   Client → POST file bytes to our API route → we upload to Cloudinary → save public_id to DB
//
// Download flow:
//   If stored path starts with "cloudinary:" → return Cloudinary delivery URL (no expiry, CDN)
//   Otherwise                               → return Supabase signed URL (legacy files)

import { createServiceClient } from "@/lib/supabase/server";
import { v2 as cloudinary } from "cloudinary";

// ── Cloudinary config (server-side only, never exposed to browser) ─────────
// All three variables are required. The app will throw at startup if any is missing.
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY    = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  throw new Error(
    "Missing required Cloudinary environment variables: " +
    [
      !CLOUDINARY_CLOUD_NAME && "CLOUDINARY_CLOUD_NAME",
      !CLOUDINARY_API_KEY    && "CLOUDINARY_API_KEY",
      !CLOUDINARY_API_SECRET && "CLOUDINARY_API_SECRET",
    ]
      .filter(Boolean)
      .join(", ")
  );
}

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key:    CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
  secure:     true,
});

// Cloud that owned student documents before the 10 Nov 2026 key rotation.
// Its assets are still served publicly; see the fallback in createDownloadUrl.
const LEGACY_CLOUDINARY_CLOUD_NAME = "dpqqwqnsd";

// Public_ids proven to live only in the legacy cloud (per serverless
// instance lifetime). Lets repeat views/exports skip the HEAD check.
const legacyCloudAssets = new Set<string>();

function legacyCloudUrl(publicId: string): string {
  return `https://res.cloudinary.com/${LEGACY_CLOUDINARY_CLOUD_NAME}/image/upload/${publicId}`;
}

// HEAD the new-cloud delivery URL. Returns the HTTP status, or null when
// the check itself could not run (network error) so the caller keeps the
// new-cloud URL instead of guessing.
async function newCloudHeadStatus(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.status;
  } catch {
    return null;
  }
}

// Supabase bucket names (kept for legacy URL generation)
const DOCS  = process.env.STORAGE_DOCUMENTS_BUCKET  ?? "student-documents";
const SHOTS = process.env.STORAGE_SCREENSHOTS_BUCKET ?? "payment-screenshots";

// ── Cloudinary folder mapping ─────────────────────────────────────────────
const FOLDER: Record<"docs" | "screenshots" | "chat", string> = {
  docs:        "student-documents",
  screenshots: "payment-screenshots",
  chat:        "group-chat-photos",
};

// ── Check if a stored path is a Cloudinary public_id ─────────────────────
// New paths are stored as "cloudinary:folder/filename"
// Legacy Supabase paths are stored as "uuid/filename.ext"
export function isCloudinaryPath(path: string): boolean {
  return path.startsWith("cloudinary:");
}

export function cloudinaryPublicId(path: string): string {
  return path.replace(/^cloudinary:/, "");
}

// ── Upload a Buffer/stream to Cloudinary ─────────────────────────────────
export async function uploadToCloudinary(
  bucket: "docs" | "screenshots" | "chat",
  fileBuffer: Buffer,
  filename: string,
  mimeType: string
): Promise<{ publicId: string; url: string; storagePath: string }> {
  const folder = FOLDER[bucket];
  const resourceType = mimeType.startsWith("image/") ? "image" : "raw";

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        use_filename: false,
        unique_filename: true,
        overwrite: false,
        // Transformation: auto-quality, auto-format for images
        ...(resourceType === "image" ? {
          transformation: [{ quality: "auto", fetch_format: "auto" }]
        } : {}),
      },
      (error, result) => {
        if (error || !result) {
          const err = error instanceof Error ? error : new Error((error as { message?: string } | undefined)?.message ?? "Upload failed");
          return reject(err);
        }
        const storagePath = `cloudinary:${result.public_id}`;
        resolve({ publicId: result.public_id, url: result.secure_url, storagePath });
      }
    );
    // Safety net: if the underlying write stream itself errors (dropped
    // connection, DNS blip, etc.) before Cloudinary's own callback fires,
    // the promise would otherwise never settle and the request would hang
    // until the platform force-kills it — surfacing as an opaque timeout
    // instead of a clean, loggable error.
    stream.on("error", (err) => reject(err instanceof Error ? err : new Error(String(err))));
    stream.end(fileBuffer);
  });
}

// ── Generate a delivery URL for a stored path ─────────────────────────────
// Works for both Cloudinary (new) and Supabase (legacy) paths.
export async function createDownloadUrl(
  bucket: "docs" | "screenshots",
  path: string
): Promise<string> {
  if (isCloudinaryPath(path)) {
    // Cloudinary: generate a signed URL valid for 1 hour (3600s)
    const publicId = cloudinaryPublicId(path);
    const url = cloudinary.url(publicId, {
      resource_type: "image",
      type: "upload",
      sign_url: true,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      secure: true,
    });
    // Pre-rotation fallback (11 Nov 2026): documents uploaded before the
    // 10 Nov Cloudinary key rotation live in the OLD cloud (dpqqwqnsd);
    // the SDK is configured for the NEW cloud (u5xpsmhz), so a signed URL
    // for an old asset 404s and the student/admin sees a dead link (the
    // batch document export listed all 101 pre-rotation College IDs as
    // MISSING for exactly this reason). The old cloud still serves its
    // assets publicly, so when the new-cloud URL 404s, deliver from there
    // instead of handing out a dead link. Once an asset is known-legacy
    // it is remembered for the lifetime of the serverless instance so
    // repeat views/exports skip the HEAD check. A network error (not a
    // 404) keeps the new-cloud URL — never guess on a blip.
    // TODO: migrate the old-cloud assets into the new cloud (same
    // public_ids) and delete this fallback.
    if (legacyCloudAssets.has(publicId)) return legacyCloudUrl(publicId);
    const status = await newCloudHeadStatus(url);
    if (status === 404) {
      legacyCloudAssets.add(publicId);
      console.warn(`[storage] ${publicId} not in ${CLOUDINARY_CLOUD_NAME}; falling back to legacy cloud ${LEGACY_CLOUDINARY_CLOUD_NAME}`);
      return legacyCloudUrl(publicId);
    }
    return url;
  }

  // Legacy: Supabase signed URL (600s)
  const db = createServiceClient();
  const b = bucket === "docs" ? DOCS : SHOTS;
  const { data, error } = await db.storage.from(b).createSignedUrl(path, 600);
  if (error || !data) throw new Error(error?.message ?? "Supabase URL generation failed");
  return data.signedUrl;
}

// ── Legacy: create a Supabase signed upload URL (kept for compatibility) ──
// Not used for new uploads — new uploads go through uploadToCloudinary()
export async function createUploadUrl(
  bucket: "docs" | "screenshots",
  path: string
) {
  const db = createServiceClient();
  const b = bucket === "docs" ? DOCS : SHOTS;
  const { data, error } = await db.storage.from(b).createSignedUploadUrl(path, { upsert: true });
  if (error || !data) throw new Error(error?.message);
  return { signedUrl: data.signedUrl, path };
}

// ── Delete a previously stored asset (Cloudinary or legacy Supabase) ─────
// Used when a document is replaced (e.g. one-time College ID re-upload) so
// the old file doesn't sit around forever as an orphaned asset. Failures are
// swallowed — losing the old file after a successful replace is a minor
// cleanup issue, not something that should block the student's flow.
export async function deleteStoredAsset(bucket: "docs" | "screenshots", path: string | null | undefined): Promise<void> {
  if (!path) return;
  try {
    if (isCloudinaryPath(path)) {
      const publicId = cloudinaryPublicId(path);
      await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
    } else {
      const db = createServiceClient();
      const b = bucket === "docs" ? DOCS : SHOTS;
      await db.storage.from(b).remove([path]);
    }
  } catch {
    // best-effort cleanup only
  }
}

// ── Path helpers ──────────────────────────────────────────────────────────
export const screenshotPath = (userId: string, ext = "jpg") =>
  `${userId}/screenshot_${Date.now()}.${ext}`;
export const documentPath = (studentId: string, type: string, ext = "jpg") =>
  `${studentId}/${type}_${Date.now()}.${ext}`;

