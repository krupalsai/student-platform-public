import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireViewerOrSuperAdmin } from "@/lib/session";
import { ok, forbidden } from "@/lib/api-response";

export async function GET(req: NextRequest) {
  const { error } = await requireViewerOrSuperAdmin(req);
  if (error) return forbidden();

  const db = createServiceClient();
  const metrics: {
    label: string;
    score: number;
    detail: string;
    status: "ok" | "warn" | "error";
    rows?: Record<string, string | number>[];
  }[] = [];

  // ── Database ──────────────────────────────────────────────────────────────
  try {
    const t0 = Date.now();
    const { count } = await db.from("profiles").select("id", { count: "exact", head: true });
    const ms = Date.now() - t0;
    const score = ms < 300 ? 100 : ms < 800 ? 80 : ms < 1500 ? 60 : 40;
    metrics.push({
      label: "Database", score, status: ms < 1500 ? "ok" : "warn",
      detail: `${count ?? 0} profiles · ${ms}ms response`,
      rows: [
        { key: "Response time", value: `${ms}ms` },
        { key: "Status", value: ms < 800 ? "✅ Fast" : "⚠️ Slow" },
        { key: "Total profiles", value: count ?? 0 },
      ],
    });
  } catch (e: any) {
    metrics.push({ label: "Database", score: 0, status: "error", detail: e?.message ?? "Query failed" });
  }

  // ── Profiles (paid students only) ─────────────────────────────────────────
  // Health is measured against students who have PAID — a student who paid but
  // has an incomplete profile is a real problem; someone who opened the bot and
  // never enrolled is noise.
  //
  // This previously counted profiles.payment_status = "verified". THAT COLUMN
  // DOES NOT EXIST. PostgREST returns an error object rather than throwing, so
  // the count came back null, every figure rendered as 0, and the panel showed
  // a green "No paid students yet" with a perfect score — against 32 approved
  // payments. A broken check that reports healthy is worse than no check, so
  // this now derives from the payments table and marks itself ERROR if any of
  // its queries fail instead of quietly reporting zero.
  try {
    const [approvedRes, totalRes, adminRes] = await Promise.all([
      db.from("payments").select("student_id").eq("status", "approved"),
      db.from("profiles").select("id", { count: "exact", head: true }).eq("role", "student"),
      db.from("profiles").select("id", { count: "exact", head: true }).in("role", ["admin", "viewer", "super_admin"]),
    ]);
    if (approvedRes.error) throw approvedRes.error;
    if (totalRes.error) throw totalRes.error;

    // DISTINCT: one student can hold two payment rows (item #100).
    const paidIds = Array.from(new Set((approvedRes.data ?? []).map((r: { student_id: string }) => r.student_id)));
    const paid = paidIds.length;

    // Chunked — .in() is a querystring, and this list grows with every batch
    // (item #102).
    let complete = 0;
    for (let i = 0; i < paidIds.length; i += 200) {
      const { count, error } = await db
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .in("id", paidIds.slice(i, i + 200))
        .eq("is_profile_complete", true);
      if (error) throw error;
      complete += count ?? 0;
    }

    const total = totalRes.count ?? 0;
    const pct = paid > 0 ? Math.round((complete / paid) * 100) : 100;
    const score = paid === 0 ? 100 : pct >= 80 ? 100 : pct >= 50 ? 70 : 40;
    const status = paid === 0 ? "ok" : pct >= 50 ? "ok" : "warn";

    metrics.push({
      label: "Profiles", score, status,
      detail: paid === 0
        ? "No paid students yet"
        : `${complete}/${paid} paid students have complete profiles (${pct}%)`,
      rows: [
        { key: "Paid students", value: paid },
        { key: "Complete profiles (paid)", value: complete },
        { key: "Incomplete (paid)", value: paid - complete },
        { key: "Unpaid / just visited", value: Math.max(total - paid, 0) },
        { key: "Admin/Viewer accounts", value: adminRes.count ?? 0 },
        { key: "Completion rate (paid)", value: `${pct}%` },
      ],
    });
  } catch (err) {
    console.error("[api/admin/health] profiles metric failed", err);
    metrics.push({ label: "Profiles", score: 0, status: "error", detail: "Profile query failed" });
  }

  // ── Sessions ──────────────────────────────────────────────────────────────
  try {
    const [{ count: active }, { count: total }] = await Promise.all([
      db.from("sessions").select("id", { count: "exact", head: true }).gt("expires_at", new Date().toISOString()),
      db.from("sessions").select("id", { count: "exact", head: true }),
    ]);
    const a = active ?? 0;
    const t = total ?? 0;
    const expired = t - a;
    const score = expired > 500 ? 60 : expired > 100 ? 80 : 100;
    metrics.push({
      label: "Sessions", score, status: expired > 500 ? "warn" : "ok",
      detail: `${a} active · ${expired} expired`,
      rows: [
        { key: "Active sessions", value: a },
        { key: "Expired sessions", value: expired },
        { key: "Total", value: t },
        { key: "Status", value: expired > 100 ? "⚠️ Cleanup recommended" : "✅ Healthy" },
      ],
    });
  } catch (err) { console.error("[api/admin/health]", err);
    metrics.push({ label: "Sessions", score: 0, status: "error", detail: "Session query failed" });
  }

  // ── Batches ───────────────────────────────────────────────────────────────
  try {
    const { data: batches } = await db.from("batches").select("id,name,status,college,fee_amount");
    const all = batches ?? [];
    const active = all.filter((b: any) => b.status === "active");
    metrics.push({
      label: "Batches", score: 100, status: "ok",
      detail: all.length === 0 ? "No batches yet" : `${active.length} active · ${all.length - active.length} inactive`,
      rows: all.length === 0
        ? [{ key: "Status", value: "✅ No batches yet — ready to create" }]
        : all.map((b: any) => ({ key: b.name, value: `${b.status} · ${b.college ?? "All"} · ₹${b.fee_amount ?? "?"}` })),
    });
  } catch (err) { console.error("[api/admin/health]", err);
    metrics.push({ label: "Batches", score: 0, status: "error", detail: "Batch query failed" });
  }

  // ── Storage (Supabase) ───────────────────────────────────────────────────
  let totalMB = 0;
  try {
    const screenshotBucket = process.env.STORAGE_SCREENSHOTS_BUCKET ?? "payment-screenshots";
    const documentBucket   = process.env.STORAGE_DOCUMENTS_BUCKET   ?? "student-documents";
    const [shots, docs] = await Promise.all([
      db.storage.from(screenshotBucket).list("", { limit: 1000 }),
      db.storage.from(documentBucket).list("", { limit: 1000 }),
    ]);
    const shotCount = shots.data?.length ?? 0;
    const docCount  = docs.data?.length  ?? 0;
    const shotSize  = shots.data?.reduce((s: number, f: any) => s + (f.metadata?.size ?? 0), 0) ?? 0;
    const docSize   = docs.data?.reduce((s: number, f: any)  => s + (f.metadata?.size ?? 0), 0) ?? 0;
    totalMB = Math.round((shotSize + docSize) / (1024 * 1024) * 10) / 10;
    const usedPct = Math.round((totalMB / 1024) * 100);
    const needsMigration = totalMB > 800;
    const ok_ = !shots.error && !docs.error;
    metrics.push({
      label: "Storage", score: ok_ ? (needsMigration ? 60 : 100) : 60,
      status: ok_ ? (needsMigration ? "warn" : "ok") : "warn",
      detail: ok_ ? `${shotCount} screenshots · ${docCount} documents · ${totalMB} MB used`
                  : `Issue: ${shots.error?.message ?? docs.error?.message}`,
      rows: ok_ ? [
        { key: "Screenshots",          value: `${shotCount} files` },
        { key: "Documents",            value: `${docCount} files` },
        { key: "Total size",           value: `${totalMB} MB` },
        { key: "Free tier limit",      value: "1024 MB (1 GB)" },
        { key: "Used",                 value: `${usedPct}%` },
        { key: "Cloudinary migration", value: needsMigration ? "⚠️ Required soon" : "✅ Not needed yet" },
      ] : [{ key: "Error", value: shots.error?.message ?? docs.error?.message ?? "Unknown" }],
    });
  } catch (err) { console.error("[api/admin/health]", err);
    metrics.push({ label: "Storage", score: 0, status: "error", detail: "Storage unreachable" });
  }

  // ── Cloudinary ───────────────────────────────────────────────────────────
  try {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME ?? "";
    const apiKey    = process.env.CLOUDINARY_API_KEY    ?? "";
    const apiSecret = process.env.CLOUDINARY_API_SECRET ?? "";
    const configured = Boolean(cloudName && apiKey && apiSecret);

    let usageData: any = null;
    let pingMs = 0;
    if (configured) {
      try {
        const t0 = Date.now();
        const authStr = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
        const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/usage`, {
          headers: { Authorization: `Basic ${authStr}` },
          signal: AbortSignal.timeout(5000),
        });
        pingMs = Date.now() - t0;
        if (res.ok) usageData = await res.json();
      } catch (err) { console.error("[api/admin/health]", err); /* timeout */ }
    }

    const storageMB  = usageData ? Math.round((usageData.storage?.usage ?? 0) / (1024*1024) * 10) / 10 : null;
    const rawLimitMB = usageData ? Math.round((usageData.storage?.limit  ?? 0) / (1024*1024)) : null;
    const limitMB    = rawLimitMB === 0 ? 25600 : rawLimitMB;
    const usedPct    = storageMB != null && limitMB ? Math.round((storageMB / limitMB) * 100) : null;
    const transforms = usageData?.transformations?.usage ?? null;
    const bwMB       = usageData ? Math.round((usageData.bandwidth?.usage ?? 0) / (1024*1024) * 10) / 10 : null;
    const reachable  = usageData !== null;

    const score  = !configured ? 40 : !reachable ? 70 : (usedPct ?? 0) > 90 ? 60 : 100;
    const status = !configured ? "warn" : !reachable ? "warn" : (usedPct ?? 0) > 90 ? "warn" : "ok" as "ok"|"warn"|"error";

    const rows: { key: string; value: string | number }[] = [
      { key: "Credentials", value: configured ? "✅ Set" : "❌ Missing" },
      { key: "Connection",  value: !configured ? "—" : reachable ? `✅ Online (${pingMs}ms)` : "⚠️ Could not reach" },
    ];
    if (storageMB !== null) rows.push({ key: "Storage used", value: `${storageMB} MB` });
    if (limitMB !== null)   rows.push({ key: "Storage limit", value: limitMB >= 1024 ? `${Math.round(limitMB/1024)} GB` : `${limitMB} MB` });
    if (usedPct !== null)   rows.push({ key: "Usage", value: `${usedPct}%` });
    if (transforms !== null) rows.push({ key: "Transformations", value: transforms });
    if (bwMB !== null)      rows.push({ key: "Bandwidth used", value: `${bwMB} MB` });

    metrics.push({
      label: "Cloudinary", score, status,
      detail: !configured ? "Credentials not configured"
            : !reachable  ? "Credentials set · could not reach API"
            : `${storageMB ?? 0} MB used · ${usedPct ?? 0}% of limit · ${pingMs}ms`,
      rows,
    });
  } catch (e: any) {
    metrics.push({ label: "Cloudinary", score: 0, status: "error", detail: e?.message ?? "Cloudinary check failed" });
  }

  // ── WhatsApp broadcast reach ──────────────────────────────────────────────
  // FREE-ONLY (owner rule, 2026-10-26): no paid broadcast template is in use.
  // Broadcasts send free-form text only to students inside Meta's 24h window;
  // everyone outside it is not reached, never billed. Surfaced here so the
  // limited reach is visible before a send rather than discovered afterwards.
  metrics.push({
    label: "WhatsApp broadcast",
    score: 70,
    status: "warn",
    detail: "Free-form only — only students who messaged in the last 24h can be reached. No paid template in use.",
    rows: [
      { key: "Template", value: "none (removed)" },
      { key: "Reach", value: "24h window only" },
    ],
  });

  // ── WhatsApp messages left (free tier) ───────────────────────────────────
  // Source of truth: whatsapp_monthly_usage (migration 0083) — service_sent
  // counts non-template replies against the 1,000 free service messages per
  // UTC calendar month; template sends are billed separately and never touch
  // the allowance. Display only — this never claims a slot or changes the
  // guard in src/lib/whatsapp/client.ts. The score IS the percent left, so
  // the card's bar literally shows what remains.
  try {
    const waLimit = Math.max(1, Number(process.env.WHATSAPP_SERVICE_MONTHLY_LIMIT ?? "1000"));
    const waMonth = new Date().toISOString().slice(0, 7); // 'YYYY-MM' UTC
    const { data: waUsageData, error: waError } = await db
      .from("whatsapp_monthly_usage")
      .select("service_sent, template_sent")
      .eq("month", waMonth)
      .maybeSingle();
    if (waError) throw waError;
    const waUsage = waUsageData as { service_sent?: number | null; template_sent?: number | null } | null;
    const waUsed = waUsage?.service_sent ?? 0;
    const waTemplates = waUsage?.template_sent ?? 0;
    const waLeft = Math.max(waLimit - waUsed, 0);
    const waPctLeft = Math.round((waLeft / waLimit) * 100);
    const [waYear, waMon] = waMonth.split("-").map(Number);
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const waMonthLabel = `${monthNames[(waMon ?? 1) - 1] ?? ""} ${waYear}`;
    const waNext = waMon === 12 ? { y: (waYear ?? 0) + 1, m: 1 } : { y: waYear, m: (waMon ?? 1) + 1 };
    // Reset instant: 1st of next month 00:00 UTC. Display it in IST
    // (Asia/Kolkata, UTC+5:30 year-round) — a real timezone conversion of
    // that instant, not a relabelled UTC time. So 1 Nov 00:00 UTC renders
    // as "1 Nov 2026, 5:30 AM IST".
    const waResetInstant = new Date(Date.UTC(waNext.y, (waNext.m ?? 1) - 1, 1, 0, 0, 0));
    const waResetDate = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }).format(waResetInstant);
    const waResetTime = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).format(waResetInstant);
    const waResetLabel = `${waResetDate}, ${waResetTime} IST`;
    metrics.push({
      label: "WhatsApp messages",
      score: waPctLeft,
      status: waLeft === 0 ? "warn" : waLeft <= 100 ? "warn" : "ok",
      detail: waLeft === 0
        ? `Free messages exhausted for ${waMonthLabel} — bot stays silent until ${waResetLabel}`
        : `${waUsed} used · ${waLeft} left of ${waLimit.toLocaleString("en-IN")} (${waPctLeft}% left) · resets ${waResetLabel}`,
      rows: [
        { key: "Month", value: waMonthLabel },
        { key: "Messages used", value: waUsed },
        { key: "Messages left", value: `${waLeft} of ${waLimit.toLocaleString("en-IN")}` },
        { key: "Left", value: `${waPctLeft}%` },
        { key: "Template messages (billed separately)", value: waTemplates },
        { key: "Resets", value: waResetLabel },
      ],
    });
  } catch {
    metrics.push({
      label: "WhatsApp messages",
      score: 50,
      status: "warn",
      detail: "Usage data unavailable — could not read whatsapp_monthly_usage (migration 0083)",
      rows: [
        { key: "Month", value: new Date().toISOString().slice(0, 7) },
        { key: "Free limit", value: "1,000 / month (UTC)" },
        { key: "Resets", value: "1st of next month, 5:30 AM IST" },
      ],
    });
  }

  return ok(metrics);
}


