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

/* -------------------------------------------------------------------- out */

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  x  ${f}\n`);
  process.exit(1);
}
console.log("  All deterministic checks passed.\n");
