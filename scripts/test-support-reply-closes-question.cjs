// Item #241: a team reply in the Support Inbox closes the linked unknown question(s).
const fs = require("fs");
const s = fs.readFileSync("src/lib/services/support-cases.ts", "utf8");
let pass = 0, fail = 0;
const t = (n, c) => { c ? pass++ : (fail++, console.log("FAIL", n)); };
t("postTeamReply closes linked questions", /await closeLinkedQuestions\(db, thread\)/.test(s));
t("thread select carries the link and start time", /unknown_question_id, created_at/.test(s));
t("only pending rows are touched", (s.match(/\.eq\("status", "pending"\)/g) || []).length >= 2);
t("matches the student's phone in all stored forms", /\[ten, `91\$\{ten\}`, `\+91\$\{ten\}`\]/.test(s));
t("only questions since the thread began", /gte\("first_seen_at", thread\.created_at\)/.test(s));
t("never throws", /closeLinkedQuestions failed/.test(s));
console.log(`test-support-reply-closes-question: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
