// Pins the WhatsApp "VERIFY -> 6-digit login code" reply
// (whatsapp/verify-code.ts) and the login / registration screens that
// lead to it.
//
// Why it exists: a login code sent as a plain WhatsApp message is accepted by
// Meta and then silently dropped when the person has not messaged the bot in
// the last 24 hours — the owner saw "code sent" and got nothing. The fix is
// NOT a link (the old one-time sign-in link opened in Chrome instead of the
// installed app, and was removed 9 Nov 2026): the person sends VERIFY,
// which opens the window, and the bot replies with the code. A reply to
// the student's own message is inside the window by construction, so the
// code always arrives. The app's "Try again" button is the same path —
// it opens WhatsApp with VERIFY pre-filled.
//
// The handler signs people in via the code, so the tests are about WHO
// gets a code and that the code is the one stored — not just that it works.
//
// Run: node scripts/test-verify-code.cjs
const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const jiti = require("jiti")(__filename, { alias: { "@": path.resolve(__dirname, "../src") }, interopDefault: true });
process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
process.env.WHATSAPP_ADMIN_NUMBER = ""; // no bootstrap admin in the fake database
const { replyWithCodeToVerify, VERIFY_MESSAGE_RE } = jiti("../src/lib/whatsapp/verify-code.ts");
const { redactCredentials } = jiti("../src/lib/whatsapp/bot-guard.ts");
const read = (p) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error("FAIL:", n); } };
const sha = (s) => createHash("sha256").update(s).digest("hex");

// ── A tiny fake of the Supabase query builder: just what these two modules touch ──
function makeDb(state) {
  state.inserted = [];
  state.updated = [];
  state.deleted = [];
  state.rate = state.rate || {};
  let nextId = 1;
  const matches = (r, filters) =>
    filters.every(([op, c, v]) =>
      op === "eq" ? r[c] === v
      : op === "is" ? (r[c] ?? null) === v
      : op === "gt" ? (r[c] === undefined || r[c] > v) // a row without the column counts as "still valid"
      : op === "lt" ? (r[c] !== undefined && r[c] < v)
      : op === "in" ? v.includes(r[c])
      : true);
  function exec(q) {
    if (q.op === "insert") {
      if (state.failInsert === q.table) {
        if (state.onInsertFail) state.onInsertFail(q.table); // e.g. a concurrent request created the row first
        return { data: null, error: { message: "boom" } };
      }
      const row = q.table === "profiles" ? { id: `new-profile-${nextId++}`, ...q.payload } : { ...q.payload };
      state.inserted.push({ table: q.table, row });
      (state[q.table] = state[q.table] || []).push(row);
      if (q.table === "rate_limits") state.rate[q.payload.bucket_key] = (state.rate[q.payload.bucket_key] || 0) + 1;
      return { data: q.table === "profiles" ? row : null, error: null };
    }
    if (q.op === "update") {
      const hit = (state[q.table] || []).filter((r) => matches(r, q.filters));
      hit.forEach((r) => Object.assign(r, q.payload));
      state.updated.push({ table: q.table, payload: q.payload, filters: q.filters });
      return q.wantRows ? { data: q.single ? hit[0] ?? null : hit, error: null } : { data: null, error: null };
    }
    if (q.op === "delete") {
      const doomed = (state[q.table] || []).filter((r) => matches(r, q.filters));
      state[q.table] = (state[q.table] || []).filter((r) => !doomed.includes(r));
      state.deleted.push({ table: q.table, count: doomed.length, filters: q.filters });
      return { data: null, error: null };
    }
    if (q.table === "rate_limits") {
      const key = q.filters.find((f) => f[1] === "bucket_key")[2];
      return { count: state.rate[key] || 0, error: null };
    }
    const rows = (state[q.table] || []).filter((r) => matches(r, q.filters));
    return q.single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
  }
  return {
    from(table) {
      const q = { table, filters: [], op: "select", single: false, wantRows: false, payload: null };
      const api = {
        select() { q.wantRows = true; return api; },
        insert(row) { q.op = "insert"; q.payload = row; return api; },
        update(row) { q.op = "update"; q.payload = row; q.wantRows = false; return api; },
        delete() { q.op = "delete"; return api; },
        eq(c, v) { q.filters.push(["eq", c, v]); return api; },
        is(c, v) { q.filters.push(["is", c, v]); return api; },
        gt(c, v) { q.filters.push(["gt", c, v]); return api; },
        gte(c, v) { q.filters.push(["gte", c, v]); return api; },
        lt(c, v) { q.filters.push(["lt", c, v]); return api; },
        in(c, v) { q.filters.push(["in", c, v]); return api; },
        order() { return api; },
        limit() { return api; },
        single() { q.single = true; return api; },
        maybeSingle() { q.single = true; return api; },
        then(resolve, reject) { try { resolve(exec(q)); } catch (e) { reject(e); } },
      };
      return api;
    },
  };
}

const FROM = "919000000010"; // what Meta sends: country code, no plus
const PHONE = "9000000010";
const codeIn = (text) => (text.match(/login code: (\d{6})/) || [])[1];

async function run(state, opts = { isAdmin: false }, from = FROM) {
  const db = makeDb(state);
  const sent = [];
  const handled = await replyWithCodeToVerify(db, from, opts, { send: async (to, text, sendOpts) => { sent.push({ to, text, opts: sendOpts }); return true; } });
  return { handled, sent, inserted: state.inserted, updated: state.updated, state };
}
const otpRows = (r) => r.inserted.filter((i) => i.table === "app_login_otps");
const student = (extra = {}) => ({ id: "p1", phone: PHONE, role: "student", is_profile_complete: true, ...extra });

(async () => {
  // 0. Which messages count as VERIFY — exact word only, never a sentence.
  for (const t of ["VERIFY", "verify", " Verify ", "VERIFY!", "verify."]) check(`matches: ${JSON.stringify(t)}`, VERIFY_MESSAGE_RE.test(t));
  for (const t of ["verify my payment", "unverified", "LOGIN", "please verify", "verify 123456", ""]) check(`ignores: ${JSON.stringify(t)}`, !VERIFY_MESSAGE_RE.test(t));

  // 1. A number we know nothing about is left to the normal bot — no code, no message.
  let r = await run({ profiles: [], registration_tokens: [] });
  check("unknown number: not handled", r.handled === false);
  check("unknown number: nothing sent", r.sent.length === 0);
  check("unknown number: nothing issued", r.inserted.length === 0);

  // 2. A registered student gets a 6-digit login code, to the sender only.
  r = await run({ profiles: [student()], registration_tokens: [] });
  check("student: handled", r.handled === true);
  check("student: exactly one message", r.sent.length === 1);
  check("student: reply goes to the sender's own number", r.sent[0].to === FROM);
  const code = codeIn(r.sent[0].text);
  check("student: the reply carries a 6-digit login code", /^\d{6}$/.test(code || ""));
  const otpRow = otpRows(r)[0];
  check("student: code stored against that profile", otpRow && otpRow.row.profile_id === "p1");
  check("student: only the code's hash is stored, and it matches", otpRow && otpRow.row.otp_hash === sha(code));
  check("student: the raw code is never stored", !JSON.stringify(r.inserted).includes(code));
  check("student: code expires in about 5 minutes", otpRow && Math.abs(new Date(otpRow.row.expires_at).getTime() - Date.now() - 5 * 60 * 1000) < 5000);
  check("student: no link of any kind is issued or sent", !r.inserted.some((i) => i.table === "student_login_keys") && !/login\?key=/.test(r.sent[0].text));
  check("student: the message says to type the code in the app", /Type this code in the Student App/i.test(r.sent[0].text));
  check("student: the message says the code expires in 5 minutes", /expires in 5 minutes/i.test(r.sent[0].text));
  check("student: the reply marks the code preserve-me, so the output guard cannot redact it", Array.isArray(r.sent[0].opts?.preserve) && r.sent[0].opts.preserve[0] === code);

  // 3. Staff roles need to be an active WhatsApp admin too (same rule as requestAppLoginOtp).
  const staff = () => ({ profiles: [{ id: "a1", phone: PHONE, role: "super_admin", is_profile_complete: true }], registration_tokens: [] });
  r = await run(staff(), { isAdmin: false });
  check("staff profile, not a WhatsApp admin: refused", r.handled === true && /isn't authorized/.test(r.sent[0].text));
  check("staff profile, not a WhatsApp admin: no code issued", otpRows(r).length === 0 && !codeIn(r.sent[0].text));
  r = await run(staff(), { isAdmin: true });
  check("staff profile that IS a WhatsApp admin: gets a code", r.handled === true && !!codeIn(r.sent[0].text) && otpRows(r).length === 1);

  // 4. A live registration link and no profile yet: the incomplete profile is
  // created (same as the login recovery path) so the code can be issued.
  const token = { id: "t1", phone: PHONE, consumed_at: null };
  r = await run({ profiles: [], registration_tokens: [token] });
  const made = r.inserted.find((i) => i.table === "profiles");
  check("link only: handled, one message, to the sender", r.handled === true && r.sent.length === 1 && r.sent[0].to === FROM);
  check("link only: an INCOMPLETE profile is created for the number", made && made.row.phone === PHONE && made.row.is_profile_complete === false && made.row.role === "student");
  check("link only: that profile is attached to the registration link", r.updated.some((u) => u.table === "registration_tokens" && made && u.payload.profile_id === made.row.id && u.filters.some((f) => f[1] === "id" && f[2] === "t1")));
  check("link only: the code belongs to the new profile", otpRows(r).length === 1 && made && otpRows(r)[0].row.profile_id === made.row.id && !!codeIn(r.sent[0].text));

  r = await run({ profiles: [], registration_tokens: [{ id: "t9", phone: "9999999999", consumed_at: null }] });
  check("someone else's link never gives this number anything", r.handled === false && r.sent.length === 0 && r.inserted.length === 0);
  r = await run({ profiles: [], registration_tokens: [{ id: "t8", phone: PHONE, consumed_at: "2026-01-01T00:00:00Z" }] });
  check("a used-up link gives nothing", r.handled === false && r.sent.length === 0);
  r = await run({ profiles: [], registration_tokens: [{ id: "t7", phone: PHONE, consumed_at: null, expires_at: "2000-01-01T00:00:00Z" }] });
  check("an expired link gives nothing and creates no profile", r.handled === false && r.sent.length === 0 && !r.inserted.some((i) => i.table === "profiles"));
  r = await run({ profiles: [], registration_tokens: [token], failInsert: "profiles" });
  check("profile cannot be created: falls through to the normal bot, no code", r.handled === false && r.sent.length === 0 && otpRows(r).length === 0);
  const raceState = { profiles: [], registration_tokens: [token], failInsert: "profiles" };
  raceState.onInsertFail = () => raceState.profiles.push({ id: "race-1", phone: PHONE, role: "student", is_profile_complete: false });
  r = await run(raceState);
  check("a concurrent request created the profile: it is used, not duplicated", r.handled === true && otpRows(r).length === 1 && otpRows(r)[0].row.profile_id === "race-1");
  r = await run({ profiles: [{ id: "a2", phone: PHONE, role: "admin", is_profile_complete: true }], registration_tokens: [token] }, { isAdmin: false });
  check("staff profile + link, not a WhatsApp admin: refused, nothing issued", r.handled === true && /isn't authorized/.test(r.sent[0].text) && otpRows(r).length === 0);

  // 5. A number cannot farm codes: 5 per 10 minutes, then it is told to wait.
  const flood = { profiles: [student({ id: "p4" })], registration_tokens: [], rate: {} };
  let issued = 0, last;
  for (let i = 0; i < 7; i++) {
    last = await run(flood);
    if (otpRows(last).length) issued++;
  }
  check("rate limit: only 5 codes get issued", issued === 5);
  check("rate limit: the extra request is told to wait, with no code", last.handled === true && !codeIn(last.sent[0].text) && /wait/i.test(last.sent[0].text));

  // 6. A database failure still answers the person instead of leaving them hanging.
  r = await run({ profiles: [student({ id: "p5" })], registration_tokens: [], failInsert: "app_login_otps" });
  check("insert failure: handled, apologises, no code in the text", r.handled === true && r.sent.length === 1 && !codeIn(r.sent[0].text) && /try again/i.test(r.sent[0].text));

  // 7. A malformed sender number is ignored.
  r = await run({ profiles: [student({ id: "p6", phone: "123" })], registration_tokens: [] }, { isAdmin: false }, "123");
  check("short sender number: not handled", r.handled === false && r.sent.length === 0);

  // ── Source pins: the wiring that makes this reachable and honest ──
  const router = read("src/lib/whatsapp/router.ts");
  const loginIdx = router.indexOf("if (/^LOGIN$/i.test(adminText))");
  const verifyIdx = router.indexOf("VERIFY_MESSAGE_RE.test(adminText)");
  const adminIdx = router.indexOf("  if (admin) {\n    if (msg.selectionId)");
  check("router handles VERIFY", verifyIdx > 0 && /replyWithCodeToVerify\(db, msg\.from, \{ isAdmin: !!admin \}\)/.test(router));
  check("router: VERIFY comes after LOGIN and before the admin branch", loginIdx > 0 && verifyIdx > loginIdx && verifyIdx < adminIdx);
  check("router: VERIFY is not behind the bot's on/off switch", verifyIdx < router.indexOf("if (!(await isWhatsAppBotEnabled(db)))"));

  const handler = read("src/lib/whatsapp/verify-code.ts");
  check("handler sends plain text only (free, in-window)", /sendWhatsAppText/.test(handler) && !/sendWhatsAppTemplate|resolveBroadcastTemplate/.test(handler));
  check("handler issues a login code, never a link", /issueLoginOtp\(db, profile\.id\)/.test(handler) && !/issueStudentLoginLink|student-login-link/.test(handler));
  const sendCalls = [...handler.matchAll(/\bsend\(([^,)]+)/g)].map((m) => m[1].trim());
  check("handler replies only to the sender", sendCalls.length >= 3 && sendCalls.every((a) => a === "waFrom"));

  const lib = read("src/lib/app-login.ts");
  check("one place issues login codes", /export async function issueLoginOtp/.test(lib) && /const otp = await issueLoginOtp\(db, profile\.id\)/.test(lib));
  check("the recovery profile is created in ONE place, used by login and VERIFY", /export async function createProfileForPendingToken/.test(lib) && /createProfileForPendingToken\(db, phone, pendingToken\.id\)/.test(lib) && /createProfileForPendingToken/.test(handler));
  check("login: the app request never sends WhatsApp itself", !/sendWhatsAppOtp/.test(lib) && /whatsappCodeFallback: true as const/.test(lib));
  const reqRoute = read("src/app/api/auth/app-login/request/route.ts");
  check("login route turns that flag into fallback: whatsapp_code", /fallback: "whatsapp_code"/.test(reqRoute) && /result\.whatsappCodeFallback/.test(reqRoute));
  check("login-link redeem route is deleted", !fs.existsSync(path.resolve(__dirname, "..", "src/app/api/auth/login-link/route.ts")));
  check("student-login-link module is deleted", !fs.existsSync(path.resolve(__dirname, "..", "src/lib/student-login-link.ts")));

  // ── The screens ──
  const login = read("src/app/login/page.tsx");
  check("login: the WhatsApp code button follows the server flag", /setShowCodeFallback\(data\?\.fallback === "whatsapp_code"\)/.test(login) && !/msg\.includes\(/.test(login));
  check("login: no ?key= redeem remains, no interstitial", !/params\.get\("key"\)/.test(login) && !/\/api\/auth\/login-link/.test(login) && !/browserSignedIn/.test(login) && !/signingInKey/.test(login) && !/You're signed in/.test(login));
  check("login: the code box always offers the WhatsApp code when it can", /No code\? Try again/.test(login) && /\{waLink && \(/.test(login));
  check("login: after sending, the code box opens without a new request", /function openCodeEntry\(\)/.test(login) && /onClick=\{openCodeEntry\}/.test(login));
  check("login: someone who already has the code can open the box from the phone form", /Already have a code\? Enter it/.test(login) && /Enter your mobile number first\./.test(login));
  check("login: the old long WhatsApp / 24-hour paragraphs are gone", !/WhatsApp only delivers/.test(login) && !/in the last 24 hours/.test(login) && !/Your login code arrives as an app notification/.test(login) && !/Message <b>app<\/b>/.test(login));
  check("login: the phone form hint is one short line", /Your code arrives as a notification and fills in by itself\./.test(login));

  const register = read("src/app/register/page.tsx");
  check("register: after sending, the code box opens without a new request", /function openVerifyCodeEntry\(\)/.test(register) && (register.match(/onClick=\{openVerifyCodeEntry\}/g) || []).length >= 1 && /Already have a code\? Enter it/.test(register));
  check("register: the old long paragraphs are gone", !/WhatsApp only delivers/.test(register) && !/in the last 24 hours/.test(register) && !/Your confirmation code arrives as an app notification/.test(register));
  check("register: the hint is one short line", /Your code arrives as a notification on this device\./.test(register));
  check("register: still sends the escape wording the stale-link button matches on", /startsWith\("That number doesn't match this registration link"\)/.test(register) && /That number doesn't match this registration link/.test(read("src/app/api/registration-tokens/request-otp/route.ts")));

  // ── The output guard must not eat the login code it is protecting ──
  // 8 Nov 2026 live incident: the guard's "long hex secret" pattern matched
  // the 64-hex sign-in key, so VERIFY replies arrived with ?key=[redacted]
  // and /login showed "Validation failed". The link flow is gone now, but
  // the lesson stands: a 6-digit code matches NO credential pattern (the
  // long-hex one needs 32+ chars), so the code survives even without
  // preserve — and preserve is still passed, so a future pattern can
  // never eat it. The guard itself is unchanged: a 64-hex string is
  // still redacted, proving preserve spares only what the caller minted.
  const CODE = "515202";
  const codeMsg = `🔐 *Your Student Platform login code: ${CODE}*\n\nType this code in the Student App to sign in. It expires in 5 minutes. Do not share this code with anyone.`;
  const unpreserved = redactCredentials(codeMsg);
  check("guard: a 6-digit code survives without preserve", unpreserved.text.includes(CODE) && !unpreserved.text.includes("[redacted]"));
  const preserved = redactCredentials(codeMsg, [CODE]);
  check("guard: with preserve, the code survives verbatim", preserved.text.includes(CODE) && !preserved.text.includes("[redacted]"));
  const mixed = redactCredentials(`${codeMsg}\n\nsk-abcdefghijklmnop123456`, [CODE]);
  check("guard: preserve spares only the code — other credential-shaped text is still redacted", mixed.text.includes(CODE) && mixed.text.includes("[redacted]") && !mixed.text.includes("sk-abcdefghijklmnop123456"));
  const hex64 = "ab".repeat(32);
  check("guard: a 64-hex string is still redacted (the guard itself works)", redactCredentials(`key=${hex64}`).text.includes("[redacted]"));

  console.log(`test-verify-code: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
