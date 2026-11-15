/** Pure lexical fallback. Single-word overlap is not evidence of an answer. */
export interface RankedFaq { id: string; question: string; answer: string; category: string | null }
const STOP = new Set("a an the is are i my me you your to of for in on at how what when where tell please can do did this that it and or".split(" "));
// NOTE: "fee"/"fees" are deliberately NOT stopwords here. This platform's core
// topic IS fees, and filtering them out made the commonest student question
// unmatchable: "how do I pay the fee" reduced to the single word "pay", so the
// >=2-shared-words bar in lexicalScore could never pass for it. A single shared
// word is still not evidence (lexicalScore returns 0 below 2), so keeping "fee"
// as a content word is safe — it just lets fee questions match fee answers.
function words(value: string): Set<string> {
  return new Set((value.toLocaleLowerCase("en").normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length > 2 && !STOP.has(word)));
}
export function lexicalScore(query: string, question: string): number {
  const queryWords = words(query);
  const faqWords = words(question);
  if (!queryWords.size || !faqWords.size) return 0;
  let shared = 0;
  for (const word of queryWords) if (faqWords.has(word)) shared++;
  // One overlapping word is not enough to ground a reply.
  if (shared < 2) return 0;
  return shared / Math.sqrt(queryWords.size * faqWords.size);
}
export function rankFaqs(query: string, faqs: RankedFaq[], limit = 6): RankedFaq[] {
  return faqs.map((faq) => ({ faq, score: lexicalScore(query, faq.question) }))
    .filter(({ score }) => score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit).map(({ faq }) => faq);
}
