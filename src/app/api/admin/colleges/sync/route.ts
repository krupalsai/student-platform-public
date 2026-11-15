import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireViewerOrAdmin } from "@/lib/session";
import { invalidateActiveCollegesCache } from "@/lib/services/colleges";

const STATES = [
  "Andaman and Nicobar Islands","Andhra Pradesh","Arunachal Pradesh","Assam","Bihar","Chandigarh",
  "Chhattisgarh","Dadra and Nagar Haveli","Daman and Diu","Delhi","Goa","Gujarat","Haryana","Himachal Pradesh",
  "Jammu and Kashmir","Jharkhand","Karnataka","Kerala","Ladakh","Lakshadweep","Madhya Pradesh","Maharashtra",
  "Manipur","Meghalaya","Mizoram","Nagaland","Odisha","Puducherry","Punjab","Rajasthan","Sikkim","Tamil Nadu",
  "Telangana","Tripura","Uttar Pradesh","Uttarakhand","West Bengal"
];

const YEAR = "2026-2027";

export async function POST(req: NextRequest) {
  const { error } = await requireViewerOrAdmin(req);
  if (error) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const db = createServiceClient();
  const imported = new Map<string, { id: string; name: string; state: string }>();

  for (const state of STATES) {
    const url = new URL("https://facilities.aicte-india.org/dashboard/pages/php/approvedinstituteserver.php");
    url.searchParams.set("method", "fetchdata");
    url.searchParams.set("year", YEAR);
    url.searchParams.set("program", "1");
    url.searchParams.set("level", "1");
    url.searchParams.set("institutiontype", "1");
    url.searchParams.set("Women", "1");
    url.searchParams.set("Minority", "1");
    url.searchParams.set("state", state);
    url.searchParams.set("course", "1");

    try {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (!response.ok) continue;
      const rows = await response.json();
      if (!Array.isArray(rows)) continue;

      for (const row of rows) {
        if (!Array.isArray(row) || !row[0] || !row[1]) continue;
        const id = String(row[0]).trim();
        const name = String(row[1]).replace(/\s+/g, " ").trim();
        if (!id || !name) continue;
        imported.set(id, { id, name, state });
      }
    } catch (e) {
      console.error("[college-sync] state failed", state, e);
    }
  }

  if (!imported.size) {
    return NextResponse.json({ ok: false, error: "AICTE returned no engineering-college records" }, { status: 502 });
  }

  const rows = [...imported.values()].map((c) => ({
    id: c.id,
    name: c.name,
    active: true,
    institution_type: "engineering",
    normalized_name: c.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
    college_code: c.id,
    state: c.state,
    source: "AICTE Approved Institutes 2026-27",
    search_aliases: []
  }));

  for (let i = 0; i < rows.length; i += 500) {
    const { error: upsertError } = await db.from("colleges").upsert(rows.slice(i, i + 500), { onConflict: "id" });
    if (upsertError) {
      console.error("[college-sync] upsert failed", upsertError);
      return NextResponse.json({ ok: false, error: "Database import failed" }, { status: 500 });
    }
  }

  invalidateActiveCollegesCache();
  return NextResponse.json({
    ok: true,
    source: "AICTE Approved Institutes 2026-27",
    imported: rows.length,
    total: rows.length
  });
}
