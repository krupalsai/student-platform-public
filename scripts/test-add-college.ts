/**
 * Pins the fix for a live-reported failure:
 *
 *   bot   : "College not listed — review required … Action: Verify the correct
 *            institution and add it to the supported-college list."
 *   admin : "Add then"
 *   bot   : "Could you clarify what you'd…"
 *
 * The alert asked for an action the bot had no command for, so nothing could
 * match the reply. Same shape as item #118, where the admin prompt referred to
 * commands it never showed and the model invented one.
 *
 * Two things must stay true, and they are separate failures:
 *   1. ADD COLLEGE exists and matches what an admin would actually type.
 *   2. The alert NAMES that command. A command nobody is told about is not
 *      reachable, which is the state this whole bug came from.
 *
 *   node --experimental-strip-types scripts/test-add-college.ts
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

const admin = readFileSync("src/lib/whatsapp/admin.ts", "utf8");
const colleges = readFileSync("src/lib/services/colleges.ts", "utf8");
const knowledge = readFileSync("src/lib/intent-engine/platform-knowledge.ts", "utf8");

let passed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
}

// ── 1. The command exists and matches real input ──────────────────────────
const ADD_COLLEGE_RE = /^ADD\s*COLLEGE\b/i;
for (const input of ["ADD COLLEGE GNITS", "add college Gnits", "AddCollege GNITS", "ADD COLLEGE: GNITS"]) {
  ok(`matches "${input}"`, ADD_COLLEGE_RE.test(input.trim()));
}
ok("the handler uses that matcher", /\/\^ADD\\s\*COLLEGE\\b\/i\.test\(trimmed\)/.test(admin));

// Must not swallow ADD ADMIN, which is a different command sitting earlier in
// the same chain.
ok("does not swallow ADD ADMIN", !ADD_COLLEGE_RE.test("ADD ADMIN 9000000010"));
// ...and ADD ADMIN's own matcher must not swallow ADD COLLEGE, since it runs first.
const ADD_ADMIN_RE = /^(ADD|REMOVE|DELETE)\s*ADMIN\b/i;
ok("ADD ADMIN does not swallow ADD COLLEGE", !ADD_ADMIN_RE.test("ADD COLLEGE GNITS"));

// ── 2. The alert names the command ────────────────────────────────────────
// This is the assertion that would have caught the reported bug. The previous
// text ended at "add it to the supported-college list", which tells an admin
// what to achieve but not how, so their natural-language reply matched nothing.
const alert = admin.slice(
  admin.indexOf("College not listed"),
  admin.indexOf("College not listed") + 1200,
);
ok("the not-listed alert exists", alert.length > 0);
ok(
  "the alert tells the admin to reply ADD COLLEGE",
  /ADD COLLEGE/.test(alert),
  "alert must name the command, not just describe the goal",
);
ok(
  "the alert interpolates the requested college name into the command",
  /ADD COLLEGE \$\{collegeName\}/.test(alert),
  "so the admin can send it verbatim rather than retyping the name",
);

// ── 3. It is advertised to the model, and backed by a real service call ───
ok(
  "ADD COLLEGE is in the admin command reference",
  /- ADD COLLEGE/.test(knowledge),
);
ok("addCollege() exists", /export async function addCollege/.test(colleges));
ok("the handler actually calls it", /addCollege\(db, name\)/.test(admin));

// ── 4. Re-activation, not a duplicate-key error ───────────────────────────
// The AICTE "not listed" flow has already inserted ~22 inactive rows, so the
// college an admin is asked to approve usually EXISTS with active=false.
// Inserting blindly would fail on the primary key and the admin would be told
// the college could not be added when in fact it was already there.
ok(
  "an existing inactive college is re-activated rather than re-inserted",
  /if \(existing\)/.test(colleges) && /active: true/.test(colleges),
);
ok(
  "an already-active college is reported, not silently re-added",
  /already active/.test(colleges),
);

console.log(`test-add-college: all ${passed} assertions passed`);
