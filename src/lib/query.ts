/**
 * Deterministic filter / group / aggregate engine.
 *
 * The model chooses WHAT to compute; this file computes it. No number in an
 * answer is ever produced by the language model itself.
 */

import { companyKey, expandTerm, normKey } from "./normalize";
import { vocabFor, type Dataset, type Row } from "./store";

export type Filter = { field: string; op: string; value?: string };

export type QuerySpec = {
  filters?: Filter[];
  timeframe?: string;
  date_field?: string;
  group_by?: string;
  metrics?: string[];
  sort?: string;
  limit?: number;
  return_rows?: boolean;
};

/* ------------------------------------------------------------- timeframes */

export function today(): Date {
  return new Date();
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Turns "this quarter", "last 90 days", "FY25", "2026" into an ISO range.
 * Quarters are CALENDAR quarters; Indian financial years are supported via
 * "fy"/"financial year" wording. The interpretation is returned so the agent
 * can state it back to the user.
 */
export function resolveTimeframe(phrase: string | undefined, now = today()): { from?: string; to?: string; label: string } | null {
  if (!phrase) return null;
  const p = phrase.toLowerCase().trim();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const mk = (a: Date, b: Date, label: string) => ({ from: iso(a), to: iso(b), label });
  const U = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd));

  const rel = p.match(/(?:last|past|previous)\s+(\d+)\s*(day|week|month|quarter|year)s?/);
  if (rel) {
    const n = Number(rel[1]);
    const mult = { day: 1, week: 7, month: 30, quarter: 91, year: 365 }[rel[2] as "day"];
    const from = new Date(now.getTime() - n * mult * 86400000);
    return mk(from, now, `last ${n} ${rel[2]}${n > 1 ? "s" : ""} (${iso(from)} to ${iso(now)})`);
  }

  const fy = p.match(/\bfy\s*'?(\d{2,4})(?:\s*[-/]\s*(\d{2,4}))?\b/) || p.match(/financial year\s*'?(\d{2,4})(?:\s*[-/]\s*(\d{2,4}))?/);
  if (fy) {
    const a = Number(fy[1]);
    const full = (n: number) => (n < 100 ? 2000 + n : n);
    // Range notation "FY 2025-26" names the STARTING year; bare "FY26" names
    // the ending year (both are the same Indian Apr-Mar year).
    const start = fy[2] !== undefined ? full(a) : full(a) - 1;
    return mk(U(start, 3, 1), U(start + 1, 2, 31), `FY${String(start).slice(-2)}-${String(start + 1).slice(-2)} (1 Apr ${start} to 31 Mar ${start + 1})`);
  }
  if (/\b(this|current)\s+(financial year|fy)\b/.test(p)) {
    const start = m >= 3 ? y : y - 1;
    return mk(U(start, 3, 1), U(start + 1, 2, 31), `current financial year (1 Apr ${start} to 31 Mar ${start + 1})`);
  }

  const qExplicit = p.match(/\bq([1-4])\s*(?:of\s*)?'?(\d{2,4})?\b/);
  if (qExplicit) {
    const q = Number(qExplicit[1]);
    const raw = qExplicit[2] ? Number(qExplicit[2]) : NaN;
    // "Q3 25" means 2025, not the current year.
    const yy = Number.isNaN(raw) ? y : raw < 100 ? 2000 + raw : raw;
    return mk(U(yy, (q - 1) * 3, 1), U(yy, q * 3, 0), `Q${q} ${yy} (calendar)`);
  }

  if (/\b(this|current)\s+quarter\b/.test(p)) {
    const q = Math.floor(m / 3);
    return mk(U(y, q * 3, 1), U(y, q * 3 + 3, 0), `this calendar quarter, Q${q + 1} ${y}`);
  }
  if (/\blast\s+quarter\b|\bprevious\s+quarter\b/.test(p)) {
    const q = Math.floor(m / 3) - 1;
    const yy = q < 0 ? y - 1 : y;
    const qq = q < 0 ? 3 : q;
    return mk(U(yy, qq * 3, 1), U(yy, qq * 3 + 3, 0), `last calendar quarter, Q${qq + 1} ${yy}`);
  }
  if (/\bnext\s+quarter\b/.test(p)) {
    const q = Math.floor(m / 3) + 1;
    const yy = q > 3 ? y + 1 : y;
    const qq = q > 3 ? 0 : q;
    return mk(U(yy, qq * 3, 1), U(yy, qq * 3 + 3, 0), `next calendar quarter, Q${qq + 1} ${yy}`);
  }
  if (/\b(this|current)\s+month\b/.test(p)) return mk(U(y, m, 1), U(y, m + 1, 0), `this month (${iso(U(y, m, 1))} to ${iso(U(y, m + 1, 0))})`);
  if (/\blast\s+month\b/.test(p)) return mk(U(y, m - 1, 1), U(y, m, 0), "last month");
  if (/\b(this|current)\s+year\b|\bytd\b|year to date/.test(p)) return mk(U(y, 0, 1), now, `year to date (1 Jan ${y} to ${iso(now)})`);
  if (/\blast\s+year\b/.test(p)) return mk(U(y - 1, 0, 1), U(y - 1, 11, 31), `${y - 1}`);

  const yr = p.match(/^(\d{4})$/);
  if (yr) return mk(U(Number(yr[1]), 0, 1), U(Number(yr[1]), 11, 31), `calendar ${yr[1]}`);

  const range = p.match(/(\d{4}-\d{2}-\d{2})\s*(?:to|\.\.|-)\s*(\d{4}-\d{2}-\d{2})/);
  if (range) return { from: range[1], to: range[2], label: `${range[1]} to ${range[2]}` };

  return null;
}

/* ------------------------------------------------------------ field access */

/** Accepts a canonical field key, a monday column title, or "name". */
function readField(row: Row, field: string): string | number | null {
  const f = field.trim();
  if (!f) return null;
  // On both boards the deal name is the monday ITEM name, not a column, so
  // these aliases are the only way a filter on it can bind.
  if (f === "name" || f === "item" || f === "item name" || f === "deal_name" || f === "deal name" || f === "wo_name") {
    return row.name || null;
  }
  if (f in row.f) return row.f[f];

  const lower = f.toLowerCase();
  for (const key of Object.keys(row.raw)) if (key.toLowerCase() === lower) return row.raw[key];
  for (const key of Object.keys(row.raw)) if (key.toLowerCase().includes(lower)) return row.raw[key];
  return null;
}

function asNumber(v: string | number | null): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;

  // The string has to actually look like a number. Stripping non-digits from
  // "Zebra Corp" used to leave "" and Number("") is 0, so every text value
  // compared and sorted as zero - silently turning a name sort into board
  // order, with every figure in the result still perfectly grounded.
  const stripped = String(v).trim().replace(/[₹$€£,\s]/g, "");
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(stripped)) return null;
  const n = Number(stripped);
  return Number.isFinite(n) ? n : null;
}

const asText = (v: string | number | null) => (v == null ? "" : String(v).toLowerCase().trim());

/* ------------------------------------------ resolving the user's wording */

const SET_OPS = new Set(["eq", "in", "ne", "neq", "not_in", "contains"]);

type Prepared = { f: Filter; valueSet?: Set<string>; negate?: boolean };

/**
 * The boards use Skylark's own vocabulary ("Renewables", "F. Negotiations").
 * A founder says "energy" or "negotiation". This resolves the founder's word
 * onto the values the board actually holds, and records what it matched so the
 * answer can state it.
 */
function prepare(ds: Dataset, filters: Filter[], resolved: Array<Record<string, unknown>>, caveats: string[]): Prepared[] {
  return filters.map((f) => {
    const op = (f.op || "eq").toLowerCase();
    const values = ds.distinct[f.field];
    if (!SET_OPS.has(op) || !values || !f.value) return { f };

    const terms = op === "in" || op === "not_in" ? f.value.split(",").map((s) => s.trim()).filter(Boolean) : [f.value];
    const pool = values.map((v) => v.value);
    const matched = new Set<string>();
    const unresolved: string[] = [];

    for (const term of terms) {
      const hit = expandTerm(term, pool, vocabFor(f.field, ds.key));
      if (hit) hit.matched.forEach((v) => matched.add(v));
      else unresolved.push(term);
    }

    if (!matched.size) {
      caveats.push(
        `Nothing on this board matches "${f.value}" for ${f.field}. The values actually present are: ${pool.slice(0, 15).join(", ")}${pool.length > 15 ? ", ..." : ""}.`,
      );
      return { f };
    }

    if (unresolved.length) caveats.push(`Could not match "${unresolved.join('", "')}" to any ${f.field} value on this board.`);

    const asked = terms.join(", ");
    const got = [...matched].join(", ");
    if (normKey(asked) !== normKey(got)) {
      resolved.push({ field: f.field, you_asked_for: asked, board_values_used: [...matched] });
    }

    return { f, valueSet: new Set([...matched].map(normKey)), negate: op === "ne" || op === "neq" || op === "not_in" };
  });
}

/* ---------------------------------------------------------------- matching */

function matches(row: Row, p: Prepared): boolean {
  const { f } = p;
  const raw = readField(row, f.field);
  const op = (f.op || "eq").toLowerCase();
  const want = f.value ?? "";

  if (op === "is_empty" || op === "is_null") return raw == null || raw === "";
  if (op === "not_empty" || op === "not_null") return raw != null && raw !== "";
  if (raw == null || raw === "") return false;

  if (p.valueSet) {
    const hit = p.valueSet.has(normKey(String(raw)));
    return p.negate ? !hit : hit;
  }

  const text = asText(raw);
  const w = want.toLowerCase().trim();

  switch (op) {
    case "eq":
      return text === w || companyKey(text) === companyKey(w);
    case "ne":
    case "neq":
      return text !== w;
    case "contains":
      return text.includes(w);
    case "not_contains":
      return !text.includes(w);
    case "in":
      return w.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).some((v) => text === v || text.includes(v));
    case "not_in":
      return !w.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).some((v) => text === v || text.includes(v));
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = asNumber(raw);
      const b = Number(w);
      if (a == null || !Number.isFinite(b)) {
        if (op === "gt") return text > w;
        if (op === "gte") return text >= w;
        if (op === "lt") return text < w;
        return text <= w;
      }
      return op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b;
    }
    case "before":
      return text < w;
    case "after":
      return text > w;
    case "between": {
      const [lo, hi] = w.split(",").map((s) => s.trim());
      const a = asNumber(raw);
      const nlo = Number(lo);
      const nhi = Number(hi);
      if (a != null && Number.isFinite(nlo) && Number.isFinite(nhi)) return a >= nlo && a <= nhi;
      return text >= lo && text <= hi;
    }
    default:
      return text.includes(w);
  }
}

/* -------------------------------------------------------------- aggregation */

type MetricDef = { fn: string; field?: string; key: string };

function parseMetrics(metrics: string[] | undefined): MetricDef[] {
  const list = metrics?.length ? metrics : ["count"];
  return list.map((m) => {
    const [fn, field] = m.split(":").map((s) => s.trim());
    return { fn: fn.toLowerCase(), field, key: field ? `${fn.toLowerCase()}_${field}` : fn.toLowerCase() };
  });
}

function aggregate(rows: Row[], defs: MetricDef[]) {
  const out: Record<string, number | null> = {};
  const nullCounts: Record<string, number> = {};

  for (const d of defs) {
    if (d.fn === "count") {
      out.count = rows.length;
      continue;
    }
    if (!d.field) {
      out[d.key] = null;
      continue;
    }
    if (d.fn === "distinct" || d.fn === "distinct_count") {
      out[d.key] = new Set(rows.map((r) => asText(readField(r, d.field!))).filter(Boolean)).size;
      continue;
    }

    const vals: number[] = [];
    let nulls = 0;
    for (const r of rows) {
      const n = asNumber(readField(r, d.field));
      if (n == null) nulls++;
      else vals.push(n);
    }
    nullCounts[d.field] = nulls;

    if (!vals.length) {
      out[d.key] = null;
      continue;
    }
    const sum = vals.reduce((a, b) => a + b, 0);
    out[d.key] =
      d.fn === "sum" ? Math.round(sum * 100) / 100
      : d.fn === "avg" || d.fn === "mean" ? Math.round((sum / vals.length) * 100) / 100
      : d.fn === "min" ? Math.min(...vals)
      : d.fn === "max" ? Math.max(...vals)
      : d.fn === "median" ? median(vals)
      : Math.round(sum * 100) / 100;
  }

  return { out, nullCounts };
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/* -------------------------------------------------------------------- main */

export type QueryResult = {
  board: string;
  scanned: number;
  matched: number;
  timeframe?: string;
  filters_applied: Filter[];
  resolved_values?: Array<Record<string, unknown>>;
  totals: Record<string, number | null>;
  groups?: Array<Record<string, unknown>>;
  rows?: Array<Record<string, unknown>>;
  caveats: string[];
};

/**
 * The model may name a field by its monday column title ("Masked Deal value").
 * When that column is mapped, translate to the canonical field so comparisons
 * run on PARSED values (numbers, ISO dates) instead of raw cell text.
 */
function toCanonicalField(ds: Dataset, field: string | undefined): string | undefined {
  if (!field) return field;
  const f = field.trim();
  if (ds.mapping.some((m) => m.field === f)) return f;
  const byTitle = ds.mapping.find((m) => m.columnTitle.toLowerCase() === f.toLowerCase());
  return byTitle ? byTitle.field : f;
}

export function runQuery(ds: Dataset, spec: QuerySpec): QueryResult {
  const caveats: string[] = [];
  const resolved: Array<Record<string, unknown>> = [];
  const filters: Filter[] = (spec.filters ?? []).map((f) => ({ ...f, field: toCanonicalField(ds, f.field) ?? f.field }));
  spec = {
    ...spec,
    date_field: toCanonicalField(ds, spec.date_field),
    group_by: toCanonicalField(ds, spec.group_by),
    metrics: spec.metrics?.map((m) => {
      const [fn, field] = m.split(":").map((x) => x.trim());
      return field ? `${fn}:${toCanonicalField(ds, field)}` : fn;
    }),
  };

  // Timeframe -> a between filter on the most sensible date field.
  const tf = resolveTimeframe(spec.timeframe);
  if (spec.timeframe && !tf) caveats.push(`Could not interpret the timeframe "${spec.timeframe}"; no date filter was applied.`);

  if (tf) {
    const has = (f: string) => ds.mapping.some((m) => m.field === f);
    const fallback = ds.key === "deals" ? ["close_date", "created_date", "actual_close_date"] : ["end_date", "start_date", "po_date"];
    const dateField = spec.date_field && has(spec.date_field) ? spec.date_field : fallback.find(has);

    if (dateField) {
      filters.push({ field: dateField, op: "between", value: `${tf.from},${tf.to}` });
      if (spec.date_field && spec.date_field !== dateField) caveats.push(`This board has no "${spec.date_field}"; the timeframe was applied to "${dateField}" instead.`);
      const blank = ds.rows.filter((r) => r.f[dateField] == null).length;
      if (blank) caveats.push(`${blank} of ${ds.rowCount} rows have no ${dateField.replace(/_/g, " ")}, so they cannot fall inside ${tf.label} and are excluded.`);
    } else {
      caveats.push("This board has no usable date column, so the timeframe filter was skipped.");
    }
  }

  for (const f of filters) {
    const known = ds.mapping.some((m) => m.field === f.field) || ds.rows.some((r) => readField(r, f.field) != null);
    if (!known) caveats.push(`Filter on "${f.field}" matched no column on this board, so it removed every row. Available fields: ${ds.mapping.map((m) => m.field).join(", ")}.`);
  }

  const prepared = prepare(ds, filters, resolved, caveats);
  const matchedRows = ds.rows.filter((r) => prepared.every((p) => matches(r, p)));
  const defs = parseMetrics(spec.metrics);
  const { out: totals, nullCounts } = aggregate(matchedRows, defs);

  for (const [field, n] of Object.entries(nullCounts)) {
    if (n > 0) caveats.push(`${n} of ${matchedRows.length} matched rows have no "${field}" value; they are excluded from sums and averages on that field.`);
  }

  // Quantities keep their unit in a sibling field, so a sum silently adds
  // hectares to acres to bare counts. The number is still returned - refusing
  // would be worse than reporting - but it must not be read as one quantity.
  for (const d of defs) {
    if ((d.fn !== "sum" && d.fn !== "average") || !d.field) continue;
    const field = d.field;
    const units = new Set<string>();
    for (const r of matchedRows) {
      if (readField(r, field) == null) continue;
      const u = readField(r, `${field}_unit`);
      units.add(u == null || u === "" ? "(no unit)" : String(u));
    }
    if (units.size > 1) {
      caveats.push(
        `"${field}" is recorded in more than one unit (${[...units].sort().join(", ")}), so this ${d.fn} adds quantities that are not the same measure. Group by ${field}_unit for a total that means something.`,
      );
    }
  }

  const result: QueryResult = {
    board: `${ds.board.name} (${ds.key})`,
    scanned: ds.rowCount,
    matched: matchedRows.length,
    ...(tf ? { timeframe: tf.label } : {}),
    filters_applied: filters,
    ...(resolved.length ? { resolved_values: resolved } : {}),
    totals,
    caveats,
  };

  if (spec.group_by) {
    // Bucket on a normalized key (companyKey for clients) so spelling and case
    // variants merge - the data-quality warning promises exactly that. The
    // most frequent original spelling becomes the displayed label.
    const isClient = spec.group_by === "client";
    const buckets = new Map<string, { rows: Row[]; labels: Map<string, number> }>();
    for (const r of matchedRows) {
      const v = readField(r, spec.group_by);
      const text = v == null || v === "" ? null : String(v);
      const key = text == null ? "(blank)" : (isClient ? companyKey(text) : normKey(text)) || "(blank)";
      if (!buckets.has(key)) buckets.set(key, { rows: [], labels: new Map() });
      const b = buckets.get(key)!;
      b.rows.push(r);
      const label = text ?? "(blank)";
      b.labels.set(label, (b.labels.get(label) ?? 0) + 1);
    }

    let groups = [...buckets.entries()].map(([key, b]) => {
      const label = key === "(blank)" ? "(blank)" : [...b.labels.entries()].sort((x, y) => y[1] - x[1])[0][0];
      return { [spec.group_by!]: label, ...aggregate(b.rows, defs).out };
    });

    // Each group's share of the whole, computed here so the model never has to
    // divide. Shares are named after the metric they measure: a bare
    // "share_pct" next to both a count and a sum is ambiguous, and reading the
    // value share as a count share is a wrong answer the grounding gate cannot
    // catch, because the figure genuinely came from a tool.
    const shareOf = defs.filter((d) => d.fn === "sum" || d.fn === "count");
    for (const d of shareOf) {
      const whole = groups.reduce((n, g) => n + (Number(g[d.key]) || 0), 0);
      if (whole <= 0) continue;
      const label = d.fn === "count" ? "share_of_count_pct" : `share_of_${d.key}_pct`;
      for (const g of groups) g[label] = Math.round(((Number(g[d.key]) || 0) / whole) * 1000) / 10;
    }

    // Accept "sum:value desc" as well as "sum_value desc"; fall back to text
    // comparison when the key is not numeric, so sorting never no-ops.
    const sortKey = ((spec.sort || "").replace(/\s*(desc|asc)$/i, "").trim() || defs.find((d) => d.fn !== "count")?.key || "count").replace(":", "_");
    const ascending = /asc$/i.test(spec.sort || "");
    const dir = ascending ? -1 : 1;
    groups.sort((a, b) => {
      // Fall back to the group label only when the sort key is absent
      // entirely; a null metric sorts as 0, not as its label.
      const has = sortKey in a || sortKey in b;
      const av = has ? a[sortKey] : a[spec.group_by!];
      const bv = has ? b[sortKey] : b[spec.group_by!];
      const an = Number(av ?? 0);
      const bn = Number(bv ?? 0);
      if (Number.isFinite(an) && Number.isFinite(bn)) return dir * (bn - an);
      return dir * String(bv ?? "").localeCompare(String(av ?? ""));
    });
    if (spec.limit) groups = groups.slice(0, spec.limit);
    result.groups = groups;

    // A total carried by one group is not a typical figure, and reporting it
    // without saying so is misleading - Tender is 77% of open pipeline value
    // on four deals.
    // Check EVERY share, not just the first metric: four deals can be a
    // trivial share of rows and a dominant share of value, and it is the
    // dominant one that makes a headline unrepresentative. Value shares are
    // reported first because that is the concentration a founder cares about.
    const shareKeys = shareOf
      .map((d) => (d.fn === "count" ? "share_of_count_pct" : `share_of_${d.key}_pct`))
      .sort((a, b) => (a === "share_of_count_pct" ? 1 : 0) - (b === "share_of_count_pct" ? 1 : 0));

    if (groups.length >= 3) {
      for (const key of shareKeys) {
        const top = [...groups].sort((a, b) => Number(b[key] ?? 0) - Number(a[key] ?? 0))[0];
        const share = Number(top?.[key] ?? 0);
        if (share < 50) continue;
        caveats.push(
          `"${top[spec.group_by!]}" alone is ${share}% of the total by ${key.replace(/^share_of_|_pct$/g, "").replace(/_/g, " ")} ${top.count === undefined ? "" : ` across ${top.count} row(s)`}; the headline figure is concentrated in one group rather than typical of the whole.`,
        );
        break; // one is enough; more is noise
      }
    }

    // Shares are of the WHOLE, so a truncated list will not add up to 100.
    if (spec.limit && buckets.size > spec.limit && shareKeys.length) {
      caveats.push(`Showing the top ${spec.limit} of ${buckets.size} groups; shares are of the full total, so the rows shown do not add to 100%.`);
    }

    // Deal names repeat across unrelated records (one appears 27 times), so
    // grouping by them merges rows that have nothing to do with each other.
    if (spec.group_by === "deal_name" || spec.group_by === "name") {
      const merged = [...buckets.values()].filter((b) => b.rows.length > 1).length;
      if (merged) {
        caveats.push(
          `Deal names are not unique on this board: ${merged} of ${buckets.size} groups merge more than one record. Group by client for per-account figures, or return rows for individual deals.`,
        );
      }
    }

    const blanks = buckets.get("(blank)")?.rows.length ?? 0;
    if (blanks) caveats.push(`${blanks} matched rows have no "${spec.group_by}" value and are shown as "(blank)".`);
  }

  if (spec.return_rows || (!spec.group_by && matchedRows.length <= 25)) {
    const cols = ds.mapping.map((m) => m.field);
    const cap = spec.limit ?? 25;

    // Sort the rows too, not only groups. "The eight largest open deals" asked
    // for sort:"value desc" and used to get the first eight in board order.
    let ordered = matchedRows;
    if (spec.sort) {
      const raw = spec.sort.replace(/\s*(desc|asc)$/i, "").trim();
      // Accept the metric spelling ("sum_value" / "sum:value") as the field.
      const field = toCanonicalField(ds, raw.replace(/^(sum|avg|min|max|median|count|distinct)[_:]/, "")) ?? raw;
      const dir = /asc$/i.test(spec.sort) ? -1 : 1;
      ordered = [...matchedRows].sort((a, b) => {
        const av = readField(a, field);
        const bv = readField(b, field);
        const an = asNumber(av);
        const bn = asNumber(bv);

        if (an != null && bn != null) return dir * (bn - an);

        // Not numeric: compare as text, which is what a name or an ISO date
        // needs. Empty values sink whichever way the sort runs.
        const as = av == null || av === "" ? null : String(av);
        const bs = bv == null || bv === "" ? null : String(bv);
        if (as == null && bs == null) return 0;
        if (as == null) return 1;
        if (bs == null) return -1;
        return dir * bs.localeCompare(as, undefined, { numeric: true });
      });
    }

    result.rows = ordered.slice(0, cap).map((r) => {
      const o: Record<string, unknown> = { item: r.name };
      for (const c of cols) if (r.f[c] != null) o[c] = r.f[c];
      if (r.issues.length) o._issues = r.issues.slice(0, 3);
      return o;
    });
    if (matchedRows.length > cap) caveats.push(`Showing ${cap} of ${matchedRows.length} matched rows.`);
  }

  return result;
}

export { readField };
