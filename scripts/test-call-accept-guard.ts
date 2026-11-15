/**
 * Pins the real reason an admin callback could never be answered.
 *
 * Live report, after the notifyStudent/ringtone fix (test-call-notifications.ts)
 * shipped: "Still had with calling and talking". Checked prod data rather than
 * guessed — every single `voice_calls` row with reason "Admin callback" was
 * `status: "missed"`, `answered_at: null`, forever. Not one had ever reached
 * `accepted`. Meanwhile student-INITIATED calls (reason "Payment problem" etc,
 * the admin accepting) worked fine, including one real 29-minute call.
 *
 * Root cause, in `src/app/api/calls/[id]/route.ts`'s accept/decline handler:
 *
 *   if (isStudentCallback) query = query.eq("admin_id", user!.profileId);
 *
 * `isStudentCallback` is true when the STUDENT is accepting an admin-placed
 * callback. `user!.profileId` there is the STUDENT's own profile id — but
 * `call.admin_id` on that row is the ADMIN who placed the callback, a
 * different person. The row can never match `admin_id = <student's id>`
 * (except by coincidence when one account is both, e.g. an enrolled admin
 * testing on themselves — which is exactly why a handful of self-test calls
 * looked like they worked while every real one silently 409'd). The UPDATE
 * therefore always matched zero rows, and the API answered "That callback is
 * no longer available" no matter how fast the student tapped Answer.
 *
 * The fix removes that filter entirely for the student side — `loadParticipantCall`
 * already proved the caller owns this exact row (its `student_id` matches
 * them), so `.eq("id", id).eq("status", "ringing")` is the whole guard needed.
 * The admin-side guard (an unclaimed student-originated call, raced between
 * every super_admin) is untouched.
 *
 *   node --experimental-strip-types scripts/test-call-accept-guard.ts
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

const route = readFileSync("src/app/api/calls/[id]/route.ts", "utf8");

let passed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
}

const acceptBlock = route.slice(
  route.indexOf('if (action === "accept" || action === "decline")'),
  route.indexOf("// end — either side may hang up"),
);

ok(
  "the accept/decline query never filters by the STUDENT's own profileId as if it were the admin's",
  !/isStudentCallback\)\s*query\s*=\s*query\.eq\("admin_id",\s*user!\.profileId\)/.test(acceptBlock),
  "call.admin_id is the ADMIN who placed the callback, never the student accepting it — that filter always matched zero rows and 409'd every real callback",
);

ok(
  "the admin-side unclaimed-call guard is still there",
  /if \(side === "admin"\) query = query\.is\("admin_id", null\);/.test(acceptBlock),
  "a student-originated call must still be claimable by only one racing super_admin",
);

ok(
  "isStudentCallback is still computed and still gates who may act at all",
  acceptBlock.includes("const isStudentCallback = side === \"student\" && !!call.admin_id;") &&
    acceptBlock.includes('if (side !== "admin" && !isStudentCallback) return forbidden();'),
  "this check is correct on its own — only the later query filter reusing it was wrong",
);

ok(
  "the query is still scoped to this exact row and still-ringing",
  acceptBlock.includes('.eq("id", id)') && acceptBlock.includes('.eq("status", "ringing")'),
);

console.log(`test-call-accept-guard: all ${passed} assertions passed`);
