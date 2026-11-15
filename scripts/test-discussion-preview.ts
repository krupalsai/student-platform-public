/**
 * Pins the fix for a live report: "at student group chat section when I
 * open the discussion of gnit 2 it is opening the gnitc 1".
 *
 * Root cause: /discussion/page.tsx read `sp_token` straight from
 * localStorage for every fetch (loadMessages/pollNew/send/the read-receipt
 * POST), completely ignoring `?preview_token=` — unlike /batch, /payments
 * and /messages, which all already went through `useStudentData()`
 * (whose `authHeader()` prefers `preview_token` over the admin's own
 * session, item #72). `/messages`'s "Batch Discussion" button already
 * calls `navigate("/discussion")`, which DOES append `?preview_token=`
 * when previewing — the URL carried the right token, the page just never
 * read it. So previewing a GNIT Batch 2 student's Discussion showed the
 * ADMIN's own real batch chat (GNITC Batch 1) instead, and this happened
 * for every batch previewed, not just this one pair.
 *
 * Fix: /discussion now shares useStudentData() like its sibling tabs, and
 * preview mode is read-only there too (no send, no read-receipts, no call
 * buttons) — the same "look, never act as the student" rule item #72
 * applies everywhere else.
 *
 *   node --experimental-strip-types scripts/test-discussion-preview.ts
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

const page = readFileSync("src/app/discussion/page.tsx", "utf8");

let passed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
}

ok(
  "the page shares useStudentData(), not a private localStorage-only reader",
  page.includes('from "@/lib/hooks/useStudentData"') && page.includes("useStudentData()"),
);
ok(
  "no fetch on this page builds its own Authorization header from localStorage directly",
  !/localStorage\.getItem\(\s*["']sp_token["']\s*\)/.test(page),
  "that bypasses preview_token entirely — the exact bug reported live",
);
ok(
  "batch identity comes from the loaded profile (preview-aware), not a bare fetch",
  page.includes("profile?.batch_id") && page.includes("profile?.batches?.name"),
);

for (const call of [
  'fetch(`/api/group-chat/${id}/messages`, { headers: authHeader() }',
  "fetch(`/api/group-chat/${id}/messages?since=",
  'fetch(`/api/group-chat/${batchId}/messages`, { method: "POST", headers: authHeader()',
  "fetch(`/api/group-chat/${batchId}/read`",
]) {
  ok(`a group-chat fetch call site is present: ${call.slice(0, 40)}…`, page.includes(call.split("${")[0] + "${"));
}
ok(
  "every group-chat fetch on this page uses the preview-aware auth header",
  (page.match(/headers:\s*authHeader\(\)/g) ?? []).length >= 2 &&
    (page.match(/\.\.\.authHeader\(\)/g) ?? []).length >= 1,
);

ok(
  "sending a message is a no-op in preview mode",
  /async function send\(\)\s*\{\s*if\s*\(previewMode/.test(page),
);
ok(
  "marking messages read is skipped in preview mode",
  /if\s*\(previewMode \|\| !batchId \|\| !myId \|\| !messages\.length\)\s*return;/.test(page),
);
ok(
  "the composer itself is hidden in preview mode, not just its handler disarmed",
  /previewMode\s*\?\s*\([\s\S]{0,400}read only/.test(page),
);
ok(
  "the group call buttons are hidden in preview mode",
  /rightSlot=\{previewMode \? undefined/.test(page),
);

console.log(`test-discussion-preview: all ${passed} assertions passed`);
