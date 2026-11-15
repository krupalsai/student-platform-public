import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireViewerOrAdmin } from "@/lib/session";
import { canAdminAccessBatch } from "@/lib/authz";
import { isCloudinaryPath, createDownloadUrl } from "@/lib/storage";
import {
  Document, Packer, Paragraph, TextRun,
  AlignmentType, BorderStyle, convertMillimetersToTwip,
} from "docx";
import { zipSync, strToU8 } from "fflate";

// ── helpers ──────────────────────────────────────────────────────────────────

function studentLine(s: {
  full_name: string | null;
  father_name: string | null;
  gender: string | null;
  home_address: string | null;
  roll_number: string | null;
}): string {
  const name    = (s.full_name    ?? "").trim();
  const father  = (s.father_name  ?? "").trim();
  const address = (s.home_address ?? "").trim();
  const roll    = (s.roll_number  ?? "").trim();
  const g = (s.gender ?? "").trim().toLowerCase();
  const relation = g === "male" ? "S/o" : g === "female" ? "D/o" : "Child of";
  const parts: string[] = [];
  if (name)    parts.push(name);
  if (father)  parts.push(`${relation} ${father}`);
  if (roll)    parts.push(`(Student Roll No-${roll})`);
  if (address) parts.push(`R/o ${address}`);
  return parts.join(", ") + (parts.length > 0 ? "." : "");
}

/** Sanitize a string for use in a filename */
function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

/** Derive file extension from storage path or content-type */
function extFromPath(path: string): string {
  const m = path.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  return m ? m[1].toLowerCase() : "jpg";
}

// ── route ────────────────────────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  // Auth: header token OR ?token= query param (for Telegram download)
  const qToken = req.nextUrl.searchParams.get("token");
  let allowed = false;
  let allowedViaXt = false;
  let sessionProfileId = "";
  let sessionRole = "";
  if (qToken) {
    const { hashToken } = await import("@/lib/token");
    const db2 = createServiceClient();
    const { data: sess } = await db2.from("sessions").select("student_id, profiles(role)")
      .eq("token_hash", hashToken(qToken))
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    const role = (sess?.profiles as any)?.role ?? "";
    if (["admin", "viewer", "super_admin"].includes(role)) {
      allowed = true;
      sessionProfileId = (sess as any)?.student_id ?? "";
      sessionRole = role;
    }
  } else {
    const { user, error } = await requireViewerOrAdmin(req);
    if (!error) {
      allowed = true;
      sessionProfileId = user!.profileId;
      sessionRole = user!.role;
    }
  }
  const { batchId } = await params;

  // Batch-scoped export token (?xt=) — how a WhatsApp admin, who has no website
  // session, downloads this export from a tapped link. Scoped to THIS batch and
  // short-lived, so it can't be used to fetch any other batch.
  if (!allowed && batchId) {
    const xt = req.nextUrl.searchParams.get("xt");
    if (xt) {
      const { validateExportToken } = await import("@/lib/export-token");
      if (await validateExportToken(createServiceClient(), xt, batchId)) {
        allowed = true;
        allowedViaXt = true;
      }
    }
  }

  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!batchId) return NextResponse.json({ error: "Batch ID required" }, { status: 400 });

  // Batch isolation for session-based access: the ?xt= token is already
  // scoped to this batch, so it needs no extra check. A normal admin may
  // only export batches they are assigned to.
  if (!allowedViaXt) {
    if (!(await canAdminAccessBatch(createServiceClient(), sessionProfileId, sessionRole, batchId))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  try {
    const db = createServiceClient();

    // ── 1. Batch info ─────────────────────────────────────────────────────────
    const { data: batch } = await db.from("batches")
      .select("id, name, college")
      .eq("id", batchId)
      .maybeSingle();
    if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

    // ── 2. Students with approved payments only ────────────────────────────────
    const approvedStudentIds = await db.from("payments")
      .select("student_id")
      .eq("status", "approved")
      .eq("batch_id", batchId)
      .then(r => (r.data ?? []).map((p: any) => p.student_id));

    const { data: students } = await db.from("profiles")
      .select("full_name, father_name, phone, home_address, college, branch, year, roll_number, gender, college_id_path")
      .eq("batch_id", batchId)
      // Enrolment, not role — matches the DOCX exhibit this zip accompanies.
      .in("id", approvedStudentIds)
      .order("roll_number", { ascending: true });

    const rows = students ?? [];
    const dateStr = new Date().toLocaleDateString("en-IN", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
    }).toUpperCase();

    // ── 3. Build DOCX ─────────────────────────────────────────────────────────
    const doc = new Document({
      styles: {
        default: {
          document: { run: { font: "Times New Roman", size: 24 } },
        },
      },
      sections: [{
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: {
              top:    convertMillimetersToTwip(25),
              bottom: convertMillimetersToTwip(25),
              left:   convertMillimetersToTwip(30),
              right:  convertMillimetersToTwip(25),
            },
          },
        },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 80 },
            children: [new TextRun({
              text: (batch.college ?? "GNIT").toUpperCase(),
              bold: true, size: 28, font: "Times New Roman",
            })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "000000", space: 4 } },
            children: [new TextRun({
              text: batch.name.toUpperCase(),
              bold: true, size: 26, font: "Times New Roman",
            })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 300 },
            children: [new TextRun({ text: dateStr, size: 22, font: "Times New Roman" })],
          }),
          new Paragraph({
            spacing: { after: 60 },
            children: [
              new TextRun({ text: "Total Students: ", bold: true, size: 22 }),
              new TextRun({ text: String(rows.length), size: 22 }),
            ],
          }),
          new Paragraph({
            spacing: { after: 400 },
            children: [new TextRun({ text: "List of Students", bold: true, size: 22, underline: {} })],
          }),
          ...rows.map((s, i) => new Paragraph({
            spacing: { before: 60, after: 60 },
            indent: { left: 360, hanging: 360 },
            children: [
              new TextRun({ text: `${i + 1}. `, bold: true, size: 22, font: "Times New Roman" }),
              new TextRun({ text: studentLine(s), size: 22, font: "Times New Roman" }),
            ],
          })),
          ...(rows.length === 0 ? [new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 400 },
            children: [new TextRun({
              text: "No students registered in this batch yet.",
              italics: true, size: 22, color: "888888",
            })],
          })] : []),
          new Paragraph({
            spacing: { before: 600 },
            border: { top: { style: BorderStyle.SINGLE, size: 4, color: "999999", space: 4 } },
            children: [new TextRun({
              text: `Generated on ${new Date().toLocaleString("en-IN")} · ${batch.college ?? ""} — ${batch.name}`,
              size: 18, color: "999999",
            })],
          }),
        ],
      }],
    });

    const docxBuffer = await Packer.toBuffer(doc);
    const safeBatch  = safe(batch.name);

    // ── 4. Fetch college ID images from Supabase Storage ─────────────────────
    // Build ZIP entries: { filename: Uint8Array }
    const zipEntries: Record<string, Uint8Array> = {};

    // DOCX goes in root of ZIP
    zipEntries[`${safeBatch}_students.docx`] = new Uint8Array(docxBuffer);

    // College IDs — fetch in parallel, skip if no path stored.
    // college_id_path is either:
    //   "cloudinary:folder/public_id"  → current uploads, fetch from Cloudinary CDN
    //   "uuid/filename.ext"            → legacy uploads, fetch from Supabase Storage
    const idFetches = rows
      .filter(s => s.college_id_path)
      .map(async (s) => {
        try {
          const path = s.college_id_path as string;
          let buf: ArrayBuffer;

          if (isCloudinaryPath(path)) {
            // createDownloadUrl carries the pre-rotation old-cloud
            // fallback (11 Nov 2026): documents uploaded before the
            // 10 Nov Cloudinary key rotation live in the OLD cloud
            // (dpqqwqnsd); building the URL directly against the new
            // cloud 404'd for all 101 of them and the ZIP silently
            // dropped every old ID. Do not build the URL here.
            const url = await createDownloadUrl("docs", path);
            const res = await fetch(url);
            if (!res.ok) return;
            buf = await res.arrayBuffer();
          } else {
            const { data, error } = await db.storage
              .from("student-documents")
              .download(path);
            if (error || !data) return;
            buf = await data.arrayBuffer();
          }

          const ext      = extFromPath(path);
          const namePart = safe(s.full_name   ?? "Unknown");
          const rollPart = safe(s.roll_number ?? "NoRoll");
          const filename = `college_ids/${namePart}_${rollPart}_CollegeID.${ext}`;

          zipEntries[filename] = new Uint8Array(buf);
        } catch (err) { console.error("[api/admin/export/docx/[batchId]/zip]", err);
          // silently skip failed downloads — don't abort entire export
        }
      });

    await Promise.all(idFetches);

    // ── 5. Add a manifest text listing students without a college ID ──────────
    const missing = rows.filter(s => !s.college_id_path)
      .map(s => `${s.roll_number ?? "?"}\t${s.full_name ?? "?"}`);
    if (missing.length > 0) {
      const manifest = `Students without uploaded College ID (${missing.length}):\n\nRoll\tName\n${missing.join("\n")}\n`;
      zipEntries["college_ids/MISSING_IDs.txt"] = strToU8(manifest);
    }

    // ── 6. Create ZIP ─────────────────────────────────────────────────────────
    const zipBuffer = zipSync(zipEntries, { level: 6 });

    return new NextResponse(zipBuffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${safeBatch}_export.zip"`,
      },
    });

  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Export failed" }, { status: 500 });
  }
}
