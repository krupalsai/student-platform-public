import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";
import { reindexFaqEmbeddings } from "@/lib/services/faq";
import { embeddingsEnabled } from "@/lib/embeddings";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/faqs/reindex
 *
 * Backfills semantic-search embeddings for FAQs that don't have one yet.
 * Run once after configuring an embedding key. Read/compute only — it never
 * changes FAQ content, just fills the embedding column.
 */
export async function POST(req: NextRequest) {
  const { error } = await requireAdmin(req);
  if (error) return forbidden();

  if (!embeddingsEnabled()) {
    return ok({
      enabled: false,
      message: "Embeddings aren't configured. Set EMBEDDINGS_API_KEY (or GEMINI_API_KEY) to enable semantic FAQ search.",
    });
  }

  try {
    const db = createServiceClient();
    const result = await reindexFaqEmbeddings(db);
    return ok({ enabled: true, ...result });
  } catch (err) {
    console.error("[api/admin/faqs/reindex]", err);
    return serverError();
  }
}
