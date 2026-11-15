import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * The browser needs only the VAPID public key. Keep it server-derived so a
 * mistakenly populated NEXT_PUBLIC_VAPID_PUBLIC_KEY can never put a private
 * key into the client bundle.
 *
 * Accept the first non-empty line for one migration-safe deployment where a
 * public key and private key were accidentally pasted together. The private
 * value is never returned. The Vercel environment variable must still be
 * corrected and the exposed key pair rotated.
 */
export async function GET() {
  const configured = process.env.VAPID_PUBLIC_KEY ?? process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
  const publicKey = configured.split(/\r?\n/, 1)[0].trim();

  // A VAPID public key is the 65-byte uncompressed EC point, represented as
  // 87 base64url characters (padding is optional). Reject obviously malformed
  // configuration instead of letting PushManager produce a cryptic error.
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(publicKey)) {
    return NextResponse.json(
      { success: false, error: "Push notifications are not configured on the server." },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  return NextResponse.json(
    { success: true, data: { publicKey } },
    { headers: { "Cache-Control": "no-store" } }
  );
}
