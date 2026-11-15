/**
 * The one list of image types this platform accepts for upload.
 *
 * It lived as eight separate copies of `["image/jpeg","image/png","image/webp"]`
 * across four API routes and four pages, which is how iPhone uploads came to be
 * rejected in some places and not others.
 *
 * ── Why HEIC/HEIF are on the list ──────────────────────────────────────────
 * An iPhone shoots HEIC by default. Safari usually transcodes to JPEG when a
 * file input carries a RESTRICTIVE `accept` list, which is why the College ID
 * picker mostly worked — but that conversion is not guaranteed: picking through
 * the Files app, or through an input with `accept="image/*"`, hands over the
 * original with `type: "image/heic"`. The upload then failed with "Only JPEG,
 * PNG, WebP allowed" — on the College ID that blocks registration outright, and
 * the student has no way to understand why, because the photo looks perfectly
 * normal on their phone.
 *
 * Accepting it is safe: Cloudinary ingests HEIC and every delivery URL this app
 * builds carries `fetch_format: "auto"` (see storage.ts), so what actually gets
 * served — to a browser, and to the vision model that reads College IDs — is a
 * normal JPEG/WebP. Nothing downstream ever sees HEIC.
 *
 * Keep `ACCEPT_ATTR` in sync with this list; it is what file inputs advertise.
 */
export const ALLOWED_IMAGE_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;

/**
 * `accept` attribute for a file input.
 *
 * Deliberately lists concrete types rather than `image/*`: a restrictive list
 * is what nudges iOS into transcoding HEIC to JPEG in the first place, so the
 * HEIC entries above stay a safety net rather than the normal path. Never
 * change this to `image/*` — that turns the net into the default.
 */
export const ACCEPT_ATTR = ".jpg,.jpeg,.png,.webp,.heic,.heif,image/jpeg,image/png,image/webp,image/heic,image/heif";

/** Shared copy for the "wrong file type" message, so every surface says the same thing. */
export const IMAGE_TYPE_ERROR = "Please upload a photo (JPG, PNG, WEBP or HEIC).";

/** True when a picked/uploaded file is an image type this platform accepts. */
export function isAllowedImage(type: string | undefined | null): boolean {
  return !!type && (ALLOWED_IMAGE_MIME as readonly string[]).includes(type);
}
