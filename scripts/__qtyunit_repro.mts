/* Repro: are quantity units summed across incompatible units? */

process.env.GEMINI_API_KEY = "test-key";
process.env.MONDAY_API_TOKEN = "test-token";
process.env.MONDAY_DEALS_BOARD_ID = "";
process.env.MONDAY_WORK_ORDERS_BOARD_ID = "";

const DEAL_HEADERS = [
  "Deal Name", "Owner code", "Client Code", "Deal Status", "Close Date (A)", "Closure Probability",
  "Masked Deal value", "Tentative Close Date", "Deal Stage", "Product deal", "Sector/service", "Created Date",
];
const DEAL_ROWS: string[][] = [
  ["Naruto", "OWNER_001", "COMPANY089", "Open", "", "High", "489360", "2026-02-26", "B. Sales Qualified Leads", "Service + Spectra", "Mining", "2025-12-26"],
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

// Verbatim from scripts/e2etest.mts WO_ROWS.
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

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("api.monday.com")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (String(body.query ?? "").includes("items_page")) {
      const src = String(body.variables?.boardId) === "101" ? DEALS : WORK;
      return json({ data: { boards: [{ items_page: { cursor: null, items: src.items } }] } });
    }
    return json({ data: { boards: [
      { id: "101", name: "Deal Funnel", items_count: DEALS.items.length, columns: DEALS.columns },
      { id: "202", name: "Work Order Tracker", items_count: WORK.items.length, columns: WORK.columns },
    ] } });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const { executeTool } = await import("../src/lib/tools.ts");
const { getDataset } = await import("../src/lib/store.ts");

const wo = await getDataset("work_orders");
console.log("=== per-row parsed quantity_po + unit ===");
for (const r of wo.rows) {
  console.log(`  ${String(r.name).padEnd(12)} sector=${String(r.f.sector).padEnd(11)} value=${String(r.f.quantity_po).padEnd(10)} unit=${JSON.stringify(r.f.quantity_po_unit)}`);
}

console.log("\n=== A) EXACT CLAIMED CALL: group_by sector, metrics [count, sum:quantity_po] ===");
const grouped = (await executeTool("query_board", {
  board: "work_orders",
  group_by: "sector",
  metrics: ["count", "sum:quantity_po"],
})) as any;
console.log(JSON.stringify(grouped, null, 2));

console.log("\n>>> totals.sum_quantity_po =", grouped.totals.sum_quantity_po);
console.log(">>> grouped.rows is", grouped.rows === undefined ? "ABSENT" : "present");
console.log(">>> any caveat mentioning a unit (HA/Acr/Months)?",
  grouped.caveats.some((c: string) => /\bHA\b|Acr|Month|unit/i.test(c)));

console.log("\n=== B) ungrouped: sum/avg/min/max/median across mixed units ===");
const total = (await executeTool("query_board", {
  board: "work_orders",
  metrics: ["count", "sum:quantity_po", "avg:quantity_po", "min:quantity_po", "max:quantity_po", "median:quantity_po"],
})) as any;
console.log("totals:", JSON.stringify(total.totals));
console.log("caveats:", JSON.stringify(total.caveats, null, 2));

console.log("\n=== C) does return_rows emit the unit? (cols = ds.mapping fields) ===");
console.log("mapping has quantity_po_unit?", wo.mapping.some((m: any) => m.field === "quantity_po_unit"));
console.log(JSON.stringify(total.rows?.slice(0, 3), null, 2));
