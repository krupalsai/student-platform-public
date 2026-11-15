import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";
import { listFaqs } from "@/lib/services/faq";

export async function GET(req: NextRequest) {
  const { error } = await requireSession(req);
  if (error) return forbidden();
  try {
    const db = createServiceClient();
    const data = await listFaqs(db);
    return ok(data);
  } catch (err) { console.error("[api/faqs]", err);
    return serverError();
  }
}
