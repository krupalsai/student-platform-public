import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { ok, forbidden, serverError, dbError, badRequest } from "@/lib/api-response";
import { createAnnouncement, AnnouncementInput } from "@/lib/services/announcements";
import { adminBatchIds, canAdminAccessBatch } from "@/lib/authz";

export const dynamic = "force-dynamic";
// The fan-out walks the whole student list (161 recipients on 29 Oct 2026).
// Give it the full Hobby-plan window so a slow push service can never cut
// the tail of the list off silently; the service itself now fans out with
// bounded concurrency as well.
export const maxDuration = 60;

/** The request body: the shared announcement fields plus this route's own
 *  push_telegram flag, which is stripped before the insert. */
type AnnouncementRequest = AnnouncementInput & { push_telegram: boolean };

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return Boolean(new URL(value)); } catch { return false; }
}

async function parseBody(req: NextRequest): Promise<AnnouncementRequest | { error: string }> {
  const raw = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return { error: "Invalid JSON body." };

  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const message = typeof raw.body === "string" ? raw.body.trim() : "";
  const college = raw.college === undefined ? "all" : raw.college;
  const priority = raw.priority === undefined ? "normal" : raw.priority;
  const batchId = raw.batch_id === undefined || raw.batch_id === null || raw.batch_id === "" ? null : raw.batch_id;
  const expiresAt = raw.expires_at === undefined || raw.expires_at === null || raw.expires_at === "" ? null : raw.expires_at;
  const attachmentUrl = raw.attachment_url === undefined || raw.attachment_url === null || raw.attachment_url === "" ? null : raw.attachment_url;
  const attachmentName = raw.attachment_name === undefined || raw.attachment_name === null || raw.attachment_name === "" ? null : raw.attachment_name;

  if (!title || title.length > 120) return { error: "Title is required and must be at most 120 characters." };
  if (!message || message.length > 1000) return { error: "Body is required and must be at most 1000 characters." };
  // College is validated against the colleges TABLE in POST, not against a
  // hardcoded list — that list said ["all","GNIT","GNITC"] and silently made
  // BIET announcements impossible. Same trap as items #101/#107/#114.
  if (typeof college !== "string" || !college.trim()) return { error: "Invalid college." };
  if (!["normal", "urgent"].includes(String(priority))) return { error: "Invalid priority." };
  if (batchId !== null && !isUuid(batchId)) return { error: "Invalid batch ID." };
  if (expiresAt !== null && (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt)))) return { error: "Invalid expiry date." };
  if (attachmentUrl !== null && !isUrl(attachmentUrl)) return { error: "Invalid attachment URL." };
  if (attachmentName !== null && (typeof attachmentName !== "string" || attachmentName.length > 200)) return { error: "Attachment name is too long." };
  if (raw.push_telegram !== undefined && typeof raw.push_telegram !== "boolean") return { error: "Invalid push_telegram value." };

  return {
    title,
    body: message,
    college: college as AnnouncementRequest["college"],
    batch_id: batchId as string | null,
    priority: priority as AnnouncementRequest["priority"],
    expires_at: expiresAt as string | null,
    attachment_url: attachmentUrl as string | null,
    attachment_name: attachmentName as string | null,
    push_telegram: raw.push_telegram === undefined ? true : raw.push_telegram as boolean,
  };
}

export async function GET(req: NextRequest) {
  const { user, error } = await requireAdmin(req);
  if (error) return forbidden();
  const db = createServiceClient();
  const assignedBatchIds = await adminBatchIds(db, user!.profileId, user!.role);
  if (assignedBatchIds !== null && assignedBatchIds.length === 0) return ok([]);
  let query = db
    .from("announcements")
    .select("id,title,body,college,batch_id,priority,created_at,expires_at,attachment_url,attachment_name")
    .order("created_at", { ascending: false })
    .limit(50);
  if (assignedBatchIds !== null) query = query.in("batch_id", assignedBatchIds);
  const { data, error: err } = await query;
  if (err) return dbError("api/admin/announcements", err);
  return ok(data ?? []);
}

export async function POST(req: NextRequest) {
  const { user, error } = await requireAdmin(req);
  if (error) return forbidden();
  try {
    const parsed = await parseBody(req);
    if ("error" in parsed) return badRequest(parsed.error);
    const d = parsed;
    const db = createServiceClient();
    if (user!.role !== "super_admin") {
      if (!d.batch_id || !(await canAdminAccessBatch(db, user!.profileId, user!.role, d.batch_id))) return forbidden();
      if (d.college === "all") return forbidden();
      const { data: assignedBatch } = await db.from("batches").select("college").eq("id", d.batch_id).maybeSingle();
      if (!assignedBatch || assignedBatch.college !== d.college) return forbidden();
    }

    if (d.college !== "all") {
      const { getActiveColleges } = await import("@/lib/services/colleges");
      const known = (await getActiveColleges(db)).map(c => c.id.toUpperCase());
      if (!known.includes(d.college.toUpperCase())) return badRequest("Invalid college.");
    }

    // Insert + notify lives in services/announcements.ts so the WhatsApp
    // ANNOUNCE command posts exactly the same announcement, to exactly the
    // same people, as this route.
    const { push_telegram: _, ...insertData } = d;
    const result = await createAnnouncement(db, insertData, user!.profileId);
    const ann = result.announcement;

    return ok({ ...ann, push_sent: result.pushSent, push_failed: result.pushFailed, push_no_subscription: result.pushNoSubscription, inbox_saved: result.inboxSaved });
  } catch (err) { console.error("[api/admin/announcements]", err); return serverError(); }
}
