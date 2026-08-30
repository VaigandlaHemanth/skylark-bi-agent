/**
 * End-to-end test with no API keys and no network.
 *
 * Stubs `fetch` to serve two monday.com boards built from the REAL column
 * headers and REAL vocabulary of the assignment spreadsheets, then runs the
 * actual agent loop. This exercises the whole chain:
 *
 *   monday client -> column mapping -> normalization -> query engine -> tools -> agent
 *
 *   npm run e2etest
 */

process.env.GEMINI_API_KEY = "test-key";
process.env.MONDAY_API_TOKEN = "test-token";
process.env.MONDAY_DEALS_BOARD_ID = "";
process.env.MONDAY_WORK_ORDERS_BOARD_ID = "";

/* --------------------------------------------- fixtures (real board shape) */

// Headers verbatim from the assignment export. None of them match the app's
// canonical field names, which is the point.
const DEAL_HEADERS = [
  "Deal Name", "Owner code", "Client Code", "Deal Status", "Close Date (A)", "Closure Probability",
  "Masked Deal value", "Tentative Close Date", "Deal Stage", "Product deal", "Sector/service", "Created Date",
];

const DEAL_ROWS: string[][] = [
  ["Naruto", "OWNER_001", "COMPANY089", "Open", "", "High", "489360", "2026-02-26", "B. Sales Qualified Leads", "Service + Spectra", "Mining", "2025-12-26"],
  ["Sasuke", "OWNER_001", "COMPANY091", "Open", "", "", "17616960", "2026-02-28", "E. Proposal/Commercials Sent", "", "Renewables", "2025-09-15"],
  ["Sakura", "OWNER_002", "COMPANY124", "Open", "", "Medium", "611700", "2026-02-26", "F. Negotiations", "", "Powerline", "2025-11-12"],
  ["Alphonse", "OWNER_003", "COMPANY005", "Won", "2025-11-28", "", "1223400", "2025-11-20", "G. Project Won", "Pure Service", "Renewables", "2025-07-28"],
  ["Ben Tennyson", "OWNER_003", "COMPANY038", "Won", "", "", "305850", "2025-08-31", "H. Work Order Received", "Pure Service", "Mining", "2025-05-14"],
  ["Mojo Jojo", "OWNER_003", "COMPANY133", "Dead", "", "", "367020", "2025-07-04", "L. Project Lost", "Pure Service", "Railways", "2024-11-17"],
  ["Subaru", "OWNER_006", "COMPANY186", "Dead", "", "Low", "", "2025-01-14", "N. Not relevant at the moment", "", "Others", "2024-09-30"],
  ["Tanjiro", "OWNER_004", "COMPANY076", "Open", "", "High", "550530", "2026-01-15", "A. Lead Generated", "Pure Service", "Renewables", "2026-01-08"],
  // A repeated header row, exactly as it appears partway down the real export.
  ["Nezuko", "", "", "Deal Status", "Close Date (A)", "Closure Probability", "", "Tentative Close Date", "Deal Stage", "Product deal", "Sector/service", "Created Date"],
  ["Alias_162", "OWNER_002", "COMPANY111", "On Hold", "", "", "", "", "M. Projects On Hold", "", "Construction", "2025-11-27"],
];

const WO_HEADERS = [
  "Deal name masked", "Customer Name Code", "Serial #", "Nature of Work", "Execution Status",
  "Data Delivery Date", "Date of PO/LOI", "Document Type", "Probable Start Date", "Probable End Date",
  "BD/KAM Personnel code", "Sector", "Type of Work",
  "Is any Skylark software platform part of the client deliverables in this deal?",
  "Amount in Rupees (Excl of GST) (Masked)", "Billed Value in Rupees (Excl of GST.) (Masked)",
  "Collected Amount in Rupees (Incl of GST.) (Masked)", "Amount to be billed in Rs. (Exl. of GST) (Masked)",
  "Amount Receivable (Masked)", "Invoice Status", "Quantities as per PO", "WO Status (billed)",
];

const WO_ROWS: string[][] = [
  ["Scooby-Doo", "WOCOMPANY_002", "SDPLDEAL-075", "One time Project", "Completed", "2025-09-27", "2025-10-29", "Purchase Order", "2025-05-31", "2025-06-03", "OWNER_003", "Mining", "Raw images/videography", "NONE", "264398.08", "264398.08", "264398.08", "0", "0", "Fully Billed", "5360 HA", "Closed"],
  ["Appa", "WOCOMPANY_038", "SDPLDEAL-101", "Proof of Concept", "Not Started", "", "2025-07-31", "Purchase Order", "2025-08-11", "2025-08-15", "OWNER_002", "Powerline", "Powerline Inspection", "", "154150", "", "", "154150", "181897", "Not billed yet", "4", "Open"],
  ["Alias_160", "WOCOMPANY_051", "SDPLDEAL-002", "Annual Rate Contract", "Ongoing", "", "2025-04-10", "Purchase Order", "2025-05-01", "2025-12-31", "OWNER_001", "Renewables", "Topography Survey: RGB", "SPECTRA", "1233200", "554940", "400173.4", "678260", "1433885.9", "Partially Billed", "2057 Acr", "Open"],
  ["Alphonse", "WOCOMPANY_009", "SDPLDEAL-003", "One time Project", "Executed until current month", "2025-05-13", "2025-04-10", "Purchase Order", "2025-05-01", "2025-05-31", "OWNER_001", "Mining", "LiDAR Survey: LiDAR", "NONE", "308300", "308300", "", "0", "327414.6", "Fully Billed", "3956HA", "Open"],
  ["Tanjiro", "WOCOMPANY_019", "SDPLDEAL-004", "Monthly Contract", "Pause / struck", "", "2025-06-11", "LOA/LOI", "2025-07-01", "2025-08-30", "OWNER_003", "Renewables", "Others", "NONE", "184980", "", "", "184980", "218276.4", "", "24 Months", ""],
  ["Sakura", "WOCOMPANY_036", "SDPLDEAL-005", "One time Project", "Partial Completed", "", "2025-10-27", "Purchase Order", "2025-11-01", "2025-11-30", "OWNER_004", "Railways", "Hydrology, Topography Survey: RGB", "NONE", "431620", "215810", "", "215810", "254655.8", "Partially Billed", "Rate based on MW slabs", "Open"],
  ["Subaru", "WOCOMPANY_026", "SDPLDEAL-006", "One time Project", "Details pending from Client", "", "2026-01-09", "Email Confirmation", "2026-01-15", "2026-02-28", "OWNER_005", "Mining", "Topography Survey: RGB", "SPECTRA + DMO", "24664", "", "", "24664", "29103.52", "Not billed yet", "-1309.85", "Open"],
  ["Bugs Bunny", "WOCOMPANY_002", "SDPLDEAL-007", "One time Project", "Completed", "2025-06-10", "2025-04-01", "Purchase Order", "2025-04-15", "2025-06-16", "OWNER_001", "Others", "Others", "DMO", "0", "0", "", "0", "0", "Fully Billed", "1", "Closed"],
];

function board(headers: string[], rows: string[][], prefix: string) {
  const columns = headers.map((title, i) => ({ id: `${prefix}${i}`, title, type: "text" }));
  const items = rows.map((r, i) => ({
    id: `${prefix}item${i}`,
    name: r[0],
    column_values: columns.map((c, j) => ({ id: c.id, text: r[j] ?? "" })),
  }));
  return { columns, items };
}

const DEALS = board(DEAL_HEADERS, DEAL_ROWS, "d");
const WORK = board(WO_HEADERS, WO_ROWS, "w");

/* ------------------------------------------------------ scripted LLM turns */

let llmTurn = 0;
const LLM_SCRIPT = [
  {
    candidates: [{ content: { parts: [{ functionCall: { name: "query_board", args: {
      board: "deals",
      filters: [{ field: "sector", op: "eq", value: "energy" }, { field: "status", op: "eq", value: "Open" }],
      metrics: ["count", "sum:value"],
    } } }] } }],
  },
  { candidates: [{ content: { parts: [{ text: "**Energy pipeline: 3 open deals.**\n\n*Deal value is sparsely filled.*" }] } }] },
];

/* -------------------------------------------------------------- fetch stub */

const realFetch = globalThis.fetch;
let mondayCalls = 0;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);

  if (url.includes("api.monday.com")) {
    mondayCalls++;
    const body = JSON.parse(String(init?.body ?? "{}"));
    const query = String(body.query ?? "");

    if (query.includes("items_page")) {
      const src = String(body.variables?.boardId) === "101" ? DEALS : WORK;
      return json({ data: { boards: [{ items_page: { cursor: null, items: src.items } }] } });
    }
    return json({
      data: {
        boards: [
          { id: "101", name: "Deal Funnel", items_count: DEALS.items.length, columns: DEALS.columns },
          { id: "202", name: "Work Order Tracker", items_count: WORK.items.length, columns: WORK.columns },
        ],
      },
    });
  }

  if (url.includes("generativelanguage.googleapis.com")) return json(LLM_SCRIPT[Math.min(llmTurn++, LLM_SCRIPT.length - 1)]);
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

console.log("\n─── column mapping (real headers, none of which match field names) ───");
const deals = await getDataset("deals");
const map = Object.fromEntries(deals.mapping.map((m) => [m.field, m.columnTitle]));
for (const m of deals.mapping) console.log(`   ${m.field.padEnd(18)} <- "${m.columnTitle}" (${m.confidence}%)`);
check("client <- Client Code", map.client, "Client Code");
check("owner <- Owner code", map.owner, "Owner code");
check("sector <- Sector/service", map.sector, "Sector/service");
check("status <- Deal Status", map.status, "Deal Status");
check("stage <- Deal Stage", map.stage, "Deal Stage");
check("value <- Masked Deal value", map.value, "Masked Deal value");
check("close_date <- Tentative Close Date", map.close_date, "Tentative Close Date");
check("actual_close_date <- Close Date (A)", map.actual_close_date, "Close Date (A)");
check("probability <- Closure Probability", map.probability, "Closure Probability");
check("product <- Product deal", map.product, "Product deal");
check("created_date <- Created Date", map.created_date, "Created Date");

const wo = await getDataset("work_orders");
const wmap = Object.fromEntries(wo.mapping.map((m) => [m.field, m.columnTitle]));
for (const m of wo.mapping) console.log(`   [wo] ${m.field.padEnd(14)} <- "${m.columnTitle}" (${m.confidence}%)`);
check("wo status <- Execution Status", wmap.status, "Execution Status");
check("wo value <- Amount excl GST", wmap.value, "Amount in Rupees (Excl of GST) (Masked)");
check("wo billed <- Billed Value excl GST", wmap.billed, "Billed Value in Rupees (Excl of GST.) (Masked)");
check("wo collected <- Collected Amount", wmap.collected, "Collected Amount in Rupees (Incl of GST.) (Masked)");
check("wo unbilled <- Amount to be billed", wmap.unbilled, "Amount to be billed in Rs. (Exl. of GST) (Masked)");
check("wo receivable <- Amount Receivable", wmap.receivable, "Amount Receivable (Masked)");
check("wo end_date <- Probable End Date", wmap.end_date, "Probable End Date");
check("wo owner <- BD/KAM Personnel code", wmap.owner, "BD/KAM Personnel code");
check("wo service <- Type of Work", wmap.service, "Type of Work");
check("wo quantity <- Quantities as per PO", wmap.quantity_po, "Quantities as per PO");

console.log("\n─── messy-data handling ───");
check("repeated header row dropped", [deals.droppedRows, deals.rowCount], [1, 9]);
check("drop is reported", deals.quality.warnings.some((w) => w.includes("repeated header")), true);

const byName = Object.fromEntries(deals.rows.map((r) => [r.name, r]));
check("board sector vocabulary preserved verbatim", byName["Sasuke"].f.sector, "Renewables");
check("lettered stage preserved verbatim", byName["Sakura"].f.stage, "F. Negotiations");
check("probability kept as its High/Medium/Low label", byName["Naruto"].f.probability, "High");
check("blank value stays null", byName["Subaru"].f.value, null);

const woByName = Object.fromEntries(wo.rows.map((r) => [r.name, r]));
check("quantity with a unit is split", [woByName["Scooby-Doo"].f.quantity_po, woByName["Scooby-Doo"].f.quantity_po_unit], [5360, "HA"]);
check("quantity with no space", woByName["Alphonse"].f.quantity_po, 3956);
check("negative quantity parses", woByName["Subaru"].f.quantity_po, -1309.85);
check("prose quantity is null and flagged", [woByName["Sakura"].f.quantity_po, woByName["Sakura"].issues.length > 0], [null, true]);
check("NONE is kept as a real answer", woByName["Scooby-Doo"].f.platform, "NONE");

console.log("\n─── vocabulary discovered from the board ───");
console.log("   sectors:", deals.distinct.sector?.map((v) => v.value).join(", "));
console.log("   statuses:", deals.distinct.status?.map((v) => v.value).join(", "));
console.log("   wo statuses:", wo.distinct.status?.map((v) => v.value).join(", "));
check("sector vocabulary indexed", deals.distinct.sector?.length, 6);
check("deal status vocabulary indexed", deals.distinct.status?.map((v) => v.value).sort(), ["Dead", "On Hold", "Open", "Won"]);

console.log("\n─── founder wording resolved onto board values ───");
const energy = (await executeTool("query_board", {
  board: "deals",
  filters: [{ field: "sector", op: "eq", value: "energy" }, { field: "status", op: "eq", value: "Open" }],
  metrics: ["count", "sum:value"],
})) as Record<string, any>;
console.log(`   "energy" -> ${JSON.stringify(energy.resolved_values?.[0]?.board_values_used)}`);
check("energy resolves to Renewables + Powerline", energy.resolved_values?.[0]?.board_values_used, ["Renewables", "Powerline"]);
check("open energy deals", energy.matched, 3);

const negotiation = (await executeTool("query_board", { board: "deals", filters: [{ field: "stage", op: "eq", value: "negotiation" }], metrics: ["count"] })) as Record<string, any>;
check("'negotiation' finds 'F. Negotiations'", negotiation.matched, 1);

const running = (await executeTool("query_board", { board: "work_orders", filters: [{ field: "status", op: "in", value: "in progress" }], metrics: ["count"] })) as Record<string, any>;
check("'in progress' finds Ongoing + Executed until current month", running.matched, 2);

const nonsense = (await executeTool("query_board", { board: "deals", filters: [{ field: "sector", op: "eq", value: "banking" }], metrics: ["count"] })) as Record<string, any>;
check("unknown value lists what does exist", nonsense.caveats.some((c: string) => c.includes("Renewables")), true);

const distinct = (await executeTool("distinct_values", { board: "work_orders", field: "invoice_status" })) as Record<string, any>;
check("distinct_values lists real values", distinct.values.map((v: any) => v.value).sort(), ["Fully Billed", "Not billed yet", "Partially Billed"]);

console.log("\n─── aggregation ───");
const byStatus = (await executeTool("query_board", { board: "deals", group_by: "status", metrics: ["count", "sum:value"], sort: "count desc" })) as Record<string, any>;
check("groups sorted descending", byStatus.groups.map((g: any) => g.count), [4, 2, 2, 1]);

const cash = (await executeTool("query_board", { board: "work_orders", metrics: ["sum:value", "sum:billed", "sum:collected", "sum:receivable"] })) as Record<string, any>;
check("order book totalled", cash.totals.sum_value, 2601312.08);
check("receivable totalled", cash.totals.sum_receivable, 2445233.22);
check("sparse billed column caveated", cash.caveats.some((c: string) => c.includes('no "billed" value')), true);

console.log("\n─── leadership brief ───");
const brief = (await executeTool("leadership_brief", { timeframe: "FY26" })) as Record<string, any>;
check("brief pipeline uses Open status", brief.pipeline?.open_deals, 4);
check("brief has a win rate", typeof brief.conversion?.win_rate_pct, "number");
check("brief has a cash section", typeof brief.cash?.receivable_outstanding, "number");
check("brief carries caveats", Array.isArray(brief.data_caveats) && brief.data_caveats.length > 0, true);
check("brief compares pipeline to delivery per sector", Array.isArray(brief.sector_pipeline_vs_delivery), true);

console.log("\n─── full agent loop ───");
const events: string[] = [];
for await (const ev of runAgent([{ role: "user", content: "How's our pipeline looking for the energy sector this quarter?" }])) {
  events.push(ev.type);
  if (ev.type === "tool") console.log(`   → ${ev.name}(${JSON.stringify(ev.args).slice(0, 100)}…)`);
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
