import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin, requireViewerOrAdmin } from "@/lib/session";
import { ok, created, forbidden, zodError, badRequest, serverError } from "@/lib/api-response";
import { getActiveColleges, addCollege } from "@/lib/services/colleges";
import { countStudentsInCollegeBatches } from "@/lib/services/college-counts";

/**
 * GET — the college list for the admin Colleges page.
 *
 * The stats endpoint only ever lists active colleges, so a college whose
 * row is inactive but which still has a running batch (BIET: inactive row,
 * active "BIET Batch 1") never appeared anywhere the admin could tap it.
 * This list is the complete one: every active college, plus any college
 * with at least one active batch. A newly added college (active, no
 * batches yet) is in the list from the moment it is created.
 */
export async function GET(req: NextRequest) {
  const { error } = await requireViewerOrAdmin(req);
  if (error) return forbidden();
  try {
    const db = createServiceClient();
    const active = await getActiveColleges(db);

    const { data: activeBatchRows } = await db
      .from("batches")
      .select("college")
      .eq("status", "active");
    const ids = new Map<string, string>();
    for (const c of active) ids.set(c.id, c.name);
    for (const b of activeBatchRows ?? []) {
      const college = String((b as { college?: unknown }).college ?? "");
      if (college && !ids.has(college)) ids.set(college, college);
    }
    const missing = [...ids.keys()].filter((id) => !active.some((c) => c.id === id));
    if (missing.length) {
      const { data } = await db.from("colleges").select("id, name").in("id", missing);
      for (const row of data ?? []) {
        ids.set(String((row as { id: unknown }).id), String((row as { name: unknown }).name ?? (row as { id: unknown }).id));
      }
    }

    const colleges = await Promise.all(
      [...ids.entries()].map(async ([id, name]) => {
        const [students, { count: batches }, { count: activeBatches }] = await Promise.all([
          countStudentsInCollegeBatches(db, id),
          db.from("batches").select("*", { count: "exact", head: true })
            .neq("status", "archived").eq("college", id),
          db.from("batches").select("*", { count: "exact", head: true })
            .eq("status", "active").eq("college", id),
        ]);
        return { id, name, students, batches: batches ?? 0, has_active_batch: (activeBatches ?? 0) > 0 };
      }),
    );
    colleges.sort((a, b) => a.name.localeCompare(b.name));
    return ok({ colleges });
  } catch (err) {
    console.error("[api/admin/colleges GET]", err);
    return serverError();
  }
}

const Schema = z.object({
  name: z.string().trim().min(2, "Enter the college name.").max(120, "That name is too long."),
  code: z.string().trim().regex(/^[A-Za-z]{2,10}$/, "The short code should be 2–10 letters, like GNIT.").optional().or(z.literal("")),
});

/**
 * POST — add a college (admin only). The admin Colleges page and the Admin
 * Copilot's "create a new college" command both use this. Validation and
 * duplicate handling live in addCollege(); this route only gates the role
 * and shapes the request.
 */
export async function POST(req: NextRequest) {
  const { error } = await requireAdmin(req);
  if (error) return forbidden();
  try {
    const body = Schema.safeParse(await req.json());
    if (!body.success) return zodError(body.error);
    const db = createServiceClient();
    const result = await addCollege(db, body.data.name, body.data.code || undefined);
    if (!result.ok) return badRequest(result.reason);
    return created({ id: result.id, name: body.data.name.trim().replace(/\s+/g, " "), reactivated: result.reactivated });
  } catch (err) {
    console.error("[api/admin/colleges POST]", err);
    return serverError();
  }
}
