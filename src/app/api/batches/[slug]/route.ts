import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin, requireSession } from "@/lib/session";
import { ok, notFound, forbidden, serverError, zodError, dbError } from "@/lib/api-response";
import { canAdminAccessBatch } from "@/lib/authz";
import { resolveUpiDetails, buildUpiLink } from "@/lib/services/payment-settings";
const UpdSchema = z.object({
  status: z.enum(["active","paused","closed","archived"]).optional(),
  fee_amount: z.number().positive().optional(),
  upi_id: z.string().optional(), upi_link: z.string().optional(), upi_qr_url: z.string().optional(),
  description: z.string().max(500).optional(),
});
export async function GET(req:NextRequest,{params}:{params:Promise<{slug:string}>}) {
  // Was unauthenticated select("*") — full batch row (UPI details,
  // representative phone, case data) to anyone who guessed a slug.
  // Now: any logged-in session, payment-screen fields only — the same
  // subset /api/batches/by-slug returns (which is also what the pay page
  // and register page already use unauthenticated for active batches).
  const { error } = await requireSession(req); if (error) return forbidden();
  const {slug}=await params;
  const db=createServiceClient();
  const {data}=await db.from("batches").select("id,name,slug,college,upi_id,upi_name,fee_amount,upi_link").eq("slug",slug).maybeSingle();
  if (!data) return notFound("Batch");
  const upi = await resolveUpiDetails(db, data);
  const upi_link = data.upi_link || buildUpiLink(upi, data.fee_amount);
  return ok({
    id: data.id,
    name: data.name,
    slug: data.slug,
    college: data.college,
    upi_id: upi.upi_id,
    upi_name: upi.upi_name,
    fee_amount: data.fee_amount,
    upi_link,
  });
}
export async function PATCH(req:NextRequest,{params}:{params:Promise<{slug:string}>}) {
  const {user,error}=await requireAdmin(req); if (error) return forbidden();
  const {slug}=await params;
  const body=UpdSchema.safeParse(await req.json()); if (!body.success) return zodError(body.error);
  const db=createServiceClient();
  // Batch isolation: only a super_admin or an admin assigned to this batch
  // may rewrite its fee or UPI payment destination.
  const {data: target}=await db.from("batches").select("id").eq("slug",slug).maybeSingle();
  if (!target) return notFound("Batch");
  if (user!.role !== "super_admin" && !(await canAdminAccessBatch(db, user!.profileId, user!.role, target.id))) return forbidden();
  const {data,error:err}=await db.from("batches").update(body.data).eq("slug",slug).select().single();
  if (err) return dbError("api/batches/[slug]", err);
  return ok(data);
}
