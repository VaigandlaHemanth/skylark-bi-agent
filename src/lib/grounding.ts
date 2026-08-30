/**
 * Grounding: every figure in an answer must trace back to a figure a tool
 * returned.
 *
 * The system prompt asks the model not to do arithmetic. Asking is not a
 * reliability mechanism, so this checks the finished answer against everything
 * the tools actually returned and reports what does not trace. The agent uses
 * it as a gate before shipping an answer; the eval uses it as a metric. Same
 * code, so the number reported is the number enforced.
 */

/** Every number appearing anywhere in a tool payload, at any depth. */
export function numbersIn(value: unknown, out: Set<number> = new Set()): Set<number> {
  if (typeof value === "number" && Number.isFinite(value)) out.add(value);
  else if (typeof value === "string") {
    for (const m of value.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
      const n = Number(m[0].replace(/,/g, ""));
      if (Number.isFinite(n)) out.add(n);
    }
  } else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => numbersIn(v, out));
  return out;
}

const SUFFIX: Record<string, number> = {
  k: 1e3, m: 1e6, bn: 1e9, b: 1e9, cr: 1e7, l: 1e5,
  lakh: 1e5, lakhs: 1e5, crore: 1e7, crores: 1e7, million: 1e6, billion: 1e9,
};

/** Figures the model wrote, with any magnitude suffix expanded. */
export function numbersInProse(text: string): number[] {
  const out: number[] = [];
  // Code spans and ISO dates are not claims about the data.
  const cleaned = text.replace(/`[^`]*`/g, " ").replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ");
  for (const m of cleaned.matchAll(/(-?\d[\d,]*(?:\.\d+)?)\s*(lakhs?|crores?|millions?|billions?|bn|cr|[kmbl])?\b/gi)) {
    const base = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    out.push(base * (m[2] ? (SUFFIX[m[2].toLowerCase()] ?? 1) : 1));
  }
  return out;
}

/** Years, list markers and small ordinals are not claims about the boards. */
export function isNoise(n: number): boolean {
  if (!Number.isInteger(n)) return false;
  if (n >= 1990 && n <= 2100) return true;
  return Math.abs(n) <= 12;
}

/**
 * Grounded if some retrieved figure matches exactly, within rounding, or as a
 * stated magnitude ("31.9M" for 31,894,034).
 */
export function isGrounded(n: number, pool: Set<number>): boolean {
  if (pool.has(n)) return true;
  for (const t of pool) {
    if (t === 0 && n === 0) return true;
    const denom = Math.max(Math.abs(t), 1);
    if (Math.abs(n - t) / denom < 0.011) return true;
    for (const scale of [1e3, 1e5, 1e6, 1e7, 1e9]) {
      if (Math.abs(n * scale - t) / denom < 0.011) return true;
    }
  }
  return false;
}

/**
 * An ungrounded figure is not automatically invented. "derived" means the model
 * did arithmetic the engine should have done - recoverable by pointing it at
 * the compute tool. "fabricated" means the figure has no basis at all.
 */
export function classify(n: number, pool: Set<number>): "derived" | "fabricated" {
  const vals = [...pool];
  const close = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1) < 0.02;

  for (const a of vals) {
    if (a === 0) continue;
    for (const b of vals) {
      if (close(n, (a / b) * 100) || close(n, a / b)) return "derived";
      if (close(n, a + b) || close(n, a - b)) return "derived";
      if (close(n, ((a - b) / Math.abs(b)) * 100)) return "derived";
    }
  }
  return "fabricated";
}

export type GroundingReport = {
  checked: number;
  grounded: number;
  derived: number[];
  fabricated: number[];
  /** True when every figure in the answer traces to retrieved data. */
  clean: boolean;
};

export function checkGrounding(answer: string, pool: Set<number>): GroundingReport {
  const figures = numbersInProse(answer).filter((n) => !isNoise(n));
  const ungrounded = figures.filter((n) => !isGrounded(n, pool));
  const derived = ungrounded.filter((n) => classify(n, pool) === "derived");
  const fabricated = ungrounded.filter((n) => classify(n, pool) === "fabricated");

  return {
    checked: figures.length,
    grounded: figures.length - ungrounded.length,
    derived,
    fabricated,
    clean: ungrounded.length === 0,
  };
}

/** What to tell the model so it can repair the answer itself. */
export function correctionPrompt(report: GroundingReport): string {
  const fmt = (n: number) => n.toLocaleString("en-IN");
  const lines = ["SYSTEM CHECK: your answer contains figures that do not appear in any tool result."];

  if (report.fabricated.length) {
    lines.push(`No retrieved data supports: ${report.fabricated.map(fmt).join(", ")}. Remove these or retrieve them.`);
  }
  if (report.derived.length) {
    lines.push(`These look like arithmetic you performed yourself: ${report.derived.map(fmt).join(", ")}.`);

    // Percentage-shaped misses are almost always a rate over a subset, and the
    // engine already returns those - naming the exact call fixes it where a
    // generic "call compute" does not.
    if (report.derived.some((n) => Math.abs(n) <= 100)) {
      lines.push(
        "A rate or share over a subset is retrievable, not calculated: query_board with a filter for the subset, " +
          "group_by the field that splits it, and read the share off the group you want. " +
          'A win rate, for example, is filter status in "Won,Dead", group_by status, metrics ["count"] - then share_of_count_pct on the Won group IS the win rate. ' +
          "Otherwise call compute with the two figures you already retrieved.",
      );
    } else {
      lines.push("Call compute with the figures you already retrieved, then restate the answer using its result.");
    }
  }

  lines.push("Rewrite the answer so every figure comes from a tool result. Do not apologise or mention this check.");
  return lines.join(" ");
}


/* ------------------------------------------------------ data-quality gate */

/**
 * A caveat is material when it changes how a figure should be read: rows
 * dropped from a sum, a column that is half empty, a total one group
 * dominates, groups merged under a repeated name.
 */
const MATERIAL = /excluded from sums|are excluded|only \d+% filled|concentrated in one group|not unique|could not be read|shown as "\(blank\)"|do not add to 100/i;

export function materialCaveats(caveats: string[]): string[] {
  return caveats.filter((c) => MATERIAL.test(c));
}

/** Loose check that the prose already says what a caveat says. */
function alreadySaid(answer: string, caveat: string): boolean {
  const a = answer.toLowerCase();

  // A caveat about concentration is not answered by mentioning blanks, and vice
  // versa, so each kind is checked against language that actually conveys it.
  if (/concentrated in one group/i.test(caveat)) return /concentrat|dominat|skew|driven by|accounts for/.test(a);
  if (/not unique/i.test(caveat)) return /not unique|repeat|duplicate|merge/.test(a);
  if (/could not be read/i.test(caveat)) return /could not be read|unavailable|unable|failed/.test(a);
  if (/do not add to 100/i.test(caveat)) return /do not add|not add to 100|top \d+/.test(a);

  // What is left is the missing-data family. Any wording that tells the reader
  // the figure rests on incomplete data counts - the point is that the reader
  // is warned, not that the engine's sentence is quoted.
  //
  // Matching a bare digit run does NOT count. The caveat carries the row totals
  // as well as the fill rate, so "344 deals" in an answer about 344 deals used
  // to read as a disclosure of a 48% fill rate and suppressed the warning.
  return /blank|missing|excluded|exclude|incomplete|not populated|unfilled|sparse|partial|only .{0,12}filled/.test(a);
}

/**
 * "Communicate data quality issues to the user" is a requirement, not a
 * preference, so an answer that omits every material caveat gets one appended
 * verbatim from the engine rather than being quietly shipped. Deterministic:
 * no extra model call, and the text is the engine's own.
 */
export function appendMissingCaveats(answer: string, caveats: string[]): string {
  const material = materialCaveats(caveats);
  if (!material.length) return answer;

  // Per caveat, not across them. Disclosing one material caveat used to excuse
  // every other: an answer that noted a concentration but hid a 48% fill rate
  // was shipped untouched, which is the omission this whole function exists to
  // prevent.
  const missing = material.filter((c) => !alreadySaid(answer, c));
  if (!missing.length) return answer;

  const NL = String.fromCharCode(10);
  const note = missing.slice(0, 2).join(" ");
  return `${answer}${NL}${NL}*${note}*`;
}
