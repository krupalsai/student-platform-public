import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes, createHash } from "crypto";

/**
 * Short-lived download tokens for a single batch's export.
 *
 * The DOCX/ZIP export routes are admin-gated, but a WhatsApp admin tapping a
 * link has no website session to authenticate with. Rather than loosen those
 * routes, an admin action mints a token scoped to ONE batch that expires
 * quickly. Only the SHA-256 hash is stored, so the table is useless if leaked.
 */

const TTL_MINUTES = Number(process.env.EXPORT_TOKEN_TTL_MINUTES ?? 60);

function hash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Issues a token for a batch and returns the raw value (shown once). */
export async function issueExportToken(
  db: SupabaseClient,
  batchId: string,
  createdBy: string,
): Promise<string | null> {
  const raw = randomBytes(24).toString("hex");
  const { error } = await db.from("export_tokens").insert({
    token_hash: hash(raw),
    batch_id: batchId,
    created_by: createdBy,
    expires_at: new Date(Date.now() + TTL_MINUTES * 60_000).toISOString(),
  });
  if (error) {
    console.error("[export-token] issue failed:", error.message);
    return null;
  }
  return raw;
}

/**
 * Validates a raw token for a specific batch. Returns true only when the token
 * exists, is unexpired, and was minted for exactly this batch — so a token for
 * one batch can never be used to download another.
 *
 * Deliberately reusable within its window (not single-use): a download link
 * that dies on a failed/retried download would strand the admin.
 */
export async function validateExportToken(
  db: SupabaseClient,
  raw: string,
  batchId: string,
): Promise<boolean> {
  if (!raw) return false;
  const { data } = await db
    .from("export_tokens")
    .select("id, batch_id, expires_at, used_count")
    .eq("token_hash", hash(raw))
    .maybeSingle();

  if (!data) return false;
  if (data.batch_id !== batchId) return false;
  if (new Date(data.expires_at) <= new Date()) return false;

  await db.from("export_tokens")
    .update({ used_count: (data.used_count ?? 0) + 1 })
    .eq("id", data.id);
  return true;
}

/** Minutes a freshly issued token stays valid (for user-facing copy). */
export const EXPORT_TOKEN_TTL_MINUTES = TTL_MINUTES;
