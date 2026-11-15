import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { hashToken } from "@/lib/token";
import { hasApprovedPayment } from "@/lib/services/payments";
import { canReadRouteMap, isStaff } from "@/lib/authz";

/**
 * GET /api/route-map/attachments/[id]/download
 *
 * Streams a Route Map attachment with headers that make it usable.
 *
 * Why this exists rather than linking Cloudinary directly:
 *
 *  1. Cloudinary raw delivery derives Content-Type and the download filename
 *     from the public_id's extension, and the uploader generates one without
 *     any — so a PDF arrived as `application/octet-stream` named
 *     "sknz52czoiet0jp1kmxo", which Android will not open. For a court order
 *     whose whole purpose is being printed, that is a silent total failure.
 *  2. Giving the asset a .pdf extension fixes the headers but trips this
 *     account's restricted-media-types setting: verified against the live CDN,
 *     the same bytes return 200 extensionless and 401 `x-cld-error: deny or
 *     ACL failure` once recognised as a PDF. Signed delivery URLs were tried
 *     and are ALSO refused, so this is not something code can route around on
 *     the delivery side.
 *
 * So the asset stays extensionless (which Cloudinary serves happily) and the
 * correct headers are applied here, where we control them.
 *
 * Security: this is strictly tighter than what it replaces. The Cloudinary
 * URLs are unguessable but entirely public — anyone with the link could read a
 * college's court documents with no session at all. Here the same rules as the
 * attachment list apply: a verified payment (or staff), and the attachment's
 * college must match the caller's own, so an id cannot be used to reach
 * another college's material.
 */

/** Vercel caps a serverless response at ~4.5MB; beyond that this fails. */
const MAX_PROXY_BYTES = 4_000_000;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = createServiceClient();

  /**
   * A plain <a href> cannot send an Authorization header, so a download link
   * carries ?token=. Same pattern the DOCX exports already use. The token is a
   * real session token, validated here exactly as the header path would be.
   */
  const qToken = req.nextUrl.searchParams.get("token");
  let profileId: string | null = null;
  let role = "";

  if (qToken) {
    const { data: sess } = await db
      .from("sessions")
      .select("student_id, profiles(id, role)")
      .eq("token_hash", hashToken(qToken))
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    const p = sess?.profiles as unknown as { id: string; role: string } | null;
    if (p) {
      profileId = p.id;
      role = p.role;
    }
  } else {
    const { user, error } = await requireSession(req);
    if (!error && user) {
      profileId = user.profileId;
      role = user.role;
    }
  }

  if (!profileId) return new NextResponse("Unauthorized", { status: 401 });

  const verified =
    role === "super_admin" ? true : await hasApprovedPayment(db, profileId);
  if (!canReadRouteMap(role as Parameters<typeof canReadRouteMap>[0], verified)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const { data: attachment } = await db
    .from("route_map_attachments")
    .select("college, title, file_url, file_name, file_type")
    .eq("id", id)
    .maybeSingle();

  if (!attachment) return new NextResponse("Not found", { status: 404 });

  // College scoping, so an attachment id from one college cannot be fetched by
  // a student of another. Staff (who have no college of their own, and already
  // read every college's material on /admin/route-map) pass through.
  if (!isStaff(role as Parameters<typeof isStaff>[0])) {
    const { data: profile } = await db
      .from("profiles").select("college").eq("id", profileId).maybeSingle();
    const college = profile?.college ?? null;
    if (attachment.college !== "all" && attachment.college !== college) {
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(attachment.file_url, { cache: "no-store" });
  } catch (e) {
    console.error("[route-map/download] upstream fetch failed:", e);
    return new NextResponse("Could not fetch the document", { status: 502 });
  }
  if (!upstream.ok) {
    console.error(`[route-map/download] upstream ${upstream.status} for ${id}`);
    return new NextResponse("Could not fetch the document", { status: 502 });
  }

  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (bytes.length > MAX_PROXY_BYTES) {
    // Better an explicit error than a truncated PDF that looks fine until a
    // student tries to print it.
    console.error(`[route-map/download] ${id} is ${bytes.length}B, over the proxy limit`);
    return new NextResponse("This document is too large to download here", { status: 413 });
  }

  /**
   * Filename is rebuilt rather than trusted: file_name comes from whatever an
   * admin uploaded, and it lands in a header. Strip anything that could break
   * out of the quoted string or suggest a path.
   */
  const safeName =
    (attachment.file_name ?? `${attachment.title}.pdf`)
      .replace(/[^A-Za-z0-9._ -]/g, "")
      .replace(/^\.+/, "")
      .slice(0, 100) || "document.pdf";

  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": attachment.file_type || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Content-Length": String(bytes.length),
      // These are per-college documents behind an auth check — they must not
      // sit in a shared cache.
      "Cache-Control": "private, no-store",
    },
  });
}
