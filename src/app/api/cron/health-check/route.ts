/**
 * /api/cron/health-check  (GET)
 *
 * Runs on a schedule (see .github/workflows/health-check.yml — GitHub
 * Actions cron, not Vercel Cron, so this isn't limited by Vercel plan
 * cron-frequency restrictions). Each run:
 *
 *   1. Pulls unreported rows from `system_errors` (populated by
 *      src/lib/system-errors.ts, called from route catch blocks, and by
 *      /api/client-error for client-side telemetry).
 *   2. Groups/dedupes them and sends the batch to AI triage
 *      (src/lib/ai-triage.ts): Claude first while under the self-tracked
 *      monthly budget, automatically handing off to Gemini once that budget
 *      is spent or if Claude errors — see that file for why this is a
 *      self-tracked budget rather than a real "check remaining credit" call.
 *   3. Alert policy (Krupal's standing rule, 2026-10-20): admins are
 *      WhatsApped ONLY about verified, material server-side failures
 *      (triage severity high/critical), in plain language.
 *        - Client telemetry (route `client/*` — stuck launch covers,
 *          unhandled rejections on a student's phone, reload loops) is
 *          LOG-ONLY: it stays in `system_errors`, is marked handled, and
 *          never messages an admin.
 *        - Errors from a payment gateway that is NOT the active one
 *          (app_settings: razorpay_enabled / cashfree_enabled /
 *          phonepe_enabled) are expected, not incidents: the admin
 *          switched the live gateway, and the old gateway's API now
 *          rejects calls ("transactions are not enabled"). Those groups
 *          are never triaged or alerted; they are marked handled with a
 *          note naming the active gateway. (2026-10-26: Cashfree was off
 *          and Razorpay live, yet api/cashfree/initiate was WhatsApped
 *          as a serious server problem.)
 *        - The AI summary is NOT sent to admins: it describes the whole
 *          triaged batch, including groups that were not alerted, so it
 *          reads as "a variety of server errors" when only one group was
 *          flagged. The report lists only the alerted groups, each with
 *          its own cause. Triage itself only ever sees server groups.
 *        - If AI triage is unavailable, server errors are HELD — left
 *          unreported so a later run can triage them — and never forwarded
 *          to admins as a raw error dump.
 *        - DETERMINISTIC LAYER (14 Nov 2026): holding everything silently
 *          while triage is down left a real, all-day server failure
 *          (court-case live refresh failing since the morning, dozens of
 *          rows) invisible. So this route ALSO probes the app itself
 *          (home /api/health) and counts recent server errors per route
 *          without any AI. When a deterministic signal fires — home down,
 *          or one server route failing 20+ times in 24h — admins get ONE
 *          plain-language alert saying what broke, what students see and
 *          what was already tried, with a 6h cooldown per route so it
 *          cannot spam. Client telemetry stays log-only throughout.
 *   4. When the triage engine is confident about a server-side fix, opens
 *      a GitHub issue containing the suggested fix for human review. It
 *      does NOT push straight to `main` or open a PR that could get
 *      auto-merged — this is a live payments platform; an unreviewed AI
 *      patch landing in production unattended is a worse outage than the
 *      one it's trying to catch. A human merges.
 *
 * Auth: same convention as /api/admin/payments/reconcile-pending —
 * `Authorization: Bearer <CRON_SECRET>` / `x-cron-secret: <CRON_SECRET>`,
 * or a normal admin session (for manual triggering).
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getActiveAdminPhones } from "@/lib/whatsapp/admin";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { requireAdmin } from "@/lib/session";
import { triage, type ErrorGroup } from "@/lib/ai-triage";

function authorize(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization") ?? "";
  if (cronSecret && (authHeader === `Bearer ${cronSecret}` || req.headers.get("x-cron-secret") === cronSecret)) {
    return true;
  }
  return false;
}

async function notifyAdmins(db: ReturnType<typeof createServiceClient>, text: string): Promise<void> {
  // Telegram is no longer used — admins are reached on WhatsApp.
  const phones = await getActiveAdminPhones(db).catch(() => [] as string[]);
  for (const phone of phones) {
    await sendWhatsAppText(phone, text).catch((e) =>
      console.error("[api/cron/health-check] notifyAdmins WhatsApp failed:", e),
    );
  }
}

async function openGithubIssue(title: string, body: string): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO; // e.g. "krupalsai/student-platform"
  if (!token || !repo) {
    console.warn("health-check: GITHUB_TOKEN/GITHUB_REPO not set — skipping issue creation");
    return;
  }
  await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body, labels: ["auto-detected", "needs-review"] }),
  }).catch((e) => console.error("health-check: GitHub issue creation failed", e));
}

type PaymentGatewayName = "razorpay" | "cashfree" | "phonepe";

/**
 * Deterministic home probe: does the app itself answer? 8s bound so a
 * hung homepage cannot stall the whole 15-min check.
 */
async function probeHome(): Promise<{ ok: boolean; ms: number; status: number | null }> {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://studentplatform.dev").replace(/\/$/, "");
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${appUrl}/api/health`, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    return { ok: res.ok, ms: Date.now() - start, status: res.status };
  } catch {
    return { ok: false, ms: Date.now() - start, status: null };
  }
}

/**
 * Plain-language cause for the server routes that fail repeatedly, written
 * from what the route actually does — never a guess about the underlying
 * provider. Unknown routes get a factual fallback (route + message).
 */
function deterministicCause(route: string, message: string): string {
  if (route === "court-case/getBatchCaseStatus") {
    return "Deterministic check: the High Court case-status lookup is failing, so case pages show the last saved status instead of a fresh one. Students see old case info and report the app as broken.";
  }
  return `Deterministic check: server route ${route} is failing repeatedly (${message}).`;
}

/** Unreported server errors per route in the last 24h (client rows excluded). */
async function recentServerCounts(db: ReturnType<typeof createServiceClient>): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data } = await db
      .from("system_errors")
      .select("route")
      .eq("reported", false)
      .gte("created_at", since)
      .limit(500);
    for (const r of (data ?? []) as { route: string }[]) {
      if (r.route.startsWith("client/")) continue;
      counts.set(r.route, (counts.get(r.route) ?? 0) + 1);
    }
  } catch {
    /* a failed count is not an incident by itself */
  }
  return counts;
}

/** True when this route already got a deterministic alert in the last 6h. */
async function recentDeterministicAlert(
  db: ReturnType<typeof createServiceClient>,
  route: string,
): Promise<boolean> {
  try {
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { data } = await db
      .from("system_errors")
      .select("id")
      .eq("route", route)
      .eq("reported", true)
      .gte("created_at", since)
      .like("groq_analysis->>likely_cause", "Deterministic check:%")
      .limit(1);
    return (data ?? []).length > 0;
  } catch {
    return false;
  }
}

/** "api/cashfree/initiate" → "cashfree"; any other route → null. */
function gatewayForRoute(route: string): PaymentGatewayName | null {
  const m = route.match(/^api\/(razorpay|cashfree|phonepe)\//);
  return m ? (m[1] as PaymentGatewayName) : null;
}

/**
 * Which payment gateway is live, read from app_settings (same keys and
 * priority — Razorpay > Cashfree > PhonePe — as
 * src/lib/payments/payment-settings.ts getActivePaymentGateway; that
 * module is deliberately not imported here, so this cron route has no
 * dependency on the payments code it is watching). Returns undefined
 * when the settings cannot be read, so the caller suppresses nothing;
 * null when no gateway is enabled at all.
 */
async function getActivePaymentGateway(
  db: ReturnType<typeof createServiceClient>,
): Promise<PaymentGatewayName | null | undefined> {
  try {
    const { data, error } = await db
      .from("app_settings")
      .select("key, value")
      .in("key", ["razorpay_enabled", "cashfree_enabled", "phonepe_enabled"]);
    if (error || !data) return undefined;
    const settings: Record<string, string> = {};
    for (const r of data as { key: string; value: string }[]) settings[r.key] = r.value;
    if (settings.razorpay_enabled === "true") return "razorpay";
    if (settings.cashfree_enabled === "true") return "cashfree";
    if (settings.phonepe_enabled === "true") return "phonepe";
    return null;
  } catch {
    return undefined;
  }
}

export async function GET(req: NextRequest) {
  if (!authorize(req)) {
    const { error } = await requireAdmin(req);
    if (error) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = createServiceClient();

  // ── Deterministic probes (no AI) ──────────────────────────────────────
  // The home probe proves the app itself answers; the system_errors fetch
  // below proves Supabase answers. Either failing is a verdict on its own,
  // even with zero new error rows.
  const homeProbe = await probeHome();
  const checks = {
    home: homeProbe,
    database: "ok" as const,
    ai_triage: "unknown" as string | null,
  };

  const { data: rows, error: fetchErr } = await db
    .from("system_errors")
    .select("id, route, message, created_at")
    .eq("reported", false)
    .order("created_at", { ascending: true })
    .limit(200);

  if (fetchErr) {
    console.error("health-check: failed to fetch system_errors", fetchErr);
    return NextResponse.json({ ok: false, error: fetchErr.message }, { status: 500 });
  }

  if (!rows || rows.length === 0) {
    // No new errors — but a down homepage is still an incident, and the
    // old code returned "no new errors" while the app was unreachable.
    let notified = false;
    if (!homeProbe.ok) {
      await notifyAdmins(
        db,
        `🩺 <b>Health Check</b>\n\n🔴 <b>The Student App is not answering.</b>\nThe home page check failed (${homeProbe.status ?? "no response"} in ${homeProbe.ms}ms).\n\nWhat students see: the app does not open at all.\nWhat was already tried: this is a direct check, not a guess — no automatic fix was attempted.\n\nCheck Vercel / Supabase status. Students reporting "app not working" will be told it is reported.`,
      );
      notified = true;
    }
    return NextResponse.json({
      ok: homeProbe.ok,
      verdict: homeProbe.ok ? "ok" : "down",
      checks,
      message: homeProbe.ok ? "no new errors since last run" : "home page is not answering",
      notified,
    });
  }

  // Dedupe by route+message
  const groupMap = new Map<string, ErrorGroup>();
  for (const row of rows) {
    const key = `${row.route}::${row.message}`;
    const existing = groupMap.get(key);
    if (existing) {
      existing.occurrences++;
      existing.sample_ids.push(row.id);
      existing.last_seen = row.created_at;
    } else {
      groupMap.set(key, {
        route: row.route,
        message: row.message,
        occurrences: 1,
        sample_ids: [row.id],
        first_seen: row.created_at,
        last_seen: row.created_at,
      });
    }
  }
  const groups = Array.from(groupMap.values());

  // --- Alert policy (see header): client telemetry is log-only; server
  // errors alert only when triage verified them as high/critical; with no
  // triage engine available, server errors are held silently, never dumped.
  const isClientGroup = (g: ErrorGroup) => g.route.startsWith("client/");
  const clientGroups = groups.filter(isClientGroup);
  const serverGroups = groups.filter((g) => !isClientGroup(g));

  // Errors from a payment gateway that is not the active one are
  // expected, not incidents: the admin switched the live gateway, and the
  // old gateway's API now rejects calls ("transactions are not enabled").
  // Never triage or alert them; mark them handled with a note naming the
  // active gateway. Unknown active gateway (settings read failed) means
  // no suppression — a real payment outage must never be silently
  // dropped because of a failed settings read.
  const activeGateway = await getActivePaymentGateway(db);
  const inactiveGatewayGroups: ErrorGroup[] = [];
  const triageServerGroups: ErrorGroup[] = [];
  for (const g of serverGroups) {
    const gw = gatewayForRoute(g.route);
    if (activeGateway !== undefined && gw && gw !== activeGateway) inactiveGatewayGroups.push(g);
    else triageServerGroups.push(g);
  }
  if (inactiveGatewayGroups.length > 0) {
    console.log(
      `health-check: ${inactiveGatewayGroups.length} error group(s) from inactive payment gateway(s) ` +
        `(active: ${activeGateway ?? "none"}) — logged only, never alerted: ` +
        inactiveGatewayGroups.map((g) => `${g.route} ×${g.occurrences}`).join(", "),
    );
  }

  // Triage sees server errors only. Client telemetry is log-only, and its
  // kinds must not leak into the triage summary (the 2026-10-26 alert
  // described "a script error ... and a reload loop" from client rows
  // while only one server group was actually flagged).
  const result = triageServerGroups.length > 0 ? await triage(db, triageServerGroups) : null;
  checks.ai_triage = result?.engine ?? null;
  const triageByKey = new Map((result?.groups ?? []).map((g) => [`${g.route}::${g.message}`, g]));

  const alertGroups = result
    ? triageServerGroups.filter((g) => {
        const a = triageByKey.get(`${g.route}::${g.message}`);
        return a !== undefined && (a.severity === "high" || a.severity === "critical");
      })
    : [];
  const heldServerGroups = result ? [] : triageServerGroups;

  let notified = false;
  if (result && alertGroups.length > 0) {
    // No AI summary here on purpose: it describes the whole triaged batch,
    // including groups that were not alerted, so it reads as "a variety of
    // server errors" when only the groups below were flagged. The per-group
    // lines are the complete, scoped report.
    let report = `🩺 <b>Health Check</b>\n\n${alertGroups.length} serious server problem(s) need attention:\n\n`;
    for (const g of alertGroups) {
      const a = triageByKey.get(`${g.route}::${g.message}`)!;
      const icon = a.severity === "critical" ? "🔴" : "🟠";
      report += `${icon} <b>${g.route}</b> (×${g.occurrences})\n${a.likely_cause}\n`;
      if (a.confident_fix) report += `→ Suggested fix opened as a GitHub issue for review.\n`;
      report += `\n`;
    }
    await notifyAdmins(db, report.trim());
    notified = true;
  }
  if (heldServerGroups.length > 0) {
    console.warn(
      `health-check: AI triage unavailable — holding ${heldServerGroups.length} server error group(s) silently ` +
        `(left unreported for a later run); no raw errors sent to admins.`,
    );
  }
  // ── Deterministic alert (no AI) ────────────────────────────────────────
  // Triage is down, so a real server break would otherwise sit held
  // forever — that is exactly what happened to the court-case refresh,
  // which failed all day without anyone being told. Alert once per route
  // per 6h when: the homepage is down, one server route failed 20+ times
  // in 24h, or one group spiked 10+ times in this single 15-min batch.
  // Plain language only: what broke, what students see, what was tried.
  let deterministicAlert = false;
  let topIssue: string | null = null;
  let homeAlertSent = false;
  const deterministicGroups: ErrorGroup[] = [];
  if (!result) {
    if (!homeProbe.ok) {
      topIssue = "home page not answering";
      deterministicAlert = true;
    }
    const counts24h = await recentServerCounts(db);
    for (const g of triageServerGroups) {
      const count24h = counts24h.get(g.route) ?? g.occurrences;
      const candidate = count24h >= 20 || g.occurrences >= 10;
      if (!candidate) continue;
      if (await recentDeterministicAlert(db, g.route)) continue; // 6h cooldown
      deterministicGroups.push(g);
    }
    if (deterministicGroups.length > 0) {
      deterministicAlert = true;
      topIssue = topIssue ?? `${deterministicGroups[0].route} failing repeatedly`;
      let report = `🩺 <b>Health Check</b>\n\n${deterministicGroups.length} serious server problem(s) found by direct check (no AI diagnosis available):\n\n`;
      for (const g of deterministicGroups) {
        const count24h = counts24h.get(g.route) ?? g.occurrences;
        report += `🔴 <b>${g.route}</b> (×${g.occurrences} in the last 15 min, ×${count24h} in 24h)\n${deterministicCause(g.route, g.message)}\n\n`;
      }
      if (!homeProbe.ok) {
        report += `🔴 <b>Home page not answering</b> (${homeProbe.status ?? "no response"} in ${homeProbe.ms}ms)\nWhat students see: the app does not open at all.\n\n`;
      }
      report +=
        `What was already tried: the automatic AI diagnosis is unavailable, so this comes from a direct check of the live app and its error log — no automatic fix was attempted.\n` +
        `Students reporting "app not working" are being told it is reported and we are fixing it.`;
      await notifyAdmins(db, report.trim());
      notified = true;
      if (!homeProbe.ok) homeAlertSent = true;
    } else if (!homeProbe.ok) {
      // Homepage down but no error groups to attach: still say so once.
      await notifyAdmins(
        db,
        `🩺 <b>Health Check</b>\n\n🔴 <b>The Student App is not answering.</b>\nThe home page check failed (${homeProbe.status ?? "no response"} in ${homeProbe.ms}ms).\n\nWhat students see: the app does not open at all.\nWhat was already tried: this is a direct check, not a guess — no automatic fix was attempted.\n\nCheck Vercel / Supabase status. Students reporting "app not working" will be told it is reported.`,
      );
      notified = true;
      deterministicAlert = true;
      homeAlertSent = true;
    }
  }
  // Homepage down is an incident on its own, whatever triage did.
  if (!homeProbe.ok && !homeAlertSent) {
    await notifyAdmins(
      db,
      `🩺 <b>Health Check</b>\n\n🔴 <b>The Student App is not answering.</b>\nThe home page check failed (${homeProbe.status ?? "no response"} in ${homeProbe.ms}ms).\n\nWhat students see: the app does not open at all.\nWhat was already tried: this is a direct check, not a guess — no automatic fix was attempted.\n\nCheck Vercel / Supabase status. Students reporting "app not working" will be told it is reported.`,
    );
    notified = true;
    deterministicAlert = true;
    topIssue = topIssue ?? "home page not answering";
  }
  if (clientGroups.length > 0) {
    console.log(
      `health-check: ${clientGroups.length} client telemetry group(s) logged only (no admin message): ` +
        clientGroups.map((g) => `${g.route} ×${g.occurrences}`).join(", "),
    );
  }

  // Open GitHub issues for server-side fixes the triage engine is confident about
  if (result) {
    for (const g of result.groups) {
      if (g.route.startsWith("client/")) continue;
      if (g.confident_fix && g.suggested_diff) {
        const title = `[auto-detected] ${g.route}: ${g.message.slice(0, 80)}`;
        const body =
          `**Detected by automated health-check (triaged by ${result.engine}).**\n\n` +
          `**Route:** \`${g.route}\`\n**Severity:** ${g.severity}\n\n` +
          `**Likely cause:** ${g.likely_cause}\n\n` +
          `**Suggested fix (review before applying — not auto-applied):**\n\`\`\`diff\n${g.suggested_diff}\n\`\`\`\n\n` +
          `This issue was opened automatically. A human should verify the diff before merging.`;
        await openGithubIssue(title, body);
      }
    }
  }

  // Mark handled rows as reported, and attach the triage result where we
  // have one. Client telemetry is always handled here (log-only is its
  // final state). Server rows are marked only when triage ran — held rows
  // stay unreported so a later run can triage them properly instead of
  // being silently dropped. Inactive-gateway rows are always handled
  // here, with a note naming the active gateway (never held: there is
  // nothing a later run could triage differently about a disabled
  // gateway).
  const inactiveByKey = new Map(
    inactiveGatewayGroups.map((g) => [
      `${g.route}::${g.message}`,
      {
        route: g.route,
        message: g.message,
        severity: "low",
        likely_cause: `${gatewayForRoute(g.route)} is not the active payment gateway (active: ${activeGateway ?? "none"}). Errors from a disabled gateway are expected and are not a live incident.`,
        confident_fix: false,
        suggested_diff: null,
      },
    ]),
  );
  // Deterministically alerted groups are handled here, with the plain
  // cause attached — same as inactive-gateway rows, they must not be
  // re-alerted next run (the 6h cooldown reads this marker). Held rows
  // that were NOT deterministically alerted stay unreported for triage.
  const deterministicByKey = new Map(
    deterministicGroups.map((g) => [
      `${g.route}::${g.message}`,
      {
        route: g.route,
        message: g.message,
        severity: "high",
        likely_cause: deterministicCause(g.route, g.message),
        confident_fix: false,
        suggested_diff: null,
      },
    ]),
  );
  for (const g of groups) {
    const inactiveAnalysis = inactiveByKey.get(`${g.route}::${g.message}`);
    if (inactiveAnalysis) {
      await db.from("system_errors").update({ reported: true, groq_analysis: inactiveAnalysis }).in("id", g.sample_ids);
      continue;
    }
    const deterministicAnalysis = deterministicByKey.get(`${g.route}::${g.message}`);
    if (deterministicAnalysis) {
      await db.from("system_errors").update({ reported: true, groq_analysis: deterministicAnalysis }).in("id", g.sample_ids);
      continue;
    }
    if (!result && !isClientGroup(g)) continue; // held — retry next run
    const analysis = triageByKey.get(`${g.route}::${g.message}`) ?? null;
    await db.from("system_errors").update({ reported: true, groq_analysis: analysis }).in("id", g.sample_ids);
  }

  return NextResponse.json({
    ok: homeProbe.ok,
    verdict: !homeProbe.ok
      ? "down"
      : notified || deterministicAlert || heldServerGroups.length > 0
        ? "degraded"
        : "ok",
    checks,
    top_issue: topIssue ?? (alertGroups[0] ? `${alertGroups[0].route}: ${alertGroups[0].message}` : null),
    deterministic_alert: deterministicAlert,
    errors_processed: rows.length,
    groups: groups.length,
    client_groups: clientGroups.length,
    inactive_gateway_groups: inactiveGatewayGroups.length,
    active_gateway: activeGateway ?? null,
    alert_groups: alertGroups.length,
    held: heldServerGroups.length > 0,
    notified,
    ai_triage: !!result,
    engine: result?.engine ?? null,
  });
}
