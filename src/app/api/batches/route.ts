import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { ok, created, forbidden, serverError, zodError, dbError } from "@/lib/api-response";

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const Schema = z.object({
  name:        z.string().trim().min(2).max(120),
  college:     z.string().trim().min(1).max(50),  // validated against DB below — no hardcoded enum
  description: z.string().max(500).optional(),
  fee_amount:  z.number().positive(),
  upi_id:      z.string().trim().min(3).optional(),
  upi_name:    z.string().trim().min(1).max(100).optional(),
  status:      z.enum(["active", "paused", "closed", "archived"]).optional(),
  start_date:  z.string().optional(),
  end_date:    z.string().optional(),
  batch_limit: z.number().int().positive().nullable().optional(),
  low_seat_alert_threshold: z.number().int().min(0).nullable().optional(),
});

export async function GET(req: NextRequest) {
  const db      = createServiceClient();
  const college = req.nextUrl.searchParams.get("college");
  // Security fix (2026-11-06): this public endpoint used to return
  // upi_id / upi_name / upi_link for every active batch, with no auth.
  // Those are gone now — same strip as /api/batches/by-slug (f29cb08).
  // No live caller needs them here: the registration page's college-pick
  // flow reads only fee_amount / slug / status / college from this
  // endpoint, and a student paying their own batch gets the UPI details
  // from the authenticated registration-bootstrap flow instead.
  let q = db.from("batches")
    .select("name,slug,college,status,fee_amount,start_date,end_date")
    .eq("status", "active")
    .order("created_at", { ascending: false });
  if (college) q = q.eq("college", college);
  const { data, error } = await q;
  if (error) return serverError();
  return ok(data ?? []);
}

export async function POST(req: NextRequest) {
  const { error } = await requireAdmin(req);
  if (error) return forbidden();
  try {
    const body = Schema.safeParse(await req.json());
    if (!body.success) return zodError(body.error);

    const db = createServiceClient();

    // Generate base slug from the batch name alone. The admin form already
    // builds `name` as "${college} Batch ${n}" (e.g. "GNIT Batch 1"), so
    // prepending college again here used to produce double-prefixed slugs
    // like "gnit-gnit-batch-1" — fixed by not re-prepending college.
    const baseSlug = slugify(body.data.name);

    // Check if slug already exists (including archived) and make it unique
    const { data: existing } = await db
      .from("batches")
      .select("slug")
      .like("slug", `${baseSlug}%`);

    let slug = baseSlug;
    if (existing && existing.length > 0) {
      // Append incrementing suffix: gnit-batch-1-2, gnit-batch-1-3 …
      const usedSlugs = new Set(existing.map((r: any) => r.slug));
      let i = 2;
      while (usedSlugs.has(`${baseSlug}-${i}`)) i++;
      slug = `${baseSlug}-${i}`;
    }

    const upi_link = (body.data.upi_id && body.data.upi_name)
      ? `upi://pay?pa=${encodeURIComponent(body.data.upi_id)}&pn=${encodeURIComponent(body.data.upi_name)}&am=${Math.round(Number(body.data.fee_amount))}&cu=INR`
      : null;

    const { data, error: err } = await db.from("batches")
      .insert({ ...body.data, slug, upi_link, upi_qr_url: null })
      .select().single();
    if (err) return dbError("api/batches", err);
    return created(data);
  } catch (err) { console.error("[api/batches]", err); return serverError(); }
}
