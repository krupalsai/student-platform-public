import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireViewerOrAdmin } from "@/lib/session";
import { adminBatchIds } from "@/lib/authz";
import * as XLSX from "xlsx";

export async function GET(req: NextRequest) {
  // Browser-initiated file downloads cannot set Authorization headers.
  // Accept a session token in the URL for this download path and validate it
  // server-side before returning any student data.
  let profileId = "";
  let role = "";
  const qToken = req.nextUrl.searchParams.get("token");
  if (qToken) {
    const { hashToken } = await import("@/lib/token");
    const db = createServiceClient();
    const { data: sess } = await db
      .from("sessions")
      .select("student_id, profiles(role)")
      .eq("token_hash", hashToken(qToken))
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    role = (sess?.profiles as any)?.role ?? "";
    profileId = (sess as any)?.student_id ?? "";
    if (!["admin", "viewer", "super_admin"].includes(role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else {
    const { user, error } = await requireViewerOrAdmin(req);
    if (error) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    profileId = user!.profileId;
    role = user!.role;
  }

  const p = req.nextUrl.searchParams;
  const format  = p.get("format") ?? "xlsx";
  const college = p.get("college") ?? "";
  const status  = p.get("status") ?? "";

  const db = createServiceClient();

  // Batch isolation: normal admins/viewers only export their assigned
  // batches (super_admin → null = all batches; no assignments → empty file).
  const assignedBatchIds = await adminBatchIds(db, profileId, role);

  // Join profiles for father_name + home_address not in the view
  let data: any[] | null = null;
  if (assignedBatchIds !== null && assignedBatchIds.length === 0) {
    data = [];
  } else {
    let q = db.from("admin_payment_queue").select("*, profiles!inner(father_name, home_address)").order("college").order("batch_name").order("roll_number");
    if (college) q = (q as any).eq("college", college);
    if (status)  q = (q as any).eq("payment_status", status);
    if (assignedBatchIds !== null) q = q.in("batch_id", assignedBatchIds);
    ({ data } = await q);
  }

  // Keep student-supplied strings literal in spreadsheet software.
  const spreadsheetText = (value: unknown): string => {
    const text = String(value ?? "");
    return /^[\s\u0000-\u001f]*[=+\-@]/.test(text) ? "'" + text : text;
  };

  const rows = (data ?? []).map((r: any) => ({
    "Name":         spreadsheetText(r.full_name        ?? ""),
    "Father Name":  spreadsheetText(r.profiles?.father_name ?? ""),
    "Phone":        spreadsheetText(r.phone            ?? ""),
    "Home Address": spreadsheetText(r.profiles?.home_address ?? ""),
    "College":      spreadsheetText(r.college          ?? ""),
    "Batch":        spreadsheetText(r.batch_name       ?? ""),
    "Roll Number":  spreadsheetText(r.roll_number      ?? ""),
    "Branch":       spreadsheetText(r.branch           ?? ""),
    "Year":         spreadsheetText(r.year             ?? ""),
    "UTR":          spreadsheetText(r.utr_number       ?? ""),
    "Amount (₹)":   r.amount           ?? 0,
    "Payment Status": spreadsheetText(r.payment_status ?? ""),
    "Submitted At": spreadsheetText(r.submitted_at     ?? ""),
  }));

  const date = new Date().toISOString().slice(0, 10);

  if (format === "csv") {
    const ws  = XLSX.utils.json_to_sheet(rows);
    const csv = XLSX.utils.sheet_to_csv(ws);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="students_${date}.csv"`,
      },
    });
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);

  // Column widths (approximate characters)
  ws["!cols"] = [22, 22, 14, 30, 8, 18, 14, 10, 6, 16, 16, 10, 16, 22].map(w => ({ wch: w }));

  // Freeze header row
  ws["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft" };

  // Bold header row
  const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[cell]) {
      ws[cell].s = {
        font: { bold: true, color: { rgb: "FFFFFF" } },
        fill: { fgColor: { rgb: "1E3A8A" } },
        alignment: { horizontal: "center", wrapText: true },
      };
    }
  }

  XLSX.utils.book_append_sheet(wb, ws, "Students");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx", bookSST: false });
  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="students_${date}.xlsx"`,
    },
  });
}
