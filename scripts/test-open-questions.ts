/**
 * The admin's open-question queue, and the tag-stripping bug that hid the
 * usage lines telling admins how to use it.
 *
 * Two real failures are pinned here:
 *
 *  1. Tapping "Answer a Question" printed only "reply with ANSWER UQ-001" —
 *     an invented example id. The questions students had actually asked were
 *     recorded in unknown_questions all along and never shown, so an admin had
 *     no way to know what was waiting. formatOpenQuestions() is the fix.
 *
 *  2. Every usage string that names its arguments in angle brackets —
 *     "MESSAGE <phone> <text>" — was run through a blanket /<[^>]+>/ strip on
 *     the way out, and reached the admin's phone as "MESSAGE ". Confirmed in a
 *     production screenshot.
 *
 * Both halves under test are pure — no Supabase, no Meta API.
 *
 * Run with: npx tsx scripts/test-open-questions.ts
 */
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL  = "https://dummy.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy-service-role-key";
process.env.WHATSAPP_ACCESS_TOKEN     = "dummy-token";
process.env.WHATSAPP_PHONE_NUMBER_ID  = "dummy-phone-id";

/* eslint-disable @typescript-eslint/no-require-imports */
const oq = require("../src/lib/whatsapp/open-questions") as typeof import("../src/lib/whatsapp/open-questions");
/* eslint-enable @typescript-eslint/no-require-imports */

const { formatOpenQuestions, displayIdFor } = oq;

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}\n     ${(e as Error).message}`);
  }
}

type Q = Parameters<typeof formatOpenQuestions>[0][number];
const q = (over: Partial<Q> = {}): Q => ({
  shortId: 45,
  displayId: "UQ-045",
  question: "After entering my details and clicking save it shows internal server error",
  occurrences: 1,
  phone: "919000000031",
  name: null,
  lastSeenAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
  ...over,
});

console.log("\n── the queue an admin actually sees ─────────────────────────");

test("the question text itself is shown, not just an id", () => {
  const out = formatOpenQuestions([q()], 1);
  assert.ok(
    out.includes("internal server error"),
    "the admin must be able to read the question without opening the website",
  );
  assert.ok(out.includes("UQ-045"));
});

test("the reply example uses a REAL id from the queue, not UQ-001", () => {
  const out = formatOpenQuestions([q({ shortId: 45, displayId: "UQ-045" })], 1);
  assert.ok(out.includes("ANSWER UQ-045"), "example must be answerable as-is");
  assert.ok(!out.includes("UQ-001"), "UQ-001 was the invented placeholder that started this bug");
});

test("who asked and how long ago are shown", () => {
  const named = formatOpenQuestions([q({ name: "Ravi" })], 1);
  assert.ok(named.includes("Ravi"));
  assert.ok(named.includes("1h ago"), `expected a relative time, got:\n${named}`);

  const anon = formatOpenQuestions([q({ name: null })], 1);
  assert.ok(anon.includes("+919000000031"), "fall back to the number when there's no name");
});

test("a repeatedly-asked question is marked as such", () => {
  const out = formatOpenQuestions([q({ occurrences: 4 })], 1);
  assert.ok(out.includes("4×"), `expected the repeat count, got:\n${out}`);
  const once = formatOpenQuestions([q({ occurrences: 1 })], 1);
  assert.ok(!once.includes("1×"), "don't clutter a one-off with 'asked 1×'");
});

test("a capped list says how many more there are", () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    q({ shortId: 40 + i, displayId: `UQ-0${40 + i}` }));
  const out = formatOpenQuestions(many, 18);
  assert.ok(out.includes("10 of 18"), `expected the total, got:\n${out.slice(0, 200)}`);
});

test("an empty queue reads as done, not as an error", () => {
  const out = formatOpenQuestions([], 0);
  assert.ok(/no open questions/i.test(out));
  assert.ok(!out.includes("undefined"));
  assert.ok(!out.includes("ANSWER UQ"), "don't prompt for an answer when there's nothing to answer");
});

test("every listed question is present in the output", () => {
  const list = [
    q({ shortId: 45, displayId: "UQ-045", question: "internal server error" }),
    q({ shortId: 40, displayId: "UQ-040", question: "Amount needed for registration" }),
    q({ shortId: 31, displayId: "UQ-031", question: "Is there any seats available", occurrences: 4 }),
  ];
  const out = formatOpenQuestions(list, 3);
  for (const item of list) {
    assert.ok(out.includes(item.displayId), `${item.displayId} missing`);
    assert.ok(out.includes(item.question), `"${item.question}" missing`);
  }
});

test("display ids are zero-padded to match what the ANSWER command parses", () => {
  assert.equal(displayIdFor(45, "abcdef01-2345"), "UQ-045");
  assert.equal(displayIdFor(1, "abcdef01-2345"), "UQ-001");
  assert.equal(displayIdFor(1234, "abcdef01-2345"), "UQ-1234");
  // No short_id at all — fall back to a stub of the uuid rather than "UQ-null".
  assert.equal(displayIdFor(null, "abcdef01-2345"), "abcdef01");
});

console.log("\n── ANSWER command parsing ───────────────────────────────────");

// The exact regex admin.ts uses. Kept in step deliberately: a change to one
// without the other is what turns a working command into "unknown command".
const ANSWER_RE = /^ANSWER\s+(?:UQ[-\s]?)?(\d+)[\s:.\-]*([\s\S]*)$/i;
const parseAnswer = (s: string) => {
  const m = s.match(ANSWER_RE);
  return m ? { id: parseInt(m[1], 10), answer: (m[2] ?? "").trim() } : null;
};

test("the documented form — id on line 1, answer below — works", () => {
  const p = parseAnswer("ANSWER UQ-045\nClear your browser cache and try again.");
  assert.equal(p?.id, 45);
  assert.equal(p?.answer, "Clear your browser cache and try again.");
});

test("the answer on the SAME line works too", () => {
  // Typing on a phone, a newline is a deliberate act; plenty of admins won't.
  const p = parseAnswer("ANSWER UQ-045 Clear your cache and try again.");
  assert.equal(p?.id, 45);
  assert.equal(p?.answer, "Clear your cache and try again.");
});

test("a bare number works — UQ- is noise to retype", () => {
  assert.equal(parseAnswer("ANSWER 45 try again")?.id, 45);
  assert.equal(parseAnswer("answer uq 45 try again")?.id, 45);
});

test("an id with no answer is still recognised (so we can show the question)", () => {
  const p = parseAnswer("ANSWER UQ-045");
  assert.equal(p?.id, 45);
  assert.equal(p?.answer, "");
});

test("a multi-line answer keeps every line", () => {
  const p = parseAnswer("ANSWER UQ-045\nline one\nline two\nline three");
  assert.equal(p?.answer, "line one\nline two\nline three");
});

console.log("\n── HTML stripping must not eat usage placeholders ───────────");

// Mirrors client.ts. Kept here because the two must agree; the bug was a
// blanket /<[^>]+>/ that matched <phone> as eagerly as <b>.
const HTML_TAG_NAMES = "a|abbr|b|blockquote|br|code|del|div|em|h[1-6]|hr|i|img|li|ol|p|pre|s|small|span|strike|strong|sub|sup|table|tbody|td|th|thead|tr|u|ul";
const STRAY_HTML_TAG = new RegExp(`</?(?:${HTML_TAG_NAMES})(?:\\s[^<>]*)?/?>`, "gi");
const toWa = (input: string) =>
  input
    .replace(/<(b|strong)>/gi, "*").replace(/<\/(b|strong)>/gi, "*")
    .replace(/<(i|em)>/gi, "_").replace(/<\/(i|em)>/gi, "_")
    .replace(/<(s|strike|del)>/gi, "~").replace(/<\/(s|strike|del)>/gi, "~")
    .replace(/<code>/gi, "```").replace(/<\/code>/gi, "```")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(STRAY_HTML_TAG, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'");

test("REGRESSION: 'MESSAGE <phone> <text>' keeps its arguments", () => {
  // The production screenshot showed "Usage: *MESSAGE *".
  assert.equal(toWa("Usage: *MESSAGE <phone> <text>*"), "Usage: *MESSAGE <phone> <text>*");
});

test("every other usage placeholder survives", () => {
  for (const s of [
    "*BROADCAST <your message>*",
    "*WHATSAPP BROADCAST <msg>*",
    "*ADD ADMIN <phone>*",
    "*END BATCH <COLLEGE>*",
    "*ANSWER UQ-001*\n<your answer>",
    "*RESTRICT PERMANENT <phone>*",
  ]) {
    assert.equal(toWa(s), s, `mangled: ${s}`);
  }
});

test("real HTML is still converted", () => {
  assert.equal(toWa("<b>Registration Complete!</b>"), "*Registration Complete!*");
  assert.equal(toWa("<i>soon</i>"), "_soon_");
  assert.equal(toWa("line<br>break"), "line\nbreak");
  assert.equal(toWa('<a href="https://x.test">link</a>'), "link");
  assert.equal(toWa("<p>para</p><div>d</div>"), "parad");
});

test("entities are still decoded", () => {
  assert.equal(toWa("GNIT &amp; GNITC"), "GNIT & GNITC");
  assert.equal(toWa("&quot;quoted&quot;"), '"quoted"');
});

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
