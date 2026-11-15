/**
 * Step 1 of the bot: decide what a message means. It returns one label from a
 * fixed list. Code then answers from the database, so the model never writes
 * a name, fee or payment status itself.
 *
 * Order: rules first (free, exact, testable). Only messages the rules cannot
 * place go to the AI classifier, and its answer must be one of the labels.
 * Anything else becomes "unclear", which triggers the menu, not a guess.
 */

export const INTENTS = [
  "greeting",
  "my_name",
  "fee",
  "paid_status",
  "registration",
  "menu",
  "faq",
  "unclear",
] as const;
export type Intent = (typeof INTENTS)[number];

const RULES: [Intent, RegExp][] = [
  ["greeting", /^\s*(?:hi+|hey+|hello+|hii+|namaste|good (?:morning|evening|afternoon))[\s!.?]*$/i],
  ["my_name", /\b(?:what(?:'s| is)? (?:is )?(?:my|the|the name|name)|(?:tell me )?what name\b|which name\b|name (?:you|uh|u) (?:saved|have)|my name)\b/i],
  ["paid_status", /\b(?:have i paid|did i pay|did i (?:get )?paid|payment status|am i paid|paid or not|my payment)\b/i],
  ["fee", /\b(?:fee|fees|price|how much|amount to pay|batch fee|pay(?:ing)? (?:the )?(?:money|fee|for|batch)|can we pay)\b/i],
  ["registration", /\b(?:register|registration|enrol|enroll|join|sign ?up)\b/i],
  ["menu", /^\s*(?:menu|help|options|start)\s*[?!.]*$/i],
];

/** Returns a label when a rule clearly matches, else null (needs the classifier). */
export function ruleIntent(text: string): Intent | null {
  const t = text.trim();
  if (!t) return "unclear";
  for (const [label, re] of RULES) if (re.test(t)) return label;
  return null;
}

/** Accepts only a known label from the model. Anything else is "unclear". */
export function parseLabel(raw: string): Intent {
  const cleaned = raw.trim().toLowerCase().replace(/[`"'.\s]/g, "").replace(/^label:/, "");
  return (INTENTS as readonly string[]).includes(cleaned) ? (cleaned as Intent) : "unclear";
}

export function classifierPrompt(text: string, lastBotLine: string): string {
  return [
    "You label one WhatsApp message from a student or admin of a college fee platform.",
    `Labels: ${INTENTS.join(", ")}.`,
    "greeting = hi/hello. my_name = asks what name is saved for them. fee = asks batch fee or price.",
    "paid_status = asks whether they paid. registration = wants to register or join a batch.",
    "menu = asks for options. faq = a platform question (dates, certificates, documents).",
    "unclear = you cannot tell. Do not guess.",
    `The bot's last message was: "${lastBotLine.slice(0, 200)}"`,
    `Message: "${text.slice(0, 300)}"`,
    "Reply with exactly one label and nothing else.",
  ].join("\n");
}
