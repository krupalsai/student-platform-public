// Pins three fixes from the 2026-10-10 daily review of real support threads:
//
//  1. A reply must never be shown cut off mid-sentence. Groq's gpt-oss-120b
//     spends hidden reasoning tokens out of the same max_tokens budget as the
//     visible reply, so a 300-token cap left room for a few words: real
//     replies ended "...reach out to the support team through the" and "...To".
//  2. "Contact support team" (an explicit request for a person) is honoured
//     directly instead of being answered with "what specifically do you need?".
//  3. The assistant does not quote a batch's CURRENT fee to someone who already
//     paid or whose batch is closed, nor a petition minimum once a case exists.
//
// Run: node scripts/test-bot-replies-complete.cjs
const fs = require("fs");
const path = require("path");
const jiti = require("jiti")(__filename, { alias: { "@": path.resolve(__dirname, "../src") }, interopDefault: true });
const read = (p) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error("FAIL:", n); } };

const { completeAnswer, endsMidSentence } = jiti("../src/lib/intent-engine/answer-text.ts");
const groq = jiti("../src/lib/intent-engine/groq-provider.ts");
const { generateBotAnswerOpenRouter } = jiti("../src/lib/intent-engine/openrouter-provider.ts");
const { generateBotAnswerSelfHosted } = jiti("../src/lib/intent-engine/self-hosted-provider.ts");
const { generateBotAnswerGemini } = jiti("../src/lib/intent-engine/gemini-chat-provider.ts");
const { completeSupportReply } = jiti("../src/lib/services/support-response-guard.ts");
const bot = jiti("../src/lib/services/support-bot.ts");
const snap = jiti("../src/lib/services/student-snapshot.ts");

(async () => {
  // ── 1a. completeAnswer: the exact replies students were shown ──
  const REAL = [
    "Sorry for any mix-up. The app shows your case as WP 12346 / 2026, status PENDING, with the next court listing on 09/10/2026. You can see this",
    "You’re registered for GNITC Batch 1 (the batch is closed, payment isn’t open yet, and the fee is ₹1100). To",
    "Your payment of ₹2200 is approved, the batch is closed and not currently accepting payments, and the petition still needs more students. For any issues, reach out to the support team through the",
  ];
  check("real cut-off reply 1: trimmed to the last finished sentence", completeAnswer(REAL[0], true) === "Sorry for any mix-up. The app shows your case as WP 12346 / 2026, status PENDING, with the next court listing on 09/10/2026.");
  check("real cut-off reply 2: trimmed (the fee clause stays inside the finished sentence)", completeAnswer(REAL[1], true) === "You’re registered for GNITC Batch 1 (the batch is closed, payment isn’t open yet, and the fee is ₹1100).");
  check("real cut-off reply 3: trimmed", completeAnswer(REAL[2], true).endsWith("the petition still needs more students.") && !/through the$/.test(completeAnswer(REAL[2], true)));
  check("not truncated: left exactly as written", completeAnswer("  Your payment is approved.  ", false) === "Your payment is approved.");
  check("truncated with no finished sentence: nothing worth showing", completeAnswer("Your payment of ₹2200 is approved and the", true) === null);
  check("truncated right after a very short sentence: nothing worth showing", completeAnswer("Hi. Your pay", true) === null);
  check("empty stays empty", completeAnswer("   ", false) === null && completeAnswer("", true) === null);
  check("decimals are not sentence ends", completeAnswer("Your payment is approved today. The rate is 1.5 percent and the next", true) === "Your payment is approved today.");
  check("list numbering is not a sentence end", completeAnswer("Here is how you do it:\n1. Open the app\n2.", true) === null || !/\n2\.$/.test(completeAnswer("Here is how you do it:\n1. Open the app\n2.", true)));
  check("a closing quote after the full stop is kept", completeAnswer('He said "open the Payments tab." Then the', true) === 'He said "open the Payments tab."');
  check("Telugu/Hindi danda ends a sentence", completeAnswer("మీ చెల్లింపు పూర్తయింది। తదుపరి", true) === "మీ చెల్లింపు పూర్తయింది।");
  check("a dangling action tag is dropped with the cut", !/\[\[/.test(completeAnswer("Open the Payments tab to pay now. [[OPEN:pay", true)));

  // ── 1b. endsMidSentence: the second safety net for any provider ──
  for (const t of REAL) check(`cut-off detected: …${t.slice(-24)}`, endsMidSentence(t));
  for (const t of ["Your payment is approved.", "Open the Payments tab 👍", "Your batch is GNIT Batch 2", "Thank you", "Registered students: 24", "Done!", "Sure (see the Batch tab)", "ok", "No"])
    check(`complete reply left alone: ${t}`, !endsMidSentence(t));
  check("completeSupportReply trims a cut-off tail", completeSupportReply(REAL[0]) === "Sorry for any mix-up. The app shows your case as WP 12346 / 2026, status PENDING, with the next court listing on 09/10/2026.");
  check("completeSupportReply falls back when nothing is salvageable", /couldn't finish that answer/.test(completeSupportReply("Your payment of ₹2200 is approved and the")));
  check("completeSupportReply leaves a finished reply alone", completeSupportReply("Your payment is approved.") === "Your payment is approved.");

  // ── 1c. The providers: bigger budget, low reasoning effort, truncation handled ──
  const calls = [];
  const realFetch = globalThis.fetch;
  let nextBody;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => nextBody, text: async () => "" };
  };
  const chat = (content, finish) => ({ choices: [{ message: { content }, finish_reason: finish }] });
  const gem = (text, finish) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: finish }] });

  delete process.env.GROQ_MODEL;
  nextBody = chat(REAL[0], "length");
  let r = await groq.generateBotAnswer("k", "q", {}, [], [], "student", false, "app");
  check("groq: a length-truncated reply is trimmed, not shown cut", r.kind === "answer" && r.text.endsWith("09/10/2026."));
  check("groq: gpt-oss is asked for LOW reasoning effort", calls[0].body.reasoning_effort === "low");
  check("groq: the token budget has real headroom", calls[0].body.max_tokens >= 600);
  nextBody = chat(REAL[0], "stop");
  r = await groq.generateBotAnswer("k", "q", {}, [], [], "student", false, "app");
  check("groq: a reply that finished normally is kept whole", r.kind === "answer" && r.text === REAL[0]);
  nextBody = chat("", "length");
  r = await groq.generateBotAnswer("k", "q");
  check("groq: all budget spent on reasoning (empty reply) -> next provider", r.kind === "unavailable");
  nextBody = chat("Your payment of ₹2200 is approved and the", "length");
  r = await groq.generateBotAnswer("k", "q");
  check("groq: truncated with no usable sentence -> next provider", r.kind === "unavailable");
  nextBody = chat("ESCALATE", "stop");
  r = await groq.generateBotAnswer("k", "q");
  check("groq: ESCALATE still means escalate", r.kind === "escalate");
  process.env.GROQ_MODEL = "llama-3.3-70b-versatile";
  calls.length = 0;
  nextBody = chat("Fine.", "stop");
  await groq.generateBotAnswer("k", "q");
  check("groq: other models are NOT sent reasoning_effort (they would reject it)", calls[0].body.reasoning_effort === undefined);
  delete process.env.GROQ_MODEL;

  // If Groq ever rejects reasoning_effort with a 400, the call is retried once
  // without it instead of taking the provider down.
  {
    calls.length = 0;
    let n = 0;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      n++;
      return n === 1
        ? { ok: false, status: 400, json: async () => ({}), text: async () => "unknown field reasoning_effort" }
        : { ok: true, status: 200, json: async () => chat("Your payment is approved.", "stop"), text: async () => "" };
    };
    const retried = await groq.generateBotAnswer("k", "q", {}, [], [], "student", false, "app");
    check("groq: a 400 on reasoning_effort is retried once without it", retried.kind === "answer" && calls.length === 2 && calls[0].body.reasoning_effort === "low" && calls[1].body.reasoning_effort === undefined);
    calls.length = 0; n = 0;
    globalThis.fetch = async (url, init) => { calls.push({ body: JSON.parse(init.body) }); return { ok: false, status: 400, json: async () => ({}), text: async () => "bad" }; };
    const failed = await groq.generateBotAnswer("k", "q");
    check("groq: a second 400 is final (no retry loop)", failed.kind === "unavailable" && calls.length === 2);
    calls.length = 0;
    process.env.GROQ_MODEL = "llama-3.3-70b-versatile";
    await groq.generateBotAnswer("k", "q");
    check("groq: a 400 on a model that never sent reasoning_effort is not retried", calls.length === 1);
    delete process.env.GROQ_MODEL;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => nextBody, text: async () => "" };
    };
  }

  calls.length = 0;
  nextBody = chat('{"intent":"UNKNOWN","confidence":0.5,"reason":"x","next_action":"y"}', "stop");
  await new groq.GroqIntentClassifier("k").classify("hello");
  check("groq classifier: low reasoning effort and a budget that fits the JSON", calls[0].body.reasoning_effort === "low" && calls[0].body.max_tokens >= 400);

  nextBody = chat(REAL[1], "length");
  r = await generateBotAnswerOpenRouter("k", "q", {}, [], [], "student", false, "app");
  check("openrouter: truncated reply trimmed", r.kind === "answer" && r.text.endsWith("₹1100)."));
  r = await generateBotAnswerSelfHosted({ url: "http://x", token: "t", model: "m", timeoutMs: 1000, primary: false }, "q", {}, [], [], "student", "app");
  check("self-hosted: truncated reply trimmed", r.kind === "answer" && r.text.endsWith("₹1100)."));
  nextBody = gem(REAL[0], "MAX_TOKENS");
  r = await generateBotAnswerGemini("k", "q", {}, [], [], "student", false, "app");
  check("gemini: MAX_TOKENS reply trimmed", r.kind === "answer" && r.text.endsWith("09/10/2026."));
  nextBody = gem(REAL[0], "STOP");
  r = await generateBotAnswerGemini("k", "q", {}, [], [], "student", false, "app");
  check("gemini: a finished reply is kept whole", r.kind === "answer" && r.text === REAL[0]);
  globalThis.fetch = realFetch;

  // ── 2. Explicit requests for a person ──
  for (const q of ["Quickly Once again check and contact support team", "Raise these question to the owner of this app", "contact support", "I want to talk to someone", "connect me to the admin", "human", "Support team", "call the admin please"])
    check(`asks for a person: ${q}`, bot.wantsHuman(q) === true);
  for (const q of ["How do I contact the support team?", "where can I talk to the admin", "what is my payment status", "payment ayinda?", "I paid yesterday why still pending", "call", "request", "send me the batch details", "will the admin contact me", "",
    "my friend said that when i went to the college office the staff told me about a team that is going to contact all the students about the certificates so i am confused what to do now"])
    check(`not a handoff: ${q.slice(0, 50)}`, bot.wantsHuman(q) === false);
  const botSrc = read("src/lib/services/support-bot.ts");
  const iHandoff = botSrc.indexOf("if (wantsHuman(caption))");
  check("handoff runs before the data-only answers and the model", iHandoff > 0 && iHandoff < botSrc.indexOf("const direct = deterministicReply(") && iHandoff < botSrc.indexOf("generateGroundedAnswerDetailed("));
  check("handoff comes after the other-student privacy guard", botSrc.indexOf("aboutAnotherStudent(caption, snapshot)") < iHandoff);
  check("handoff does not re-escalate a request already waiting on the team", /if \(wantsHuman\(caption\)\) \{\s*if \(input\.waitingOnTeam\) return \{ reply: WAITING_ON_TEAM_REPLY/.test(botSrc));
  check("handoff records the question and alerts the admins through the same path", /fileForTeam\(db, studentId, snapshot, handoff\)/.test(botSrc) && /notifyAdminWhatsApp\(/.test(botSrc));
  check("handoff attaches the student's recent messages", /Earlier messages:/.test(botSrc) && /\.slice\(-2\)/.test(botSrc));
  check("handoff is honest when the question could not be saved", /filed\.saveFailed\)[\s\S]{0,200}retryable: true/.test(botSrc) && !/filed\.saveFailed[\s\S]{0,120}escalated: true/.test(botSrc));
  check("handoff tells the route to open a case", /escalated: true,\s*unknownQuestionId: filed\.id/.test(botSrc));

  // ── 3. Fee / petition-minimum facts ──
  const base = {
    name: "Ravi Kumar", college: "GNIT", registrationComplete: true,
    batch: { id: "b1", name: "GNIT Batch 1", slug: "gnit-batch-1", status: "closed" },
    payment: { state: "approved", rawStatus: "approved", amount: 2200, at: new Date(Date.now() - 864e5).toISOString(), reviewNotes: null },
    gate: { open: false, reason: "closed", message: "Batch is closed.", fee: 1100, registered: 24, required: 42 },
    documents: { collegeIdUploaded: true, aiFlag: null, reuploadUsed: false },
    caseInfo: { number: "WP 12345 / 2026", status: "DISPOSED", nextHearing: null, checkedAt: null, disposedOn: "28-09-2026", disposalType: "ALLOWED NO COSTS", finalOrderAvailable: false },
    representative: null, announcements: [], openCases: 0,
  };
  let facts = snap.snapshotToFacts(base);
  check("paid student in a closed batch: the batch's current fee is not quoted", !/Batch fee/.test(facts) && !/₹1100/.test(facts));
  check("paid student: their own approved payment is still stated", /₹2200 is approved/.test(facts));
  check("closed batch with a case: no 'petition minimum' to mislead", !/petition minimum/.test(facts) && /Registered students in batch: 24/.test(facts));
  const open = { ...base, batch: { ...base.batch, status: "active" }, payment: { ...base.payment, state: "none", rawStatus: null, amount: null }, gate: { ...base.gate, open: true, message: null }, caseInfo: null };
  facts = snap.snapshotToFacts(open);
  check("unpaid student in an open batch: the fee is stated", /Batch fee \(set by admin\): ₹1100/.test(facts));
  check("forming batch: the petition minimum is stated", /petition minimum 42/.test(facts));
  check("WhatsApp still never gets a rupee amount", !/₹1100/.test(snap.snapshotToFacts(open, { hideAmounts: true })));
  check("isBatchOver covers closed and archived only", snap.isBatchOver(base) && snap.isBatchOver({ ...base, batch: { ...base.batch, status: "archived" } }) && !snap.isBatchOver(open) && !snap.isBatchOver({ ...base, batch: null }));

  const unpaidClosed = { ...base, payment: { ...base.payment, state: "failed", rawStatus: "pg_failed" } };
  let m = bot.menuReply("Fee & how to pay", unpaidClosed);
  check("menu fee, closed batch: says payment is closed, quotes no amount", /no longer open/.test(m.reply) && !/₹/.test(m.reply));
  m = bot.menuReply("Fee & how to pay", base);
  check("menu fee, already paid: shows the payment, not the batch fee", /₹2200/.test(m.reply) && !/1100/.test(m.reply));
  m = bot.menuReply("Fee & how to pay", open);
  check("menu fee, open batch: unchanged — fee and how to pay", /₹1100/.test(m.reply) && /Payments tab/.test(m.reply));
  m = bot.deterministicReply("fee", unpaidClosed);
  check("typed 'fee', closed batch: no amount", /no longer open/.test(m.reply) && !/₹/.test(m.reply));
  m = bot.deterministicReply("fee", base);
  check("typed 'fee', already paid: the payment", /₹2200/.test(m.reply) && !/1100/.test(m.reply));

  console.log(`test-bot-replies-complete: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
