export interface OnlineEngineeringCollege {
  id: string;
  name: string;
  search_aliases: string[];
}

// Student college picker policy:
// - AICTE-sourced online data only
// - 2026-27 dataset
// - all Indian states
// - engineering/technology institutions only
// - no static/snapshot fallback that can silently become stale
//
// Fetched through THIS SITE's own /api/aicte-directory, not the upstream URL
// directly. vercel.json rewrites that path to the same upstream and sets
// CDN-Cache-Control (1h cache, 1d stale-while-revalidate) on it — that
// caching layer was already configured but the code here was still hitting
// the flaky third-party mirror directly on every cold serverless instance,
// getting the AbortError/HTTP 500/ECONNRESET failures that caching exists
// to absorb. Going through the CDN-cached path means most requests are
// served from Vercel's edge instead of depending on the upstream being up
// at that exact moment, without reviving the stale-snapshot design this
// file explicitly rejected (a cache miss still fetches fresh data or fails
// honestly — it never serves silently-outdated data past the 1-day grace).
const LIVE_PROXY_URL =
  (process.env.NEXT_PUBLIC_APP_URL || "https://studentplatform.dev").replace(/\/$/, "") +
  "/api/aicte-directory";

let cached: { expires: number; colleges: OnlineEngineeringCollege[] } | null = null;
let loading: Promise<OnlineEngineeringCollege[]> | null = null;

const EXCLUDED_NON_ENGINEERING = [
  "polytechnic", "diploma", "mba", "mca", "management", "degree college",
  "first grade", "pharmacy", "nursing", "medical", "dental", "ayur",
  "homoeo", "physiotherapy", "paramedical", "education", "teacher",
  "law college", "arts college", "commerce", "hotel management",
  "hospitality", "fine arts", "social science",
];

const ENGINEERING_MARKERS = [
  "engineering", "technology", "technological", "technical institute",
  "institute of information technology", "college of technology",
  "school of engineering", "faculty of engineering", "institute of technology",
  "technological university", "iit ", "iit-", "nit ", "nit-", "iiit ", "iiit-",
];

function normalize(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isEngineeringInstitution(name: string): boolean {
  const n = normalize(name);
  if (!n) return false;
  if (EXCLUDED_NON_ENGINEERING.some((term) => n.includes(term))) return false;
  return ENGINEERING_MARKERS.some((term) => n.includes(term));
}

function mapRows(payload: unknown): OnlineEngineeringCollege[] {
  const wrapped = payload && typeof payload === "object"
    ? payload as { data?: unknown }
    : null;

  const rawPayload = wrapped?.data ?? payload;
  const raw = Array.isArray(rawPayload)
    ? rawPayload
    : rawPayload && typeof rawPayload === "object" && Array.isArray((rawPayload as { combined?: unknown }).combined)
      ? (rawPayload as { combined: unknown[] }).combined
      : rawPayload && typeof rawPayload === "object" && Array.isArray((rawPayload as { data?: unknown[] }).data)
        ? (rawPayload as { data: unknown[] }).data
        : [];

  const seen = new Set<string>();
  const result: OnlineEngineeringCollege[] = [];

  for (const row of raw) {
    let id = "";
    let name = "";

    if (Array.isArray(row)) {
      id = String(row[0] ?? "").trim();
      name = String(row[1] ?? "").trim();
    } else if (row && typeof row === "object") {
      const r = row as Record<string, unknown>;
      id = String(r.aicte_id ?? r.id ?? r.college_code ?? "").trim();
      name = String(r.institute_name ?? r.name ?? "").trim();
    }

    name = name.replace(/\s+/g, " ");
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);

    result.push({
      id,
      name,
      search_aliases: [
        id,
        name,
        ...name.split(/\s+/).filter((part) => part.length >= 4),
      ],
    });
  }

  return result;
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  // The live AICTE proxy can return an ~12 MB dataset. A 10-second timeout
  // was too aggressive on Vercel and caused the picker to fail even though
  // the upstream service was healthy. Use one bounded 30-second request so
  // the serverless function has enough time to download and parse it without
  // stacking multiple retries into the function execution window.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "Student-Platform-College-Directory/2.0",
      },
    });

    if (!response.ok) {
      throw new Error("AICTE college source returned HTTP " + response.status);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadDirectory(): Promise<OnlineEngineeringCollege[]> {
  // Deliberately do not fall back to an older snapshot. A stale snapshot can
  // make the student picker silently incomplete and was the source of the
  // previous "2 engineering colleges" failure mode.
  const payload = await fetchJson(LIVE_PROXY_URL, 30_000);
  const raw = mapRows(payload);
  const colleges = raw.filter((college) => isEngineeringInstitution(college.name));

  // A tiny response is treated as a failed/partial upstream response rather
  // than being presented to students as the complete India directory.
  if (colleges.length < 100) {
    throw new Error(
      `AICTE engineering directory validation failed: only ${colleges.length} engineering institutions returned`,
    );
  }

  return colleges;
}

export async function getOnlineEngineeringColleges(): Promise<OnlineEngineeringCollege[]> {
  if (cached && cached.expires > Date.now()) return cached.colleges;
  if (loading) return loading;

  loading = loadDirectory().then((colleges) => {
    // Refresh frequently enough to pick up AICTE changes without making every
    // student request download the large directory.
    cached = {
      expires: Date.now() + 10 * 60_000,
      colleges,
    };
    return colleges;
  });

  try {
    return await loading;
  } finally {
    loading = null;
  }
}

export async function getEngineeringDirectorySource(): Promise<string> {
  await getOnlineEngineeringColleges();
  return "AICTE online · 2026-27";
}

export function filterEngineeringColleges(
  colleges: OnlineEngineeringCollege[],
): OnlineEngineeringCollege[] {
  // Keep this exported guard so callers cannot accidentally bypass the
  // engineering-only contract if they receive a mixed dataset in the future.
  return colleges.filter((college) => isEngineeringInstitution(college.name));
}

export function searchOnlineEngineeringColleges(
  colleges: OnlineEngineeringCollege[],
  query: string,
): OnlineEngineeringCollege[] {
  const needle = normalize(query);
  if (!needle) return colleges.slice(0, 25);

  return colleges
    .filter((college) =>
      college.search_aliases.some((alias) => {
        const text = normalize(alias);
        return text.includes(needle) || text.split(" ").some((token) => token.startsWith(needle));
      }),
    )
    .slice(0, 25);
}
