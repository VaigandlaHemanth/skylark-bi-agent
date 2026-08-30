/**
 * Dry run against the real assignment spreadsheets, without monday.com.
 *
 * Reads the two CSV exports from a local folder, serves them through a stubbed
 * monday.com API, and prints exactly what the agent would see: the column
 * mapping it inferred, the vocabulary it found, the data-quality warnings, and
 * the answers to a battery of founder questions.
 *
 * This is a development aid for checking the mapping before importing into
 * monday.com. The app itself never reads these files.
 *
 *   npx tsx scripts/verify-real-data.mts [folder]
 */

import fs from "node:fs";
import path from "node:path";

const folder = process.argv[2] ?? "..";

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function findCsv(dir: string, needle: RegExp): string {
  const hit = fs.readdirSync(dir).find((f) => needle.test(f) && f.toLowerCase().endsWith(".csv"));
  if (!hit) throw new Error(`No CSV matching ${needle} in ${path.resolve(dir)}`);
  return path.join(dir, hit);
}

/** Skip fully blank leading rows, as the work order export has one. */
function load(file: string) {
  const rows = parseCsv(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  let h = 0;
  while (h < rows.length && rows[h].every((c) => !c.trim())) h++;
  const header = rows[h].map((c) => c.trim());
  const data = rows.slice(h + 1).filter((r) => r.some((c) => c.trim()));
  return { header, data };
}

const deals = load(findCsv(folder, /deal/i));
const work = load(findCsv(folder, /work[_ ]?order/i));
console.log(`Loaded ${deals.data.length} deal rows (${deals.header.length} cols), ${work.data.length} work order rows (${work.header.length} cols)`);

/* ------------------------------------------------------- stub monday.com */

process.env.MONDAY_API_TOKEN = "local";
process.env.MONDAY_DEALS_BOARD_ID = "";
process.env.MONDAY_WORK_ORDERS_BOARD_ID = "";

// Pick up a real model key from .env.local so the agent loop can be exercised
// against this data for real. Falls back to a stub when none is present.
const envFile = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
for (const line of envFile.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
  if (m && m[2]) process.env[m[1]] ??= m[2];
}
const LIVE = !!(process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || process.env.ANTHROPIC_API_KEY);
process.env.GEMINI_API_KEY ??= "local";

const cols = (header: string[], prefix: string) =>
  header.map((title, i) => ({ id: `${prefix}${i}`, title: title || `Column ${i + 1}`, type: "text" }));

const DEAL_COLS = cols(deals.header, "d");
const WORK_COLS = cols(work.header, "w");

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.includes("api.monday.com")) return realFetch(input as RequestInfo, init);

  const body = JSON.parse(String(init?.body ?? "{}"));
  const query = String(body.query ?? "");

  if (query.includes("items_page")) {
    const isDeals = String(body.variables?.boardId) === "101";
    const [c, d] = isDeals ? [DEAL_COLS, deals.data] : [WORK_COLS, work.data];
    return new Response(
      JSON.stringify({
        data: {
          boards: [
            {
              items_page: {
                cursor: null,
                items: d.map((r, i) => ({
                  id: `${isDeals ? "d" : "w"}${i}`,
                  name: (r[0] ?? "").trim() || `Item ${i + 1}`,
                  column_values: c.map((col, j) => ({ id: col.id, text: (r[j] ?? "").trim() })),
                })),
              },
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({
      data: {
        boards: [
          { id: "101", name: "Deal Funnel", items_count: deals.data.length, columns: DEAL_COLS },
          { id: "202", name: "Work Order Tracker", items_count: work.data.length, columns: WORK_COLS },
        ],
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}) as typeof fetch;

/* -------------------------------------------------------------- dry run */

const { getDataset } = await import("../src/lib/store");
const { executeTool } = await import("../src/lib/tools");

for (const key of ["deals", "work_orders"] as const) {
  const ds = await getDataset(key);
  console.log(`\n${"=".repeat(94)}\n${key.toUpperCase()}  —  "${ds.board.name}", ${ds.rowCount} usable rows (${ds.droppedRows} dropped as repeated headers)\n${"=".repeat(94)}`);

  console.log("\nCOLUMN MAPPING");
  for (const m of ds.mapping) console.log(`   ${m.field.padEnd(20)} <- "${m.columnTitle}"  [${m.confidence}%]`);

  const un = ds.unmappedColumns.map((c) => c.title).filter(Boolean);
  if (un.length) console.log(`\nUNMAPPED (still queryable by title): ${un.join(" | ")}`);

  console.log("\nVOCABULARY FOUND");
  for (const [f, v] of Object.entries(ds.distinct)) {
    if (v.length > 20) { console.log(`   ${f.padEnd(16)} ${v.length} distinct`); continue; }
    console.log(`   ${f.padEnd(16)} ${v.map((x) => `${x.value}(${x.count})`).join(", ")}`);
  }

  console.log("\nFILL RATES");
  for (const q of ds.quality.fields) console.log(`   ${q.field.padEnd(20)} ${String(q.fillRate).padStart(3)}%  ${q.missing} blank`);

  console.log("\nWARNINGS");
  for (const w of ds.quality.warnings) console.log(`   ! ${w}`);
}

/* ------------------------------------------------------- founder questions */

console.log(`\n${"=".repeat(94)}\nFOUNDER QUESTIONS\n${"=".repeat(94)}`);

const show = (label: string, r: any) => {
  console.log(`\n▸ ${label}`);
  if (r.resolved_values) for (const rv of r.resolved_values) console.log(`   resolved ${rv.field} "${rv.you_asked_for}" -> ${JSON.stringify(rv.board_values_used)}`);
  console.log(`   matched ${r.matched}/${r.scanned}  totals ${JSON.stringify(r.totals)}`);
  if (r.groups) for (const g of r.groups.slice(0, 8)) console.log(`     ${JSON.stringify(g)}`);
  for (const c of (r.caveats ?? []).slice(0, 3)) console.log(`   ~ ${c}`);
};

show("Open pipeline in the ENERGY sector (should resolve to Renewables/Powerline)",
  await executeTool("query_board", { board: "deals", filters: [{ field: "sector", op: "eq", value: "energy" }, { field: "status", op: "eq", value: "open" }], metrics: ["count", "sum:value"] }));

show("Open pipeline by sector",
  await executeTool("query_board", { board: "deals", filters: [{ field: "status", op: "eq", value: "Open" }], group_by: "sector", metrics: ["count", "sum:value"], sort: "count desc" }));

show("Deals by status",
  await executeTool("query_board", { board: "deals", group_by: "status", metrics: ["count", "sum:value"], sort: "count desc" }));

show("Deals sitting in negotiation (board says 'F. Negotiations')",
  await executeTool("query_board", { board: "deals", filters: [{ field: "stage", op: "eq", value: "negotiation" }], metrics: ["count", "sum:value"] }));

show("Won deals in FY26",
  await executeTool("query_board", { board: "deals", filters: [{ field: "status", op: "eq", value: "Won" }], timeframe: "FY26", metrics: ["count", "sum:value"] }));

show("Work orders still running (not complete)",
  await executeTool("query_board", { board: "work_orders", filters: [{ field: "status", op: "not_in", value: "Completed" }], metrics: ["count", "sum:value"] }));

show("Overdue delivery",
  await executeTool("query_board", { board: "work_orders", filters: [{ field: "status", op: "not_in", value: "Completed" }, { field: "end_date", op: "before", value: new Date().toISOString().slice(0, 10) }], metrics: ["count", "sum:value"] }));

show("Receivables by client",
  await executeTool("query_board", { board: "work_orders", filters: [{ field: "receivable", op: "gt", value: "0" }], group_by: "client", metrics: ["count", "sum:receivable"], sort: "sum_receivable desc", limit: 6 }));

show("Mining delivery",
  await executeTool("query_board", { board: "work_orders", filters: [{ field: "sector", op: "eq", value: "mining" }], group_by: "status", metrics: ["count", "sum:value"], sort: "count desc" }));

const brief = (await executeTool("leadership_brief", { timeframe: "FY26" })) as any;
console.log("\n▸ LEADERSHIP BRIEF (FY26)");
console.log(JSON.stringify({ period: brief.period, pipeline: { open_deals: brief.pipeline?.open_deals, open_value: brief.pipeline?.open_value }, conversion: brief.conversion, delivery: { active: brief.delivery?.active_work_orders, completed: brief.delivery?.completed_in_window }, cash: { ...brief.cash, top_receivable_accounts: brief.cash?.top_receivable_accounts?.slice(0, 3) }, slipping: brief.slipping_deals?.count, overdue: brief.overdue_delivery?.count }, null, 2));
console.log("\ncaveats:");
for (const c of brief.data_caveats) console.log(`   ~ ${c}`);


/* ------------------------------------------------------- live agent (optional) */

if (LIVE) {
  const { runAgent } = await import("../src/lib/agent");
  const { providerInfo } = await import("../src/lib/llm");
  const info = providerInfo();
  console.log(`
${"=".repeat(94)}
LIVE AGENT via ${info.provider}/${info.model}
${"=".repeat(94)}`);

  const QUESTIONS = process.argv.slice(3).length
    ? process.argv.slice(3)
    : [
        "How's our pipeline looking for the energy sector?",
        "What's our win rate, and where are we losing?",
        "How much is sitting in receivables, and with whom?",
      ];

  const NL = String.fromCharCode(10);

  for (const q of QUESTIONS) {
    console.log(`${NL}▸ ${q}`);
    for await (const ev of runAgent([{ role: "user", content: q }])) {
      if (ev.type === "status") console.log(`   · ${ev.text}`);
      if (ev.type === "tool") console.log(`   → ${ev.name} ${JSON.stringify(ev.args).slice(0, 170)}`);
      if (ev.type === "tool_result") console.log(`   ← ${ev.summary}`);
      if (ev.type === "answer") console.log(NL + ev.text.split(NL).map((l) => `   ${l}`).join(NL) + NL);
      if (ev.type === "error") console.log(`   ! ${ev.text}${ev.hint ? ` (${ev.hint})` : ""}`);
    }
  }
} else {
  console.log(`${String.fromCharCode(10)}(no model key found in .env.local - skipped the live agent run)`);
}
