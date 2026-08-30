/**
 * Deterministic filter / group / aggregate engine.
 *
 * The model chooses WHAT to compute; this file computes it. No number in an
 * answer is ever produced by the language model itself.
 */

import { companyKey } from "./normalize";
import type { Dataset, Row } from "./store";

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
  const m = now.getUTCMonth(); // 0-11
  const mk = (a: Date, b: Date, label: string) => ({ from: iso(a), to: iso(b), label });
  const U = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd));

  const rel = p.match(/(?:last|past|previous)\s+(\d+)\s*(day|week|month|quarter|year)s?/);
  if (rel) {
    const n = Number(rel[1]);
    const mult = { day: 1, week: 7, month: 30, quarter: 91, year: 365 }[rel[2] as "day"];
    const from = new Date(now.getTime() - n * mult * 86400000);
    return mk(from, now, `last ${n} ${rel[2]}${n > 1 ? "s" : ""} (${iso(from)} to ${iso(now)})`);
  }

  // Indian financial year: 1 Apr - 31 Mar
  const fy = p.match(/\bfy\s*'?(\d{2,4})\b/) || p.match(/financial year\s*'?(\d{2,4})/);
  if (fy) {
    const raw = Number(fy[1]);
    const start = raw < 100 ? 2000 + raw : raw;
    return mk(U(start, 3, 1), U(start + 1, 2, 31), `FY${String(start).slice(-2)}-${String(start + 1).slice(-2)} (1 Apr ${start} to 31 Mar ${start + 1})`);
  }
  if (/\b(this|current)\s+(financial year|fy)\b/.test(p)) {
    const start = m >= 3 ? y : y - 1;
    return mk(U(start, 3, 1), U(start + 1, 2, 31), `current financial year (1 Apr ${start} to 31 Mar ${start + 1})`);
  }

  const qExplicit = p.match(/\bq([1-4])\s*(?:of\s*)?'?(\d{4})?\b/);
  if (qExplicit) {
    const q = Number(qExplicit[1]);
    const yy = qExplicit[2] ? Number(qExplicit[2]) : y;
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
  if (/\b(next)\s+quarter\b/.test(p)) {
    const q = Math.floor(m / 3) + 1;
    const yy = q > 3 ? y + 1 : y;
    const qq = q > 3 ? 0 : q;
    return mk(U(yy, qq * 3, 1), U(yy, qq * 3 + 3, 0), `next calendar quarter, Q${qq + 1} ${yy}`);
  }
  if (/\b(this|current)\s+month\b/.test(p)) return mk(U(y, m, 1), U(y, m + 1, 0), `this month (${iso(U(y, m, 1))} to ${iso(U(y, m + 1, 0))})`);
  if (/\blast\s+month\b/.test(p)) return mk(U(y, m - 1, 1), U(y, m, 0), `last month`);
  if (/\b(this|current)\s+(year)\b|\bytd\b|year to date/.test(p)) return mk(U(y, 0, 1), now, `year to date (1 Jan ${y} to ${iso(now)})`);
  if (/\blast\s+year\b/.test(p)) return mk(U(y - 1, 0, 1), U(y - 1, 11, 31), `${y - 1}`);

  const yr = p.match(/^(\d{4})$/);
  if (yr) return mk(U(Number(yr[1]), 0, 1), U(Number(yr[1]), 11, 31), `calendar ${yr[1]}`);

  const range = p.match(/(\d{4}-\d{2}-\d{2})\s*(?:to|\.\.|-)\s*(\d{4}-\d{2}-\d{2})/);
  if (range) return { from: range[1], to: range[2], label: `${range[1]} to ${range[2]}` };

  if (/\b(open|all|any|ever|overall|total)\b/.test(p)) return null;
  return null;
}

/* ------------------------------------------------------------ field access */

/** Accepts a canonical field key, a monday column title, or "name". */
function readField(row: Row, field: string): string | number | null {
  const f = field.trim();
  if (!f) return null;
  if (f === "name" || f === "item" || f === "item name") return row.name || null;
  if (f in row.f) return row.f[f];

  const lower = f.toLowerCase();
  for (const key of Object.keys(row.raw)) {
    if (key.toLowerCase() === lower) return row.raw[key];
  }
  for (const key of Object.keys(row.raw)) {
    if (key.toLowerCase().includes(lower)) return row.raw[key];
  }
  return null;
}

function asNumber(v: string | number | null): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const asText = (v: string | number | null) => (v == null ? "" : String(v).toLowerCase().trim());

/* ---------------------------------------------------------------- filtering */

function matches(row: Row, f: Filter): boolean {
  const raw = readField(row, f.field);
  const op = (f.op || "eq").toLowerCase();
  const want = f.value ?? "";

  if (op === "is_empty" || op === "is_null") return raw == null || raw === "";
  if (op === "not_empty" || op === "not_null") return raw != null && raw !== "";
  if (raw == null || raw === "") return false;

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
      return !w.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).some((v) => text === v);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = asNumber(raw);
      const b = Number(w);
      if (a == null || !Number.isFinite(b)) {
        // fall back to lexicographic comparison, which is correct for ISO dates
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
      d.fn === "sum" ? sum
      : d.fn === "avg" || d.fn === "mean" ? Math.round((sum / vals.length) * 100) / 100
      : d.fn === "min" ? Math.min(...vals)
      : d.fn === "max" ? Math.max(...vals)
      : d.fn === "median" ? median(vals)
      : sum;
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
  totals: Record<string, number | null>;
  groups?: Array<Record<string, unknown>>;
  rows?: Array<Record<string, unknown>>;
  caveats: string[];
};

export function runQuery(ds: Dataset, spec: QuerySpec): QueryResult {
  const caveats: string[] = [];
  const filters: Filter[] = [...(spec.filters ?? [])];

  // Timeframe -> a between filter on the most sensible date field.
  const tf = resolveTimeframe(spec.timeframe);
  if (spec.timeframe && !tf) caveats.push(`Could not interpret the timeframe "${spec.timeframe}"; no date filter was applied.`);
  if (tf) {
    const dateField =
      spec.date_field ||
      (ds.key === "deals" ? (ds.mapping.some((m) => m.field === "close_date") ? "close_date" : "created_date") : ds.mapping.some((m) => m.field === "end_date") ? "end_date" : "start_date");

    if (ds.mapping.some((m) => m.field === dateField)) {
      filters.push({ field: dateField, op: "between", value: `${tf.from},${tf.to}` });
      const blank = ds.rows.filter((r) => r.f[dateField] == null).length;
      if (blank) caveats.push(`${blank} of ${ds.rowCount} rows have no ${dateField.replace("_", " ")}, so they cannot fall inside ${tf.label} and are excluded.`);
    } else {
      caveats.push(`This board has no usable "${dateField.replace("_", " ")}" column, so the timeframe filter was skipped.`);
    }
  }

  // Warn when a filter targets a field this board does not have.
  for (const f of filters) {
    const known = ds.mapping.some((m) => m.field === f.field) || ds.rows.some((r) => readField(r, f.field) != null);
    if (!known) caveats.push(`Filter on "${f.field}" matched no column on this board; it removed every row. Available fields: ${ds.mapping.map((m) => m.field).join(", ")}.`);
  }

  const matchedRows = ds.rows.filter((r) => filters.every((f) => matches(r, f)));
  const defs = parseMetrics(spec.metrics);
  const { out: totals, nullCounts } = aggregate(matchedRows, defs);

  for (const [field, n] of Object.entries(nullCounts)) {
    if (n > 0) caveats.push(`${n} of ${matchedRows.length} matched rows have no "${field}" value; they are excluded from sums and averages on that field.`);
  }

  const result: QueryResult = {
    board: `${ds.board.name} (${ds.key})`,
    scanned: ds.rowCount,
    matched: matchedRows.length,
    ...(tf ? { timeframe: tf.label } : {}),
    filters_applied: filters,
    totals,
    caveats,
  };

  if (spec.group_by) {
    const buckets = new Map<string, Row[]>();
    for (const r of matchedRows) {
      const v = readField(r, spec.group_by);
      const key = spec.group_by === "client" ? (companyKey(String(v ?? "")) ? String(v) : "(blank)") : v == null || v === "" ? "(blank)" : String(v);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(r);
    }

    let groups = [...buckets.entries()].map(([key, rs]) => ({ [spec.group_by!]: key, ...aggregate(rs, defs).out }));
    const sortKey = (spec.sort || "").replace(/\s*(desc|asc)$/i, "").trim() || defs.find((d) => d.fn !== "count")?.key || "count";
    const dir = /asc$/i.test(spec.sort || "") ? 1 : -1;
    groups.sort((a, b) => ((Number(b[sortKey] ?? 0) - Number(a[sortKey] ?? 0)) * (dir === 1 ? -1 : 1)));
    if (spec.limit) groups = groups.slice(0, spec.limit);
    result.groups = groups;

    const blanks = buckets.get("(blank)")?.length ?? 0;
    if (blanks) caveats.push(`${blanks} matched rows have no "${spec.group_by}" value and are shown as "(blank)".`);
  }

  if (spec.return_rows || (!spec.group_by && matchedRows.length <= 30)) {
    const cols = ds.mapping.map((m) => m.field);
    result.rows = matchedRows.slice(0, spec.limit ?? 25).map((r) => {
      const o: Record<string, unknown> = { item: r.name };
      for (const c of cols) if (r.f[c] != null) o[c] = r.f[c];
      if (r.issues.length) o._issues = r.issues;
      return o;
    });
    if (matchedRows.length > (spec.limit ?? 25)) caveats.push(`Showing ${spec.limit ?? 25} of ${matchedRows.length} matched rows.`);
  }

  return result;
}

export { readField };
