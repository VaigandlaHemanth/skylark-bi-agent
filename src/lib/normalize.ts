/**
 * Cleaning layer for real-world messy board data.
 * Every coercion either succeeds or records a note - nothing is silently dropped.
 */

const BLANKS = new Set([
  "", "-", "--", "n/a", "na", "none", "null", "nil", "tbd", "tba", "?",
  "unknown", "not available", "#n/a", "pending", "not applicable",
]);

export function isBlank(raw: string | null | undefined): boolean {
  return raw == null || BLANKS.has(String(raw).trim().toLowerCase());
}

export function cleanText(raw: string | null | undefined): string | null {
  if (isBlank(raw)) return null;
  return String(raw).replace(/\s+/g, " ").trim();
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

/** "Rs 1,20,000", "$1.2M", "45k", "(500)", "12 lakhs" -> number */
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

  // Keep digits and one decimal point; drop currency symbols, codes, separators.
  const digits = s.replace(/[()]/g, "").replace(/[^0-9.]/g, "");
  if (!digits || digits === ".") return { value: null, note: `could not read a number from "${s}"` };

  const parts = digits.split(".");
  const numeric = parts.length > 2 ? `${parts[0]}.${parts.slice(1).join("")}` : digits;
  const n = Number(numeric);
  if (!Number.isFinite(n)) return { value: null, note: `could not read a number from "${s}"` };

  const value = n * multiplier * (negative ? -1 : 1);
  return multiplier === 1
    ? { value }
    : { value, note: `read "${s}" as ${Math.round(value).toLocaleString("en-IN")}` };
}

export function parsePercent(raw: string | null | undefined): number | null {
  const { value } = parseNumber(raw);
  if (value == null) return null;
  return value > 1 && value <= 100 ? value / 100 : value; // accept both 60 and 0.6
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
  return { order: "dmy", ambiguous: seen > 0 }; // default to day-first (IN/EU convention)
}

/** Returns an ISO date (YYYY-MM-DD) or null, plus a note when the read was lossy. */
export function parseDate(
  raw: string | null | undefined,
  order: DayOrder = "dmy",
): { value: string | null; note?: string } {
  if (isBlank(raw)) return { value: null };
  const s = String(raw).trim();
  let m: RegExpMatchArray | null;

  // 2026-07-15 / 2026/07/15
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) {
    const v = iso(+m[1], +m[2], +m[3]);
    if (v) return { value: v };
  }

  // 15/07/2026 or 07/15/2026
  if ((m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/))) {
    const a = +m[1];
    const b = +m[2];
    const dayFirst = a > 12 ? true : b > 12 ? false : order === "dmy";
    const v = dayFirst ? iso(+m[3], b, a) : iso(+m[3], a, b);
    if (v) return { value: v };
  }

  // 15-Jul-2026, 15 July 26
  if ((m = s.match(/^(\d{1,2})[\s\-.]+([A-Za-z]{3,9})[\s\-.,]+(\d{2,4})$/))) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo) {
      const v = iso(+m[3], mo, +m[1]);
      if (v) return { value: v };
    }
  }

  // Jul 15, 2026 / July 15 2026
  if ((m = s.match(/^([A-Za-z]{3,9})[\s\-.]+(\d{1,2})[\s,.]+(\d{2,4})$/))) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo) {
      const v = iso(+m[3], mo, +m[2]);
      if (v) return { value: v };
    }
  }

  // Q3 2026 / 2026-Q3 -> first day of the quarter, flagged as low precision
  const qFirst = s.match(/^Q([1-4])[\s\-]*(\d{4})$/i);
  const qLast = s.match(/^(\d{4})[\s\-]*Q([1-4])$/i);
  if (qFirst || qLast) {
    const q = qFirst ? +qFirst[1] : +qLast![2];
    const y = qFirst ? +qFirst[2] : +qLast![1];
    return { value: iso(y, q * 3 - 2, 1), note: `"${s}" is quarter-level only; used the first day of the quarter` };
  }

  // Jul 2026 -> first of month, flagged
  if ((m = s.match(/^([A-Za-z]{3,9})[\s\-.]+(\d{4})$/))) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo) return { value: iso(+m[2], mo, 1), note: `"${s}" is month-level only; used the 1st` };
  }

  // Excel serial number (days since 1899-12-30)
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial > 20000 && serial < 60000) {
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      return { value: d.toISOString().slice(0, 10), note: `"${s}" read as an Excel date serial` };
    }
  }

  const fallback = new Date(s);
  if (!Number.isNaN(fallback.getTime())) {
    return { value: fallback.toISOString().slice(0, 10), note: `"${s}" parsed loosely` };
  }

  return { value: null, note: `could not read a date from "${s}"` };
}

/* ------------------------------------------------------- controlled vocabs */

export type Vocab = Record<string, string[]>;

export const SECTORS: Vocab = {
  Energy: ["energy", "power", "renewable", "renewables", "solar", "wind", "hydro", "utility", "utilities", "grid", "transmission", "epc"],
  "Oil & Gas": ["oil", "gas", "o&g", "petroleum", "refinery", "pipeline", "petrochemical", "lng"],
  Mining: ["mining", "mines", "mineral", "minerals", "quarry", "coal", "aggregate", "aggregates", "cement", "iron ore"],
  Infrastructure: ["infra", "infrastructure", "construction", "road", "roads", "highway", "highways", "railway", "railways", "metro", "bridge", "smart city", "urban"],
  Agriculture: ["agri", "agriculture", "agro", "farming", "farm", "plantation", "crop", "horticulture"],
  Telecom: ["telecom", "telecommunication", "telecommunications", "tower", "towers", "5g", "fiber", "fibre"],
  Government: ["government", "govt", "public sector", "psu", "municipal", "municipality", "defence", "defense", "state"],
  "Real Estate": ["real estate", "realty", "property", "township", "housing"],
  Water: ["water", "irrigation", "canal", "river", "dam", "wastewater"],
  Logistics: ["logistics", "port", "ports", "warehouse", "warehousing", "supply chain"],
  Environment: ["environment", "forest", "forestry", "conservation", "climate"],
};

export const DEAL_STAGES: Vocab = {
  Lead: ["lead", "leads", "new", "inbound", "enquiry", "inquiry", "prospect", "prospecting", "discovery"],
  Qualified: ["qualified", "qualification", "qualify", "scoping", "demo", "poc", "pilot"],
  Proposal: ["proposal", "quote", "quotation", "quoted", "rfp", "rfq", "bid", "tender", "estimate"],
  Negotiation: ["negotiation", "negotiating", "negotiate", "contract", "legal", "commercials"],
  Won: ["won", "closed won", "close won", "close-won", "closed-won", "win", "signed", "converted", "booked"],
  Lost: ["lost", "closed lost", "close lost", "closed-lost", "loss", "rejected", "declined", "no bid"],
  "On Hold": ["on hold", "hold", "paused", "stalled", "deferred", "postponed", "dormant"],
  Cancelled: ["cancelled", "canceled", "dropped", "withdrawn", "dead", "abandoned"],
};

export const WORK_STATUSES: Vocab = {
  "Not Started": ["not started", "notstarted", "new", "planned", "planning", "yet to start", "scheduled", "backlog", "upcoming"],
  "In Progress": ["in progress", "inprogress", "progress", "wip", "ongoing", "working", "execution", "executing", "flying", "survey", "processing", "in review", "active"],
  "On Hold": ["on hold", "hold", "paused", "blocked", "stalled", "waiting", "delayed"],
  Completed: ["completed", "complete", "done", "delivered", "closed", "finished", "handed over", "signed off"],
  Cancelled: ["cancelled", "canceled", "dropped", "terminated", "aborted"],
};

/** Open (still-live) deal stages, used by pipeline metrics. */
export const OPEN_STAGES = ["Lead", "Qualified", "Proposal", "Negotiation", "On Hold"];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Longest-match alias lookup. Unmapped values are kept verbatim and reported. */
export function canonical(raw: string | null | undefined, vocab: Vocab): { value: string | null; mapped: boolean } {
  const text = cleanText(raw);
  if (!text) return { value: null, mapped: true };
  const hay = text.toLowerCase();

  let best: { value: string; len: number } | null = null;
  for (const [label, aliases] of Object.entries(vocab)) {
    for (const alias of [label.toLowerCase(), ...aliases]) {
      const hit = hay === alias || new RegExp(`(^|[^a-z])${escapeRe(alias)}([^a-z]|$)`).test(hay);
      if (hit && (!best || alias.length > best.len)) best = { value: label, len: alias.length };
    }
  }
  return best ? { value: best.value, mapped: true } : { value: text, mapped: false };
}

const COMPANY_NOISE =
  /\b(pvt|private|ltd|limited|llp|inc|incorporated|corp|corporation|co|company|plc|gmbh|group|holdings|industries|enterprises|solutions|technologies|technology|tech|services|projects)\b/g;

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
