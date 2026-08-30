/**
 * Setup helper. Run after importing the two spreadsheets into monday.com:
 *
 *   MONDAY_API_TOKEN=xxx node scripts/inspect-boards.mjs
 *
 * Prints every board the token can read, its columns and types, and a couple of
 * sample rows - so you can confirm the board ids and see how the import landed.
 */

const token = process.env.MONDAY_API_TOKEN;
if (!token) {
  console.error("Set MONDAY_API_TOKEN first.\n  PowerShell:  $env:MONDAY_API_TOKEN=\"...\"; node scripts/inspect-boards.mjs");
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { Authorization: token, "API-Version": "2024-10", "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data;
}

const { boards } = await gql(`
  query {
    boards(limit: 100, state: active) {
      id
      name
      items_count
      columns { id title type }
    }
  }
`);

if (!boards?.length) {
  console.log("This token can see no boards. Check the token, or share the boards with that user.");
  process.exit(0);
}

for (const b of boards) {
  console.log(`\n${"=".repeat(72)}\n${b.name}\n  board id : ${b.id}\n  rows     : ${b.items_count}`);
  console.log("  columns  :");
  for (const c of b.columns) console.log(`    - ${c.title.padEnd(28)} ${c.type}`);

  const sample = await gql(
    `query ($id: ID!) {
       boards(ids: [$id]) {
         items_page(limit: 2) { items { name column_values { id text } } }
       }
     }`,
    { id: b.id },
  );

  const titles = Object.fromEntries(b.columns.map((c) => [c.id, c.title]));
  for (const it of sample.boards[0].items_page.items) {
    const cells = it.column_values
      .filter((c) => c.text)
      .map((c) => `${titles[c.id] ?? c.id}=${JSON.stringify(c.text)}`)
      .join("  ");
    console.log(`  sample   : ${it.name} | ${cells}`);
  }
}

console.log(`\n${"=".repeat(72)}\nAdd the two ids to .env.local as:\n  MONDAY_WORK_ORDERS_BOARD_ID=...\n  MONDAY_DEALS_BOARD_ID=...\n(Optional - the app also auto-detects them by board name.)`);
