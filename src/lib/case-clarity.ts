/**
 * case-clarity.ts — pure, dependency-free logic for the case-clarity upgrade.
 *
 * Why this exists: the court portal only ever says "DISPOSED" / "ALLOWED NO
 * COSTS" / "DISPOSED OF NO COSTS", and the app's old explanation didn't even
 * handle "DISPOSED OF NO COSTS" — students and admin alike were left guessing
 * what happened, whether anything was new, and what the court actually
 * directed. Everything here speaks in plain words and never claims more
 * than the court's record shows.
 */

export interface CourtOrderLike {
  date: string | null;
  type: string | null;
  judge: string | null;
  url: string | null;
}

export interface CaseStatusLike {
  status: string | null;
  listingDate: string | null;
  filingDate: string | null;
  registrationDate: string | null;
  disposalDate: string | null;
  disposalType: string | null;
  judges: string | null;
  purpose: string | null;
  latestOrder: { date: string | null; type: string | null } | null;
  orders?: CourtOrderLike[];
  petitionerCount: number | null;
}

export type ClarityStepState = "done" | "active" | "pending";

export interface ClarityStep {
  key: string;
  label: string;
  date: string | null;
  state: ClarityStepState;
  note?: string | null;
  /** When set, the tracker renders a "View order" link on this step. */
  orderUrl?: string | null;
  /** When true, the note is shown even for pending steps (default: hidden). */
  showNoteWhenPending?: boolean;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * The court portal gives dates in TWO shapes: the disposal and listing dates
 * as "13-10-2026" / "13/10/2026", but order dates (and the latest order) as ISO
 * "2026-10-13". Both must read the same everywhere below — comparing them as
 * raw strings or digit runs never matches, which would leave a published final
 * order stuck on "Awaiting publication" (found in the 2026-10-15 review).
 */
export function parseCourtDate(raw: string | null | undefined): { y: number; m: number; d: number } | null {
  if (!raw) return null;
  const s = raw.trim();
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  const iso = dmy ? null : /^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/.exec(s);
  const [y, m, d] = dmy ? [+dmy[3], +dmy[2], +dmy[1]] : iso ? [+iso[1], +iso[2], +iso[3]] : [0, 0, 0];
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 0 ? { y, m, d } : null;
}

/** "13-10-2026", "13/10/2026" or "2026-10-13" -> "13 Oct 2026". Null-safe. */
export function formatCourtDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const p = parseCourtDate(raw);
  return p ? `${p.d} ${MONTHS[p.m - 1]} ${p.y}` : raw.trim();
}

/** Any date shape the portal uses -> "2026-10-13" (null when unreadable). */
export function courtDateToISO(raw: string | null | undefined): string | null {
  const p = parseCourtDate(raw);
  return p ? `${String(p.y).padStart(4, "0")}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}` : null;
}

/** One comparable key per calendar day, whichever shape the portal used. */
function dateKey(raw: string | null | undefined): string | null {
  const p = parseCourtDate(raw);
  return p ? `${String(p.y).padStart(4, "0")}${String(p.m).padStart(2, "0")}${String(p.d).padStart(2, "0")}` : null;
}

/**
 * Plain-English meaning for a disposal type. Most-specific pattern first.
 * CRITICAL: "DISPOSED OF NO COSTS" does NOT mean the petition was allowed —
 * it only means the court closed the case without ordering either side to
 * pay costs. Never claim a win the record doesn't show.
 */
export function disposalMeaning(disposalType: string | null): string | null {
  if (!disposalType) return null;
  const d = disposalType.toLowerCase();
  if (d.includes("partly")) {
    return "The court ruled partly in favor of the petition and partly against it.";
  }
  if (d.includes("withdraw")) {
    return "The petition was withdrawn before the court gave a final decision.";
  }
  if (d.includes("dismiss")) {
    return "The court rejected the petition.";
  }
  if (d.includes("disposed") && d.includes("no cost")) {
    return (
      "The court closed the case without ordering either side to pay court costs. " +
      "\"No costs\" alone doesn't tell us who won — only the court's written order " +
      "says what it actually directed."
    );
  }
  if (
    (d.includes("allow") && d.includes("no cost")) ||
    (d.includes("allow") && d.includes("without cost"))
  ) {
    return "The court ruled in favor of the petition, and did not order either side to pay court costs.";
  }
  if (d.includes("allow")) {
    return "The court ruled in favor of the petition.";
  }
  if (d.includes("disposed")) {
    return "The court has closed the case and given its final decision.";
  }
  return null;
}

/** Plain-English meaning for the overall case status. */
export function statusMeaning(status: string | null): string | null {
  if (!status) return null;
  const s = status.toUpperCase();
  if (s === "PENDING") {
    return "The case is still ongoing — the court hasn't given a final decision yet.";
  }
  if (s === "DISPOSED") {
    return "The court has finished hearing this case and given its final decision.";
  }
  return null;
}

/** Banner headline for a disposed case, e.g. "Case closed on 13 Oct 2026". */
export function disposedBannerTitle(disposalDate: string | null): string {
  const when = formatCourtDate(disposalDate);
  return when ? `Case closed on ${when}` : "Case closed";
}

export type WrittenOrderState =
  | { kind: "published"; order: CourtOrderLike }
  | { kind: "listed-no-pdf"; order: CourtOrderLike }
  | { kind: "pending" };

/**
 * Where the written disposal order stands, date-matched against the
 * disposal date (court order rows carry the date the order was passed).
 * Returns null when the case isn't disposed — there is no disposal order
 * to look for.
 */
export function writtenOrderState(cs: CaseStatusLike): WrittenOrderState | null {
  if (!cs.status || cs.status.toUpperCase() !== "DISPOSED") return null;
  const dKey = dateKey(cs.disposalDate);
  const match = dKey
    ? (cs.orders ?? []).find((o) => dateKey(o.date) === dKey)
    : null;
  if (match && match.url) return { kind: "published", order: match };
  if (match) return { kind: "listed-no-pdf", order: match };
  return { kind: "pending" };
}

/**
 * The written-order-copy timeline step appended after "Disposed".
 * Greyed "Awaiting publication" while unpublished — this is the visual that
 * answers "is anything new there?".
 */
export function writtenOrderStep(cs: CaseStatusLike): ClarityStep | null {
  const state = writtenOrderState(cs);
  if (!state) return null;
  if (state.kind === "published") {
    return {
      key: "order-copy",
      label: "Written order copy",
      date: state.order.date,
      state: "done",
      note:
        "The court's full written order — this is where any directions " +
        "(like releasing certificates) would appear. Open it to read exactly what was directed.",
      orderUrl: state.order.url,
    };
  }
  if (state.kind === "listed-no-pdf") {
    return {
      key: "order-copy",
      label: "Written order copy",
      date: state.order.date,
      state: "pending",
      note:
        "The court lists an order for this date but the PDF isn't available yet. " +
        "Until it appears, we can't confirm what the court directed.",
      showNoteWhenPending: true,
    };
  }
  return {
    key: "order-copy",
    label: "Written order copy",
    date: null,
    state: "pending",
    note:
      "Awaiting publication — the court hasn't published the written order yet. " +
      "Until it appears, we can't confirm what the court directed.",
    showNoteWhenPending: true,
  };
}

/**
 * The most recent meaningful date on the record — used for the
 * "No new update since …" freshness line.
 */
export function freshnessSinceDate(cs: CaseStatusLike): string | null {
  return (
    formatCourtDate(cs.disposalDate) ??
    formatCourtDate(cs.latestOrder?.date) ??
    null
  );
}

/** "No new update since 13 Oct 2026" — null when nothing to anchor on. */
export function freshnessLine(cs: CaseStatusLike): string | null {
  const since = freshnessSinceDate(cs);
  return since ? `No new update since ${since}` : null;
}

export interface KnownUnknown {
  known: string[];
  unknown: string[];
}

/**
 * Honest known-vs-unknown split. KNOWN = what the court's record states.
 * NOT KNOWN = what nobody can confirm yet (deliberately explicit about the
 * certificates question — that's what everyone actually wants to know).
 */
export function knownUnknown(cs: CaseStatusLike): KnownUnknown {
  const known: string[] = [];
  const unknown: string[] = [];

  const when = formatCourtDate(cs.disposalDate);
  if (cs.status && cs.status.toUpperCase() === "DISPOSED") {
    known.push(
      when ? `The case was closed (disposed) on ${when}.` : "The case was closed (disposed)."
    );
  }
  if (cs.disposalType) known.push(`The court's result label: "${cs.disposalType}".`);
  if (cs.judges) known.push(`Decided by ${cs.judges}.`);

  const orderState = writtenOrderState(cs);
  if (orderState && orderState.kind !== "published") {
    unknown.push(
      "The court's written order copy is not published yet, so we cannot " +
        "confirm whether the college must release the certificates."
    );
  } else if (orderState && orderState.kind === "published") {
    known.push("The written order is published — open it above to read what the court directed.");
  }

  return { known, unknown };
}
