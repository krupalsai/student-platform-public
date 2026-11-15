import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, serverError, dbError } from "@/lib/api-response";
import { hasApprovedPayment } from "@/lib/services/payments";

const isPaymentPromptAnnouncement = (a: any) => {
  const text = `${a?.title ?? ""} ${a?.body ?? ""}`.toLowerCase();
  return /payment\s+(is\s+)?now\s+open|payment\s+required|pay\s+now|tap\s+pay|go\s+to\s+the\s+payments\s+tab|payment.*open.*pay/i.test(text);
};

export async function GET(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();
  try {
    const db = createServiceClient();

    const { data: profile } = await db
      .from("profiles")
      .select("college, batch_id")
      .eq("id", user!.profileId)
      .single();

    const college = profile?.college ?? null;
    const batchId = profile?.batch_id ?? null;
    const isPaid = await hasApprovedPayment(db, user!.profileId);
    const isHistory = req.nextUrl.searchParams.get("history") === "true";

    const batchFilter = batchId
      ? `batch_id.is.null,batch_id.eq.${batchId}`
      : "batch_id.is.null";
    const collegeFilter = college
      ? `college.eq.all,college.eq.${college}`
      : "college.eq.all";

    let query = db
      .from("announcements")
      .select("id,title,body,college,batch_id,priority,created_at,expires_at,attachment_url,attachment_name")
      .or(batchFilter)
      .or(collegeFilter);

    if (!isHistory) {
      query = query
        .or("expires_at.is.null,expires_at.gt." + new Date().toISOString())
        .limit(20);
    } else {
      query = query.limit(200);
    }

    const { data, error: err } = await query
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false });

    if (err) return dbError("api/announcements", err);

    const visible = (data ?? []).filter((a: any) => !(isPaid && isPaymentPromptAnnouncement(a)));
    return ok(visible);
  } catch (err) { console.error("[api/announcements]", err); return serverError(); }
}
