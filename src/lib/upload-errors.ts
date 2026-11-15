/**
 * Error contract for the College-ID upload route
 * (src/app/api/uploads/college-id/route.ts).
 *
 * A throw from the storage upload step means the storage provider
 * (Cloudinary) is unavailable — bad config, bad credentials, or an outage.
 * That is a downstream outage, not a generic 500: the route answers 503
 * with a retryable message so the student sees something actionable
 * instead of "Internal server error", and the provider's own error is
 * logged server-side at the call site for diagnosis.
 *
 * The failure semantic is uniform for this step — any throw from the
 * upload call maps here — so the classifier takes the error for the log
 * context at the call site and always returns this descriptor.
 *
 * Live incident 11 Nov 2026: every College-ID upload 500'd with
 * "Invalid cloud_name dpqqwqnsd". The Cloudinary API key/secret had been
 * rotated (10 Nov) to a pair belonging to cloud u5xpsmhz, while
 * CLOUDINARY_CLOUD_NAME still named the old cloud dpqqwqnsd. The fix for
 * that is the env value (plus redeploy); this contract keeps the next
 * such failure diagnosable and retryable instead of a cryptic double 500.
 */

export interface UploadErrorResponse {
  status: number;
  body: { success: false; error: string; code: string };
}

export function mapUploadError(_err: unknown): UploadErrorResponse {
  return {
    status: 503,
    body: {
      success: false,
      error: "Photo upload is temporarily unavailable — please try again in a bit.",
      code: "UPLOAD_UNAVAILABLE",
    },
  };
}
