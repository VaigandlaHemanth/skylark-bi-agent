/**
 * Self-test for the deterministic layer: parsing, vocabularies, and the
 * filter/group/aggregate engine. No network, no API keys.
 *
 *   npm run selftest
 */

import {
  canonical,
  companyKey,
  DEAL_STAGES,
  detectDayOrder,
  isBlank,
  parseDate,
  parseNumber,
  SECTORS,
  WORK_STATUSES,
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
check("blank number", parseNumber("-").value, null);
check("TBD", parseNumber("TBD").value, null);
check("unparseable flagged", typeof parseNumber("ask sales").note, "string");

/* ------------------------------------------------------------ vocabulary */

check("energy alias", canonical("energy sector", SECTORS).value, "Energy");
check("solar folds to energy", canonical("Solar EPC", SECTORS).value, "Energy");
check("power folds to energy", canonical("POWER & UTILITIES", SECTORS).value, "Energy");
check("oil and gas", canonical("Oil & Gas", SECTORS).value, "Oil & Gas");
check("unknown sector kept verbatim", canonical("Aerospace", SECTORS), { value: "Aerospace", mapped: false });
check("closed won", canonical("Closed Won", DEAL_STAGES).value, "Won");
check("negotiating", canonical("negotiating", DEAL_STAGES).value, "Negotiation");
check("wip", canonical("WIP", WORK_STATUSES).value, "In Progress");
check("delivered", canonical("Delivered", WORK_STATUSES).value, "Completed");

check("company key strips suffixes", companyKey("Adani Green Pvt. Ltd."), companyKey("adani green"));
check("company key keeps identity", companyKey("Tata Power") === companyKey("Adani Green"), false);
check("blank detection", [isBlank(""), isBlank("N/A"), isBlank("0")], [true, true, false]);

/* -------------------------------------------------------------- timeframe */

const jul = new Date(Date.UTC(2026, 7, 15)); // 15 Aug 2026
check("this quarter", resolveTimeframe("this quarter", jul)?.from, "2026-07-01");
check("last quarter", resolveTimeframe("last quarter", jul)?.from, "2026-04-01");
check("explicit quarter", resolveTimeframe("Q1 2026", jul)?.to, "2026-03-31");
check("indian FY", resolveTimeframe("FY26", jul)?.from, "2026-04-01");
check("last 90 days", resolveTimeframe("last 90 days", jul)?.to, "2026-08-15");
check("explicit range", resolveTimeframe("2026-01-01 to 2026-03-31", jul)?.from, "2026-01-01");
check("nonsense timeframe", resolveTimeframe("whenever", jul), null);

/* ----------------------------------------------------------- query engine */

const row = (id: string, f: Record<string, string | number | null>): Row => ({
  id,
  name: `Deal ${id}`,
  f,
  raw: { "Item name": `Deal ${id}` },
  issues: [],
});

const ds: Dataset = {
  key: "deals",
  board: { id: "1", name: "Deals" },
  rowCount: 6,
  mapping: [
    { field: "sector", label: "Sector", type: "enum", columnId: "c1", columnTitle: "Industry", columnType: "status", confidence: 90 },
    { field: "stage", label: "Stage", type: "enum", columnId: "c2", columnTitle: "Stage", columnType: "status", confidence: 100 },
    { field: "value", label: "Value", type: "money", columnId: "c3", columnTitle: "Deal Value", columnType: "numbers", confidence: 95 },
    { field: "close_date", label: "Close", type: "date", columnId: "c4", columnTitle: "Expected Close", columnType: "date", confidence: 95 },
  ],
  unmappedColumns: [],
  rows: [
    row("1", { sector: "Energy", stage: "Proposal", value: 100, close_date: "2026-08-20" }),
    row("2", { sector: "Energy", stage: "Won", value: 200, close_date: "2026-07-10" }),
    row("3", { sector: "Mining", stage: "Proposal", value: 300, close_date: "2026-08-01" }),
    row("4", { sector: "Energy", stage: "Negotiation", value: null, close_date: "2026-09-30" }), // null value
    row("5", { sector: null, stage: "Lead", value: 50, close_date: null }),                      // null sector + date
    row("6", { sector: "Energy", stage: "Lost", value: 999, close_date: "2026-08-05" }),
  ],
  quality: { fields: [], warnings: [], duplicateClients: [] },
  fetchedAt: "2026-08-30T00:00:00.000Z",
};

const openPipeline = runQuery(ds, {
  filters: [
    { field: "sector", op: "eq", value: "Energy" },
    { field: "stage", op: "in", value: "Lead,Qualified,Proposal,Negotiation,On Hold" },
  ],
  metrics: ["count", "sum:value"],
});
check("open energy pipeline count", openPipeline.matched, 2);
check("open energy pipeline value excludes null", openPipeline.totals.sum_value, 100);
check("null value produces a caveat", openPipeline.caveats.some((c) => c.includes('no "value" value')), true);

const bySector = runQuery(ds, { group_by: "sector", metrics: ["count", "sum:value"], sort: "sum_value desc" });
check("groups include a blank bucket", bySector.groups?.length, 3);
check("top sector by value", (bySector.groups?.[0] as Record<string, unknown>).sector, "Energy");
check("blank group flagged", bySector.caveats.some((c) => c.includes("(blank)")), true);

const won = runQuery(ds, { filters: [{ field: "stage", op: "eq", value: "Won" }], metrics: ["count", "sum:value"] });
check("won total", [won.matched, won.totals.sum_value], [1, 200]);

// 5 of 6 rows close inside Jul-Sep 2026; row 5 has no close date at all.
const q3 = runQuery(ds, { timeframe: "Q3 2026", metrics: ["count"] });
check("timeframe filters by close date", q3.matched, 5);
check("timeframe label reported", q3.timeframe, "Q3 2026 (calendar)");
check("missing close dates flagged", q3.caveats.some((c) => c.includes("no close date")), true);

const bogus = runQuery(ds, { filters: [{ field: "not_a_field", op: "eq", value: "x" }], metrics: ["count"] });
check("unknown field returns nothing but explains why", [bogus.matched, bogus.caveats.length > 0], [0, true]);

const empties = runQuery(ds, { filters: [{ field: "value", op: "is_empty" }], metrics: ["count"] });
check("is_empty finds the null", empties.matched, 1);

const avg = runQuery(ds, { filters: [{ field: "sector", op: "eq", value: "Energy" }], metrics: ["avg:value", "max:value", "distinct:stage"] });
check("avg ignores nulls", avg.totals.avg_value, 433);
check("max value", avg.totals.max_value, 999);
check("distinct stages", avg.totals.distinct_stage, 4);

/* -------------------------------------------------------------------- out */

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  x  ${f}\n`);
  process.exit(1);
}
console.log("  All deterministic checks passed.\n");
