import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";

// Bulk-deletes Cloudinary assets — destructive, and not linked from any
// admin UI page (curl/manual-trigger only). super_admin-only, not just
// widened to include it — a restricted admin has no business reaching a
// tool this dangerous just because it happens to share a session role.
export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error || !user || user.role !== "super_admin")
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });

  const cloudName  = process.env.CLOUDINARY_CLOUD_NAME!;
  const apiKey     = process.env.CLOUDINARY_API_KEY!;
  const apiSecret  = process.env.CLOUDINARY_API_SECRET!;
  const authStr    = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
  const base       = `https://api.cloudinary.com/v1_1/${cloudName}`;

  async function listAll(resourceType: string) {
    const all: any[] = [];
    let nextCursor: string | undefined;
    do {
      const url = `${base}/resources/${resourceType}?max_results=500${nextCursor ? `&next_cursor=${nextCursor}` : ""}`;
      const res = await fetch(url, { headers: { Authorization: `Basic ${authStr}` } });
      const j   = await res.json();
      all.push(...(j.resources ?? []));
      nextCursor = j.next_cursor;
    } while (nextCursor);
    return all;
  }

  const [images, raws] = await Promise.all([listAll("image"), listAll("raw")]);
  const all = [...images, ...raws];

  if (all.length === 0)
    return NextResponse.json({ success: true, deleted: 0, message: "Already empty" });

  // Delete all in batches of 100
  let deleted = 0;
  const imgIds = images.map((r: any) => r.public_id);
  const rawIds = raws.map((r: any) => r.public_id);

  async function deleteIds(ids: string[], resourceType: string) {
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const body  = new URLSearchParams();
      chunk.forEach(id => body.append("public_ids[]", id));
      body.append("resource_type", resourceType);
      await fetch(`${base}/resources/${resourceType}`, {
        method: "DELETE",
        headers: { Authorization: `Basic ${authStr}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      deleted += chunk.length;
    }
  }

  await deleteIds(imgIds, "image");
  await deleteIds(rawIds, "raw");

  return NextResponse.json({ success: true, deleted, total: all.length });
}
