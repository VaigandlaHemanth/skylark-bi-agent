/**
 * Cleaning layer for real-world messy board data.
 *
 * Design note: the boards carry Skylark's OWN vocabulary ("Renewables",
 * "F. Negotiations", "Executed until current month"). Rewriting those into a
 * generic taxonomy would destroy information and make answers disagree with
 * what a founder sees in monday.com. So values are preserved verbatim, and the
 * concept tables below are used the other way round - to expand the *user's*
 * phrasing ("energy sector") onto the values the board actually uses.
 */

const BLANKS = new Set([
  "", "-", "--", "n/a", "na", "null", "nil", "tbd", "tba", "?",
  "unknown", "not available", "#n/a", "not applicable", "#value!", "#ref!",
  // "none" is deliberately NOT here: on these boards it is a real answer
  // ("no Skylark platform in this deal"), not an empty cell.
]);

export function isBlank(raw: string | null | undefined): boolean {
  return raw == null || BLANKS.has(String(raw).trim().toLowerCase());
}

export function cleanText(raw: string | null | undefined): string | null {
  if (isBlank(raw)) return null;
  return String(raw).replace(/\s+/g, " ").trim();
}

/** Case/space-insensitive key so "Mining", "mining " and "MINING" group together. */
export function normKey(raw: string | null | undefined): string {
  return String(raw ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ numbers */

/**
 * Order matters, and each pattern requires a preceding digit so that "$1.2M"
 * (no word boundary before the M) is caught while "Mar" or a currency code is not.
 */
const UNIT_MULTIPLIERS: Array<[RegExp, number]> = [
  [/\d\s*(?:crores?|cr)\b/i, 1e7],
  [/\d\s*(?:lakhs?|lacs?|l)\b/i, 1e5],
  [/\d\s*(?:billions?|bn|b)\b/i, 1e9],
  [/\d\s*(?:millions?|mn|mm|m)\b/i, 1e6],
  [/\d\s*(?:thousands?|k)\b/i, 1e3],
];

/** "12,00,000", "Rs 45,000", "$1.2M", "45k", "(500)", "12 lakhs" -> number */
export function parseNumber(raw: string | null | undefined): { value: number | null; note?: string } {
  if (isBlank(raw)) return { value: null };
  const s = String(raw).trim();

  const negative = /^\(.*\)$/.test(s) || /^-/.test(s);
  let multiplier = 1;
  for (const [re, mult] of UNIT_MULTIPLIERS) {
    if (re.test(s)) {
      multiplier = mult;
      break;
    }
  }

  // Take the FIRST number token only. Stripping every non-digit globally would
  // concatenate ranges: "1,00,000 - 2,00,000" must not become 100000200000.
  const cleaned = s.replace(/[()]/g, "");
  // The bare-decimal alternative must not fire on an abbreviation's full stop.
  // Scanning left to right, "Rs.45,000" hit the dot first and matched ".45",
  // reporting forty-five thousand rupees as 0.45 - and "Rs.45000" did it
  // silently, because the greedy digit run left nothing behind to flag as a
  // second number.
  const token = cleaned.match(/\d[\d,]*(?:\.\d+)?|(?<![A-Za-z])\.\d+/);
  if (!token) return { value: null, note: `could not read a number from "${s}"` };

  const n = Number(token[0].replace(/,/g, ""));
  if (!Number.isFinite(n)) return { value: null, note: `could not read a number from "${s}"` };

  const rest = cleaned.slice(cleaned.indexOf(token[0]) + token[0].length);
  const hasMore = /\d/.test(rest);

  const value = n * multiplier * (negative ? -1 : 1);
  const notes: string[] = [];
  if (multiplier !== 1) notes.push(`read "${s}" as ${Math.round(value).toLocaleString("en-IN")}`);
  if (hasMore) notes.push(`"${s}" contains more than one number; used the first`);
  return notes.length ? { value, note: notes.join("; ") } : { value };
}

/**
 * Quantity cells mix a number with a unit: "5360 HA", "2057 Acr", "7 mines",
 * "24 Months", "45days", or a bare "1". Returns both parts so the number is
 * still aggregatable and the unit is not lost.
 */
export function parseQuantity(raw: string | null | undefined): { value: number | null; unit: string | null; note?: string } {
  if (isBlank(raw)) return { value: null, unit: null };
  const s = String(raw).trim();
  const m = s.match(/^\s*(-?[\d,]*\.?\d+)\s*([A-Za-z][A-Za-z .]*)?\s*$/);
  if (!m) return { value: null, unit: null, note: `could not read a quantity from "${s}"` };
  const value = Number(m[1].replace(/,/g, ""));
  const unit = m[2] ? m[2].trim() : null;
  if (!Number.isFinite(value)) return { value: null, unit, note: `could not read a quantity from "${s}"` };
  return { value, unit, ...(unit ? { note: `"${s}" is ${value} in units of "${unit}"` } : {}) };
}

export function parsePercent(raw: string | null | undefined): number | null {
  const { value } = parseNumber(raw);
  if (value == null) return null;
  return value > 1 && value <= 100 ? value / 100 : value;
}

/* -------------------------------------------------------------------- dates */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

export type DayOrder = "dmy" | "mdy";

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const yy = y < 100 ? (y > 70 ? 1900 + y : 2000 + y) : y;
  const dt = new Date(Date.UTC(yy, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * Ambiguous values like 03/04/2026 cannot be resolved row by row.
 * Scan the whole column: if any first component exceeds 12 it must be a day.
 */
export function detectDayOrder(values: Array<string | null | undefined>): { order: DayOrder; ambiguous: boolean } {
  let firstOver12 = 0;
  let secondOver12 = 0;
  let seen = 0;

  for (const v of values) {
    if (isBlank(v)) continue;
    const m = String(v).trim().match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
    if (!m) continue;
    seen++;
    if (Number(m[1]) > 12) firstOver12++;
    if (Number(m[2]) > 12) secondOver12++;
  }

  if (firstOver12 > 0 && secondOver12 === 0) return { order: "dmy", ambiguous: false };
  if (secondOver12 > 0 && firstOver12 === 0) return { order: "mdy", ambiguous: false };
  return { order: "dmy", ambiguous: seen > 0 };
}

/** Returns an ISO date (YYYY-MM-DD) or null, plus a note when the read was lossy. */
export function parseDate(
  raw: string | null | undefined,
  order: DayOrder = "dmy",
): { value: string | null; note?: string } {
  if (isBlank(raw)) return { value: null };
  const s = String(raw).trim();
  let m: RegExpMatchArray | null;

  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) {
    const v = iso(+m[1], +m[2], +m[3]);
    if (v) return { value: v };
  }

  // Tolerate a trailing time ("13/04/2026 10:30") - falling through to the
  // loose Date() fallback would silently flip to month-first parsing.
  if ((m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})(?=$|[\sT,])/))) {
    const a = +m[1];
    const b = +m[2];
    const dayFirst = a > 12 ? true : b > 12 ? false : order === "dmy";
    const v = dayFirst ? iso(+m[3], b, a) : iso(+m[3], a, b);
    if (v) return { value: v };
  }

  if ((m = s.match(/^(\d{1,2})[\s\-.]+([A-Za-z]{3,9})[\s\-.,]+(\d{2,4})$/))) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo) {
      const v = iso(+m[3], mo, +m[1]);
      if (v) return { value: v };
    }
  }

  if ((m = s.match(/^([A-Za-z]{3,9})[\s\-.]+(\d{1,2})[\s,.]+(\d{2,4})$/))) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo) {
      const v = iso(+m[3], mo, +m[2]);
      if (v) return { value: v };
    }
  }

  const qFirst = s.match(/^Q([1-4])[\s\-]*(\d{4})$/i);
  const qLast = s.match(/^(\d{4})[\s\-]*Q([1-4])$/i);
  if (qFirst || qLast) {
    const q = qFirst ? +qFirst[1] : +qLast![2];
    const y = qFirst ? +qFirst[2] : +qLast![1];
    return { value: iso(y, q * 3 - 2, 1), note: `"${s}" is quarter-level only; used the first day of the quarter` };
  }

  if ((m = s.match(/^([A-Za-z]{3,9})[\s\-.]+(\d{2}|\d{4})$/))) {
    const mo = MONTHS[m[1].toLowerCase()];
    // Two-digit years ("Aug-25") included: the loose fallback used to read
    // that as 25 August 2001.
    if (mo) return { value: iso(+m[2], mo, 1), note: `"${s}" is month-level only; used the 1st` };
  }

  // A bare month name, as used in the billing-month columns.
  if (MONTHS[s.toLowerCase()]) {
    return { value: null, note: `"${s}" is a month name with no year; it cannot be placed on a timeline` };
  }

  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial > 20000 && serial < 60000) {
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      return { value: d.toISOString().slice(0, 10), note: `"${s}" read as an Excel date serial` };
    }
  }

  const fallback = new Date(s);
  if (!Number.isNaN(fallback.getTime())) {
    const y = fallback.getFullYear();
    if (y >= 1990 && y <= 2100) {
      // Local date parts, NOT toISOString: JS parses bare dates at local
      // midnight, and converting that to UTC shifts the day back in IST.
      const isoLocal = `${y}-${String(fallback.getMonth() + 1).padStart(2, "0")}-${String(fallback.getDate()).padStart(2, "0")}`;
      return { value: isoLocal, note: `"${s}" parsed loosely` };
    }
    return { value: null, note: `could not read a date from "${s}"` };
  }

  return { value: null, note: `could not read a date from "${s}"` };
}

/* ----------------------------------------------- concepts for term matching */

export type Vocab = Record<string, string[]>;

/**
 * Concept -> phrases that mean it. Used ONLY to decide whether a user's word and
 * a board value refer to the same thing. Board values are never rewritten.
 */
export const SECTOR_CONCEPTS: Vocab = {
  Energy: ["energy", "renewable", "renewables", "solar", "wind", "hydro", "power", "powerline", "power line", "transmission", "grid", "utility", "utilities", "electricity"],
  Mining: ["mining", "mines", "mine", "mineral", "minerals", "quarry", "coal", "aggregate", "aggregates", "cement", "iron ore", "bauxite"],
  Infrastructure: ["infra", "infrastructure", "construction", "railway", "railways", "rail", "metro", "road", "roads", "highway", "highways", "bridge", "urban", "smart city", "real estate"],
  "Oil & Gas": ["oil", "gas", "o&g", "petroleum", "refinery", "petrochemical", "lng"],
  Manufacturing: ["manufacturing", "factory", "plant", "industrial", "production"],
  Aviation: ["aviation", "airport", "airports", "airline", "aerospace"],
  Security: ["security", "surveillance", "defence", "defense", "policing"],
  Agriculture: ["agri", "agriculture", "agro", "farming", "plantation", "crop", "forestry"],
  Telecom: ["telecom", "telecommunication", "telecommunications", "tower", "towers", "5g", "fiber", "fibre"],
  Government: ["government", "govt", "public sector", "psu", "municipal", "municipality"],
  Water: ["water", "irrigation", "canal", "river", "dam", "wastewater"],
};

/** Deal Status on the funnel board: Open / Won / Dead / On Hold. */
export const DEAL_STATUS_CONCEPTS: Vocab = {
  Open: ["open", "active", "live", "in play", "pipeline", "in pipeline", "ongoing", "in progress", "pursuing"],
  Won: ["won", "win", "wins", "closed won", "close won", "converted", "signed", "booked", "successful"],
  Dead: ["dead", "lost", "closed lost", "close lost", "loss", "rejected", "declined", "dropped", "no bid"],
  "On Hold": ["on hold", "hold", "paused", "stalled", "deferred", "postponed", "frozen"],
};

/** Deal Stage on the funnel board is a lettered A-O ladder plus a few strays. */
export const DEAL_STAGE_CONCEPTS: Vocab = {
  Lead: ["lead", "leads", "lead generated", "lead generation", "new", "inbound", "enquiry", "inquiry", "prospect", "prospecting", "top of funnel"],
  Qualified: ["qualified", "sales qualified", "sales qualified leads", "sql", "qualification"],
  Demo: ["demo", "demo done", "demonstration", "presentation"],
  Feasibility: ["feasibility", "feasibility study", "assessment"],
  POC: ["poc", "proof of concept", "pilot", "trial"],
  Proposal: ["proposal", "proposals", "commercials", "commercials sent", "quote", "quotation", "quoted", "rfp", "rfq", "bid", "tender", "estimate"],
  Negotiation: ["negotiation", "negotiations", "negotiating", "negotiate", "contracting"],
  Won: ["won", "project won", "work order received", "wo received", "win", "signed", "converted", "order received"],
  Invoiced: ["invoice sent", "invoiced", "invoice", "amount accrued", "accrued", "billing"],
  Completed: ["project completed", "completed", "complete", "delivered", "done", "closed out"],
  Lost: ["lost", "project lost", "loss", "closed lost", "rejected", "declined"],
  "On Hold": ["on hold", "projects on hold", "hold", "paused", "stalled", "deferred"],
  "Not Relevant": ["not relevant", "not relevant at all", "not relevant at the moment", "irrelevant", "disqualified", "junk"],
};

/** Execution Status on the work order board. */
export const WORK_STATUS_CONCEPTS: Vocab = {
  "Partially Complete": ["partial completed", "partially completed", "partially complete", "partial"],
  Completed: ["completed", "complete", "done", "delivered", "finished", "closed", "handed over", "signed off"],
  "In Progress": ["ongoing", "in progress", "inprogress", "wip", "executing", "execution", "executed", "executed until current month", "active", "running", "underway"],
  "Not Started": ["not started", "notstarted", "new", "planned", "planning", "yet to start", "upcoming", "scheduled", "backlog"],
  "On Hold": ["pause", "paused", "pause / struck", "struck", "stuck", "on hold", "hold", "blocked", "stalled", "suspended"],
  "Waiting on Client": ["details pending from client", "details pending", "pending from client", "waiting on client", "awaiting client", "client input"],
  Cancelled: ["cancelled", "canceled", "dropped", "terminated", "aborted"],
};

export const INVOICE_CONCEPTS: Vocab = {
  "Partially Billed": ["partially billed", "partial billed", "part billed", "partially"],
  "Fully Billed": ["fully billed", "billed", "invoiced", "raised"],
  "Not Billed": ["not billed yet", "not billed", "unbilled", "not billable", "pending billing", "yet to bill"],
  Stuck: ["stuck", "blocked", "update required", "on hold"],
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Which concept does this phrase express? Longest matching alias wins. */
export function conceptOf(raw: string | null | undefined, vocab: Vocab): string | null {
  const text = cleanText(raw);
  if (!text) return null;
  const hay = text.toLowerCase();

  let best: { value: string; len: number } | null = null;
  for (const [label, aliases] of Object.entries(vocab)) {
    for (const alias of [label.toLowerCase(), ...aliases]) {
      const hit = hay === alias || new RegExp(`(^|[^a-z])${escapeRe(alias)}([^a-z]|$)`).test(hay);
      if (hit && (!best || alias.length > best.len)) best = { value: label, len: alias.length };
    }
  }
  return best ? best.value : null;
}

/**
 * Map a word the user typed onto the values a board actually contains.
 *
 *   term "energy"  +  board values [Renewables, Mining, Powerline, ...]
 *     -> ["Renewables", "Powerline"]   via concept "Energy"
 *
 * Returns null when the term cannot be resolved, so the caller can fall back to
 * plain substring matching and say so.
 */
export function expandTerm(
  term: string,
  values: string[],
  vocab?: Vocab,
): { matched: string[]; via: "exact" | "substring" | "concept" } | null {
  const t = normKey(term);
  if (!t) return null;

  const exact = values.filter((v) => normKey(v) === t);
  if (exact.length) return { matched: exact, via: "exact" };

  const sub = values.filter((v) => {
    const n = normKey(v);
    return n.includes(t) || (t.length > 3 && t.includes(n));
  });
  if (sub.length) return { matched: sub, via: "substring" };

  if (vocab) {
    const concept = conceptOf(term, vocab);
    if (concept) {
      const byConcept = values.filter((v) => conceptOf(v, vocab) === concept);
      if (byConcept.length) return { matched: byConcept, via: "concept" };
    }
  }

  return null;
}

// Legal suffixes only. Words like "Technologies" or "Services" are part of a
// company's identity - stripping them merged distinct clients into one key.
const COMPANY_NOISE = /\b(pvt|private|ltd|limited|llp|inc|incorporated|corp|corporation|co|company|plc|gmbh)\b/g;

/** Grouping key so "Adani Green Pvt. Ltd." and "adani green" collapse together. */
export function companyKey(raw: string | null | undefined): string | null {
  const text = cleanText(raw);
  if (!text) return null;
  const key = text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(COMPANY_NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return key || text.toLowerCase();
}
