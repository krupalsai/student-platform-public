import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";
import { embedText, embeddingsEnabled, EMBEDDING_DIM } from "@/lib/embeddings";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * GET /api/admin/faqs/rag-health
 *
 * Admin-only, read-only diagnostic for the deployed FAQ retrieval pipeline.
 * It never returns secrets, student records, or generated answers. Use it
 * after applying the FAQ vector migration and configuring EMBEDDINGS_API_KEY
 * (or GEMINI_API_KEY) in the deployment environment.
 */
export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req);
  if (error) return forbidden();

  const report: {
    embeddingsConfigured: boolean;
    embeddingDimension: number;
    embeddingProbe: "passed" | "failed" | "not_configured";
    faqTable: "reachable" | "unavailable";
    enabledFaqCount?: number;
    embeddedFaqCount?: number;
    vectorSearch: "passed" | "failed" | "not_tested";
    matchedFaqCount?: number;
    checks: string[];
  } = {
    embeddingsConfigured: embeddingsEnabled(),
    embeddingDimension: EMBEDDING_DIM,
    embeddingProbe: "not_configured",
    faqTable: "unavailable",
    vectorSearch: "not_tested",
    checks: [],
  };

  try {
    const db = createServiceClient();
    const { count, error: faqError } = await db
      .from("faqs")
      .select("id", { count: "exact", head: true })
      .eq("enabled", true);

    if (faqError) {
      report.checks.push("FAQ table query failed. Confirm migrations and Supabase service credentials.");
    } else {
      report.faqTable = "reachable";
      report.enabledFaqCount = count ?? 0;
    }

    const { count: embeddedCount, error: embeddingColumnError } = await db
      .from("faqs")
      .select("id", { count: "exact", head: true })
      .eq("enabled", true)
      .not("embedding", "is", null);

    if (!embeddingColumnError) {
      report.embeddedFaqCount = embeddedCount ?? 0;
    } else {
      report.checks.push("Embedding column is unavailable. Apply the FAQ semantic-search migration.");
    }

    if (!report.embeddingsConfigured) {
      report.embeddingProbe = "not_configured";
      report.checks.push("Set EMBEDDINGS_API_KEY or GEMINI_API_KEY in the server environment, then redeploy.");
    } else {
      const vector = await embedText("How do I pay the fee?");
      if (!vector || vector.length !== EMBEDDING_DIM) {
        report.embeddingProbe = "failed";
        report.checks.push("Embedding provider did not return a valid 768-dimension vector. Check key, model access, quota, and deployment logs.");
      } else {
        report.embeddingProbe = "passed";
        const { data, error: rpcError } = await db.rpc("match_faqs", {
          query_embedding: vector,
          match_threshold: 0.35,
          match_count: 3,
        });
        if (rpcError) {
          report.vectorSearch = "failed";
          report.checks.push("Vector-search RPC failed. Apply the semantic-search migration and verify the match_faqs function.");
        } else {
          report.vectorSearch = "passed";
          report.matchedFaqCount = Array.isArray(data) ? data.length : 0;
          if (report.embeddedFaqCount === 0) {
            report.checks.push("No enabled FAQs have embeddings. As an admin, run POST /api/admin/faqs/reindex to backfill them.");
          } else if (!Array.isArray(data) || data.length === 0) {
            report.checks.push("Vector search runs but returned no candidates for the diagnostic question. Review corpus content and similarity threshold.");
          }
        }
      }
    }

    if (!report.checks.length) {
      report.checks.push("Retrieval infrastructure checks passed. Verify answer quality with real student questions before relying on it in production.");
    }
    return ok(report);
  } catch (err) {
    console.error("[api/admin/faqs/rag-health]", err);
    return serverError();
  }
}
