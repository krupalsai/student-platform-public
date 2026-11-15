/**
 * GET /api/cron/self-watch
 *
 * Proactive self-watch for the Student Platform. Every 15 minutes (via
 * .github/workflows/health-check.yml) it checks the things that actually
 * break production:
 *   - Cashfree API reachable and credentials valid
 *   - Batch payment gates (catches "not accepting payments" surprises)
 *   - Gemini vision keys configured
 *   - WhatsApp bot configured and enabled
 *   - Site homepage responding
 *
 * Super-admins are WhatsApp'd ONLY when something needs them, with the
 * exact fix. Silent when healthy. Each distinct problem alerts at most
 * once per 24 hours; brand-new problems alert immediately; recoveries
 * are silent.
 *
 * Alert state lives in the system_health table (migration 0086). The first
 * time a check is seen it only sets the baseline — it never alerts — so
 * deploying this doesn't spam about pre-existing states.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` / `x-cron-secret: <CRON_SECRET>`,
 * or a normal admin session (for manual triggering).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { getActiveAdminPhones } from "@/lib/whatsapp/admin";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { getPaymentGateForBatch } from "@/lib/services/payment-gate";
import { sendSlackAlert } from "@/lib/services/slack";
import { isCashfreeConfigured } from "@/lib/cashfree";
import { getActivePaymentGateway } from "@/lib/services/payment-settings";
import { sweepStaleRazorpayOrders } from "@/lib/razorpay-reconcile";
import { autoAnswerFromExistingFaqs, closeStaleQuestions, maybeAutoRollback } from "@/lib/services/self-heal";
import { reviewDraftFaqs } from "@/lib/services/faq-autopilot";
import { getBriefing, renderBriefing } from "@/lib/admin-copilot-data";

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "https://studentplatform.dev").replace(/\/$/, "");
const REALERT_MS = 24 * 60 * 60 * 1000; // re-alert an ongoing problem at most daily
const TERMINAL_BATCH_STATUSES = new Set(["disposed", "archived", "completed", "cancelled"]);

function authorize(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization") ?? "";
  if (cronSecret && (authHeader === `Bearer ${cronSecret}` || req.headers.get("x-cron-secret") === cronSecret)) {
    return true;
  }
  return false;
}

interface Check {
  key: string;
  title: string;
  ok: boolean;
  detail: string;
  fix: string;
  /** Terminal batches (disposed/archived/…) are tracked silently, never alerted. */
  terminal?: boolean;
  /**
   * A failure that is often momentary (rate limit, network blip, 5xx). It only
   * alerts if it is still failing on the NEXT run, so one blip never pages.
   */
  transient?: boolean;
}

function timedFetch(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/**
 * 1. Payment gateway: probe ONLY the gateway switched on in Settings
 * (getActivePaymentGateway — rule 6). Probing a gateway that is switched off
 * would alert about something no student can reach.
 */
async function checkPaymentGateway(db: ReturnType<typeof createServiceClient>): Promise<Check> {
  const base: Check = {
    key: "payment_gateway",
    title: "Payments",
    ok: true,
    detail: "",
    fix: "Admin → Settings → Payment Gateway: make sure one gateway is switched on. If it is, check that gateway's keys in Vercel → Environment Variables → Redeploy.",
  };
  const active = await getActivePaymentGateway(db).catch(() => null);
  if (!active) {
    return { ...base, ok: false, detail: "No payment gateway is switched on — no student can pay." };
  }

  if (active === "razorpay") {
    const keyId = (process.env.RAZORPAY_KEY_ID ?? "").trim();
    const keySecret = (process.env.RAZORPAY_KEY_SECRET ?? "").trim();
    if (!keyId || !keySecret) {
      return { ...base, ok: false, detail: "Razorpay is the live gateway but RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set." };
    }
    try {
      const res = await timedFetch(
        "https://api.razorpay.com/v1/orders?count=1",
        { headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}` } },
        10000,
      );
      if (res.ok) return { ...base, detail: "Razorpay reachable, keys accepted." };
      if (res.status === 401 || res.status === 403) {
        return { ...base, ok: false, detail: `Razorpay rejected our keys (HTTP ${res.status}). Students cannot pay right now.` };
      }
      return { ...base, ok: false, transient: res.status === 429 || res.status >= 500, detail: res.status === 429 ? "Razorpay is rate-limiting our checks (HTTP 429)." : `Razorpay API returned unexpected HTTP ${res.status}.` };
    } catch (e) {
      return { ...base, ok: false, transient: true, detail: `Could not reach Razorpay: ${(e as Error).message}.` };
    }
  }

  if (active === "cashfree") {
    if (!isCashfreeConfigured()) {
      return { ...base, ok: false, detail: "Cashfree is the live gateway but CASHFREE_APP_ID / CASHFREE_SECRET_KEY are not set." };
    }
    const env = (process.env.CASHFREE_ENV ?? "SANDBOX").trim().toUpperCase();
    const apiBase = env === "PROD" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
    try {
      const res = await timedFetch(
        `${apiBase}/orders/__selfwatch__`,
        {
          headers: {
            "x-api-version": "2026-01-01",
            "x-client-id": (process.env.CASHFREE_APP_ID ?? "").trim(),
            "x-client-secret": (process.env.CASHFREE_SECRET_KEY ?? "").trim(),
          },
        },
        10000,
      );
      // 404 = credentials accepted, probe order simply doesn't exist.
      if (res.status === 404) return { ...base, detail: `Cashfree reachable, credentials accepted (${env}).` };
      if (res.status === 401 || res.status === 403) {
        return { ...base, ok: false, detail: `Cashfree rejected our credentials (HTTP ${res.status}). Students cannot pay right now.` };
      }
      return { ...base, ok: false, transient: res.status === 429 || res.status >= 500, detail: `Cashfree API returned unexpected HTTP ${res.status}.` };
    } catch (e) {
      return { ...base, ok: false, transient: true, detail: `Could not reach Cashfree: ${(e as Error).message}.` };
    }
  }

  // PhonePe: configuration only (its OAuth probe would mint a token every 15 min).
  if (!(process.env.PHONEPE_CLIENT_ID ?? "").trim() || !(process.env.PHONEPE_CLIENT_SECRET ?? "").trim()) {
    return { ...base, ok: false, detail: "PhonePe is the live gateway but PHONEPE_CLIENT_ID / PHONEPE_CLIENT_SECRET are not set." };
  }
  return { ...base, detail: "PhonePe configured." };
}

/** 2. Gemini vision keys: at least one configured (live quota is per-key; rotation handles exhaustion). */
async function checkGeminiKeys(): Promise<Check> {
  const base: Check = {
    key: "gemini_keys",
    title: "AI ID checker keys",
    ok: true,
    detail: "",
    fix: "aistudio.google.com → Get API key → create a key → Vercel → student-platform → Environment Variables → set EMBEDDINGS_API_KEY → Redeploy.",
  };
  const keys = [
    process.env.EMBEDDINGS_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
  ].map((k) => (k ?? "").trim()).filter(Boolean);
  if (!keys.length) {
    return { ...base, ok: false, detail: "No Gemini API key is configured — the college-ID photo checker is dead." };
  }
  return { ...base, detail: `${new Set(keys).size} key(s) configured.` };
}

/** 3. WhatsApp bot: credentials present and bot enabled. */
async function checkWhatsApp(db: ReturnType<typeof createServiceClient>): Promise<Check> {
  const base: Check = {
    key: "whatsapp_bot",
    title: "WhatsApp bot",
    ok: true,
    detail: "",
    fix: "Vercel → check WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN are set → Redeploy. Then Supabase → app_settings → whatsapp_bot_enabled must not be 'false'.",
  };
  if (!(process.env.WHATSAPP_PHONE_NUMBER_ID ?? "").trim() || !(process.env.WHATSAPP_ACCESS_TOKEN ?? "").trim()) {
    return { ...base, ok: false, detail: "WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN missing — the bot cannot send or receive." };
  }
  const { data } = await db.from("app_settings").select("value").eq("key", "whatsapp_bot_enabled").maybeSingle();
  if (data?.value === "false") {
    return { ...base, ok: false, detail: "whatsapp_bot_enabled is 'false' — the bot is switched off for students." };
  }
  return { ...base, detail: "Credentials present, bot enabled." };
}

/** 4. Site homepage responding. */
async function checkSite(): Promise<Check> {
  const base: Check = {
    key: "site_homepage",
    title: "Site homepage",
    ok: true,
    detail: "",
    fix: "Vercel → student-platform → Deployments → check the latest deployment status and logs.",
  };
  try {
    const res = await timedFetch(APP_URL, {}, 15000);
    if (res.ok) return { ...base, detail: `HTTP ${res.status}.` };
    return { ...base, ok: false, transient: true, detail: `Homepage returned HTTP ${res.status}.` };
  } catch (e) {
    return { ...base, ok: false, transient: true, detail: `Homepage unreachable: ${(e as Error).message}.` };
  }
}

/** 5. Batch payment gates: one check per batch. */
async function checkBatchGates(db: ReturnType<typeof createServiceClient>): Promise<Check[]> {
  const { data: batches, error } = await db.from("batches").select("id, name, status").order("name");
  if (error || !batches) {
    return [{
      key: "batch_gates",
      title: "Batch payment gates",
      ok: false,
      detail: `Could not read batches table: ${error?.message ?? "unknown error"}.`,
      fix: "Supabase → check the batches table is readable.",
    }];
  }
  const checks: Check[] = [];
  for (const b of batches) {
    const name = b.name ?? b.id;
    // Only an ACTIVE batch can be "wrongly" not accepting payments. Closed,
    // full, pending_setup and archived batches are deliberate admin states —
    // track silently, never alert (alerting on them every 15 minutes was the
    // first thing this monitor did in production).
    if (String(b.status ?? "").toLowerCase() !== "active" || TERMINAL_BATCH_STATUSES.has(String(b.status ?? "").toLowerCase())) {
      checks.push({
        key: `batch_gate:${b.id}`,
        title: `Payments — ${name}`,
        ok: true,
        detail: `Batch is ${b.status} (intentionally closed).`,
        fix: "",
        terminal: true,
      });
      continue;
    }
    const gate = await getPaymentGateForBatch(db, b.id);
    if (gate.open) {
      checks.push({
        key: `batch_gate:${b.id}`,
        title: `Payments — ${name}`,
        ok: true,
        detail: "Accepting payments.",
        fix: "",
      });
      continue;
    }
    // A new batch waits for its fee by design (batch lifecycle rule), a batch
    // below its minimum student count is waiting to fill, and an admin closing
    // payments is a choice — none of these is a fault to page about.
    if (gate.reason === "fee_not_set" || gate.reason === "closed_by_admin" || gate.reason === "below_minimum") {
      checks.push({
        key: `batch_gate:${b.id}`,
        title: `Payments — ${name}`,
        ok: true,
        detail: `Not accepting payments yet (${gate.reason}) — deliberate.`,
        fix: "",
        terminal: true,
      });
      continue;
    }
    let fix = "";
    if (gate.reason === "batch_inactive") {
      fix = `Supabase → Table Editor → batches → "${name}" → set status='active' (currently '${b.status ?? "unset"}').`;
    } else {
      fix = `Supabase → Table Editor → batches → check "${name}" (reason: ${gate.reason}).`;
    }
    checks.push({
      key: `batch_gate:${b.id}`,
      title: `Payments — ${name}`,
      ok: false,
      detail: `Not accepting payments — ${gate.message ?? gate.reason}.`,
      fix,
    });
  }
  return checks;
}

interface HealthRow {
  check_key: string;
  status: "ok" | "problem";
  detail: string | null;
  last_alert_at: string | null;
}

/** Returns null when the system_health table doesn't exist yet (migration not run). */
async function loadState(db: ReturnType<typeof createServiceClient>): Promise<Map<string, HealthRow> | null> {
  try {
    const { data, error } = await db.from("system_health").select("check_key, status, detail, last_alert_at");
    if (error) throw error;
    return new Map((data ?? []).map((r: any) => [r.check_key, r as HealthRow]));
  } catch (e) {
    console.warn("[self-watch] system_health unreadable (run migration 0086):", (e as Error).message);
    return null;
  }
}

async function saveState(
  db: ReturnType<typeof createServiceClient>,
  key: string,
  status: "ok" | "problem",
  detail: string,
  lastAlertAt: string | null,
): Promise<void> {
  try {
    await db.from("system_health").upsert(
      { check_key: key, status, detail, updated_at: new Date().toISOString(), last_alert_at: lastAlertAt },
      { onConflict: "check_key" },
    );
  } catch (e) {
    console.warn("[self-watch] system_health write failed:", (e as Error).message);
  }
}

async function alertAdmins(db: ReturnType<typeof createServiceClient>, problems: Check[], noDedupe: boolean): Promise<number> {
  if (!problems.length) return 0;
  const phones = await getActiveAdminPhones(db).catch(() => [] as string[]);
  if (!phones.length) {
    console.error("[self-watch] problems found but no super-admin phones to alert");
    return 0;
  }
  const lines = problems.map((p) => `*${p.title}*\n${p.detail}\nFix: ${p.fix}`.trim());
  const body =
    `🔴 *System watch — ${problems.length} problem${problems.length > 1 ? "s need" : " needs"} you*\n\n` +
    lines.join("\n\n") +
    (noDedupe ? `\n\n_Run migration 0086_system_health.sql so repeat alerts are deduplicated._` : "");
  let sent = 0;
  for (const phone of phones) {
    try {
      if (await sendWhatsAppText(phone, body)) sent++;
    } catch (e) {
      console.error("[self-watch] admin alert failed:", (e as Error).message);
    }
  }
  // Mirror to Slack team channel — free, no per-message cost. Best-effort.
  try {
    const slackLines = problems.map((p) => `*${p.title}*\n${p.detail}\nFix: ${p.fix}`.trim());
    await sendSlackAlert(
      `\uD83D\uDD34 *System watch \u2014 ${problems.length} problem${problems.length > 1 ? "s need" : " needs"} you*\n\n` +
      slackLines.join("\n\n")
    );
  } catch (e) {
    console.error("[self-watch] slack alert failed:", (e as Error).message);
  }
  return sent;
}

export async function GET(req: NextRequest) {
  const viaCron = authorize(req);
  if (!viaCron) {
    const { error } = await requireAdmin(req);
    if (error) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = createServiceClient();
  const now = Date.now();

  const checks: Check[] = [
    await checkPaymentGateway(db),
    await checkGeminiKeys(),
    await checkWhatsApp(db),
    await checkSite(),
    ...(await checkBatchGates(db)),
  ];

  const state = await loadState(db);
  const toAlert: Check[] = [];
  // Read BEFORE the loop overwrites it: was the site already down last run?
  const siteWasDown = state?.get("site_homepage")?.status === "problem";

  for (const c of checks) {
    const terminal = c.terminal === true;
    const status = c.ok ? "ok" : "problem";
    const prev = state?.get(c.key);

    if (!state || !prev) {
      // No dedupe possible, or first sight: record silently as the baseline.
      // (When the table is missing entirely, alert so the owner notices.)
      // Without stored state there is no way to dedupe, and alerting anyway
      // means a WhatsApp every 15 minutes. Stay silent and log loudly.
      if (!state) {
        if (!c.ok && !terminal) console.error(`[self-watch] ${c.key} problem (not alerted — system_health unreadable): ${c.detail}`);
      } else {
        await saveState(db, c.key, status, c.detail, null);
      }
      continue;
    }

    if (terminal) {
      // Intentionally-closed batches: keep tracking, never alert.
      if (prev.status !== status || prev.detail !== c.detail) {
        await saveState(db, c.key, status, c.detail, prev.last_alert_at);
      }
      continue;
    }

    if (prev.status === status) {
      // Still failing: alert if it never has (a transient failure on its
      // second consecutive run), or re-alert once a day.
      if (!c.ok && (!prev.last_alert_at || now - new Date(prev.last_alert_at).getTime() > REALERT_MS)) {
        toAlert.push(c);
        await saveState(db, c.key, status, c.detail, new Date(now).toISOString());
      } else if (prev.detail !== c.detail) {
        await saveState(db, c.key, status, c.detail, prev.last_alert_at);
      }
      continue;
    }

    // Transition.
    if (!c.ok && c.transient) {
      // First failure of a blip-prone check: record, alert only if it persists.
      await saveState(db, c.key, status, c.detail, null);
    } else if (!c.ok) {
      toAlert.push(c);
      await saveState(db, c.key, status, c.detail, new Date(now).toISOString());
    } else {
      await saveState(db, c.key, status, c.detail, prev.last_alert_at); // silent recovery
    }
  }

  // Self-fix 1 — automatic rollback. The site failing on TWO consecutive
  // runs (~15 min) right after a deploy means the deploy broke it: point
  // production back at the previous working deployment. At most once a day,
  // and only with stored state (so a flapping check can't loop it).
  let rollback: Awaited<ReturnType<typeof maybeAutoRollback>> | null = null;
  const site = checks.find((c) => c.key === "site_homepage");
  const lastRollback = state?.get("auto_rollback")?.last_alert_at;
  if (state && site && !site.ok && siteWasDown && (!lastRollback || now - new Date(lastRollback).getTime() > REALERT_MS)) {
    rollback = await maybeAutoRollback();
    if (rollback.attempted) {
      await saveState(db, "auto_rollback", rollback.rolledBackTo ? "ok" : "problem", rollback.reason, new Date(now).toISOString());
      toAlert.push({
        key: "auto_rollback",
        title: rollback.rolledBackTo ? "Site was down — rolled back automatically" : "Site is down — automatic rollback failed",
        ok: false,
        detail: rollback.rolledBackTo
          ? `The newest update took the site down, so production now runs the previous working version (${rollback.rolledBackTo}).`
          : rollback.reason,
        fix: rollback.rolledBackTo
          ? "Nothing urgent. New updates will NOT go live until one is promoted: Vercel → student-platform → Deployments → the fixed deployment → Promote."
          : "Vercel → student-platform → Deployments → pick the last working deployment → Promote.",
      });
    }
  }

  const alerted = toAlert.length ? await alertAdmins(db, toAlert, !state) : 0;

  // Self-fix 2/3 — once an hour: answer waiting questions an existing FAQ
  // already covers, and close stale fragments nobody can answer.
  let questions: { autoAnswered: number; closedStale: number } | null = null;
  let faqAutopilot: Awaited<ReturnType<typeof reviewDraftFaqs>> | null = null;
  // GitHub's scheduler fires far less often than every 15 min in practice
  // (observed ~every 3h), so "once an hour" is tracked in system_health
  // rather than guessed from the clock. An admin running this by hand always
  // gets them.
  const hourlyKey = "hourly_fixes";
  const lastHourly = state?.get(hourlyKey);
  const hourlyDue = !viaCron || !state || !lastHourly?.last_alert_at ||
    now - new Date(lastHourly.last_alert_at).getTime() >= 50 * 60_000;
  if (hourlyDue) {
    const answered = await autoAnswerFromExistingFaqs(db).catch((e) => {
      console.error("[self-watch] auto-answer failed:", (e as Error).message);
      return { checked: 0, answered: 0 };
    });
    const closedStale = await closeStaleQuestions(db).catch(() => 0);
    questions = { autoAnswered: answered.answered, closedStale };
    // Self-improvement: learned answers are reviewed and published (or
    // discarded) automatically — no human approval step.
    faqAutopilot = await reviewDraftFaqs(db).catch((e) => {
      console.error("[self-watch] faq autopilot failed:", (e as Error).message);
      return null;
    });
    if (state) await saveState(db, hourlyKey, "ok", JSON.stringify({ ...questions, faq: faqAutopilot && { published: faqAutopilot.published, rejected: faqAutopilot.rejected, skipped: faqAutopilot.skipped } }).slice(0, 500), new Date(now).toISOString());
  }

  // Self-healing, not just watching: settle stuck Razorpay orders so a paid
  // student is approved even if they never reopen the app.
  const razorpaySweep = await sweepStaleRazorpayOrders(db).catch((e) => {
    console.error("[self-watch] razorpay sweep failed:", (e as Error).message);
    return null;
  });

  // Daily operations digest: send the super-admin a concise, live-data view of
  // work that still needs human attention. Aggregate only; never include student
  // names, phone numbers, payment references, or document contents in this alert.
  // Run only from the authenticated scheduler and only when dedupe state exists.
  let operationsDigest: { sent: number; attentionItems: number } | null = null;
  const digestKey = "daily_operations_digest";
  const lastDigest = state?.get(digestKey)?.last_alert_at;
  // The digest is a morning briefing, not a 2:33 am one: it goes out on the
  // first scheduler run at or after 07:00 IST each day, at most once a day.
  // (The old "24h since the last one" rule drifted to the middle of the night,
  // when "today so far" is always empty.)
  const IST_MS = 5.5 * 3600_000;
  const istNow = new Date(now + IST_MS);
  const today0700UtcMs = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), 7) - IST_MS;
  const digestDue = viaCron && !!state && now >= today0700UtcMs &&
    (!lastDigest || new Date(lastDigest).getTime() < today0700UtcMs);
  if (digestDue) {
    try {
      const briefing = await getBriefing(db);
      let sent = 0;
      if (briefing.attention.length) {
        const phones = await getActiveAdminPhones(db).catch(() => [] as string[]);
        const message = "*Student Platform — Daily Operations Briefing*\n\n" +
          renderBriefing(briefing).replace(/• /g, "• ");
        const outcomes = await Promise.all(phones.map(async (phone) => {
          try { return await sendWhatsAppText(phone, message); }
          catch (e) {
            console.error("[self-watch] daily operations digest failed:", (e as Error).message);
            return false;
          }
        }));
        sent = outcomes.filter(Boolean).length;
      }
      // Record even a quiet day so the scheduler doesn't repeatedly scan/send.
      await saveState(
        db, digestKey, "ok",
        JSON.stringify({ attentionItems: briefing.attention.length, sent }).slice(0, 500),
        new Date(now).toISOString(),
      );
      operationsDigest = { sent, attentionItems: briefing.attention.length };
    } catch (e) {
      console.error("[self-watch] daily operations briefing failed:", (e as Error).message);
      operationsDigest = null;
    }
  }

  return NextResponse.json({
    ok: true,
    checked_at: new Date(now).toISOString(),
    checks: checks.map((c) => ({ key: c.key, ok: c.ok })),
    problems: toAlert.map((c) => c.key),
    alerted_admins: alerted,
    dedupe: !!state,
    razorpay_sweep: razorpaySweep,
    rollback,
    questions,
    faq_autopilot: faqAutopilot,
    operations_digest: operationsDigest,
  });
}
