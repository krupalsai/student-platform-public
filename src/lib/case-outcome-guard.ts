/**
 * Last line of defence against an assistant telling a student how their court
 * case turned out when the court's own record does not say so.
 *
 * Regression case: a batch without a recorded case number must never be
 * described as having a favorable court outcome. A model can overstate a
 * result if the prompt is not explicit, so the guard must enforce this rule.
 * told they won. The record (STUDENT CONTEXT → caseInfo) is the only authority:
 *   - "in your favour" / "was allowed" is allowed ONLY when the court's label
 *     is ALLOWED (not PARTLY ALLOWED);
 *   - "was dismissed" only when the label says dismissed/rejected;
 *   - what the court DIRECTED (certificates released, college must…) is never
 *     in the record the app holds — it lives in the written order — so a model
 *     claiming it is always replaced.
 * The caller swaps an unsupported reply for the deterministic case status text
 * (student-snapshot.ts `caseStatusText`), which states only what the record
 * shows. Pure, dependency-free, tested in scripts/test-case-outcome.cjs.
 */

const COURT = "court|case|petition|judg\\w+|order|ruling|decision|verdict|writ|hearing";

/** a and b within one sentence of each other, either order. */
function near(a: string, b: string): RegExp {
  return new RegExp(`\\b(?:${a})\\b[^.!?\\n]{0,80}\\b(?:${b})\\b|\\b(?:${b})\\b[^.!?\\n]{0,80}\\b(?:${a})\\b`, "i");
}

const IN_FAVOUR = "in\\s+(?:your|our|their|the\\s+(?:petitioners|students)['’]?)\\s+favou?r|ruled\\s+(?:partly\\s+)?in\\s+favou?r|decided\\s+in\\s+favou?r|favou?rabl[ey]";

/** "case" alone is also a support case — it only counts next to a court word. */
const COURT_WORDS = "court|judge|judg\\w+|ruling|hearing|petition|verdict|writ|order";

/** Says the case went well for the students. */
const FAVOURABLE: RegExp[] = [
  near(IN_FAVOUR, COURT),
  // "allowed to proceed" is ordinary process wording, not an outcome.
  /\b(?:petition|writ|appeal)\s+(?:was|has\s+been|is|got)\s+(?:allowed(?!\s+to\b)|granted|accepted|successful|won)\b/i,
  near("case\\s+(?:was|has\\s+been|is|got)\\s+(?:allowed(?!\\s+to\\b)|granted|successful|won)", COURT_WORDS),
  near("(?:we|you)\\s+(?:have\\s+|had\\s+)?won(?![’'a-z])", COURT),
  /\bwon\s+the\s+(?:case|petition)\b/i,
];

/** Says the case went badly for the students. */
const ADVERSE: RegExp[] = [
  /\b(?:petition|writ|appeal)\s+(?:was|has\s+been|is|got)\s+(?:dismissed|rejected|lost)\b/i,
  near("case\\s+(?:was|has\\s+been|is|got)\\s+(?:dismissed|rejected|lost)", COURT_WORDS),
  near("(?:we|you)\\s+(?:have\\s+|had\\s+)?lost(?![’'a-z])", COURT),
  /\blost\s+the\s+(?:case|petition)\b/i,
];

/**
 * Claims about what the court ordered the college to do — never in the app's record.
 * (Not "your certificates will be released": that is how the FAQ and the process are
 * legitimately worded, conditionally — the prompt covers promises and timelines.)
 */
const DIRECTION: RegExp[] = [
  /\b(?:court|judge|high\s+court)\s+(?:has\s+|have\s+)?(?:ordered|directed|instructed|asked)\b[^.!?\n]{0,80}\b(?:release|return|hand|give|issue|refund)\b/i,
  // "the college must give you the No Due form" is ordinary Route Map wording — only next to a court word.
  near("(?:college|colleges|university|management)\\s+(?:must|has\\s+to|have\\s+to|shall|will\\s+have\\s+to|is\\s+(?:ordered|directed)\\s+to|are\\s+(?:ordered|directed)\\s+to)\\s+(?:release|return|hand|give|issue)", "court|judge|judg\\w+|ruling|verdict|high\\s+court|ordered|directed"),
];

/**
 * A sentence that only talks about what WOULD follow is process explanation, not a claim:
 * "If the High Court allows the petition and the college complies, your certificates will
 * be released." Sentences with these words are not checked.
 */
const CONDITIONAL = /\b(?:if|unless|provided|in\s+case|should|would|could|might|may|whether|once)\b/i;

const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
const claimedIn = (text: string, patterns: RegExp[]) =>
  sentences(text).some((sentence) => !CONDITIONAL.test(sentence) && patterns.some((re) => re.test(sentence)));

type OutcomeRecord = { disposedOn?: string | null; disposalType?: string | null } | null | undefined;

const allowedOutcome = (c: OutcomeRecord) =>
  !!c?.disposedOn && /allowed/i.test(c.disposalType ?? "") && !/partly|partially/i.test(c.disposalType ?? "");
const dismissedOutcome = (c: OutcomeRecord) =>
  !!c?.disposedOn && /dismiss|reject/i.test(c.disposalType ?? "");

/** Does the text claim how the case ended (or what the court directed) at all? */
export function claimsCaseOutcome(text: string): boolean {
  return claimedIn(text, FAVOURABLE) || claimedIn(text, ADVERSE) || claimedIn(text, DIRECTION);
}

/**
 * True when the text claims an outcome the court's record does not support.
 * `record` is the student's caseInfo (null = no case number on file).
 */
export function unsupportedOutcomeClaim(text: string, record: OutcomeRecord): boolean {
  if (claimedIn(text, DIRECTION)) return true;
  if (claimedIn(text, FAVOURABLE) && !allowedOutcome(record)) return true;
  if (claimedIn(text, ADVERSE) && !dismissedOutcome(record)) return true;
  return false;
}

/**
 * Typed questions that ask HOW THE CASE WENT ("did we win", "what did the court
 * say", "case result"). Matched on text already lower-cased and stripped to
 * letters, digits and spaces. Answered from the record, never by a model.
 */
export const OUTCOME_QUESTION = new RegExp([
  "did (we|you|they|the (petition|case|court)|our (petition|case)) (win|won|lose|lost|succeed|allow|accept|reject|dismiss)",
  "(have|had) we (won|lost)",
  "(are|were) we (winning|successful|won|lost)",
  "(case|petition|judg(?:e)?ment|court|hearing) (result|results|outcome|decision|verdict|status|update|updates|news|progress)",
  "(result|results|outcome|decision|verdict|status) (of|in|for) (the |our |my )?(case|petition|court|hearing|judg(?:e)?ment)",
  "in (our|my|your|the petitioners) favou?r",
  "what (did|does|has|have) (the )?(court|judge|high court|hc) (say|said|decide|decided|order|ordered|direct|directed|rule|ruled|pass|passed)",
  "what (was|is) the (decision|court order|result|outcome|judg(?:e)?ment|verdict)",
  "what happened (in|at|to|with|on) (the |our |my )?(case|petition|hearing|court)",
  "(is|was|has) (the )?(case|petition) (been )?(allowed|dismissed|rejected|granted|successful|won|lost|disposed)",
].map((p) => `\\b(?:${p})\\b`).join("|"));
