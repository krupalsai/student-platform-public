import { createHmac, timingSafeEqual } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/audit";

/**
 * Phase 3 of the voice fixer: read and change the platform's own code.
 *
 * Voice-only surface — the orb/copilot chat never propose these. Every write
 * needs a spoken "yes" on the call, is Super Admin-only, is audit-logged,
 * and can never touch the WRITE_DENYLIST below (secrets, auth, build config).
 *
 * Reads and writes go through the GitHub API with a repo-scoped token from
 * GITHUB_CODE_TOKEN. Without it, the assistant investigates nothing and says
 * plainly what is missing.
 */

const GITHUB_API = "https://api.github.com";
const REPO = "krupalsai/student-platform";
const BRANCH = "main";

export interface VoiceActor {
  profileId: string;
  role: string;
}

function codeToken(): string | null {
  return (process.env.GITHUB_CODE_TOKEN ?? "").trim() || null;
}

export function isCodeToolConfigured(): boolean {
  return !!codeToken();
}

/** Paths a voice fix may never write, even on confirmation. */
const WRITE_DENYLIST = [
  ".env",
  "src/lib/session",
  "src/lib/supabase/",
  "next.config",
  "vercel.json",
  "package.json",
  "package-lock.json",
];

export function isDeniedPath(p: string): boolean {
  const n = String(p ?? "").replace(/^\/+/, "");
  return WRITE_DENYLIST.some((d) => n === d || n.startsWith(d + "/") || (d.endsWith("/") && n.startsWith(d)));
}

async function gh(path: string, init?: RequestInit): Promise<any> {
  const token = codeToken();
  if (!token) throw new Error("GitHub code token is not configured");
  const r = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...((init?.headers as Record<string, string>) ?? {}),
    },
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error(`GitHub API ${r.status}`);
  return r.json();
}

export async function readRepoFile(path: string): Promise<string | null> {
  try {
    const j = await gh(`/repos/${REPO}/contents/${path}?ref=${BRANCH}`);
    if (j?.type !== "file" || !j?.content) return null;
    return Buffer.from(j.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}

async function listSrcFiles(): Promise<string[]> {
  const j = await gh(`/repos/${REPO}/git/trees/${BRANCH}?recursive=1`);
  return ((j?.tree ?? []) as any[])
    .filter((t) => t?.type === "blob")
    .map((t) => String(t.path))
    .filter((p) => p.startsWith("src/") && /\.(ts|tsx|js|jsx)$/.test(p) && !isDeniedPath(p));
}

async function groqJson(system: string, user: string, maxTokens = 2500): Promise<any | null> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL ?? "openai/gpt-oss-120b",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return JSON.parse(j?.choices?.[0]?.message?.content ?? "null");
  } catch {
    return null;
  }
}

export interface CodeFixProposal {
  path: string;
  /** What was wrong and what changed, in one plain sentence for a non-programmer. */
  plainWords: string;
  /** The COMPLETE new file content. */
  newContent: string;
}

export interface CodeInvestigation {
  proposal: CodeFixProposal | null;
  /** Set when this looks like a data/settings issue, not a code bug. */
  dataHint: string | null;
}

/**
 * Two-step investigation: pick candidate files from the tree, then read them
 * and propose the smallest fix. Returns a dataHint when the report smells
 * like a wrong setting rather than a code bug, so the caller can fall
 * through to the normal data pipeline.
 */
export async function investigateCodeIssue(question: string): Promise<CodeInvestigation> {
  if (!isCodeToolConfigured()) return { proposal: null, dataHint: null };
  let files: string[] = [];
  try {
    files = await listSrcFiles();
  } catch (e) {
    console.error("[voice-code] tree failed:", (e as Error).message);
    return { proposal: null, dataHint: null };
  }
  if (!files.length) return { proposal: null, dataHint: null };

  const pick = await groqJson(
    "You are triaging a bug report for a Next.js + Supabase web app. Return JSON only.",
    `Admin report: "${question}"\n\nRepo files (src/ only):\n${files.join("\n")}\n\nReturn JSON: {"files": ["up to 4 paths most likely to contain the bug"]}. Prefer pages/components over libraries.`,
    600,
  );
  const paths: string[] = ((pick?.files ?? []) as string[]).filter((p) => files.includes(p)).slice(0, 4);
  if (!paths.length) return { proposal: null, dataHint: null };

  const contents = await Promise.all(
    paths.map(async (p) => ({ path: p, content: (await readRepoFile(p)) ?? "" })),
  );
  const readable = contents.filter((c) => c.content);
  if (!readable.length) return { proposal: null, dataHint: null };

  const fix = await groqJson(
    "You are fixing a bug in a Next.js + Supabase web app. Return JSON only.",
    `Admin report: "${question}"\n\nFirst decide: is this a DATA issue (a wrong value in the database or settings, fixable without touching code) or a CODE bug? ` +
      `If it looks like a data issue, return {"dataIssue": "one plain sentence"}. ` +
      `Otherwise find the bug and return {"path": "exact file path", "plainWords": "what was wrong and what you changed, one plain sentence for a non-programmer", "newContent": "the COMPLETE new file content with the fix"}. ` +
      `Change as little as possible. Never add secrets or credentials.\n\n` +
      readable.map((c) => `--- ${c.path} ---\n${c.content.slice(0, 12000)}`).join("\n\n"),
    6000,
  );
  if (!fix) return { proposal: null, dataHint: null };
  if (typeof fix.dataIssue === "string" && fix.dataIssue.trim()) {
    return { proposal: null, dataHint: fix.dataIssue.trim().slice(0, 300) };
  }
  const path = String(fix.path ?? "");
  const newContent = String(fix.newContent ?? "");
  const plainWords = String(fix.plainWords ?? "").slice(0, 400);
  if (!path || !newContent || !plainWords || isDeniedPath(path)) return { proposal: null, dataHint: null };
  if (!files.includes(path)) return { proposal: null, dataHint: null };
  return { proposal: { path, plainWords, newContent }, dataHint: null };
}

/* ---- confirmation tokens (same HMAC pattern as admin-copilot-agent) ---- */

const SIGN_SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function sign(s: string): string {
  if (!SIGN_SECRET) throw new Error("Action signing secret is not configured");
  return createHmac("sha256", SIGN_SECRET).update(s).digest("base64url");
}

function issueCodeToken(proposal: CodeFixProposal, actor: VoiceActor): string {
  const p = Buffer.from(
    JSON.stringify({ proposal, actorId: actor.profileId, exp: Date.now() + 600000 }),
  ).toString("base64url");
  return `${p}.${sign(p)}`;
}

function readCodeToken(token: string, actor: VoiceActor): CodeFixProposal {
  const [p, s] = token.split(".");
  if (!p || !s) throw new Error("Invalid action token");
  const e = sign(p);
  if (s.length !== e.length || !timingSafeEqual(Buffer.from(s), Buffer.from(e))) {
    throw new Error("Invalid action token");
  }
  const d = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  if (d.actorId !== actor.profileId || Number(d.exp) < Date.now()) throw new Error("Expired action token");
  return d.proposal as CodeFixProposal;
}

export function prepareCodeFix(
  proposal: CodeFixProposal,
  actor: VoiceActor,
): { ok: boolean; confirmation?: string; token?: string; message?: string } {
  if (actor.role !== "super_admin") {
    return { ok: false, message: "Only Super Admin can apply code changes." };
  }
  if (isDeniedPath(proposal.path)) {
    return { ok: false, message: "That file is protected, so I won't change it." };
  }
  if (!isCodeToolConfigured()) {
    return {
      ok: false,
      message:
        "I found the issue, but code changes need a GitHub token set up on the server first. Ask in the main chat to set it up.",
    };
  }
  return {
    ok: true,
    confirmation: `I found it in ${proposal.path}. ${proposal.plainWords} Shall I apply this fix and deploy?`,
    token: issueCodeToken(proposal, actor),
  };
}

export async function executeCodeFix(
  db: SupabaseClient,
  token: string,
  actor: VoiceActor,
): Promise<{ ok: boolean; message: string }> {
  let proposal: CodeFixProposal;
  try {
    proposal = readCodeToken(token, actor);
  } catch {
    return { ok: false, message: "That confirmation has expired. Please ask me again." };
  }
  if (actor.role !== "super_admin") return { ok: false, message: "Only Super Admin can apply code changes." };
  if (isDeniedPath(proposal.path)) return { ok: false, message: "That file is protected." };
  try {
    const meta = await gh(`/repos/${REPO}/contents/${proposal.path}?ref=${BRANCH}`);
    if (!meta?.sha) return { ok: false, message: "I couldn't read the current file. Nothing was changed." };
    await gh(`/repos/${REPO}/contents/${proposal.path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Voice fixer: ${proposal.plainWords.slice(0, 80)}`,
        content: Buffer.from(proposal.newContent, "utf8").toString("base64"),
        sha: meta.sha,
        branch: BRANCH,
      }),
    });
    await audit("code.fix_applied", "repo", proposal.path, { via: "voice_fixer", plainWords: proposal.plainWords }, actor.profileId, actor.role);
    return { ok: true, message: "Done. The fix is applied and deploying — give it two minutes, then check." };
  } catch (e) {
    console.error("[voice-code] apply failed:", (e as Error).message);
    return { ok: false, message: "The fix didn't go through. Nothing was changed." };
  }
}
