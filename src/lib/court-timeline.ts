/**
 * court-timeline.ts — turns the High Court's record for a batch's case into a
 * plain-English list of "what happened, and when", newest first.
 *
 * Why this exists: the admin "Case News" screen was a blank form that someone
 * had to type into (it never held a single row), while the court's own portal
 * already says what happened — a petition filed, orders passed, papers
 * accepted, a hearing listed, the case closed. This reads that record (the
 * cached copy in `batches.case_last_status_json`, see services/court-case.ts)
 * and words it for people who are not lawyers.
 *
 * Rules this file keeps, on purpose:
 *  - It only restates the court's record. It NEVER says the petition "won" or
 *    "lost": "DISPOSED OF NO COSTS" does not say who won, and only the written
 *    order says what the court directed (see case-clarity.ts `disposalMeaning`).
 *    There is deliberately no "victory" event type.
 *  - No petitioner names, no advocate names, no case numbers in any event.
 *    The feed is shown across batches, so it carries only the facts of the case.
 *  - Pure: no network, no database, no clock except the `nowMs` argument.
 */

import {
  courtDateToISO,
  disposalMeaning,
  formatCourtDate,
  writtenOrderState,
  type CaseStatusLike,
} from "@/lib/case-clarity";

export type CourtEventType = "filing" | "hearing" | "order" | "next_hearing" | "update" | "disposed";

export interface CourtEvent {
  /** Stable for the same court record, so a link to one event keeps working. */
  id: string;
  /** YYYY-MM-DD (the court gives only a date, never a time). */
  date: string;
  type: CourtEventType;
  title: string;
  body: string;
  /** The order's own PDF on the court's website, when there is one. */
  url: string | null;
  /** Routine paperwork — worth showing to the admin, noise for students. */
  minor: boolean;
}

export interface TimelineApplication {
  date: string | null;
  type: string | null;
  status: string | null;
  decidedOn: string | null;
}

export interface TimelineFiling {
  date: string | null;
  type: string | null;
  status: string | null;
}

export interface TimelineInput extends CaseStatusLike {
  applications?: TimelineApplication[];
  filings?: TimelineFiling[];
}

// ---- small text helpers ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** Today's calendar date in India (the court's own timezone), YYYY-MM-DD. */
export function todayISTDate(nowMs: number = Date.now()): string {
  const d = new Date(nowMs + 5.5 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const squash = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

function titleCase(s: string): string {
  return squash(s)
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** "The Honourable Smt Justice JUVVADI SRIDEVI" -> "Smt Justice Juvvadi Sridevi". */
function prettyJudge(raw: string | null | undefined): string | null {
  const t = squash(raw).replace(/^the\s+(honou?rable|hon'?ble)\s+/i, "");
  if (!t) return null;
  return t
    .split(" ")
    .map((w) => (w.length > 2 && w === w.toUpperCase() ? w.charAt(0) + w.slice(1).toLowerCase() : w))
    .join(" ");
}

function orderLabel(raw: string | null | undefined): string {
  const t = squash(raw);
  if (!t) return "Order";
  if (/daily/i.test(t)) return "Daily order";
  if (/spl|special/i.test(t)) return "Special Cell order";
  if (/final|judg/i.test(t)) return "Final order";
  return titleCase(t);
}

function filingLabel(raw: string | null | undefined): { name: string; hint: string | null } {
  const t = squash(raw);
  if (!t) return { name: "Document", hint: null };
  if (/vakal/i.test(t)) return { name: "Vakalat", hint: "a lawyer's written authority to appear in the case" };
  if (/counter/i.test(t)) return { name: "Counter affidavit", hint: "a written reply to the petition" };
  if (/rejoinder/i.test(t)) return { name: "Rejoinder", hint: "a written answer to the reply" };
  if (/proof of service|memo of service|service memo/i.test(t)) return { name: "Proof of service memo", hint: "proof that the notice was delivered" };
  if (/lunch motion/i.test(t)) return { name: "Lunch motion", hint: "a request to have the case heard at the lunch break" };
  if (/memo/i.test(t)) return { name: "Memo", hint: null };
  return { name: titleCase(t), hint: null };
}

function registryNote(raw: string | null | undefined): string {
  const t = squash(raw);
  if (!t) return "";
  if (/accept/i.test(t)) return "Accepted into the case file.";
  if (/scrutiny|pending/i.test(t)) return "Waiting for the court registry to check it.";
  return `Registry note: ${t}.`;
}

function cleanPurpose(raw: string | null | undefined): string | null {
  const t = squash(raw).replace(/\s+\)/g, ")");
  return t ? titleCase(t) : null;
}

// ---- ordering ---------------------------------------------------------------------------------------
// On the same day, the later step in the story is shown first (newest first).
const RANK: Record<string, number> = {
  hearing: 9,
  next: 9,
  closed: 8,
  order: 7,
  decided: 6,
  doc: 5,
  app: 4,
  registered: 3,
  filed: 2,
};

interface Draft extends CourtEvent {
  rank: number;
  seq: number;
}

/**
 * The whole story of a case, newest first. Anything the record doesn't carry is
 * simply left out — an empty or half-filled record yields a short list, never a
 * guess.
 */
export function buildCourtTimeline(cs: TimelineInput, nowMs: number = Date.now()): CourtEvent[] {
  const drafts: Draft[] = [];
  const counters = new Map<string, number>();
  let seq = 0;

  const add = (
    kind: keyof typeof RANK,
    rawDate: string | null | undefined,
    e: Omit<CourtEvent, "id" | "date">
  ) => {
    const date = courtDateToISO(rawDate);
    if (!date) return; // an event we can't date can't be placed in a timeline
    const key = `${kind}-${date.replace(/-/g, "")}`;
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    drafts.push({ ...e, id: `${key}-${n}`, date, rank: RANK[kind], seq: seq++ });
  };

  const disposed = (cs.status ?? "").toUpperCase() === "DISPOSED";

  add("filed", cs.filingDate, {
    type: "filing",
    title: "Petition filed",
    body: "The petition was filed in the High Court.",
    url: null,
    minor: false,
  });
  add("registered", cs.registrationDate, {
    type: "filing",
    title: "Case registered",
    body: "The court accepted the petition for hearing and gave it a case number.",
    url: null,
    minor: false,
  });

  for (const a of cs.applications ?? []) {
    const name = a.type ? titleCase(a.type) : "Application";
    const done = /dispos/i.test(a.status ?? "");
    add("app", a.date, {
      type: "filing",
      title: `Application filed: ${name}`,
      // A closed case's leftover "Pending" is just the portal not updating the application — say nothing about it.
      body: `A request made inside the case.${done ? " The court has since disposed of it." : disposed ? "" : " It is still pending."}`,
      url: null,
      minor: true,
    });
    if (done) {
      add("decided", a.decidedOn, {
        type: "update",
        title: `Application decided: ${name}`,
        body: "The court disposed of this request. Its order shows what was directed.",
        url: null,
        minor: true,
      });
    }
  }

  for (const f of cs.filings ?? []) {
    const { name, hint } = filingLabel(f.type);
    add("doc", f.date, {
      type: "filing",
      title: `${name} filed`,
      body: [hint ? `${name[0].toUpperCase()}${name.slice(1)} is ${hint}.` : "", registryNote(f.status)].filter(Boolean).join(" "),
      url: null,
      minor: true,
    });
  }

  for (const o of cs.orders ?? []) {
    const judge = prettyJudge(o.judge);
    add("order", o.date, {
      type: "order",
      title: `Court order: ${orderLabel(o.type)}`,
      body: [judge ? `Passed by ${judge}.` : "", o.url ? "" : "The PDF is not on the court's website yet."]
        .filter(Boolean)
        .join(" "),
      url: o.url ?? null,
      minor: false,
    });
  }

  if (disposed) {
    const state = writtenOrderState(cs);
    const orderLine =
      state?.kind === "published"
        ? "The court's written order for that day is published — open it to read exactly what was directed."
        : state?.kind === "listed-no-pdf"
          ? "An order is listed for that day but its PDF is not out yet, so we can't yet confirm exactly what the court directed."
          : "The written order is not published yet, so we can't yet confirm exactly what the court directed.";
    add("closed", cs.disposalDate, {
      type: "disposed",
      title: "Case closed (disposed)",
      body: [
        disposalMeaning(cs.disposalType) ?? "The court has closed the case and given its final decision.",
        cs.disposalType ? `The court's label: "${squash(cs.disposalType)}".` : "",
        orderLine,
      ]
        .filter(Boolean)
        .join(" "),
      url: null,
      minor: false,
    });
  } else {
    // A hearing already in the past is not news — the court moves the date on
    // after every hearing, so a past date on a pending case is just stale.
    const iso = courtDateToISO(cs.listingDate);
    const today = todayISTDate(nowMs);
    if (iso && iso >= today) {
      const purpose = cleanPurpose(cs.purpose);
      add(iso === today ? "hearing" : "next", cs.listingDate, {
        type: iso === today ? "hearing" : "next_hearing",
        title: iso === today ? "Hearing today" : "Next hearing",
        body: [
          iso === today ? "The case is listed today." : `The case is listed on ${formatCourtDate(cs.listingDate)}.`,
          purpose ? `Listed for: ${purpose}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
        url: null,
        minor: false,
      });
    }
  }

  return drafts
    .sort((a, b) => (a.date === b.date ? b.rank - a.rank || a.seq - b.seq : b.date.localeCompare(a.date)))
    .map(({ rank: _rank, seq: _seq, ...event }) => event);
}

/** The newest thing that actually HAPPENED (not a hearing still to come). */
export function latestHappenedDate(events: CourtEvent[], nowMs: number = Date.now()): string | null {
  const today = todayISTDate(nowMs);
  for (const e of events) {
    if (e.type === "next_hearing" || e.type === "hearing") continue;
    if (e.date <= today) return e.date;
  }
  return null;
}

export interface CourtHeadline {
  tone: "closed" | "pending";
  headline: string;
  detail: string | null;
}

/** One sentence for the top of a batch's card: where the case stands right now. */
export function courtHeadline(cs: CaseStatusLike, nowMs: number = Date.now()): CourtHeadline {
  if ((cs.status ?? "").toUpperCase() === "DISPOSED") {
    const when = formatCourtDate(cs.disposalDate);
    const state = writtenOrderState(cs);
    return {
      tone: "closed",
      headline: when ? `Case closed on ${when}` : "Case closed",
      detail:
        state?.kind === "published"
          ? "The court's written order is published."
          : state?.kind === "listed-no-pdf"
            ? "An order is listed for that day but its PDF is not out yet."
            : "The court's written order is not published yet.",
    };
  }
  const iso = courtDateToISO(cs.listingDate);
  const today = todayISTDate(nowMs);
  if (iso && iso >= today) {
    const purpose = cleanPurpose(cs.purpose);
    return {
      tone: "pending",
      headline: iso === today ? "Hearing today" : `Next hearing on ${formatCourtDate(cs.listingDate)}`,
      detail: purpose ? `Listed for: ${purpose}` : null,
    };
  }
  return { tone: "pending", headline: "Case is pending", detail: "No upcoming hearing date on the court's record." };
}

// ---- the student feed -------------------------------------------------------------------------------

export interface NewsItem {
  id: string;
  batch_slug: string;
  college: string;
  batch_name: string;
  title: string;
  body: string;
  event_type: CourtEventType;
  event_date: string;
  source_url: string | null;
}

/**
 * The shape the student "Case News" pages already read. Routine paperwork is
 * left out: a student wants the milestones (filed, registered, orders, the next
 * hearing, the case closing), not every vakalat the registry accepted.
 */
export function toNewsItems(batch: { slug: string; name: string; college: string }, events: CourtEvent[]): NewsItem[] {
  return events
    .filter((e) => !e.minor)
    .map((e) => ({
      id: `${batch.slug}.${e.id}`,
      batch_slug: batch.slug,
      college: batch.college,
      batch_name: batch.name,
      title: e.title,
      body: e.body,
      event_type: e.type,
      event_date: e.date,
      source_url: e.url,
    }));
}
