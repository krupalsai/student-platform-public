/**
 * Curated knowledge base for the Student Platform WhatsApp bot.
 *
 * WHY THIS FILE EXISTS
 * The bot's AI answers ONLY from grounded facts. Before this file, its only
 * grounding was the `faqs` table in the database — 46 rows, several with
 * stale answers (fees "not fixed upfront", login "one-time link", payments
 * "go through Razorpay"). A genuine question with no grounded fact made the
 * model guess, and the output guard then blocked the guess — so students got
 * the generic "I couldn't finish that reply" fallback. This file is the
 * verified, human-readable source of truth the AI retrieves from first.
 *
 * SOURCE OF TRUTH
 * Every fact here was verified against the live database / live code on
 * 9 Nov 2026. Fees are the exact `fee_amount` values in the `batches`
 * table. Login is the OTP-only flow (6-digit code, push primary, WhatsApp
 * fallback). The live payment gateway is Cashfree (`app_settings`).
 * Court facts must come from current records. Nothing here is invented — if a fact is not in this file,
 * the DB, or live code, the bot must say it does not know.
 *
 * HOW IT IS USED
 * `retrieveRelevantFaqs` (src/lib/services/faq-retrieval.ts) merges these
 * entries with the database FAQs and passes the merged list as the
 * `knowledgeBase` to the grounded model. When a static entry and a database
 * FAQ cover the same question, the static entry wins (it is the corrected
 * version). The database FAQs remain as a second source for admin-added
 * answers.
 *
 * UPDATING
 * - If a batch fee changes, update the `batches` table, the fee entries
 *   below, `VERIFIED_FEE_AMOUNTS`, AND the fee line in
 *   src/lib/intent-engine/groq-provider.ts (WHATSAPP_CHANNEL_BLOCK) and
 *   src/lib/intent-engine/cloudflare-provider.ts. All four must agree.
 * - If the payment gateway changes, update the pay-how entry.
 * - If the login flow changes, update the login entries.
 * - Keep answers short (1-3 sentences), simple words, one idea at a time.
 *   Students are non-technical.
 */

export type KnowledgeAudience = "public" | "student" | "admin";

export interface KnowledgeEntry {
  /** Stable id, e.g. "kb:fee-gnit-b2". Prefixed so it never collides with a DB faq id. */
  id: string;
  /** Short category for grouping (fees, registration, login, payments, court, batches, support). */
  category: string;
  /** Canonical question this entry answers. */
  question: string;
  /** The grounded answer. Short, simple, human. Never a link, code, or amount that is not verified. */
  answer: string;
  /** Phrases and words used for lexical matching. Include the words students actually type. */
  keywords: string[];
  /** Who may see this entry. Almost everything is public. */
  audience: KnowledgeAudience;
}

/**
 * Registration fees, exactly as set in the `batches` table (verified 9 Nov 2026).
 * GNIT Batch 2 and GNITC Batch 2: Rs 2,200. GNIT Batch 1 and GNITC Batch 1:
 * Rs 2,200. BIET Batch 1: Rs 2. These are the ONLY rupee amounts the bot is
 * allowed to state on WhatsApp (see containsUnverifiedRupeeAmount).
 */
export const BATCH_FEES: { batch: string; fee: number }[] = [
  { batch: "GNIT Batch 2", fee: 2200 },
  { batch: "GNITC Batch 2", fee: 2200 },
  { batch: "GNIT Batch 1", fee: 2200 },
  { batch: "GNITC Batch 1", fee: 2200 },
  { batch: "BIET Batch 1", fee: 2 },
];

/** The only rupee amounts the WhatsApp bot may quote. Any other amount is a guess and stays blocked. */
export const VERIFIED_FEE_AMOUNTS: number[] = [2200, 2];

export const KNOWLEDGE_BASE: KnowledgeEntry[] = [
  // ---- Fees ----
  {
    id: "kb:fee-general",
    category: "fees",
    question: "How much is the registration fee?",
    answer:
      "The registration fee is \u20B92,200. You pay it on the Payments tab in the Student App.",
    keywords: ["how much", "registration fee", "fee", "amount", "cost", "price", "entha", "how much amount", "fee amount", "kitna fee"],
    audience: "public",
  },
  {
    id: "kb:fee-gnit-b2",
    category: "fees",
    question: "What is the registration fee for GNIT Batch 2?",
    answer: "The registration fee for GNIT Batch 2 is \u20B92,200. You pay it on the Payments tab in the Student App.",
    keywords: ["gnit batch 2", "gnit", "batch 2", "fee"],
    audience: "public",
  },
  {
    id: "kb:fee-gnitc-b2",
    category: "fees",
    question: "What is the registration fee for GNITC Batch 2?",
    answer: "The registration fee for GNITC Batch 2 is \u20B92,200. You pay it on the Payments tab in the Student App.",
    keywords: ["gnitc batch 2", "gnitc", "batch 2", "fee"],
    audience: "public",
  },
  {
    id: "kb:fee-gnit-b1",
    category: "fees",
    question: "What is the registration fee for GNIT Batch 1?",
    answer: "The registration fee for GNIT Batch 1 is \u20B92,200. You pay it on the Payments tab in the Student App.",
    keywords: ["gnit batch 1", "gnit", "batch 1", "fee"],
    audience: "public",
  },
  {
    id: "kb:fee-gnitc-b1",
    category: "fees",
    question: "What is the registration fee for GNITC Batch 1?",
    answer: "The registration fee for GNITC Batch 1 is \u20B92,200. You pay it on the Payments tab in the Student App.",
    keywords: ["gnitc batch 1", "gnitc", "batch 1", "fee"],
    audience: "public",
  },
  {
    id: "kb:fee-biet-b1",
    category: "fees",
    question: "What is the registration fee for BIET Batch 1?",
    answer: "The registration fee for BIET Batch 1 is \u20B92. You pay it on the Payments tab in the Student App.",
    keywords: ["biet batch 1", "biet", "batch 1", "fee"],
    audience: "public",
  },
  {
    id: "kb:fee-discount",
    category: "fees",
    question: "Is there any discount on the fee?",
    answer: "No, the fee is fixed for your batch and there is no discount.",
    keywords: ["discount", "offer", "less fee", "reduce fee", "concession", "discount here"],
    audience: "public",
  },

  // ---- Registration ----
  {
    id: "kb:register-how",
    category: "registration",
    question: "How do I register?",
    answer:
      "Tell me your college name and I will send your registration link. Open it, verify your phone number with the one-time code, then fill in your details and upload a photo of your College ID with your signature visible.",
    keywords: ["how to register", "register", "join", "sign up", "enrol", "enroll", "i want to register", "how do i register", "registration", "link", "registration link", "no link"],
    audience: "public",
  },
  {
    id: "kb:register-seats",
    category: "registration",
    question: "Are there seats available for joining?",
    answer:
      "Yes, your batch is open for joining. Reply with your college name and I will send your registration link. To see how many students have joined your batch, ask 'how many registered'.",
    keywords: ["seat", "seats", "available", "joining", "vacate", "vacancy", "seat available", "seats available"],
    audience: "public",
  },
  {
    id: "kb:register-documents",
    category: "registration",
    question: "What documents do I need for registration?",
    answer:
      "At registration you fill in your name, father's name, gender, phone, college, roll number, branch, year and home address, and upload one clear photo of your College ID with your own signature visible.",
    keywords: ["document", "documents", "id card", "photo", "signature", "upload", "uploaded", "what documents", "documents needed"],
    audience: "public",
  },
  {
    id: "kb:register-last-date",
    category: "registration",
    question: "What is the last date for registration?",
    answer:
      "There is no fixed deadline for registration. Once the batch completes the minimum members, the work starts quickly, so please complete your registration soon.",
    keywords: ["last date", "deadline", "last day", "last date for registration"],
    audience: "public",
  },
  {
    id: "kb:register-error",
    category: "registration",
    question: "It shows an error when I save my details.",
    answer:
      "Sorry about that! Close the page, open your registration link again and retry. If it still fails, send a screenshot here and we'll fix it on our side.",
    keywords: ["error", "internal server error", "save", "save and continue", "error when i save", "showing error", "server error"],
    audience: "public",
  },
  {
    id: "kb:register-incomplete",
    category: "registration",
    question: "My registration is not complete.",
    answer:
      "Open your registration link again and finish the remaining steps. Can't find it? Reply REGISTER and I'll resend it.",
    keywords: ["registration not complete", "incomplete", "not complete", "pending registration", "registration pending", "registration is not complete"],
    audience: "public",
  },

  // ---- Login / Student App ----
  {
    id: "kb:login-how",
    category: "login",
    question: "How do I log in to the Student App?",
    answer:
      "Open the Student App and type your phone number, then tap Send. You will get a 6-digit code, usually as a notification on your phone, otherwise here on WhatsApp. Type the 6 digits in the app and tap Login. There is no password.",
    keywords: ["log in", "login", "sign in", "how to login", "send login code", "login code", "otp", "code", "for login", "how do i log in"],
    audience: "public",
  },
  {
    id: "kb:login-code-not-arriving",
    category: "login",
    question: "I am not receiving the OTP / login code.",
    answer:
      "Check that the number you registered with is the same as your WhatsApp number. Wait two minutes, then reply VERIFY here and I will send a new 6-digit code. The code expires in 5 minutes.",
    keywords: ["otp not", "not receiving otp", "not receiving the otp", "not receiving", "otp on whatsapp", "no otp", "code not coming", "not getting code", "otp not coming", "login code not", "otp not received", "did not get code", "whatsapp"],
    audience: "public",
  },
  {
    id: "kb:login-not-registered",
    category: "login",
    question: "It says my mobile number is not registered.",
    answer: "That means you have not registered yet. Reply REGISTER here and I will send your registration link.",
    keywords: ["not registered", "number not registered", "mobile number not registered", "not register"],
    audience: "public",
  },
  {
    id: "kb:app-open",
    category: "login",
    question: "I am unable to open the Student App.",
    answer:
      "Close the app fully \u2014 swipe it away from recent apps \u2014 and open it again. If it is still stuck, open studentplatform.dev/fix in Chrome and tap Fix my app. It clears the stuck login and opens a fresh sign-in. If it still does not open, send a screenshot here.",
    keywords: ["unable to open", "cannot open", "app not opening", "stuck", "blinking", "app is stuck", "not opening", "crash", "unable to open the student app"],
    audience: "public",
  },
  {
    id: "kb:app-install",
    category: "login",
    question: "How do I install the Student App on my phone?",
    answer:
      "Tap the app link I sent you — it opens the Student App right in your browser. Register there and use it, no need to install anything. If you want the app on your home screen, open the link in Chrome and tap Install when Chrome offers it.",
    keywords: ["install", "download app", "app download", "how to install", "get the app", "install the app"],
    audience: "public",
  },

  // ---- Payments ----
  {
    id: "kb:pay-how",
    category: "payments",
    question: "How do I pay the fee?",
    answer: "Pay on the Payments tab in the Student App using UPI, debit card, or credit card. The payment goes through Cashfree.",
    keywords: ["how to pay", "pay the fee", "payment", "upi", "how do i pay", "pay fee", "how to pay the fee"],
    audience: "public",
  },
  {
    id: "kb:pay-not-showing",
    category: "payments",
    question: "I already paid but it is not showing.",
    answer:
      "Payments are verified automatically and show within a few minutes. If it has been more than 15 minutes: check your UPI app to confirm the amount was actually debited. If it was debited but is still not showing, reply STATUS and I will check your payment record. If it was not debited, just pay again.",
    keywords: ["paid but not showing", "not showing", "payment not showing", "already paid", "payment not", "not approved", "payment status"],
    audience: "public",
  },
  {
    id: "kb:pay-failed",
    category: "payments",
    question: "My payment failed.",
    answer:
      "First check whether the amount was actually debited. If it was debited, don't pay again yet \u2014 the failed payment is normally refunded within 5\u20137 working days. If nothing was debited, try again from the Payments tab. If you're not sure, reply STATUS and I'll check it.",
    keywords: ["payment failed", "failed", "payment failure", "debited", "payment fail"],
    audience: "public",
  },
  {
    id: "kb:pay-refund",
    category: "payments",
    question: "Can I get a refund?",
    answer:
      "If your payment failed and the amount was debited, it is refunded automatically within 5\u20137 working days. For any other refund request, tap Contact Support with your roll number and payment reference and the team will help you.",
    keywords: ["refund", "money back", "return money", "refund policy", "can i get a refund"],
    audience: "public",
  },
  {
    id: "kb:pay-parts",
    category: "payments",
    question: "Can I pay the fee in two parts?",
    answer: "No. The fee is paid as one single total on the payment page, not in two parts. Check your Payments tab for the current amount.",
    keywords: ["two parts", "instalment", "installment", "part payment", "split", "emi", "pay in parts"],
    audience: "public",
  },

  // ---- Court / case ----
  {
    id: "kb:case-status",
    category: "court",
    question: "What is the status of my case / petition?",
    answer:
      "You can see your batch's writ petition status in the Student App on the Home screen \u2014 it shows Filed, Registered, Order, or Disposed. For GNIT Batch 1 and GNITC Batch 1, the High Court has already allowed the petitions.",
    keywords: ["case status", "petition status", "court status", "writ", "case", "disposed", "status of my case", "petition", "court case"],
    audience: "public",
  },
  {
    id: "kb:case-certificates",
    category: "court",
    question: "When will I get my original certificates back?",
    answer:
      "The court directed the college to return the original certificates of the petitioners. Collect them from the college after the court order. Carry your college ID card. Your batch's key person (the first-listed petitioner) collects the hard copy of the order first.",
    keywords: ["certificate", "certificates", "original certificates", "return", "collect certificates", "when will i get my certificates", "my certificates", "originals"],
    audience: "public",
  },
  {
    id: "kb:case-hard-copy",
    category: "court",
    question: "When will I get the hard copy of the court order?",
    answer:
      "The hard copy of the court order is sent to your batch's key person (the first-listed petitioner). The day it arrives is announced in your batch group.",
    keywords: ["hard copy", "court order", "order copy", "hardcopy", "hard copy of the court order", "case", "softcopy", "soft copy"],
    audience: "public",
  },
  {
    id: "kb:case-key-person",
    category: "court",
    question: "Who is the key person for my batch's writ petition?",
    answer:
      "The first-listed petitioner on the writ petition is the key person for the batch. The lawyer sends the hard copy of the court order to that one person, so the key person must be present at the college first to collect it.",
    keywords: ["key person", "petitioner", "first petitioner", "who is the key person"],
    audience: "public",
  },
  {
    id: "kb:case-process",
    category: "court",
    question: "What is the process?",
    answer:
      "1. Join the batch. 2. Submit your details. 3. The advocate files the case. 4. The High Court order is obtained. 5. The order is sent to the college. 6. After the college receives it, students in that petition can collect their original certificates.",
    keywords: ["process", "how does it work", "steps", "procedure", "what is the process", "how it works", "petition process"],
    audience: "public",
  },
  {
    id: "kb:case-legal",
    category: "court",
    question: "Is this legal?",
    answer: "Yes. The petition is filed through an advocate before the High Court.",
    keywords: ["legal", "genuine", "real", "trust", "is this legal", "fraud", "fake"],
    audience: "public",
  },
  {
    id: "kb:case-route-map",
    category: "court",
    question: "What is the Route Map and when do I get it?",
    answer:
      "The Route Map is the step-by-step guide in the Student App. It opens after your payment is verified, usually within a few minutes of paying. It shows your documents, certificates, and case steps.",
    keywords: ["route map", "routemap", "route", "roadmap", "what is the route map"],
    audience: "public",
  },
  {
    id: "kb:case-bonafide",
    category: "court",
    question: "How do I get a bonafide certificate?",
    answer:
      "Complete registration and payment first, then open the Student App and check the Route Map \u2014 Bonafide Certificate is one of the tracked steps there.",
    keywords: ["bonafide", "bona fide", "bonafide certificate"],
    audience: "public",
  },
  {
    id: "kb:case-no-due",
    category: "court",
    question: "What is a no-due certificate and how do I get one?",
    answer:
      "A no-due certificate is a document from the college saying you owe nothing \u2014 no pending fees and no pending dues. You can request it on the platform after your fee payment is verified.",
    keywords: ["no-due", "no due", "dues", "no due certificate"],
    audience: "public",
  },

  // ---- Batches ----
  {
    id: "kb:batch-start",
    category: "batches",
    question: "When will my batch start?",
    answer: "The moment your batch reaches the minimum number of students. There is no fixed date.",
    keywords: ["batch start", "when will my batch start", "when start", "batch begin", "when does my batch start"],
    audience: "public",
  },
  {
    id: "kb:batch-how-long",
    category: "batches",
    question: "How long does it take?",
    answer:
      "Once the minimum number of students is reached, it usually takes about 1 month, based on court working days. After that, the lawyer or admin will share the next steps.",
    keywords: ["how long", "duration", "how much time", "time taken", "how long does it take"],
    audience: "public",
  },
  {
    id: "kb:batch-join-later",
    category: "batches",
    question: "Can I join later?",
    answer:
      "You can join later, but joining late can affect you, because batch formation is one of the slowest steps. Join and pay the fee now so the next person can do the same.",
    keywords: ["join later", "join late", "late join", "can i join later"],
    audience: "public",
  },
  {
    id: "kb:batch-leave",
    category: "batches",
    question: "Can I leave after joining?",
    answer:
      "Please join only if you're sure you want to. Once the batch is finalized and legal work begins, changes are difficult.",
    keywords: ["leave", "cancel", "quit", "exit", "withdraw", "can i leave"],
    audience: "public",
  },
  {
    id: "kb:batch-change",
    category: "batches",
    question: "Can I change my batch?",
    answer: "No. Once you join a batch, it can't be changed.",
    keywords: ["change batch", "switch batch", "shift batch", "can i change my batch"],
    audience: "public",
  },
  {
    id: "kb:batch-job-offer",
    category: "batches",
    question: "I have a job offer or higher studies. Can I join?",
    answer: "Yes. If you need your certificates urgently, joining the earliest available batch is recommended.",
    keywords: ["job offer", "higher studies", "urgent", "job", "studies"],
    audience: "public",
  },

  // ---- Support / contact ----
  {
    id: "kb:contact-call",
    category: "support",
    question: "Can I call the admin / Can I call now?",
    answer:
      "Phone calls aren't available right now. Just ask your question here \u2014 if I can't answer it, I'll pass it to our support team and their reply will come back to you. In the Student App you can also open Support from the Home screen and chat any time.",
    keywords: ["call", "talk to admin", "speak", "call now", "can i call", "phone call", "talk to you"],
    audience: "public",
  },
  {
    id: "kb:contact-support",
    category: "support",
    question: "How can I contact support?",
    answer:
      "Message here and type help. The bot shows common problems and sends the fix. For money or refund problems, or a court date question, the bot passes it to the admin.",
    keywords: ["support", "contact support", "help", "contact", "team", "how can i contact support", "owner", "raise"],
    audience: "public",
  },
  {
    id: "kb:status-check",
    category: "support",
    question: "How do I check my status?",
    answer: "Your status is in the Student App. Open studentplatform.dev, sign in with your phone number, and check the Home screen.",
    keywords: ["check status", "my status", "check my status", "how do i check my status", "status"],
    audience: "public",
  },
  {
    id: "kb:colleges",
    category: "support",
    question: "Which colleges does the Student Platform support?",
    answer: "GNIT, GNITC and BIET in Hyderabad. Each college has its own batches, and each batch has its own writ petition and case tracking.",
    keywords: ["which colleges", "colleges", "college", "supported", "which college"],
    audience: "public",
  },
];

// ---------------------------------------------------------------------------
// Lexical retrieval — no embeddings, no network. Scores each entry against
// the student's question and returns the best matches above the bar.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "is", "the", "a", "an", "what", "how", "when", "where", "why", "who", "which",
  "do", "does", "did", "can", "could", "will", "would", "should", "am", "are",
  "was", "were", "i", "my", "me", "to", "for", "of", "in", "on", "at", "by",
  "and", "or", "if", "about", "please", "tell", "have", "has", "this", "that",
  "it", "you", "your", "is", "there", "any", "get", "want", "need", "sir",
  "bro", "hi", "hello", "hey",
]);

export function normalizeKbText(text: string): string {
  return text.toLowerCase().trim().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

function significantWords(text: string): string[] {
  return [...new Set(normalizeKbText(text).split(" ").filter((w) => w.length > 2 && !STOPWORDS.has(w)))];
}

/**
 * Score one entry against the question.
 * - +3 for each keyword phrase that appears in the question.
 * - +1 for each significant question word that appears in the entry's keywords.
 * A single phrase match (3) is not enough on its own — the bar is 4, so a
 * match needs a phrase plus a word, or two phrases. This keeps one generic
 * shared word (e.g. "status", "fee") from pulling in an unrelated entry.
 */
function scoreEntry(entry: KnowledgeEntry, normalizedQuestion: string, questionWords: string[]): number {
  let score = 0;
  for (const kw of entry.keywords) {
    if (kw && normalizedQuestion.includes(normalizeKbText(kw))) score += 3;
  }
  const keywordWords = new Set(entry.keywords.flatMap((k) => normalizeKbText(k).split(" ")));
  for (const w of questionWords) {
    if (keywordWords.has(w)) score += 1;
  }
  // Exact question match always wins.
  if (normalizeKbText(entry.question) === normalizedQuestion) score += 10;
  return score;
}

const KB_MIN_SCORE = 4;
const KB_MAX_RESULTS = 3;

/** Returns the best-matching knowledge entries for a question, best first. */
export function retrieveFromKnowledgeBase(
  question: string,
  audiences: KnowledgeAudience[] = ["public"],
  maxResults: number = KB_MAX_RESULTS,
): KnowledgeEntry[] {
  const normalized = normalizeKbText(question);
  if (!normalized) return [];
  const words = significantWords(question);
  const allowed = new Set<string>(audiences);
  const scored = KNOWLEDGE_BASE.filter((e) => allowed.has(e.audience))
    .map((entry) => ({ entry, score: scoreEntry(entry, normalized, words) }))
    .filter((s) => s.score >= KB_MIN_SCORE)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map((s) => s.entry);
}

/** Shape the rest of the bot expects (same as a database FAQ row). */
export function toFaqAnswer(entry: KnowledgeEntry): { id: string; category: string | null; question: string; answer: string; audience?: KnowledgeAudience } {
  return { id: entry.id, category: entry.category, question: entry.question, answer: entry.answer, audience: entry.audience };
}
