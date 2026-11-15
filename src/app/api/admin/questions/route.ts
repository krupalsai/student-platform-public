import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { ok, forbidden, serverError, zodError } from "@/lib/api-response";
import { getPendingQuestionClusters, answerQuestionCluster } from "@/lib/services/question-queue";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

// GET — pending unknown questions, grouped into semantic clusters
// (most-asked first). Read-only except lazily backfilling embeddings.
export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req);
  if (error) return forbidden();
  try {
    const db = createServiceClient();
    const clusters = await getPendingQuestionClusters(db);
    return ok({ clusters });
  } catch (err) {
    console.error("[api/admin/questions] GET", err);
    return serverError();
  }
}

const AnswerSchema = z.object({
  ids:    z.array(z.string().uuid()).min(1).max(50),
  answer: z.string().trim().min(1).max(2000),
});

// POST — answer a whole cluster at once: creates ONE FAQ from the
// representative question, marks every question in the cluster answered,
// and notifies each asker (WhatsApp, best-effort) — all inside
// answerQuestionCluster(). Admin-only, and the actor is recorded.
export async function POST(req: NextRequest) {
  const { user, error } = await requireAdmin(req);
  if (error) return forbidden();
  try {
    const body = AnswerSchema.safeParse(await req.json());
    if (!body.success) return zodError(body.error);
    const db = createServiceClient();
    const result = await answerQuestionCluster(db, body.data.ids, body.data.answer, user!.profileId);
    return ok(result);
  } catch (err) {
    console.error("[api/admin/questions] POST", err);
    return serverError();
  }
}
