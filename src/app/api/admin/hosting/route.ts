import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";

// ─── Config ──────────────────────────────────────────────────────────────────
const VERCEL_TOKEN      = process.env.VERCEL_TOKEN ?? "";
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID ?? "";
const VERCEL_TEAM_ID    = process.env.VERCEL_TEAM_ID    ?? "";
const VERCEL_URL        = process.env.NEXT_PUBLIC_APP_URL ?? "https://studentplatform.dev";

const NETLIFY_TOKEN      = process.env.NETLIFY_TOKEN ?? "";
const NETLIFY_SITE_ID    = process.env.NETLIFY_SITE_ID ?? "";
const NETLIFY_URL        = process.env.NETLIFY_URL ?? "https://gnit-connect.netlify.app";


// ─── Types ────────────────────────────────────────────────────────────────────
export interface DeploymentInfo {
  provider:   "vercel" | "netlify";
  status:     "healthy" | "degraded" | "unknown";
  url:        string;
  lastDeploy: string | null;  // ISO string
  lastCommit: string | null;
  buildState: string | null;
  isPrimary:  boolean;
  // Usage / quota — populated where APIs allow
  usagePct:   number | null;  // 0-100
  usageLabel: string | null;
  // Future: customDomain for one-click cutover
  customDomain: string | null;
}

export interface HostingStatus {
  vercel:      DeploymentInfo;
  netlify:     DeploymentInfo;
  activeHost:  "vercel" | "netlify";
  checkedAt:   string;
  // Migration readiness
  canOneClick: boolean;  // true only when custom domain is configured
  switchSteps: string[]; // manual steps shown when canOneClick = false
}

// ─── Vercel check ─────────────────────────────────────────────────────────────
async function checkVercel(): Promise<DeploymentInfo> {
  const base: DeploymentInfo = {
    provider: "vercel", url: VERCEL_URL, isPrimary: true,
    status: "unknown", lastDeploy: null, lastCommit: null,
    buildState: null, usagePct: null, usageLabel: null, customDomain: null,
  };

  if (!VERCEL_TOKEN) return { ...base, status: "unknown", buildState: "No VERCEL_TOKEN configured" };

  try {
    const teamQ = VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : "";

    // Latest deployment
    const depRes = await fetch(
      `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT_ID}&limit=1&target=production${teamQ ? "&" + teamQ.slice(1) : ""}`,
      { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` }, signal: AbortSignal.timeout(8000) }
    );
    if (depRes.ok) {
      const depData = await depRes.json();
      const dep = depData.deployments?.[0];
      if (dep) {
        base.lastDeploy  = dep.created ? new Date(dep.created).toISOString() : null;
        base.lastCommit  = dep.meta?.githubCommitMessage ?? null;
        base.buildState  = dep.state ?? null;
        base.status      = dep.state === "READY" ? "healthy" : dep.state === "ERROR" ? "degraded" : "unknown";
      }
    }

    // Usage — Vercel usage API (available on pro plans)
    try {
      const usageRes = await fetch(
        `https://api.vercel.com/v2/usage${teamQ}`,
        { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` }, signal: AbortSignal.timeout(5000) }
      );
      if (usageRes.ok) {
        const u = await usageRes.json();
        // Serverless function execution GB-hours
        const used  = u?.usage?.serverlessFunctionExecution?.used  ?? null;
        const limit = u?.usage?.serverlessFunctionExecution?.limit ?? null;
        if (used !== null && limit && limit > 0) {
          base.usagePct   = Math.round((used / limit) * 100);
          base.usageLabel = `${Math.round(used / 1e9 * 100) / 100} GB-hrs of ${Math.round(limit / 1e9)} GB-hrs`;
        }
      }
    } catch (err) { console.error("[api/admin/hosting]", err); /* usage not critical */ }

    return base;
  } catch (e: any) {
    return { ...base, status: "degraded", buildState: e?.message ?? "Request failed" };
  }
}

// ─── Netlify check ────────────────────────────────────────────────────────────
async function checkNetlify(): Promise<DeploymentInfo> {
  const base: DeploymentInfo = {
    provider: "netlify", url: NETLIFY_URL, isPrimary: false,
    status: "unknown", lastDeploy: null, lastCommit: null,
    buildState: null, usagePct: null, usageLabel: null, customDomain: null,
  };

  if (!NETLIFY_TOKEN) return { ...base, status: "unknown", buildState: "No NETLIFY_TOKEN configured" };
  if (!NETLIFY_SITE_ID) return { ...base, status: "unknown", buildState: "No NETLIFY_SITE_ID configured" };

  try {
    // Site info
    const siteRes = await fetch(
      `https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}`,
      { headers: { Authorization: `Bearer ${NETLIFY_TOKEN}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!siteRes.ok) return { ...base, status: "degraded", buildState: `API ${siteRes.status}` };

    const site = await siteRes.json();
    base.lastDeploy  = site.published_deploy?.created_at ?? null;
    base.lastCommit  = site.published_deploy?.title ?? null;
    base.buildState  = site.published_deploy?.state ?? null;
    base.status      = site.published_deploy?.state === "ready" ? "healthy"
                     : site.published_deploy?.state === "error" ? "degraded"
                     : "unknown";

    // Account usage
    try {
      const acctRes = await fetch(
        "https://api.netlify.com/api/v1/accounts",
        { headers: { Authorization: `Bearer ${NETLIFY_TOKEN}` }, signal: AbortSignal.timeout(5000) }
      );
      if (acctRes.ok) {
        const accounts = await acctRes.json();
        const acct = accounts?.[0];
        const used  = acct?.capabilities?.bandwidth?.used  ?? null;
        const limit = acct?.capabilities?.bandwidth?.included ?? null;
        if (used !== null && limit && limit > 0) {
          base.usagePct   = Math.round((used / limit) * 100);
          const usedGB    = Math.round(used  / (1024**3) * 10) / 10;
          const limitGB   = Math.round(limit / (1024**3));
          base.usageLabel = `${usedGB} GB of ${limitGB} GB bandwidth`;
        }
        // Build minutes
        const buildUsed  = acct?.capabilities?.buildMinutes?.used    ?? null;
        const buildLimit = acct?.capabilities?.buildMinutes?.included ?? null;
        if (buildUsed !== null && buildLimit && !base.usageLabel) {
          base.usagePct   = Math.round((buildUsed / buildLimit) * 100);
          base.usageLabel = `${buildUsed} of ${buildLimit} build minutes`;
        }
      }
    } catch (err) { console.error("[api/admin/hosting]", err); /* usage not critical */ }

    return base;
  } catch (e: any) {
    return { ...base, status: "degraded", buildState: e?.message ?? "Request failed" };
  }
}

// ─── Telegram alert ───────────────────────────────────────────────────────────
async function sendHostingAlert(message: string) { console.warn("[hosting-monitor]", message.replace(/<[^>]*>/g, "")); }

// ─── Route ────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req);
  if (error) return forbidden();

  try {
    const [vercel, netlify] = await Promise.all([checkVercel(), checkNetlify()]);

    // Determine active host from env or default to vercel
    const activeHost: "vercel" | "netlify" =
      (process.env.ACTIVE_HOST as "vercel" | "netlify") ?? "vercel";

    // Custom domain — future upgrade path
    const customDomain = process.env.CUSTOM_DOMAIN ?? null;
    const canOneClick  = Boolean(customDomain);

    // Manual switch steps (no custom domain)
    const switchSteps = canOneClick ? [] : [
      `1. Open your Telegram bot settings (@BotFather)`,
      `2. Update the Mini App URL to: ${NETLIFY_URL}`,
      `3. Inform students of the new direct link: ${NETLIFY_URL}`,
      `4. Set ACTIVE_HOST=netlify in Vercel environment variables`,
      `5. Monitor Netlify for the next 30 minutes`,
      `6. Once stable, update ACTIVE_HOST env and redeploy`,
    ];

    // Auto-alert if either provider is degraded
    if (vercel.status === "degraded") {
      await sendHostingAlert(
        `⚠️ <b>Hosting Alert</b>

Vercel (Primary) is reporting a degraded state.

Last build: <code>${vercel.buildState ?? "unknown"}</code>

Check the Hosting Monitor in Admin Panel.`
      );
    }
    if (netlify.status === "degraded") {
      await sendHostingAlert(
        `⚠️ <b>Hosting Alert</b>

Netlify (Standby) is reporting a degraded state.

Last build: <code>${netlify.buildState ?? "unknown"}</code>

Check the Hosting Monitor in Admin Panel.`
      );
    }

    // Usage threshold alerts (>= 80%)
    if ((vercel.usagePct ?? 0) >= 80) {
      await sendHostingAlert(
        `📊 <b>Vercel Usage Alert</b>

Usage has reached <b>${vercel.usagePct}%</b> of limit.

${vercel.usageLabel ?? ""}

Consider switching to Netlify standby.`
      );
    }
    if ((netlify.usagePct ?? 0) >= 80) {
      await sendHostingAlert(
        `📊 <b>Netlify Usage Alert</b>

Bandwidth has reached <b>${netlify.usagePct}%</b> of limit.

${netlify.usageLabel ?? ""}`
      );
    }

    const result: HostingStatus = {
      vercel, netlify, activeHost, canOneClick, switchSteps,
      checkedAt: new Date().toISOString(),
    };

    return ok(result);
  } catch (e) {
    console.error("[api/admin/hosting]", e);
    return serverError("Hosting check failed. Please try again.");
  }
}
