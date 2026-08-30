/**
 * Self-test for the deterministic layer: parsing, term resolution, and the
 * filter/group/aggregate engine. No network, no API keys.
 *
 *   npm run selftest
 */

import {
  companyKey,
  conceptOf,
  DEAL_STAGE_CONCEPTS,
  DEAL_STATUS_CONCEPTS,
  detectDayOrder,
  expandTerm,
  INVOICE_CONCEPTS,
  isBlank,
  normKey,
  parseDate,
  parseNumber,
  parseQuantity,
  SECTOR_CONCEPTS,
  WORK_STATUS_CONCEPTS,
} from "../src/lib/normalize";
import { appendMissingCaveats, checkGrounding, correctionPrompt, materialCaveats, numbersIn, numbersInProse } from "../src/lib/grounding";
import { deriveFollowUps } from "../src/lib/followups";
import { resolveTimeframe, runQuery } from "../src/lib/query";
import type { Dataset, Row } from "../src/lib/store";

let pass = 0;
const failures: string[] = [];

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${label}\n     expected ${e}\n     actual   ${a}`);
}

/* ------------------------------------------------------------------ dates */

check("ISO date", parseDate("2026-07-15").value, "2026-07-15");
check("slash day-first", parseDate("15/07/2026", "dmy").value, "2026-07-15");
check("slash month-first", parseDate("07/15/2026", "mdy").value, "2026-07-15");
check("day > 12 overrides order", parseDate("25/03/2026", "mdy").value, "2026-03-25");
check("dd-Mon-yyyy", parseDate("15-Jul-2026").value, "2026-07-15");
check("Mon dd, yyyy", parseDate("Jul 15, 2026").value, "2026-07-15");
check("full month name", parseDate("15 September 2026").value, "2026-09-15");
check("two-digit year", parseDate("15/07/26", "dmy").value, "2026-07-15");
check("quarter", parseDate("Q3 2026").value, "2026-07-01");
check("month only", parseDate("Jul 2026").value, "2026-07-01");
check("excel serial", parseDate("46218").value, "2026-07-15");
check("blank", parseDate("").value, null);
check("N/A", parseDate("N/A").value, null);
check("garbage flagged", parseDate("sometime soon").value, null);
check("31 Feb rejected", parseDate("31/02/2026", "dmy").value, null);
// The billing-month columns hold bare month names with no year.
check("bare month name is not a date", parseDate("July").value, null);
check("bare month name explains itself", typeof parseDate("July").note, "string");

check("column day-first detected", detectDayOrder(["03/04/2026", "25/12/2026"]), { order: "dmy", ambiguous: false });
check("column month-first detected", detectDayOrder(["04/03/2026", "12/25/2026"]), { order: "mdy", ambiguous: false });
check("column genuinely ambiguous", detectDayOrder(["03/04/2026", "05/06/2026"]), { order: "dmy", ambiguous: true });

/* ---------------------------------------------------------------- numbers */

check("indian grouping", parseNumber("12,00,000").value, 1200000);
check("currency symbol", parseNumber("Rs 45,000").value, 45000);
check("dollar millions", parseNumber("$1.2M").value, 1200000);
check("thousands suffix", parseNumber("45k").value, 45000);
check("lakhs", parseNumber("12 lakhs").value, 1200000);
check("crore", parseNumber("1.5 Cr").value, 15000000);
check("accounting negative", parseNumber("(5000)").value, -5000);
check("plain decimal", parseNumber("1234.56").value, 1234.56);
check("masked fractional value", parseNumber("1.2332").value, 1.2332);
check("blank number", parseNumber("-").value, null);
check("TBD", parseNumber("TBD").value, null);
check("unparseable flagged", typeof parseNumber("ask sales").note, "string");

/* -------------------------------------------------------------- quantities */

check("quantity with unit", parseQuantity("5360 HA"), { value: 5360, unit: "HA", note: '"5360 HA" is 5360 in units of "HA"' });
check("quantity, no space", parseQuantity("3956HA").value, 3956);
check("quantity in months", parseQuantity("24 Months").unit, "Months");
check("bare quantity", parseQuantity("1"), { value: 1, unit: null });
check("negative balance", parseQuantity("-1309.85").value, -1309.85);
check("prose quantity rejected", parseQuantity("Rate based on MW slabs").value, null);
check("prose quantity flagged", typeof parseQuantity("NA . Verbal confirmation for 59 km").note, "string");

/* ---------------------------------------- concepts and term resolution */

// The boards use Skylark's wording; concepts exist only to map the user onto it.
const BOARD_SECTORS = ["Renewables", "Mining", "Railways", "Others", "Powerline", "Construction", "DSP", "Tender", "Manufacturing", "Security and Surveillance", "Aviation"];

check("energy resolves to the board's energy values", expandTerm("energy", BOARD_SECTORS, SECTOR_CONCEPTS), { matched: ["Renewables", "Powerline"], via: "concept" });
check("solar also lands on Renewables", expandTerm("solar", BOARD_SECTORS, SECTOR_CONCEPTS)?.matched, ["Renewables", "Powerline"]);
check("exact board value wins", expandTerm("Mining", BOARD_SECTORS, SECTOR_CONCEPTS), { matched: ["Mining"], via: "exact" });
check("case-insensitive exact", expandTerm("mining", BOARD_SECTORS, SECTOR_CONCEPTS)?.via, "exact");
check("rail resolves to Railways", expandTerm("rail", BOARD_SECTORS, SECTOR_CONCEPTS)?.matched, ["Railways"]);
check("infrastructure covers rail + construction", expandTerm("infrastructure", BOARD_SECTORS, SECTOR_CONCEPTS)?.matched, ["Railways", "Construction"]);
check("unknown sector resolves to nothing", expandTerm("banking", BOARD_SECTORS, SECTOR_CONCEPTS), null);

const BOARD_STAGES = ["A. Lead Generated", "B. Sales Qualified Leads", "C. Demo Done", "E. Proposal/Commercials Sent", "F. Negotiations", "G. Project Won", "H. Work Order Received", "L. Project Lost", "M. Projects On Hold", "Project Completed"];
check("negotiation finds the lettered stage", expandTerm("negotiation", BOARD_STAGES, DEAL_STAGE_CONCEPTS)?.matched, ["F. Negotiations"]);
check("proposal finds the lettered stage", expandTerm("proposal", BOARD_STAGES, DEAL_STAGE_CONCEPTS)?.matched, ["E. Proposal/Commercials Sent"]);
// Precedence is exact -> substring -> concept, so a literal word the board
// actually contains wins over a conceptual expansion. "lead" therefore also
// picks up "Sales Qualified Leads"; the result reports what it matched.
check("lead matches every stage containing the word", expandTerm("lead", BOARD_STAGES, DEAL_STAGE_CONCEPTS), { matched: ["A. Lead Generated", "B. Sales Qualified Leads"], via: "substring" });
check("lost finds the lettered stage", expandTerm("lost", BOARD_STAGES, DEAL_STAGE_CONCEPTS)?.matched, ["L. Project Lost"]);

check("pipeline means the Open status", expandTerm("pipeline", ["Open", "Won", "Dead", "On Hold"], DEAL_STATUS_CONCEPTS)?.matched, ["Open"]);
check("lost means the Dead status", expandTerm("lost", ["Open", "Won", "Dead", "On Hold"], DEAL_STATUS_CONCEPTS)?.matched, ["Dead"]);

const BOARD_WO_STATUS = ["Completed", "Ongoing", "Executed until current month", "Not Started", "Pause / struck", "Partial Completed", "Details pending from Client"];
check("in progress covers ongoing + executed", expandTerm("in progress", BOARD_WO_STATUS, WORK_STATUS_CONCEPTS)?.matched, ["Ongoing", "Executed until current month"]);
check("'Partial Completed' is not plain Completed", conceptOf("Partial Completed", WORK_STATUS_CONCEPTS), "Partially Complete");
check("'Pause / struck' is on hold", conceptOf("Pause / struck", WORK_STATUS_CONCEPTS), "On Hold");
check("'Details pending from Client' is waiting", conceptOf("Details pending from Client", WORK_STATUS_CONCEPTS), "Waiting on Client");
check("unbilled finds 'Not billed yet'", expandTerm("unbilled", ["Fully Billed", "Partially Billed", "Not billed yet", "Stuck"], INVOICE_CONCEPTS)?.matched, ["Not billed yet"]);

check("company key strips suffixes", companyKey("Adani Green Pvt. Ltd."), companyKey("adani green"));
check("company key keeps identity", companyKey("Tata Power") === companyKey("Adani Green"), false);
check("blank detection", [isBlank(""), isBlank("N/A"), isBlank("0")], [true, true, false]);
check("NONE is a real value, not a blank", isBlank("NONE"), false);
check("normKey folds case and spacing", normKey("  Not  Started "), "not started");

/* -------------------------------------------------------------- timeframe */

const aug = new Date(Date.UTC(2026, 7, 15)); // 15 Aug 2026
check("this quarter", resolveTimeframe("this quarter", aug)?.from, "2026-07-01");
check("last quarter", resolveTimeframe("last quarter", aug)?.from, "2026-04-01");
check("explicit quarter", resolveTimeframe("Q1 2026", aug)?.to, "2026-03-31");
check("FY26 is Apr 2025 - Mar 2026", [resolveTimeframe("FY26", aug)?.from, resolveTimeframe("FY26", aug)?.to], ["2025-04-01", "2026-03-31"]);
check("last 90 days", resolveTimeframe("last 90 days", aug)?.to, "2026-08-15");
check("explicit range", resolveTimeframe("2026-01-01 to 2026-03-31", aug)?.from, "2026-01-01");
check("nonsense timeframe", resolveTimeframe("whenever", aug), null);

/* ----------------------------------------------------------- query engine */

const row = (id: string, f: Record<string, string | number | null>): Row => ({
  id,
  name: `Deal ${id}`,
  f,
  raw: { "Item name": `Deal ${id}` },
  issues: [],
});

const rows = [
  row("1", { sector: "Renewables", status: "Open", stage: "E. Proposal/Commercials Sent", value: 100, close_date: "2026-08-20" }),
  row("2", { sector: "Renewables", status: "Won", stage: "G. Project Won", value: 200, close_date: "2026-07-10" }),
  row("3", { sector: "Mining", status: "Open", stage: "E. Proposal/Commercials Sent", value: 300, close_date: "2026-08-01" }),
  row("4", { sector: "Powerline", status: "Open", stage: "F. Negotiations", value: null, close_date: "2026-09-30" }), // null value
  row("5", { sector: null, status: "Open", stage: "A. Lead Generated", value: 50, close_date: null }),                // null sector + date
  row("6", { sector: "Renewables", status: "Dead", stage: "L. Project Lost", value: 999, close_date: "2026-08-05" }),
];

const distinct = (field: string) => {
  const m = new Map<string, { value: string; count: number }>();
  for (const r of rows) {
    const v = r.f[field];
    if (v == null) continue;
    const k = normKey(String(v));
    const hit = m.get(k);
    if (hit) hit.count++;
    else m.set(k, { value: String(v), count: 1 });
  }
  return [...m.values()];
};

const ds: Dataset = {
  key: "deals",
  board: { id: "1", name: "Deal Funnel" },
  rowCount: rows.length,
  droppedRows: 0,
  mapping: [
    { field: "sector", label: "Sector", type: "text", columnId: "c1", columnTitle: "Sector/service", columnType: "text", confidence: 100 },
    { field: "status", label: "Deal status", type: "text", columnId: "c2", columnTitle: "Deal Status", columnType: "text", confidence: 100 },
    { field: "stage", label: "Deal stage", type: "text", columnId: "c5", columnTitle: "Deal Stage", columnType: "text", confidence: 100 },
    { field: "value", label: "Deal value", type: "money", columnId: "c3", columnTitle: "Masked Deal value", columnType: "numbers", confidence: 100 },
    { field: "close_date", label: "Close", type: "date", columnId: "c4", columnTitle: "Tentative Close Date", columnType: "date", confidence: 100 },
  ],
  unmappedColumns: [],
  rows,
  distinct: { sector: distinct("sector"), status: distinct("status"), stage: distinct("stage") },
  quality: { fields: [], warnings: [], duplicateClients: [] },
  fetchedAt: "2026-08-30T00:00:00.000Z",
};

// The headline example from the brief: "pipeline for the energy sector".
const energy = runQuery(ds, {
  filters: [{ field: "sector", op: "eq", value: "energy" }, { field: "status", op: "eq", value: "Open" }],
  metrics: ["count", "sum:value"],
});
check("energy pipeline count", energy.matched, 2);
check("energy pipeline excludes null value", energy.totals.sum_value, 100);
check("resolution is reported back", energy.resolved_values?.[0], { field: "sector", you_asked_for: "energy", board_values_used: ["Renewables", "Powerline"] });
check("null value produces a caveat", energy.caveats.some((c) => c.includes('no "value" value')), true);

const negotiation = runQuery(ds, { filters: [{ field: "stage", op: "eq", value: "negotiation" }], metrics: ["count"] });
check("plain English stage finds the lettered value", negotiation.matched, 1);

const bogusValue = runQuery(ds, { filters: [{ field: "sector", op: "eq", value: "banking" }], metrics: ["count"] });
check("unknown value lists what does exist", bogusValue.caveats.some((c) => c.includes("Renewables")), true);

const bySector = runQuery(ds, { group_by: "sector", metrics: ["count", "sum:value"], sort: "count desc" });
check("groups sorted descending by count", bySector.groups?.map((g) => g.count), [3, 1, 1, 1]);
check("largest group first", (bySector.groups?.[0] as Record<string, unknown>).sector, "Renewables");
check("blank group flagged", bySector.caveats.some((c) => c.includes("(blank)")), true);

const byValue = runQuery(ds, { group_by: "sector", metrics: ["count", "sum:value"], sort: "sum_value asc" });
check("ascending sort works too", byValue.groups?.map((g) => g.sum_value ?? 0), [0, 50, 300, 1299]);

const won = runQuery(ds, { filters: [{ field: "status", op: "eq", value: "Won" }], metrics: ["count", "sum:value"] });
check("won total", [won.matched, won.totals.sum_value], [1, 200]);

const notWon = runQuery(ds, { filters: [{ field: "status", op: "not_in", value: "Won,Dead" }], metrics: ["count"] });
check("not_in negates a resolved set", notWon.matched, 4);

const q3 = runQuery(ds, { timeframe: "Q3 2026", metrics: ["count"] });
check("timeframe filters by close date", q3.matched, 5);
check("timeframe label reported", q3.timeframe, "Q3 2026 (calendar)");
check("missing close dates flagged", q3.caveats.some((c) => c.includes("no close date")), true);

const bogusField = runQuery(ds, { filters: [{ field: "not_a_field", op: "eq", value: "x" }], metrics: ["count"] });
check("unknown field returns nothing but explains why", [bogusField.matched, bogusField.caveats.length > 0], [0, true]);

const empties = runQuery(ds, { filters: [{ field: "value", op: "is_empty" }], metrics: ["count"] });
check("is_empty finds the null", empties.matched, 1);

const stats = runQuery(ds, { filters: [{ field: "sector", op: "eq", value: "Renewables" }], metrics: ["avg:value", "max:value", "distinct:status"] });
check("avg ignores nulls", stats.totals.avg_value, 433);
check("max value", stats.totals.max_value, 999);
check("distinct statuses", stats.totals.distinct_status, 3);

/* ----------------------------------------------- audit regression checks */

// parseNumber: ranges and multi-number cells take the FIRST number, flagged.
check("range takes first number", parseNumber("1,00,000 - 2,00,000").value, 100000);
check("range is flagged", typeof parseNumber("1,00,000 - 2,00,000").note, "string");
check("range with unit", parseNumber("5-10 lakhs").value, 500000);

// parseDate: time suffixes, 2-digit month-years, and the loose fallback.
check("slash date with time keeps day-first", parseDate("13/04/2026 10:30", "dmy").value, "2026-04-13");
check("ambiguous slash date with time honors column order", parseDate("03/04/2026 09:00", "dmy").value, "2026-04-03");
check("Aug-25 is Aug 2025, not 25 Aug 2001", parseDate("Aug-25").value, "2025-08-01");
check("loose fallback rejects nonsense centuries", parseDate("Tue Aug 25 3050").value, null);

// companyKey keeps distinctive words, strips only legal suffixes.
check("Services vs Technologies stay distinct", companyKey("ABC Services") === companyKey("ABC Technologies"), false);
check("legal suffixes still fold", companyKey("Adani Green Pvt. Ltd."), companyKey("Adani Green"));

// Timeframes: FY range notation and 2-digit quarter years.
check("FY 2025-26 range = Apr 2025 start", resolveTimeframe("FY 2025-26", aug)?.from, "2025-04-01");
check("FY 25-26 range = Apr 2025 start", resolveTimeframe("fy 25-26", aug)?.from, "2025-04-01");
check("bare FY26 unchanged", resolveTimeframe("FY26", aug)?.from, "2025-04-01");
check("Q3 25 is 2025", resolveTimeframe("Q3 25", aug)?.from, "2025-07-01");
check("Q3 2026 still works", resolveTimeframe("Q3 2026", aug)?.from, "2026-07-01");

// group_by merges case/spelling variants and labels by majority spelling.
{
  const vRows = [
    row("g1", { sector: "Mining", status: "Open", stage: "A. Lead Generated", value: 10, close_date: null }),
    row("g2", { sector: "mining", status: "Open", stage: "A. Lead Generated", value: 20, close_date: null }),
    row("g3", { sector: "MINING", status: "Open", stage: "A. Lead Generated", value: 30, close_date: null }),
    row("g4", { sector: "Railways", status: "Open", stage: "A. Lead Generated", value: 5, close_date: null }),
  ];
  const vds: Dataset = { ...ds, rows: vRows, rowCount: vRows.length, distinct: {} };
  const g = runQuery(vds, { group_by: "sector", metrics: ["count", "sum:value"], sort: "count desc" });
  check("case variants merge into one group", g.groups?.length, 2);
  check("merged group aggregates all variants", (g.groups?.[0] as Record<string, unknown>).sum_value, 60);
}

// Sorting by a metric written as "fn:field", and by a text key.
{
  const g1 = runQuery(ds, { group_by: "sector", metrics: ["count", "sum:value"], sort: "sum:value desc" });
  check("colon sort key accepted", (g1.groups?.[0] as Record<string, unknown>).sector, "Renewables");
  const g2 = runQuery(ds, { group_by: "sector", metrics: ["count"], sort: "sector asc" });
  const labels = g2.groups?.map((g) => g.sector);
  check("text sort is alphabetical, not a no-op", labels, [...(labels ?? [])].sort((a, b) => String(a).localeCompare(String(b))));
}

// Filtering by the monday column title uses PARSED values.
{
  const t = runQuery(ds, { filters: [{ field: "Masked Deal value", op: "gt", value: "150" }], metrics: ["count"] });
  check("column-title filter hits parsed numbers", t.matched, 3);
}

/* ------------------------------------------- review-round regression checks */

// sort must order ROW lists, not only groups: "the largest open deals" was
// returning the first N in board order.
{
  const byValue = runQuery(ds, { filters: [{ field: "value", op: "not_empty" }], return_rows: true, limit: 4, sort: "value desc" });
  check("row lists honour sort desc", byValue.rows?.map((r) => r.value), [999, 300, 200, 100]);
  const asc = runQuery(ds, { filters: [{ field: "value", op: "not_empty" }], return_rows: true, limit: 4, sort: "value asc" });
  check("row lists honour sort asc", asc.rows?.map((r) => r.value), [50, 100, 200, 300]);
  // The metric spelling a caller would naturally reach for must work too.
  const metricSpelling = runQuery(ds, { filters: [{ field: "value", op: "not_empty" }], return_rows: true, limit: 2, sort: "sum_value desc" });
  check("row sort accepts the metric spelling", metricSpelling.rows?.map((r) => r.value), [999, 300]);
  // Rows with no value sink rather than sorting as zero at the top.
  const withNulls = runQuery(ds, { return_rows: true, limit: 6, sort: "value desc" });
  check("rows missing the sort field sink", (withNulls.rows?.at(-1) as Record<string, unknown> | undefined)?.value, undefined);
}

// deal_name is the monday ITEM name, not a column - a filter on it must bind.
{
  const named = runQuery(ds, { filters: [{ field: "deal_name", op: "contains", value: "Deal 1" }], metrics: ["count"] });
  check("deal_name resolves to the item name", named.matched, 1);
  const empty = runQuery(ds, { filters: [{ field: "deal_name", op: "not_empty" }], metrics: ["count"] });
  check("deal_name is populated for every row", empty.matched, 6);
}

// A total carried by one group is flagged rather than reported as typical.
{
  const lopsided = [
    row("c1", { sector: "Tender", status: "Open", stage: "A. Lead Generated", value: 900, close_date: null }),
    row("c2", { sector: "Mining", status: "Open", stage: "A. Lead Generated", value: 60, close_date: null }),
    row("c3", { sector: "Railways", status: "Open", stage: "A. Lead Generated", value: 40, close_date: null }),
  ];
  const lds: Dataset = { ...ds, rows: lopsided, rowCount: 3, distinct: {} };
  const g = runQuery(lds, { group_by: "sector", metrics: ["count", "sum:value"], sort: "sum_value desc" });
  check("dominant group carries a value share", (g.groups?.[0] as Record<string, unknown>).share_of_sum_value_pct, 90);
  check("concentration is caveated", g.caveats.some((c) => c.includes("concentrated in one group")), true);
  // Four big deals can be a small share of ROWS and a huge share of VALUE.
  // Each share is named after the metric it measures so the two cannot be
  // confused - a wrong reading here would pass the grounding gate.
  const both = runQuery(lds, { group_by: "sector", metrics: ["count", "sum:value"], sort: "sum_value desc" });
  const tender = both.groups?.[0] as Record<string, unknown>;
  check("value share and count share are separate", [tender.share_of_sum_value_pct, tender.share_of_count_pct], [90, 33.3]);
  check("no ambiguous bare share remains", "share_pct" in tender, false);

  const evenRows = [
    row("e1", { sector: "Mining", status: "Open", stage: "A. Lead Generated", value: 100, close_date: null }),
    row("e2", { sector: "Railways", status: "Open", stage: "A. Lead Generated", value: 95, close_date: null }),
    row("e3", { sector: "Renewables", status: "Open", stage: "A. Lead Generated", value: 90, close_date: null }),
  ];
  const eds: Dataset = { ...ds, rows: evenRows, rowCount: 3, distinct: {} };
  const even = runQuery(eds, { group_by: "sector", metrics: ["count", "sum:value"] });
  check("balanced groups are not caveated", even.caveats.some((c) => c.includes("concentrated in one group")), false);
}

/* ------------------------------------------------------ the grounding gate */

{
  const pool = numbersIn({ totals: { sum_value: 36291748.87, count: 176 }, groups: [{ client: "A", sum_receivable: 10347676.29 }] });

  check("figures are read out of nested tool payloads", pool.has(36291748.87) && pool.has(176), true);
  check("magnitude suffixes expand", numbersInProse("about 36.3M outstanding"), [36300000]);
  check("ISO dates are not claims", numbersInProse("closing 2026-07-15"), []);

  const clean = checkGrounding("Receivables total **36,291,748.87** across 176 work orders.", pool);
  check("exact figures pass the gate", [clean.checked, clean.clean], [2, true]);

  const rounded = checkGrounding("Receivables are about 36.3M.", pool);
  check("stated magnitudes pass the gate", rounded.clean, true);

  // The real failure: a share the model divided out for itself.
  const derived = checkGrounding("The top client is 28.5% of receivables.", pool);
  check("a self-computed share is caught", derived.clean, false);
  check("and classified as derived, not invented", [derived.derived.length, derived.fabricated.length], [1, 0]);

  const invented = checkGrounding("Pipeline stands at 4,821,006.", pool);
  check("an unsupported figure is fabricated", invented.fabricated.length, 1);

  const fix = correctionPrompt(derived);
  check("the correction names the compute tool", fix.includes("compute"), true);
  // A percentage-shaped miss gets the retrieval recipe, not a generic nudge.
  check("a rate miss gets the share recipe", fix.includes("share_of_count_pct"), true);
  check("a large-magnitude miss does not", correctionPrompt(checkGrounding("Pipeline is 12,484,710.", pool)).includes("share_of_count_pct"), false);
  check("the correction names the offending figure", fix.includes("28.5"), true);

  // Years and list markers must not trip the gate.
  check("years and small ordinals are ignored", checkGrounding("In 2026 the top 3 clients led.", pool).checked, 0);
}

/* --------------------------------------------- round-two review regressions */

{
  const named = [
    row("n1", { sector: "Mining", status: "Open", stage: "A. Lead Generated", value: 10, close_date: "2026-03-01" }),
    row("n2", { sector: "Railways", status: "Open", stage: "A. Lead Generated", value: 20, close_date: "2026-01-01" }),
    row("n3", { sector: "Renewables", status: "Open", stage: "A. Lead Generated", value: 30, close_date: "2026-02-01" }),
  ];
  named[0].name = "Zebra Corp";
  named[1].name = "Alpha Ltd";
  named[2].name = "Mango Co";
  const nds: Dataset = { ...ds, rows: named, rowCount: 3, distinct: {} };

  // Sorting rows by a TEXT field used to be a silent no-op: stripping digits
  // from "Zebra Corp" left "", and Number("") is 0, so everything tied.
  const byName = runQuery(nds, { return_rows: true, sort: "deal_name asc" });
  check("text sort orders alphabetically", byName.rows?.map((r) => r.item), ["Alpha Ltd", "Mango Co", "Zebra Corp"]);
  const byNameDesc = runQuery(nds, { return_rows: true, sort: "deal_name desc" });
  check("text sort reverses", byNameDesc.rows?.map((r) => r.item), ["Zebra Corp", "Mango Co", "Alpha Ltd"]);

  // Dates are text too, and must not collapse to board order.
  const byDate = runQuery(nds, { return_rows: true, sort: "close_date asc" });
  check("date sort is chronological", byDate.rows?.map((r) => r.close_date), ["2026-01-01", "2026-02-01", "2026-03-01"]);

  // With a limit, a broken sort returns the wrong SUBSET - every figure in it
  // grounded, so the grounding gate cannot catch the error.
  const top1 = runQuery(nds, { return_rows: true, limit: 1, sort: "value desc" });
  check("limit keeps the true top row", top1.rows?.map((r) => r.value), [30]);

  // gt/lt fall back to text comparison on purpose - that is what makes ISO
  // date filters work - but a numeric field must still compare numerically.
  check("numeric comparison stays numeric", runQuery(nds, { filters: [{ field: "value", op: "gt", value: "15" }], metrics: ["count"] }).matched, 2);
  check("date comparison uses text ordering", runQuery(nds, { filters: [{ field: "close_date", op: "before", value: "2026-02-15" }], metrics: ["count"] }).matched, 2);

  // Deal names repeat across unrelated records; grouping by them merges rows.
  const dup = [...named, row("n4", { sector: "Mining", status: "Open", stage: "A. Lead Generated", value: 5, close_date: null })];
  dup[3].name = "Zebra Corp";
  const dds: Dataset = { ...ds, rows: dup, rowCount: 4, distinct: {} };
  const grouped = runQuery(dds, { group_by: "deal_name", metrics: ["count"] });
  check("merging non-unique names is caveated", grouped.caveats.some((c) => c.includes("not unique")), true);
}

{
  // A two-way split is not concentration. The win-rate recipe produces exactly
  // two groups, so this fired on the commonest founder question.
  const two = [
    row("t1", { sector: "Mining", status: "Won", stage: "G. Project Won", value: 60, close_date: null }),
    row("t2", { sector: "Mining", status: "Dead", stage: "L. Project Lost", value: 40, close_date: null }),
  ];
  const tds: Dataset = { ...ds, rows: two, rowCount: 2, distinct: {} };
  const split = runQuery(tds, { group_by: "status", metrics: ["count"] });
  check("a two-way split is not flagged as concentrated", split.caveats.some((c) => c.includes("concentrated")), false);
  check("but the shares are still there", (split.groups?.[0] as Record<string, unknown>).share_of_count_pct, 50);

  // Three-plus groups with a dominant one still warn, and never print "?".
  const three = [
    row("u1", { sector: "Tender", status: "Open", stage: "A. Lead Generated", value: 900, close_date: null }),
    row("u2", { sector: "Mining", status: "Open", stage: "A. Lead Generated", value: 60, close_date: null }),
    row("u3", { sector: "Railways", status: "Open", stage: "A. Lead Generated", value: 40, close_date: null }),
  ];
  const uds: Dataset = { ...ds, rows: three, rowCount: 3, distinct: {} };
  const conc = runQuery(uds, { group_by: "sector", metrics: ["sum:value"] });
  const warning = conc.caveats.find((c) => c.includes("concentrated")) ?? "";
  check("three groups with a dominant one still warn", warning.includes("Tender"), true);
  check("no literal question mark for a missing count", warning.includes('"?"') || warning.includes("? row"), false);
}

/* ------------------------------------------------------ the caveat gate */

{
  const sparse = ['179 of 344 matched rows have no "value" value; they are excluded from sums and averages on that field.'];
  const noise = ["Showing 8 of 48 matched rows."];

  check("a rows-excluded caveat is material", materialCaveats(sparse).length, 1);
  check("a display-only caveat is not", materialCaveats(noise).length, 0);

  // An answer that silently drops the caveat gets it back, verbatim.
  const bare = appendMissingCaveats("Total deal value is 2,305,518,040.91.", sparse);
  check("a missing caveat is appended", bare.includes("excluded from sums"), true);
  check("and marked as a footnote", bare.trimEnd().endsWith("*"), true);

  // An answer that already says it is left alone.
  const covered = appendMissingCaveats("Total is 2,305,518,040.91, though 179 rows are blank.", sparse);
  check("an answer that already says it is untouched", covered.includes("excluded from sums"), false);
  const worded = appendMissingCaveats("Total is X, but many values are missing.", sparse);
  check("paraphrase counts as saying it", worded.includes("excluded from sums"), false);
  // A number that happens to appear in both the caveat and the answer is not a
  // disclosure. "344 deals" used to satisfy the 48%-filled caveat because the
  // caveat also carries 344, which silently suppressed the warning.
  const bareNumber = appendMissingCaveats("We have 344 deals worth 2,305,518,040.91 in total.", sparse);
  check("a shared digit run is not a disclosure", bareNumber.includes("excluded from sums"), true);

  // One material caveat disclosed must not excuse a different one.
  const twoKinds = [
    '"Tender" alone is 77.3% of the total by sum value; the headline figure is concentrated in one group rather than typical of the whole.',
    '"Masked Deal value" (value) is only 48% filled - 179 of 344 rows are blank.',
  ];
  const oneSaid = appendMissingCaveats("Tender dominates the total, accounts for most of the value.", twoKinds);
  check("disclosing concentration does not excuse the fill rate", oneSaid.includes("48% filled"), true);
  check("and the disclosed one is not repeated", oneSaid.includes("concentrated in one group"), false);

  // Saying both leaves the answer alone.
  const bothSaid = appendMissingCaveats("Tender dominates the total; the value column is only partly populated, so blanks are excluded.", twoKinds);
  check("saying both leaves the answer untouched", bothSaid.includes("*"), false);

  // Concentration language does not satisfy a missing-data caveat.
  const wrongKind = appendMissingCaveats("Tender is concentrated in one group.", sparse);
  check("concentration wording does not cover missing data", wrongKind.includes("excluded from sums"), true);

    check("nothing is added when nothing is material", appendMissingCaveats("All good.", noise), "All good.");
}

/* ------------------------------------------------------------- follow-ups */

{
  const FB = ["Static one", "Static two", "Static three"];
  const base = { asked: [] as string[], fallback: FB };

  // Reading only the sales board, the useful next question is the delivery one,
  // scoped to whatever the answer was actually about.
  const oneBoard = deriveFollowUps({
    ...base,
    answer: "Renewables leads the pipeline.",
    steps: [{ name: "query_board", trace: { board: "deals", filters: [{ field: "sector", value: "Renewables" }] } }],
  });
  check("a deals-only answer pivots to delivery", oneBoard[0], "How is delivery tracking for Renewables?");

  const woBoard = deriveFollowUps({
    ...base,
    answer: "Railways carries the most work.",
    steps: [{ name: "query_board", trace: { board: "work_orders", filters: [{ field: "sector", value: "Railways" }] } }],
  });
  check("a work-order answer pivots to pipeline", woBoard[0], "What does the pipeline look like for Railways?");

  // Touching both boards leaves nothing to pivot to.
  const both = deriveFollowUps({
    ...base,
    answer: "Compared.",
    steps: [{ name: "query_board", trace: { board: "deals" } }, { name: "query_board", trace: { board: "work_orders" } }],
  });
  check("a cross-board answer proposes no pivot", both.some((q) => q.includes("delivery tracking")), false);

  // A total one group carries is the thing worth interrogating.
  const conc = deriveFollowUps({
    ...base,
    answer: "Tender dominates.",
    steps: [{
      name: "query_board",
      trace: {
        board: "deals",
        groupBy: "sector",
        top: { label: "Tender", metric: "sum_value", value: 532_000_000 },
        caveats: ['"Tender" alone is 77.3% of the total by sum value; the headline figure is concentrated in one group rather than typical of the whole.'],
      },
    }],
  });
  check("concentration becomes a why question", conc.includes("Why does Tender account for so much of that?"), true);

  // A thin column invites a data-quality question that names it.
  const thin = deriveFollowUps({
    ...base,
    answer: "Total is 2.3B.",
    steps: [{ name: "query_board", trace: { board: "deals", caveats: ['"Masked Deal value" (value) is only 48% filled - 179 of 344 rows are blank.'] } }],
  });
  check("a thin column is named in the follow-up", thin.includes("How reliable is the Masked Deal value column?"), true);

  // A word that landed on several board values can be pulled apart.
  const split = deriveFollowUps({
    ...base,
    answer: "Energy is strong.",
    steps: [{ name: "query_board", trace: { board: "deals", resolved: [{ field: "sector", asked: "energy", used: ["Renewables", "Powerline"] }] } }],
  });
  check("a multi-value match offers a split", split.includes("Split Renewables and Powerline out separately."), true);

  // Nothing already asked is offered back.
  const repeat = deriveFollowUps({
    answer: "Renewables leads.",
    steps: [{ name: "query_board", trace: { board: "deals", filters: [{ field: "sector", value: "Renewables" }] } }],
    asked: ["How is delivery tracking for Renewables?"],
    fallback: FB,
  });
  check("an already-asked follow-up is dropped", repeat.includes("How is delivery tracking for Renewables?"), false);

  // With no trace to read, the static list carries it — minus what was asked.
  const bare = deriveFollowUps({ answer: "Hello.", steps: [], asked: ["Static one"], fallback: FB });
  check("no trace falls back to the static list", bare, ["Static two", "Static three"]);

  // Never more than three, and never a duplicate.
  const many = deriveFollowUps({
    ...base,
    answer: "Lots.",
    steps: [{
      name: "query_board",
      trace: {
        board: "deals", groupBy: "sector", timeframe: "FY26",
        top: { label: "Tender", metric: "sum_value", value: 1 },
        resolved: [{ field: "sector", asked: "energy", used: ["Renewables", "Powerline"] }],
        caveats: ['"X" is only 48% filled', '"Tender" alone is 77.3% concentrated in one group'],
      },
    }],
  });
  check("at most three are offered", many.length, 3);
  check("and they are distinct", new Set(many).size, 3);

  // A multi-value filter arrives comma-joined and must read as a sentence.
  const listy = deriveFollowUps({
    ...base,
    answer: "Energy is strong.",
    steps: [{ name: "query_board", trace: { board: "deals", filters: [{ field: "sector", value: "Renewables,Powerline" }] } }],
  });
  check("a comma-joined filter reads as prose", listy[0], "How is delivery tracking for Renewables and Powerline?");

  const listy3 = deriveFollowUps({
    ...base,
    answer: "Several.",
    steps: [{ name: "query_board", trace: { board: "deals", filters: [{ field: "sector", value: "A,B,C,D" }] } }],
  });
  check("a long list is truncated, not recited", listy3[0], "How is delivery tracking for A, B and others?");

  // The engine's null caveat quotes the internal field key, not a column name.
  const internal = deriveFollowUps({
    ...base,
    answer: "Total is 2.3B.",
    steps: [{ name: "query_board", trace: { board: "deals", caveats: ['179 of 344 matched rows have no "value" value; they are excluded from sums and averages on that field.'] } }],
  });
  check("an internal field key is given its plain name", internal.includes("How reliable is the deal value column?"), true);

  // Given both caveat shapes, the one naming the spreadsheet heading wins.
  const bothCaveats = deriveFollowUps({
    ...base,
    answer: "Total is 2.3B.",
    steps: [{ name: "query_board", trace: { board: "deals", caveats: [
      '179 of 344 matched rows have no "value" value; they are excluded from sums and averages on that field.',
      '"Masked Deal value" (value) is only 48% filled - 179 of 344 rows are blank.',
    ] } }],
  });
  check("the spreadsheet heading is preferred", bothCaveats.includes("How reliable is the Masked Deal value column?"), true);

  // Having answered the deals side for Renewables, the pivot must not bounce
  // straight back to it from the work-order answer.
  const bounce = deriveFollowUps({
    ...base,
    answer: "Renewables delivery is on track.",
    steps: [{ name: "query_board", trace: { board: "work_orders", filters: [{ field: "sector", value: "Renewables" }] } }],
    priorSteps: [{ name: "query_board", trace: { board: "deals", filters: [{ field: "sector", value: "Renewables" }] } }],
  });
  check("the pivot does not bounce back to covered ground", bounce.includes("What does the pipeline look like for Renewables?"), false);

  // The same thin column should not be proposed on every turn it appears in.
  const thinCav = '"Masked Deal value" (value) is only 48% filled - 179 of 344 rows are blank.';
  const twice = deriveFollowUps({
    ...base,
    answer: "Another total.",
    steps: [{ name: "query_board", trace: { board: "deals", caveats: [thinCav] } }],
    priorSteps: [{ name: "query_board", trace: { board: "deals", caveats: [thinCav] } }],
  });
  check("a caveat already raised is not raised again", twice.includes("How reliable is the Masked Deal value column?"), false);

  // A genuinely new concentration still earns a question.
  const concCav = (g: string) => `"${g}" alone is 70% of the total by sum value; the headline figure is concentrated in one group rather than typical of the whole.`;
  const fresh = deriveFollowUps({
    ...base,
    answer: "Completed leads.",
    steps: [{ name: "query_board", trace: { board: "work_orders", groupBy: "status", top: { label: "Completed", metric: "count", value: 90 }, caveats: [concCav("Completed")] } }],
    priorSteps: [{ name: "query_board", trace: { board: "deals", groupBy: "sector", top: { label: "Tender", metric: "sum_value", value: 1 }, caveats: [concCav("Tender")] } }],
  });
  check("a new concentration is still surfaced", fresh.includes("Why does Completed account for so much of that?"), true);

  // The drill-down noun follows the board that was actually read.
  const noun = (board: string) => deriveFollowUps({
    ...base,
    answer: "Grouped.",
    steps: [{ name: "query_board", trace: { board, groupBy: "status", top: { label: "Completed", metric: "count", value: 90 } } }],
    priorSteps: [{ trace: { board: board === "deals" ? "work_orders" : "deals" } }],
  });
  check("a work-order answer drills into work orders", noun("work_orders").includes("Which are the largest Completed work orders?"), true);
  check("a deals answer drills into deals", noun("deals").includes("Which are the largest Completed deals?"), true);

  // Only sector and owner exist on both boards. A deals answer grouped by
  // status must not offer "how is delivery tracking for Won" — work orders
  // have no such dimension, so the question is unanswerable.
  const statusTop = deriveFollowUps({
    ...base,
    answer: "Win rate is 56.5%.",
    steps: [{ name: "query_board", trace: { board: "deals", groupBy: "status", top: { label: "Won", metric: "count", value: 165 } } }],
  });
  check("no pivot is scoped by a non-shared dimension", statusTop.some((q) => q.includes("delivery tracking for Won")), false);
  check("it falls back to the unscoped pivot", statusTop.includes("How does that compare with what we are delivering?"), true);

  // Grouping by a shared dimension still scopes the pivot.
  const sectorTop = deriveFollowUps({
    ...base,
    answer: "Renewables leads.",
    steps: [{ name: "query_board", trace: { board: "deals", groupBy: "sector", top: { label: "Renewables", metric: "count", value: 90 } } }],
  });
  check("a shared dimension still scopes the pivot", sectorTop.includes("How is delivery tracking for Renewables?"), true);

  // An answer that ends in a question wants an answer, not a new topic.
  const clarify = deriveFollowUps({
    ...base,
    answer: "Do you mean **won deal value** or **billed work**?",
    steps: [{ name: "query_board", trace: { board: "deals" } }],
  });
  check("a clarifying question offers its own options", clarify, ["Won deal value", "Billed work"]);
}

/* -------------------------------------------------------------------- out */

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  x  ${f}\n`);
  process.exit(1);
}
console.log("  All deterministic checks passed.\n");
