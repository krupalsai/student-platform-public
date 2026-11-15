import { NextRequest, NextResponse } from "next/server";
import { zipSync, strToU8 } from "fflate";
import { createServiceClient } from "@/lib/supabase/server";
import {
  getLawyerBatchIds,
  buildMissingPhotosNote,
  buildNamesList,
  fetchPhotoBytes,
  getBatchPetitioners,
  photoFileName,
  safeFileName,
  validateLawyerToken,
} from "@/lib/lawyer";

export const dynamic = "force-dynamic";

/**
 * GET /api/lawyer/batch-zip?batch=<batchId>&t=<lawyer link token>
 *
 * Builds the batch ZIP on the fly: every petitioner's photo file (named with
 * the student's name) under photos/, plus NAMES.txt, plus MISSING-PHOTOS.txt
 * when any photo is missing. No case papers or court orders are included.
 *
 * No student login: the unguessable link token is the only auth (same pattern
 * as the admin export tokens — only a hash is stored server-side).
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("t");
  if (!(await validateLawyerToken(token))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const batchId = req.nextUrl.searchParams.get("batch") ?? "";

  try {
    const db = createServiceClient();
    const allowedBatchIds = await getLawyerBatchIds(db);
    if (!allowedBatchIds.includes(batchId)) {
      return NextResponse.json({ error: "Unknown batch" }, { status: 400 });
    }
    const { data: batch } = await db
      .from("batches")
      .select("id, name, college")
      .eq("id", batchId)
      .maybeSingle();
    if (!batch) {
      return NextResponse.json({ error: "Batch not found" }, { status: 404 });
    }
    const batchName = (batch as { name: string }).name;

    const petitioners = await getBatchPetitioners(db, batchId);
    const entries: Record<string, Uint8Array> = {};
    const used = new Set<string>();
    const failed: string[] = [];

    const results = await Promise.all(
      petitioners
        .filter((p) => p.photoPath)
        .map(async (p) => ({
          p,
          got: await fetchPhotoBytes(p.photoPath as string),
        })),
    );
    for (const { p, got } of results) {
      if (!got) {
        failed.push(p.fullName);
        continue;
      }
      entries[`photos/${photoFileName(p, got.ext, used)}`] = got.bytes;
    }

    const missing = petitioners
      .filter((p) => !p.photoPath)
      .map((p) => p.fullName);
    entries["NAMES.txt"] = strToU8(buildNamesList(batchName, petitioners));
    if (missing.length > 0 || failed.length > 0) {
      entries["MISSING-PHOTOS.txt"] = strToU8(
        buildMissingPhotosNote(batchName, missing, failed),
      );
    }

    const zipBuffer = zipSync(entries, { level: 6 });
    return new NextResponse(zipBuffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${safeFileName(batchName)}_photos.zip"`,
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Export failed" },
      { status: 500 },
    );
  }
}
