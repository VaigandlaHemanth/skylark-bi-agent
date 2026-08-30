/**
 * ONE-TIME SETUP. Creates the two monday.com boards from the assignment
 * spreadsheets. This is the equivalent of clicking "Import data -> Excel"; it is
 * not part of the agent, which only ever reads.
 *
 *   npx tsx scripts/import-to-monday.mts <folder-with-the-two-csvs>
 *   npx tsx scripts/import-to-monday.mts .. --dry     # plan only, no writes
 *
 * Values are uploaded verbatim. Nothing is cleaned on the way in - the messy
 * data is the point of the exercise, and cleaning it here would hide the work
 * the agent is meant to do.
 */

import fs from "node:fs";
import path from "node:path";

const folder = process.argv[2] ?? "..";
const DRY = process.argv.includes("--dry");

/* ------------------------------------------------------------------- env */

for (const line of (fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
  if (m && m[2]) process.env[m[1]] ??= m[2];
}
const TOKEN = process.env.MONDAY_API_TOKEN;
if (!TOKEN && !DRY) throw new Error("MONDAY_API_TOKEN missing from .env.local");

/* ------------------------------------------------------------------- csv */

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

function load(file: string) {
  const rows = parseCsv(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  let h = 0;
  while (h < rows.length && rows[h].every((c) => !c.trim())) h++; // the work order sheet leads with a blank row
  return { header: rows[h].map((c) => c.trim()), data: rows.slice(h + 1).filter((r) => r.some((c) => c.trim())) };
}

function findCsv(dir: string, needle: RegExp): string {
  const hit = fs.readdirSync(dir).find((f) => needle.test(f) && f.toLowerCase().endsWith(".csv"));
  if (!hit) throw new Error(`No CSV matching ${needle} in ${path.resolve(dir)}`);
  return path.join(dir, hit);
}

/* ------------------------------------------------------------ monday api */

let complexityWaits = 0;

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { Authorization: TOKEN!, "API-Version": "2024-10", "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });

    const text = await res.text();
    if (text.trimStart().startsWith("<")) {
      // monday sits behind Cloudflare, which answers a burst with an HTML block
      // page rather than a GraphQL error. Back off hard, then retry.
      const seconds = 20 * (attempt + 1);
      process.stdout.write(` [edge throttled, waiting ${seconds}s] `);
      await new Promise((r) => setTimeout(r, seconds * 1000));
      continue;
    }

    const body = JSON.parse(text) as { data?: T; errors?: Array<{ message: string }>; error_message?: string };
    const message = body.errors?.map((e) => e.message).join("; ") ?? body.error_message ?? "";

    // monday throttles by "complexity budget" and tells you how long to wait.
    const wait = message.match(/reset in (\d+) seconds/i);
    if (wait || res.status === 429) {
      const seconds = wait ? Number(wait[1]) + 1 : 20;
      complexityWaits++;
      process.stdout.write(` [budget exhausted, waiting ${seconds}s] `);
      await new Promise((r) => setTimeout(r, seconds * 1000));
      continue;
    }

    if (message) throw new Error(message);
    if (!body.data) throw new Error("empty response from monday.com");
    return body.data;
  }
  throw new Error("monday.com kept throttling after 6 attempts");
}

/* -------------------------------------------------------- column planning */

type ColKind = "text" | "numbers" | "date" | "status";

/**
 * Column types chosen from what the data actually holds:
 *  - date    where every non-blank value is already ISO
 *  - numbers where every non-blank value is purely numeric
 *  - status  for short categorical lists (<= 20 distinct)
 *  - text    otherwise, which preserves the mess exactly as-is
 */
function inferKind(title: string, values: string[]): ColKind {
  const filled = values.filter((v) => v.trim());
  if (!filled.length) return "text";

  const iso = filled.filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v.trim())).length;
  if (iso / filled.length >= 0.9 && /date|on$/i.test(title)) return "date";

  const numeric = filled.filter((v) => /^-?[\d.]+$/.test(v.trim())).length;
  if (numeric / filled.length >= 0.98) return "numbers";

  const distinct = new Set(filled.map((v) => v.trim().toLowerCase())).size;
  if (distinct <= 20) return "status";

  return "text";
}

const MONDAY_TYPE: Record<ColKind, string> = { text: "text", numbers: "numbers", date: "date", status: "status" };

/** Build the column_values payload monday expects, skipping anything unusable. */
function cellValue(kind: ColKind, raw: string): unknown | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  if (kind === "date") return /^\d{4}-\d{2}-\d{2}$/.test(v) ? { date: v } : undefined;
  if (kind === "numbers") return /^-?[\d.]+$/.test(v) ? v : undefined;
  if (kind === "status") return { label: v.slice(0, 40) };
  return v;
}

/* -------------------------------------------------------------- the work */

async function buildBoard(boardName: string, header: string[], data: string[][]) {
  const cols = header.map((title, i) => ({
    index: i,
    title: title || `Column ${i + 1}`,
    kind: inferKind(title, data.map((r) => r[i] ?? "")),
    id: "",
  }));

  console.log(`\n${"=".repeat(78)}\n${boardName} — ${data.length} rows, ${header.length} columns\n${"=".repeat(78)}`);
  for (const c of cols.slice(1)) console.log(`   ${MONDAY_TYPE[c.kind].padEnd(8)} ${c.title}`);
  console.log(`   (item name)  ${cols[0].title}`);

  if (DRY) return;

  // Re-running must not leave half-imported duplicates behind - but deleting a
  // board is destructive, so it only happens when explicitly requested.
  const existing = await gql<{ boards: Array<{ id: string; name: string }> }>(
    `query { boards(limit: 100, state: active) { id name } }`,
  );
  const clashes = existing.boards.filter((x) => x.name === boardName);
  if (clashes.length && !process.argv.includes("--replace")) {
    throw new Error(
      `A board named "${boardName}" already exists (${clashes.map((b) => b.id).join(", ")}). ` +
        `Re-run with --replace to delete and re-import it, or rename the old board first.`,
    );
  }
  for (const b of clashes) {
    console.log(`   --replace: removing existing board ${b.id}`);
    await gql(`mutation ($id: ID!) { delete_board(board_id: $id) { id } }`, { id: b.id });
    await new Promise((r) => setTimeout(r, 1000));
  }

  const { create_board } = await gql<{ create_board: { id: string } }>(
    `mutation ($name: String!) { create_board(board_name: $name, board_kind: public) { id } }`,
    { name: boardName },
  );
  const boardId = create_board.id;
  console.log(`\n   board created: ${boardId}`);

  // A new board ships with default columns; remove them so only ours remain.
  const { boards } = await gql<{ boards: Array<{ columns: Array<{ id: string; title: string; type: string }> }> }>(
    `query ($id: ID!) { boards(ids: [$id]) { columns { id title type } } }`,
    { id: boardId },
  );
  for (const c of boards[0].columns) {
    if (c.type === "name") continue;
    await gql(`mutation ($b: ID!, $c: String!) { delete_column(board_id: $b, column_id: $c) { id } }`, { b: boardId, c: c.id });
  }

  // ...and with placeholder items ("Task 1"), which would otherwise show up as
  // blank rows in every count.
  const seeded = await gql<{ boards: Array<{ items_page: { items: Array<{ id: string }> } }> }>(
    `query ($id: ID!) { boards(ids: [$id]) { items_page(limit: 50) { items { id } } } }`,
    { id: boardId },
  );
  for (const it of seeded.boards[0].items_page.items) {
    await gql(`mutation ($i: ID!) { delete_item(item_id: $i) { id } }`, { i: it.id });
  }

  // Create our columns, in the spreadsheet's own order.
  for (const c of cols.slice(1)) {
    const r = await gql<{ create_column: { id: string } }>(
      `mutation ($b: ID!, $t: String!, $k: ColumnType!) { create_column(board_id: $b, title: $t, column_type: $k) { id } }`,
      { b: boardId, t: c.title.slice(0, 255), k: MONDAY_TYPE[c.kind] },
    );
    c.id = r.create_column.id;
  }
  console.log(`   ${cols.length - 1} columns created`);

  // Items, batched as aliased mutations to cut round trips.
  const BATCH = 5;
  const PACE_MS = 500; // stay under monday's edge rate limiting
  let done = 0;

  for (let i = 0; i < data.length; i += BATCH) {
    const slice = data.slice(i, i + BATCH);
    const vars: Record<string, unknown> = { b: boardId };
    const decls = ["$b: ID!"];
    const bodies: string[] = [];

    slice.forEach((row, j) => {
      const values: Record<string, unknown> = {};
      for (const c of cols.slice(1)) {
        const v = cellValue(c.kind, row[c.index] ?? "");
        if (v !== undefined) values[c.id] = v;
      }
      vars[`n${j}`] = (row[cols[0].index] ?? "").trim().slice(0, 255) || `Row ${i + j + 1}`;
      vars[`v${j}`] = JSON.stringify(values);
      decls.push(`$n${j}: String!`, `$v${j}: JSON!`);
      bodies.push(`i${j}: create_item(board_id: $b, item_name: $n${j}, column_values: $v${j}, create_labels_if_missing: true) { id }`);
    });

    await gql(`mutation (${decls.join(", ")}) { ${bodies.join(" ")} }`, vars);
    done += slice.length;
    if (done % 50 < BATCH || done === data.length) console.log(`   items: ${done}/${data.length}`);
    await new Promise((r) => setTimeout(r, PACE_MS));
  }

  console.log(`\n   done — board ${boardId}`);
  return boardId;
}

/* -------------------------------------------------------------------- go */

const deals = load(findCsv(folder, /deal/i));
const work = load(findCsv(folder, /work[_ ]?order/i));

const dealsId = await buildBoard("Deal Funnel", deals.header, deals.data);
const workId = await buildBoard("Work Order Tracker", work.header, work.data);

if (!DRY) {
  console.log(`\n${"=".repeat(78)}\nAdd these to .env.local (optional - the app also finds them by name):\n  MONDAY_DEALS_BOARD_ID=${dealsId}\n  MONDAY_WORK_ORDERS_BOARD_ID=${workId}`);
  if (complexityWaits) console.log(`\n(waited on monday's complexity budget ${complexityWaits} time(s))`);
}
