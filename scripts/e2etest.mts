/**
 * End-to-end test with no API keys and no network.
 *
 * Stubs `fetch` to serve (a) a monday.com board with deliberately messy,
 * deliberately mis-named columns and (b) a scripted Gemini response, then runs
 * the real agent loop. This exercises the whole chain:
 *
 *   monday client -> column mapping -> normalization -> query engine -> tools -> agent
 *
 *   npm run e2etest
 */

process.env.GEMINI_API_KEY = "test-key";
process.env.MONDAY_API_TOKEN = "test-token";
process.env.MONDAY_DEALS_BOARD_ID = "";
process.env.MONDAY_WORK_ORDERS_BOARD_ID = "";

/* ------------------------------------------------- fake monday.com content */

// Headers on purpose do NOT match the canonical field names.
const DEAL_COLUMNS = [
  { id: "c_client", title: "Customer Name", type: "text" },
  { id: "c_ind", title: "Industry", type: "status" },
  { id: "c_stage", title: "Funnel Stage", type: "color" },
  { id: "c_val", title: "Deal Value (INR)", type: "numbers" },
  { id: "c_close", title: "Expected Closure", type: "text" },
  { id: "c_owner", title: "Sales Rep", type: "people" },
  { id: "c_misc", title: "Internal Ref", type: "text" },
];

const WO_COLUMNS = [
  { id: "w_client", title: "Client", type: "text" },
  { id: "w_sec", title: "Vertical", type: "dropdown" },
  { id: "w_stat", title: "Execution Status", type: "color" },
  { id: "w_val", title: "Billing Amount", type: "text" },
  { id: "w_end", title: "Target Date", type: "text" },
  { id: "w_area", title: "Area (acres)", type: "numbers" },
];

const DEAL_ROWS = [
  ["Adani Green Pvt Ltd", "Solar EPC", "Proposal", "12,00,000", "15/07/2026", "R. Nair", "D-01"],
  ["ADANI GREEN PVT. LTD.", "Renewables", "Negotiation", "₹8.5 lakhs", "2026-08-20", "R. Nair", "D-02"],
  ["Tata Power", "power", "Closed Won", "45,00,000", "10-Jul-2026", "S. Iyer", "D-03"],
  ["Coal India", "Mining", "closed lost", "30,00,000", "Aug 2026", "S. Iyer", "D-04"],
  ["JSW Steel", "mining", "Qualified", "", "Q3 2026", "", "D-05"],
  ["L&T Construction", "Infrastructure", "Proposal", "$1.2M", "05/09/2026", "A. Rao", "D-06"],
  ["ONGC", "Oil & Gas", "Lead", "TBD", "N/A", "A. Rao", "D-07"],
  ["Vestas India", "Wind", "Won", "22 lakhs", "28/06/2026", "R. Nair", "D-08"],
];

const WO_ROWS = [
  ["Adani Green Pvt. Ltd.", "Solar", "In Progress", "9,00,000", "30/09/2026", "450"],
  ["Tata Power", "Power", "Completed", "45,00,000", "12/07/2026", "1200"],
  ["Coal India Ltd", "Mining", "WIP", "18,00,000", "01/06/2026", "800"],
  ["NHAI", "Highways", "Delivered", "6,50,000", "20/08/2026", "300"],
  ["JSW Steel", "Mining", "On Hold", "", "", "150"],
];

function itemsPage(columns: Array<{ id: string }>, rows: string[][], prefix: string) {
  return {
    cursor: null,
    items: rows.map((r, i) => ({
      id: `${prefix}${i}`,
      name: r[0],
      column_values: columns.map((c, j) => ({ id: c.id, text: r[j] ?? "" })),
    })),
  };
}

/* ------------------------------------------------------ scripted LLM turns */

let llmTurn = 0;
const LLM_SCRIPT = [
  // Turn 1: the model asks for the open energy pipeline.
  {
    candidates: [
      {
        content: {
          parts: [
            {
              functionCall: {
                name: "query_board",
                args: {
                  board: "deals",
                  filters: [
                    { field: "sector", op: "eq", value: "Energy" },
                    { field: "stage", op: "in", value: "Lead,Qualified,Proposal,Negotiation,On Hold" },
                  ],
                  group_by: "stage",
                  metrics: ["count", "sum:value"],
                },
              },
            },
          ],
        },
      },
    ],
  },
  // Turn 2: it narrates.
  { candidates: [{ content: { parts: [{ text: "**Energy pipeline: 2 open deals worth 2,050,000.**\n\n*Based on 8 deals.*" }] } }] },
];

/* ----------------------------------------------------------- fetch stub */

const realFetch = globalThis.fetch;
let mondayCalls = 0;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);

  if (url.includes("api.monday.com")) {
    mondayCalls++;
    const query = String(JSON.parse(String(init?.body ?? "{}")).query ?? "");
    const vars = JSON.parse(String(init?.body ?? "{}")).variables ?? {};

    if (query.includes("items_page")) {
      const isDeals = String(vars.boardId) === "101";
      return json({
        data: {
          boards: [{ items_page: isDeals ? itemsPage(DEAL_COLUMNS, DEAL_ROWS, "d") : itemsPage(WO_COLUMNS, WO_ROWS, "w") }],
        },
      });
    }

    return json({
      data: {
        boards: [
          { id: "101", name: "Deal Funnel", items_count: DEAL_ROWS.length, columns: DEAL_COLUMNS },
          { id: "202", name: "Work Order Tracker", items_count: WO_ROWS.length, columns: WO_COLUMNS },
        ],
      },
    });
  }

  if (url.includes("generativelanguage.googleapis.com")) {
    return json(LLM_SCRIPT[Math.min(llmTurn++, LLM_SCRIPT.length - 1)]);
  }

  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/* --------------------------------------------------------------- the test */

const { runAgent } = await import("../src/lib/agent");
const { getDataset, boardsOverview } = await import("../src/lib/store");
const { executeTool } = await import("../src/lib/tools");

let pass = 0;
const failures: string[] = [];
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${label}\n     expected ${e}\n     actual   ${a}`);
}

console.log("\n─── board discovery ───");
const overview = await boardsOverview();
check("both boards resolved", (overview.datasets as Array<Record<string, unknown>>).map((d) => d.monday_board), ["Deal Funnel", "Work Order Tracker"]);

console.log("\n─── column mapping (headers deliberately do not match field names) ───");
const deals = await getDataset("deals");
const map = Object.fromEntries(deals.mapping.map((m) => [m.field, m.columnTitle]));
for (const m of deals.mapping) console.log(`   ${m.field.padEnd(13)} <- "${m.columnTitle}" (${m.columnType}, ${m.confidence}%)`);
check("client mapped", map.client, "Customer Name");
check("sector mapped from 'Industry'", map.sector, "Industry");
check("stage mapped from 'Funnel Stage'", map.stage, "Funnel Stage");
check("value mapped from 'Deal Value (INR)'", map.value, "Deal Value (INR)");
check("close_date mapped from 'Expected Closure'", map.close_date, "Expected Closure");
check("owner mapped from 'Sales Rep'", map.owner, "Sales Rep");
check("unrelated column left unmapped", deals.unmappedColumns.map((c) => c.title), ["Internal Ref"]);

const wo = await getDataset("work_orders");
const wmap = Object.fromEntries(wo.mapping.map((m) => [m.field, m.columnTitle]));
check("wo status mapped from 'Execution Status'", wmap.status, "Execution Status");
check("wo value mapped from 'Billing Amount'", wmap.value, "Billing Amount");
check("wo sector mapped from 'Vertical'", wmap.sector, "Vertical");
check("wo end_date mapped from 'Target Date'", wmap.end_date, "Target Date");

console.log("\n─── normalization of messy cells ───");
const byRef = Object.fromEntries(deals.rows.map((r) => [r.raw["Internal Ref"], r]));
check("indian grouping parsed", byRef["D-01"].f.value, 1200000);
check("rupee + lakhs parsed", byRef["D-02"].f.value, 850000);
check("dollar millions parsed", byRef["D-06"].f.value, 1200000);
check("'TBD' becomes null", byRef["D-07"].f.value, null);
check("solar EPC -> Energy", byRef["D-01"].f.sector, "Energy");
check("renewables -> Energy", byRef["D-02"].f.sector, "Energy");
check("wind -> Energy", byRef["D-08"].f.sector, "Energy");
check("'closed lost' -> Lost", byRef["D-04"].f.stage, "Lost");
check("day-first date", byRef["D-01"].f.close_date, "2026-07-15");
check("dd-Mon-yyyy date", byRef["D-03"].f.close_date, "2026-07-10");
check("quarter date flagged and coerced", byRef["D-05"].f.close_date, "2026-07-01");
check("'N/A' date becomes null", byRef["D-07"].f.close_date, null);
check("lossy parse recorded on the row", byRef["D-05"].issues.length > 0, true);

console.log("\n─── data quality ───");
check("duplicate client spellings detected", deals.quality.duplicateClients[0].variants.length, 2);
check("warnings produced", deals.quality.warnings.length > 0, true);
for (const w of deals.quality.warnings.slice(0, 4)) console.log(`   ! ${w}`);

console.log("\n─── query engine over the real dataset ───");
const energy = (await executeTool("query_board", {
  board: "deals",
  filters: [
    { field: "sector", op: "eq", value: "Energy" },
    { field: "stage", op: "in", value: "Lead,Qualified,Proposal,Negotiation,On Hold" },
  ],
  metrics: ["count", "sum:value"],
})) as Record<string, any>;
check("open energy deals", energy.matched, 2);
check("open energy value", energy.totals.sum_value, 2050000);

const won = (await executeTool("query_board", { board: "deals", filters: [{ field: "stage", op: "eq", value: "Won" }], metrics: ["count", "sum:value"] })) as Record<string, any>;
check("won deals across spellings", won.matched, 2);
check("won value", won.totals.sum_value, 6700000);

const late = (await executeTool("query_board", {
  board: "work_orders",
  filters: [
    { field: "status", op: "not_in", value: "Completed,Cancelled" },
    { field: "end_date", op: "before", value: "2026-08-30" },
  ],
  metrics: ["count"],
})) as Record<string, any>;
check("overdue work orders", late.matched, 1);

console.log("\n─── leadership brief ───");
const brief = (await executeTool("leadership_brief", { timeframe: "this quarter" })) as Record<string, any>;
check("brief has pipeline", typeof brief.pipeline?.open_deals, "number");
check("brief has win rate key", "win_rate_pct" in brief.conversion, true);
check("brief has delivery", typeof brief.delivery?.active_work_orders, "number");
check("brief carries caveats", Array.isArray(brief.data_caveats), true);
check("cross-board sector view", Array.isArray(brief.sector_pipeline_vs_delivery), true);

console.log("\n─── full agent loop ───");
const events: string[] = [];
for await (const ev of runAgent([{ role: "user", content: "How's our pipeline looking for the energy sector this quarter?" }])) {
  events.push(ev.type);
  if (ev.type === "tool") console.log(`   → tool ${ev.name}(${JSON.stringify(ev.args).slice(0, 90)}…)`);
  if (ev.type === "tool_result") console.log(`   ← ${ev.name}: ${ev.summary}`);
  if (ev.type === "answer") console.log(`   ✎ ${ev.text.replace(/\n/g, " ")}`);
  if (ev.type === "error") console.log(`   ! ${ev.text}`);
}
check("agent called a tool then answered", [events.includes("tool"), events.includes("tool_result"), events.at(-1)], [true, true, "answer"]);
check("monday.com was actually queried", mondayCalls > 0, true);

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  x  ${f}\n`);
  process.exit(1);
}
console.log("  Full pipeline verified end to end.\n");
