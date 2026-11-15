/**
 * Pins the best-effort "is today's listing the judgment" heuristic added to
 * src/lib/services/court-case.ts (`computeJudgmentSignal`/`isDateTodayIST`).
 * There is no "purpose of next hearing" field on this court's API — the
 * signal is inferred from real court text (case status, or the latest
 * case-history "business" line) containing a judgment-related word,
 * combined with today's date matching the listing date. The one thing this
 * must NEVER do is fire off a bare listing date alone — that's just an
 * ordinary hearing, not a judgment.
 *
 * **Why this mirrors the real functions instead of importing them**: this
 * repo's other `scripts/test-*.ts` that try to `import` a real `src/lib/*`
 * module already fail under bare `node --experimental-strip-types` in this
 * environment, because that module's own `@/lib/...` alias imports don't
 * resolve outside Next's build (confirmed, e.g., in item #143's notes on
 * several pre-existing WhatsApp-intent test scripts) — the SAME failure
 * reproduces here (`court-case.ts` imports `@/lib/system-errors`).
 * `JUDGMENT_KEYWORD_RE` and both function bodies are copied verbatim below;
 * if `court-case.ts`'s versions ever change, update this file to match.
 *
 *   node --experimental-strip-types scripts/test-court-judgment-signal.ts
 */
import assert from "node:assert";

// ── Mirrors src/lib/services/court-case.ts verbatim — keep in sync ─────────
const JUDGMENT_KEYWORD_RE = /judg[e]?ment|reserved|pronounce/i;

function isDateTodayIST(ddmmyyyy: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!ddmmyyyy) return false;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmyyyy);
  if (!m) return false;
  const istNow = new Date(nowMs + 5.5 * 60 * 60 * 1000);
  return (
    Number(m[1]) === istNow.getUTCDate() &&
    Number(m[2]) === istNow.getUTCMonth() + 1 &&
    Number(m[3]) === istNow.getUTCFullYear()
  );
}

function computeJudgmentSignal(
  statusText: string | null | undefined,
  latestHistoryBusiness: string | null | undefined,
  listingDateDDMMYYYY: string | null | undefined,
  nowMs: number = Date.now()
): { judgmentLikelyToday: boolean; judgmentHintText: string | null } {
  if (!isDateTodayIST(listingDateDDMMYYYY, nowMs)) {
    return { judgmentLikelyToday: false, judgmentHintText: null };
  }
  if (statusText && JUDGMENT_KEYWORD_RE.test(statusText)) {
    return { judgmentLikelyToday: true, judgmentHintText: `Case status: ${statusText}` };
  }
  if (latestHistoryBusiness && JUDGMENT_KEYWORD_RE.test(latestHistoryBusiness)) {
    return { judgmentLikelyToday: true, judgmentHintText: latestHistoryBusiness };
  }
  return { judgmentLikelyToday: false, judgmentHintText: null };
}
// ── End mirror ───────────────────────────────────────────────────────────

let passed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
}

// Fixed "now": 2026-09-24T10:00:00Z -> 2026-09-24 IST (well inside the same day).
const NOW = new Date("2026-09-24T10:00:00Z").getTime();

// ── isDateTodayIST ─────────────────────────────────────────────────────────
ok("today's date (DD/MM/YYYY) matches", isDateTodayIST("24/09/2026", NOW));
ok("yesterday does not match", !isDateTodayIST("23/09/2026", NOW));
ok("tomorrow does not match", !isDateTodayIST("25/09/2026", NOW));
ok("null date does not match", !isDateTodayIST(null, NOW));
ok("malformed date does not match", !isDateTodayIST("2026-09-24", NOW));

// ── computeJudgmentSignal: the core "must not false-positive" cases ────────
ok(
  "a routine PENDING status on today's listing is NOT a judgment signal",
  computeJudgmentSignal("PENDING", null, "24/09/2026", NOW).judgmentLikelyToday === false,
  "a bare listing date alone must never read as judgment day"
);
ok(
  "a DISPOSED case is not itself flagged as 'today is judgment day' (it already happened)",
  computeJudgmentSignal("DISPOSED", null, "24/09/2026", NOW).judgmentLikelyToday === false
);
ok(
  "a judgment-worded status on a DIFFERENT day (not today) does not fire",
  computeJudgmentSignal("RESERVED FOR ORDERS", null, "23/09/2026", NOW).judgmentLikelyToday === false,
  "the date match is required, not just the keyword"
);
ok(
  "no listing date at all does not fire even with judgment wording",
  computeJudgmentSignal("RESERVED FOR JUDGMENT", null, null, NOW).judgmentLikelyToday === false
);

// ── computeJudgmentSignal: the real positive cases ──────────────────────────
{
  const r = computeJudgmentSignal("RESERVED FOR ORDERS", null, "24/09/2026", NOW);
  ok("'RESERVED FOR ORDERS' status + today's listing DOES fire", r.judgmentLikelyToday === true);
  ok("hint text surfaces the real status text", r.judgmentHintText === "Case status: RESERVED FOR ORDERS");
}
{
  const r = computeJudgmentSignal("PENDING", "Matter reserved for pronouncement of judgment", "24/09/2026", NOW);
  ok(
    "a judgment-worded case-history 'business' line + today's listing DOES fire, even with a plain PENDING status",
    r.judgmentLikelyToday === true
  );
  ok(
    "hint text surfaces the real business line verbatim, not a paraphrase",
    r.judgmentHintText === "Matter reserved for pronouncement of judgment"
  );
}
{
  const r = computeJudgmentSignal("PENDING", "Adjourned for filing counter", "24/09/2026", NOW);
  ok("an ordinary procedural business line (no judgment wording) does NOT fire", r.judgmentLikelyToday === false);
}

console.log(`\n✅ ${passed} assertions passed — court-judgment-signal heuristic pinned.`);
