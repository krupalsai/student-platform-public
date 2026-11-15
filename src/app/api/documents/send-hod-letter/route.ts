import { NextResponse } from "next/server";

/**
 * Telegram document delivery was removed from Student Platform.
 * Keep this endpoint as an explicit deprecation response so old clients do
 * not receive a misleading "link your Telegram account" message.
 */
export async function POST() {
  return NextResponse.json(
    { success: false, error: "Telegram document delivery is no longer available." },
    { status: 410 },
  );
}
