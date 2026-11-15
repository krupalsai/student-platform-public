// Item #236: a student chasing an unanswered question must not be re-escalated,
// and the assistant's own "sent to the team" messages must not poison history.
const fs = require("fs");
const jiti = require("jiti")(process.cwd() + "/x.js", { alias: { "@": process.cwd() + "/src" } });
const bot = fs.readFileSync("src/lib/services/support-bot.ts", "utf8");
const route = fs.readFileSync("src/app/api/support/route.ts", "utf8");
const prompt = fs.readFileSync("src/lib/intent-engine/groq-provider.ts", "utf8");
let pass = 0, fail = 0;
const t = (n, c) => { c ? pass++ : (fail++, console.log("FAIL", n)); };

// Behaviour: the chasing phrases from the real chat are recognised.
const m = bot.match(/const CHASING = (\/.*\/);/);
const CHASING = eval(m[1]);
const norm = (x) => x.trim().toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ");
for (const q of ["Do you get any about my previous question", "Raise these question to the owner of this app", "any update?", "still waiting", "did they reply"]) t("chasing: " + q, CHASING.test(norm(q)));
for (const q of ["what is my payment status", "how many students registered", "can I change my branch"]) t("not chasing: " + q, !CHASING.test(norm(q)));

// Wiring.
t("waitingOnTeam short-circuit before the model", /input\.waitingOnTeam && CHASING\.test/.test(bot) && bot.indexOf("input.waitingOnTeam && CHASING") < bot.indexOf("generateGroundedAnswerDetailed("));
t("repeat escalation is not announced again", /if \(input\.waitingOnTeam\) \{[\s\S]*?escalated: false/.test(bot));
t("route passes waitingOnTeam to the bot (POST/PUT + retry)", (route.match(/waitingOnTeam|isWaitingOnTeam\(/g) || []).length >= 6);
t("history drops escalated/retryable bot replies", /m\.meta\?\.escalated \|\| m\.meta\?\.retryable/.test(route));
t("meta is selected for history", /select\("sender, body, photo_description, meta"\)/.test(route));
t("prompt: earlier replies may be wrong", /EARLIER ASSISTANT REPLIES IN THIS CHAT MAY BE WRONG/.test(prompt));
t("prompt: frustration gets status not a question", /frustrated or is repeating/.test(prompt));
t("prompt: general guidance allowed, no specific facts", /general guidance and say it is general/.test(prompt));

// Pure helper behaviour via the real module.
const src = route.match(/function isWaitingOnTeam[\s\S]*?\n}\n/)[0].replace(/type HistoryRow[^;]*;/, "");
const isWaiting = eval("(" + src.replace("function isWaitingOnTeam(rows: HistoryRow[]): boolean", "function (rows)").replace("let waiting = false;", "let waiting = false;") + ")");
t("waiting after escalation", isWaiting([{ sender: "student" }, { sender: "bot", meta: { escalated: true } }]));
t("not waiting once the team replied", !isWaiting([{ sender: "bot", meta: { escalated: true } }, { sender: "admin" }]));
t("waiting again after a second escalation", isWaiting([{ sender: "bot", meta: { escalated: true } }, { sender: "admin" }, { sender: "bot", meta: { escalated: true } }]));
t("not waiting with no escalation", !isWaiting([{ sender: "student" }, { sender: "bot" }]));

console.log(`test-support-no-repeat: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
