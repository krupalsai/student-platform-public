// Cloudflare Workers AI provider for the Student Platform bot.
// 24/7 reliable LLM via Cloudflare's edge network (free tier: 10,000 Neurons/day).
// Uses CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN env vars.

export type CloudflareResult =
  | { kind: "answer"; text: string }
  | { kind: "unavailable" }
  | { kind: "escalate" };

type ChatTurn = { q: string; a: string };

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const TIMEOUT_MS = 8000;

export function cloudflareConfig(): { accountId: string; token: string } | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.replace(/\s+/g, "");
  const token = process.env.CLOUDFLARE_AI_TOKEN?.replace(/\s+/g, "");
  if (!accountId || !token) return null;
  return { accountId, token };
}

export async function generateBotAnswerCloudflare(
  question: string,
  studentCtx: any = {},
  conversationHistory: any[] = [],
  knowledgeBase: any[] = [],
  audience: string = "student",
  channel: "whatsapp" | "app" = "whatsapp",
): Promise<CloudflareResult> {
  const cfg = cloudflareConfig();
  if (!cfg) return { kind: "unavailable" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    let systemPrompt = `You are the Student Platform voice assistant. You help students with their batch registration, fees, payments, and documents.

KEY FACTS (never contradict these):
- Registration fee: GNIT Batch 2 and GNITC Batch 2 are ₹2,200; GNIT Batch 1 and GNITC Batch 1 are ₹1,100; BIET Batch 1 is ₹2. Pay on the Payments tab in the Student App. Never state any other fee amount.
- This platform is for students in writ petition batches (GNIT, GNITC colleges).
- If asked about payment status, registration status, or documents, answer from the knowledge base below. If you do not know, say so plainly and that the admin will reply — never promise to check records or send something later.
- Speak naturally like a human, not a robot. Be concise (2-3 sentences). Use simple English.
- If the user speaks Telugu, respond in Telugu.

NEVER say: "fee not decided", "contact on WhatsApp", "I can't help with that". Always be helpful.`;
    if (knowledgeBase.length > 0) {
      systemPrompt += `\n\nKnowledge base:\n` + knowledgeBase.map(kb => `Q: ${kb.question}\nA: ${kb.answer}`).join("\n\n");
    }

    const messages: { role: string; content: string }[] = [
      { role: "system", content: systemPrompt },
    ];
    for (const t of conversationHistory.slice(-4)) {
      messages.push({ role: "user", content: t.q });
      messages.push({ role: "assistant", content: t.a });
    }
    messages.push({ role: "user", content: question });

    const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/ai/run/${MODEL}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messages }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!resp.ok) {
      console.warn("[bot-ai] provider", { provider: "cloudflare", outcome: `http_${resp.status}` });
      return { kind: "unavailable" };
    }

    const data = await resp.json() as { result?: { response?: string } };
    const text = data?.result?.response?.trim();
    if (!text) {
      console.warn("[bot-ai] provider", { provider: "cloudflare", outcome: "empty_response" });
      return { kind: "unavailable" };
    }

    console.info("[bot-ai] provider", { provider: "cloudflare", outcome: "answer" });
    return { kind: "answer", text };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[bot-ai] provider", { provider: "cloudflare", outcome: "error", error: msg.slice(0, 100) });
    return { kind: "unavailable" };
  }
}

