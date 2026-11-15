import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireViewerOrAdmin } from "@/lib/session";
import { canAdminAccessBatch } from "@/lib/authz";
import {
  Document, Packer, Paragraph, TextRun,
  AlignmentType, HeadingLevel, BorderStyle, convertMillimetersToTwip,
} from "docx";

// Generates a DOCX in the format used by the High Court of Telangana for
// student petition exhibits — numbered list, each entry as a prose line:
//
//   1. Full Name, S/o or D/o Father Name, Aged __, (Student Roll No __),
//      R/o Home Address.
//
// No table — plain numbered paragraphs, matching the court order style.

function genderRelation(gender: string | null | undefined): string {
  const g = (gender ?? "").trim().toLowerCase();
  if (g === "male") return "S/o";
  if (g === "female") return "D/o";
  return "Child of";
}

function studentLine(s: {
  full_name: string | null;
  father_name: string | null;
  home_address: string | null;
  roll_number: string | null;
  year: string | null;
  branch: string | null;
  college: string | null;
  phone: string | null;
  gender: string | null;
}): string {
  const name      = (s.full_name ?? "").trim();
  const father    = (s.father_name ?? "").trim();
  const address   = (s.home_address ?? "").trim();
  const roll      = (s.roll_number ?? "").trim();
  const relation  = genderRelation(s.gender);

  // Build the prose line exactly as in the court document
  const parts: string[] = [];
  if (name)    parts.push(name);
  if (father)  parts.push(`${relation} ${father}`);
  if (roll)    parts.push(`(Student Roll No-${roll})`);
  if (address) parts.push(`R/o ${address}`);
  return parts.join(", ") + (parts.length > 0 ? "." : "");
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  // Auth: accept both header token and ?token= query param (for Telegram download)
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

    const { data: batch } = await db.from("batches")
      .select("id, name, college")
      .eq("id", batchId)
      .maybeSingle();
    if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

    // Only include students whose payment is approved.
    const approvedStudentIds = await db.from("payments")
      .select("student_id")
      .eq("status", "approved")
      .eq("batch_id", batchId)
      .then(r => (r.data ?? []).map((p: any) => p.student_id));

    const { data: students } = approvedStudentIds.length > 0
      ? await db.from("profiles")
          .select("full_name, father_name, phone, home_address, college, branch, year, roll_number, gender")
          .eq("batch_id", batchId)
          // Enrolment, not role — an admin who registered and paid is a real
          // petitioner and must appear in this court exhibit. See
          // services/enrollment.ts.
          .in("id", approvedStudentIds)
          .order("roll_number", { ascending: true })
      : { data: [] };

    const rows = students ?? [];

    // This export is a court-exhibit style document (see comment above) —
    // ONLY students with an approved payment appear, by design. That's easy
    // to mistake for a broken/empty export when a batch has real registered
    // students but nobody has paid yet (e.g. a fresh batch whose fee hasn't
    // been set, so payments are blocked) — say so explicitly instead of the
    // old "No students registered" line, which was flatly wrong in that case.
    let registeredCount = 0;
    if (rows.length === 0) {
      const { count } = await db.from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("batch_id", batchId)
        .eq("is_profile_complete", true); // enrolment, not role
      registeredCount = count ?? 0;
    }
    const today = new Date();
    const dateStr = today.toLocaleDateString("en-IN", {
      weekday: "long", day: "numeric", month: "long", year: "numeric"
    }).toUpperCase();

    // ── Document ──────────────────────────────────────────────────────────────
    const doc = new Document({
      styles: {
        default: {
          document: { run: { font: "Times New Roman", size: 24 } },
        },
      },
      sections: [{
        properties: {
          page: {
            size: { width: 12240, height: 15840 }, // US Letter
            margin: {
              top:    convertMillimetersToTwip(25),
              bottom: convertMillimetersToTwip(25),
              left:   convertMillimetersToTwip(30),
              right:  convertMillimetersToTwip(25),
            },
          },
        },
        children: [

          // Institution header (matches court doc style)
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 80 },
            children: [new TextRun({
              text: (batch.college ?? "GNIT").toUpperCase(),
              bold: true, size: 28, font: "Times New Roman",
            })],
          }),

          // Batch name as title
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "000000", space: 4 } },
            children: [new TextRun({
              text: batch.name.toUpperCase(),
              bold: true, size: 26, font: "Times New Roman",
            })],
          }),

          // Date line
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 300 },
            children: [new TextRun({
              text: dateStr,
              size: 22, font: "Times New Roman",
            })],
          }),

          // Meta info
          new Paragraph({
            spacing: { after: 60 },
            children: [
              new TextRun({ text: "Total Students: ", bold: true, size: 22 }),
              new TextRun({ text: String(rows.length), size: 22 }),
            ],
          }),
          new Paragraph({
            spacing: { after: 400 },
            children: [
              new TextRun({ text: "List of Students", bold: true, size: 22, underline: {} }),
            ],
          }),

          // Numbered student list — court format
          ...rows.map((s, i) => new Paragraph({
            spacing: { before: 60, after: 60 },
            indent: { left: 360, hanging: 360 },  // hanging indent for number alignment
            children: [
              new TextRun({
                text: `${i + 1}. `,
                bold: true, size: 22, font: "Times New Roman",
              }),
              new TextRun({
                text: studentLine(s),
                size: 22, font: "Times New Roman",
              }),
            ],
          })),

          // Empty rows placeholder — accurate about WHY it's empty (bug: this
          // used to say "no students registered" even when there were
          // registered students, just none with an approved payment yet).
          ...(rows.length === 0 ? [new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 400 },
            children: [new TextRun({
              text: registeredCount > 0
                ? `This list only includes students with an approved payment. ${registeredCount} student${registeredCount === 1 ? " is" : "s are"} registered in this batch but none have an approved payment yet.`
                : "No students registered in this batch yet.",
              italics: true, size: 22, color: "888888",
            })],
          })] : []),

          // Footer separator
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

    const buffer = await Packer.toBuffer(doc);
    const safeName = batch.name.replace(/[^a-zA-Z0-9_-]+/g, "_");

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${safeName}_students.docx"`,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Export failed" }, { status: 500 });
  }
}
