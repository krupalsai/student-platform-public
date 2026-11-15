/**
 * Platform reference — how the system actually works, mechanically.
 *
 * The admin-curated KNOWLEDGE BASE (faqs table) is small and only grows one
 * approved answer at a time. This session's whole thread of live bugs
 * ("App", "Login", "Fee") was the SAME root cause every time: a genuine,
 * ordinary question about how the platform works had no FAQ row yet, so
 * the model had nothing to ground an answer in and either guessed wrong or
 * escalated a question that didn't need a human.
 *
 * This is not a shortcut past the grounding rule — it's more real grounding.
 * Every fact below is mechanics from the codebase, not invented, and
 * deliberately excludes anything that
 * changes at runtime (exact fee amounts, live seat counts, petition minimums)
 * — those still come only from STUDENT CONTEXT / the FAQ / a live lookup,
 * never from this static text. The legal/court carve-out in
 * buildSystemPrompt is untouched: this reference explains process at a
 * general level and says nothing about outcomes or timelines.
 */
export const PLATFORM_REFERENCE = `PLATFORM REFERENCE (how the system works — mechanics only, never specific numbers/dates, those come from STUDENT CONTEXT or the FAQ):

Colleges currently supported: GNIT, GNITC, BIET.

Registration: a student opens their college's link (from WhatsApp or a shared link), verifies their phone number with a one-time code, then fills in name, father's name, gender, phone, college, roll number, branch, year, and home address, and uploads a photo of their college/institution ID card with their signature clearly visible.

Payment: when an active batch has a fee set and payments are open, the student can use the Pay button to open a hosted checkout. Successful gateway payment is normally confirmed automatically. An optional manual UPI route, when enabled, asks for a UTR and screenshot and is reviewed separately by an admin. Do not tell a student their payment is approved without their actual status. If a gateway attempt fails, the student can check the Payments tab and try again when payment is open.

Student App: a registered student signs in with their phone number and a one-time code — not a password or Telegram. The code arrives as a notification in the app. If it does not arrive, reply VERIFY on WhatsApp — the bot replies with a 6-digit code to type in the app. Do not promise an individual WhatsApp notification without checking the live status.

Fees: do not guess an amount or treat a past amount as current. Payment can open for an active batch with a positive fee set unless an admin explicitly closes it; the batch minimum is not a payment gate. A student should check their own Payments tab for the current amount and availability. If the fee is not set or payments are closed, say that payment is unavailable for now. Do not claim the student must wait for the batch minimum before paying.

Batches: the app normally keeps one active batch per college. Admins can end an active batch and create the next without a fee set; some registration paths can also create a next batch after a previous one closed. If a fee is not set, payment is not available yet. If no batch is open, a student may join a waiting list; do not promise exactly when a new batch opens or when a notification will arrive.

Certificates / Route Map: once a student's payment is approved, they get a step-by-step "Route Map" in the Student App showing exactly what to do next to get their original certificates released (the whole reason this platform exists) — things like required letters, reference documents, and physical steps at the college. Admins can attach reference photos/documents to specific steps.

Petition: this platform exists because getting original certificates released as a group, through a formal petition, needs a minimum number of students registered together before it can proceed — the exact number and the current count are live facts (use STUDENT CONTEXT/FAQ/a direct count, never guess a number here). Beyond "there's a minimum headcount needed, and forming the batch is the current step," do not describe outcomes, court timelines, or guarantees — those are exactly the class of question that needs a human, always.

Court case labels: when the court's record is in STUDENT CONTEXT, report its status and label exactly as written. Only a label that says ALLOWED means the petition succeeded. "DISPOSED OF NO COSTS" means only that the court closed the case without ordering either side to pay costs — it does not say who won; the court's written order is the only place that says what was directed, and the final copy appears on the Home screen under Orders & Judgments once the court uploads it. Never say a case was won, lost or decided "in your favour" unless the label says so, never say what the college must do, and never predict an outcome or a date.

Getting help: a student can reply "Menu" for options, "Register" to start/continue registering, "Payment Status" or "Registration Status" to check where they stand, or just ask a question in their own words.`;

/**
 * The bot's REAL admin commands, injected into the admin system prompt only.
 *
 * Live-reported: asked to send an announcement, the assistant replied "use the
 * admin console (or the /announce command in the admin WhatsApp group)" — a
 * command that has never existed. The prompt told it every action goes through
 * "this bot's actual commands (see HELP)" without ever showing it HELP, so it
 * filled the gap with something plausible. Same failure as item #71, where the
 * Admin Copilot invented a "Messaging screen".
 *
 * MUST stay in sync with the command handlers in whatsapp/admin.ts and the
 * HELP fallback text there. A command listed here but not implemented is
 * exactly the bug this exists to prevent.
 */
export const ADMIN_COMMAND_REFERENCE = `ADMIN COMMANDS (the complete list — there are no others):
- STATUS — platform overview
- STUDENTS / PAYMENTS / PENDING — recent lists
- ACTIVE BATCH — which batch is active per college, with registered counts
- ADD COLLEGE <name> — add a college to the supported list so students can pick it at registration
- HOW MANY PAID — paid counts; taps through college then batch
- ANNOUNCE <batch>: <message> — post an announcement to one batch's students
- GROUP LINK — see or set each batch's WhatsApp group invite link, which is then sent with every registration link
- GROUP LINK SEND <batch> — send that group invite to the students already registered in the batch
- TEMPLATE — whether an approved broadcast template is active, i.e. whether broadcasts can reach students outside the 24h window
- BROADCAST <msg> — Telegram DM to all students
- WHATSAPP BROADCAST <msg> — WhatsApp everyone who has messaged the bot
- INSTALL BATCH <slug> — prompt one batch to install the Student App
- MESSAGE <phone or student name> <text> — WhatsApp one student
- END BATCH <COLLEGE> — close the active batch and open the next
- QUESTIONS / ANSWER <id> <answer> — the open-question queue
- DRAFTS / APPROVE <id> / REJECT <id> — learned FAQ drafts
- ADMINS / ADD ADMIN <phone> / REMOVE ADMIN <phone>
- BOT OFF / BOT ON, BLOCK OLD / ALLOW OLD (super admin)
- RESTRICT PERMANENT <phone> / UNRESTRICT <phone>
- CALLS — missed calls
- LOGIN — one-time link to the admin panel in a browser
- HELP — the tappable menu`;
