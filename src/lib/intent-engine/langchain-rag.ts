/**
 * LangChain + LangGraph RAG chain, IN the Student Platform.
 *
 * This is the "thinking" chain: it retrieves the best FAQ entries for the
 * student's question, then lets the LLM answer from those entries — and from
 * its own knowledge when the question is outside the FAQ. It is NOT a
 * separate demo or a Colab notebook; it lives in this repo and runs on the
 * same Vercel deployment as the WhatsApp bot.
 *
 * How it works (two steps, as a LangGraph):
 *   retrieve_docs -> generate_answer -> END
 *   - retrieve_docs: a LangChain retriever over the platform's own FAQ
 *     (src/lib/whatsapp/knowledge-base.ts, the same 42 entries the rule
 *     engine uses). No vector database and no embeddings model are needed:
 *     the retriever wraps the platform's own keyword/similarity matching.
 *   - generate_answer: a LangChain prompt + ChatGroq (the same Groq key and
 *     model the rest of the bot uses). The model is invoked directly and its
 *     message content is read as the answer — no output-parser import,
 *     because '@langchain/core/output_parsers' does not export
 *     StrOutputParser in the installed version (that import broke the
 *     production build on 12 Nov 2026).
 *
 * NODE NAMES: the graph nodes are named retrieve_docs / generate_answer,
 * NOT retrieve / answer. LangGraph forbids a node name that matches a
 * state channel name, and the state has a channel called "answer" — naming
 * a node "answer" threw at runtime on every call ("answer is already being
 * used as a state attribute, cannot also be used as a node name") and the
 * chain fell back to the provider chain on every message (12 Nov 2026).
 *
 * The prompt is the general-answers rule: FAQ first, own knowledge second,
 * never invent a platform fact, never say "I don't know" unless it truly
 * cannot answer.
 *
 * Safety: every failure returns null, so the caller falls back to the
 * existing provider chain (Cloudflare -> Gemini -> Groq -> OpenRouter).
 * A broken LangChain install or a missing GROQ_API_KEY can never silence
 * the bot.
 */

import { Document } from "@langchain/core/documents";
import { BaseRetriever } from "@langchain/core/retrievers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatGroq } from "@langchain/groq";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import {
  retrieveFromKnowledgeBase,
  type KnowledgeAudience,
} from "@/lib/whatsapp/knowledge-base";

/** LangChain retriever over the platform's own FAQ. No embeddings needed. */
class FaqRetriever extends BaseRetriever {
  lc_namespace = ["student-platform", "faq-retriever"];

  constructor(private audiences: KnowledgeAudience[] = ["public"]) {
    super();
  }

  async _getRelevantDocuments(query: string): Promise<Document[]> {
    const entries = retrieveFromKnowledgeBase(query, this.audiences, 3);
    return entries.map(
      (e) =>
        new Document({
          pageContent: `Q: ${e.question}\nA: ${e.answer}`,
          metadata: { id: e.id, category: e.category ?? null },
        }),
    );
  }
}

const RAG_PROMPT = ChatPromptTemplate.fromTemplate(
  `First check the retrieved entries below. If the answer is in them, answer using them. If the answer is NOT in them, answer from your own knowledge as best you can. Never say you do not know unless you truly cannot answer. Keep the answer short and in plain words.\n\nRetrieved entries:\n{context}\n\nQuestion: {question}\n\nAnswer:`,
);

/** LangGraph state: the question, the retrieved context, the final answer. */
const RagState = Annotation.Root({
  question: Annotation<string>,
  context: Annotation<string>,
  answer: Annotation<string>,
});

function buildRagGraph(audiences: KnowledgeAudience[]) {
  const retriever = new FaqRetriever(audiences);
  const model = new ChatGroq({
    apiKey: process.env.GROQ_API_KEY ?? "",
    model: process.env.GROQ_MODEL ?? "openai/gpt-oss-120b",
    temperature: 0,
  });

  const retrieveNode = async (state: typeof RagState.State) => {
    const docs = await retriever.invoke(state.question);
    return { context: docs.map((d) => d.pageContent).join("\n\n") };
  };

  const answerNode = async (state: typeof RagState.State) => {
    const promptText = await RAG_PROMPT.format({
      question: state.question,
      context: state.context || "No matching FAQ entries.",
    });
    const response = await model.invoke(promptText);
    const content = response.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((c) =>
                typeof c === "string" ? c : ((c as { text?: string }).text ?? ""),
              )
              .join("")
          : "";
    return { answer: text.trim() };
  };

  return new StateGraph(RagState)
    .addNode("retrieve_docs", retrieveNode)
    .addNode("generate_answer", answerNode)
    .addEdge(START, "retrieve_docs")
    .addEdge("retrieve_docs", "generate_answer")
    .addEdge("generate_answer", END)
    .compile();
}

const graphCache = new Map<string, ReturnType<typeof buildRagGraph>>();

function getGraph(audiences: KnowledgeAudience[]) {
  const key = audiences.join(",");
  let graph = graphCache.get(key);
  if (!graph) {
    graph = buildRagGraph(audiences);
    graphCache.set(key, graph);
  }
  return graph;
}

/**
 * Run the LangChain + LangGraph RAG chain for one question.
 * Returns the answer text, or null when it cannot answer (no key, empty
 * result, or any error) so the caller falls back to the provider chain.
 */
export async function generateLangChainRagAnswer(
  question: string,
  audience: "student" | "admin" = "student",
): Promise<string | null> {
  try {
    const apiKey = (process.env.GROQ_API_KEY ?? "").trim();
    if (!apiKey || !question.trim()) return null;
    const audiences: KnowledgeAudience[] =
      audience === "admin" ? ["public", "admin"] : ["public"];
    const graph = getGraph(audiences);
    const result = await graph.invoke({ question, context: "", answer: "" });
    const text = (result?.answer ?? "").trim();
    return text ? text : null;
  } catch (err) {
    console.error(
      "[langchain-rag] failed, falling back to provider chain:",
      (err as Error).message,
    );
    return null;
  }
}
