/**
 * Validators for the storage references the browser sends back to us.
 *
 * Separate from `lib/storage.ts` on purpose — that module configures the
 * Cloudinary SDK and throws at import time if its env vars are missing, which
 * is right for an upload route and wrong for registration/payment submission,
 * the two routes a student cannot get past.
 *
 * WHY THIS EXISTS: `college_id_path` on the profile arrives from the client
 * and is stored verbatim — without validation a student could point it at
 * another student's uploaded document, since the two Cloudinary folders are
 * otherwise interchangeable strings. (The payment-screenshot validator that
 * used to live here went with manual UPI when that flow was deleted.)
 *
 * Each field accepts only the exact shape its own upload route produces: the
 * folder, then Cloudinary's generated public_id. Legacy Supabase-era paths
 * (`<uuid>/<file>.jpg`) are deliberately rejected — verified against
 * production before writing this: every existing row is already in the
 * Cloudinary form, so this gates writes only, not existing reads.
 */

const PREFIX  = "cloudinary:";
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_ID  = 200;

function isReference(path: string, folder: string): boolean {
  if (typeof path !== "string" || !path.startsWith(PREFIX)) return false;

  const publicId = path.slice(PREFIX.length);
  if (publicId.length > MAX_ID) return false;

  const segments = publicId.split("/");
  if (segments.shift() !== folder) return false;   // must be OUR folder
  if (segments.length === 0) return false;         // folder alone is not an id

  // No empties (leading/trailing/doubled slashes), no "." or ".." traversal,
  // no whitespace/newline that could smuggle a second value past a later check.
  return segments.every(s => s !== "." && s !== ".." && SEGMENT.test(s));
}

/** A reference issued by POST /api/uploads/college-id. */
export function isDocumentStoragePath(path: string): boolean {
  return isReference(path, "student-documents");
}
