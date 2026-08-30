/**
 * Agent evaluation: does the agent choose the right query, and is every number
 * it writes traceable to a tool result?
 *
 * The engine has unit tests. This measures the part they cannot: the model's
 * judgement. The headline metric is GROUNDING - each figure in the prose is
 * matched back to a figure the deterministic engine returned. An ungrounded
 * number is the model doing arithmetic in its head, which is the one failure
 * this architecture exists to prevent.
 *
 *   npm run eval              # all cases
 *   npm run eval -- grounding # only cases whose id contains "grounding"
 *
 * Needs a model key and MONDAY_API_TOKEN in .env.local. Free tiers rate-limit,
 * so cases run with a pause between them and a rate-limited case is reported
 * as SKIPPED, never as a failure.
 */

import fs from "node:fs";

for (const line of (fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
  if (m && m[2]) process.env[m[1]] ??= m[2];
}

const { runAgent } = await import("../src/lib/agent");
const { executeTool } = await import("../src/lib/tools");
const { boardsOverview } = await import("../src/lib/store");

/**
 * The system prompt carries the board schema, its vocabulary with row counts,
 * and the data-quality warnings ("only 48% filled"). Those come from the same
 * deterministic layer as tool results, so a figure quoted from them is
 * grounded - counting it as fabricated would be wrong.
 */
const PROMPT_FACTS = await boardsOverview();

/* ------------------------------------------------------------------- cases */

type Case = {
  id: string;
  q: string;
  /** Tool names at least one of which must be called. */
  expectTool?: string[];
  /** Board the answer should have come from. */
  expectBoard?: "deals" | "work_orders";
  /** Board values a filter term must resolve to. */
  expectResolved?: string[];
  /** Lower-cased substrings the prose should contain. */
  expectMentions?: string[];
};

const CASES: Case[] = [
  {
    id: "vocab-energy",
    q: "How's our pipeline looking for the energy sector?",
    expectTool: ["query_board", "distinct_values"],
    expectBoard: "deals",
    expectResolved: ["Renewables", "Powerline"],
  },
  {
    id: "vocab-negotiation",
    q: "How many deals are sitting in negotiation, and what are they worth?",
    expectTool: ["query_board"],
    expectBoard: "deals",
    expectResolved: ["F. Negotiations"],
  },
  { id: "grounding-receivables", q: "How much is sitting in receivables, and with whom?", expectTool: ["query_board"], expectBoard: "work_orders" },
  { id: "grounding-winrate", q: "What's our win rate, and where are we losing?", expectTool: ["query_board", "leadership_brief"], expectBoard: "deals" },
  { id: "grounding-share", q: "What share of our open pipeline is the top sector?", expectTool: ["query_board", "compute"], expectBoard: "deals" },
  { id: "ops-overdue", q: "How much work is overdue?", expectTool: ["query_board"], expectBoard: "work_orders" },
  { id: "brief", q: "Prepare the leadership update for FY26", expectTool: ["leadership_brief"] },
  {
    id: "caveat-sparse",
    q: "What is the total value of all our deals?",
    expectTool: ["query_board"],
    expectBoard: "deals",
    // 48% fill on Masked Deal value - an answer that hides this is misleading.
    expectMentions: ["blank", "fill", "48", "missing", "excluded", "populated", "sparse"],
  },
  { id: "quality", q: "How reliable is the deal value column?", expectTool: ["data_quality", "query_board"], expectBoard: "deals" },
  {
    id: "unknown-value",
    q: "How's our pipeline in the banking sector?",
    expectTool: ["query_board", "distinct_values"],
    // Must not silently answer "zero" for a sector the board has never heard of.
    expectMentions: ["no ", "not ", "does not", "n/a", "none", "banking"],
  },
];

/* --------------------------------------------------------------- grounding */

// The very module the agent gates on, so this metric is the guarantee.
const { numbersIn, numbersInProse, isNoise, isGrounded, classify } = await import("../src/lib/grounding");

/* -------------------------------------------------------------------- run */

// Gemini's free tier allows only a handful of requests per minute and each
// case costs several, so cases are deliberately spaced out.
const PAUSE_MS = Number(process.env.EVAL_PAUSE_MS ?? 20000);

const filter = process.argv.slice(2).find((a) => !a.startsWith("-"));
const cases = filter ? CASES.filter((c) => c.id.includes(filter)) : CASES;

type Result = {
  id: string;
  status: "pass" | "fail" | "skip";
  reasons: string[];
  grounded: number;
  checked: number;
  ungrounded: number[];
  derived: number[];
  fabricated: number[];
  tools: string[];
  ms: number;
};

const results: Result[] = [];

for (const c of cases) {
  const started = Date.now();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let answer = "";
  let error = "";

  for await (const ev of runAgent([{ role: "user", content: c.q }])) {
    if (ev.type === "tool") calls.push({ name: ev.name, args: ev.args });
    if (ev.type === "answer") answer = ev.text;
    if (ev.type === "error") error = ev.text;
  }

  const ms = Date.now() - started;

  if (error) {
    const rateLimited = /429|rate limit|413|tokens-per-minute|provider failed/i.test(error);
    results.push({
      id: c.id,
      status: rateLimited ? "skip" : "fail",
      reasons: [rateLimited ? `free-tier limit: ${error.slice(0, 90)}` : error.slice(0, 140)],
      grounded: 0, checked: 0, ungrounded: [], derived: [], fabricated: [], tools: calls.map((x) => x.name), ms,
    });
    console.log(`${rateLimited ? "SKIP" : "FAIL"}  ${c.id}`);
    await new Promise((r) => setTimeout(r, PAUSE_MS));
    continue;
  }

  // Re-run each tool call to recover the full payload. The dataset is cached,
  // so this reproduces exactly what the model was shown.
  const pool = numbersIn(PROMPT_FACTS);
  for (const call of calls) {
    try {
      numbersIn(await executeTool(call.name, call.args), pool);
    } catch {
      /* a tool that failed for the agent gives it no numbers either */
    }
  }

  const prose = numbersInProse(answer).filter((n) => !isNoise(n));
  const ungrounded = prose.filter((n) => !isGrounded(n, pool));

  const derived = ungrounded.filter((n) => classify(n, pool) === "derived");
  const fabricated = ungrounded.filter((n) => classify(n, pool) === "fabricated");

  const reasons: string[] = [];
  if (fabricated.length) reasons.push(`${fabricated.length} FABRICATED figure(s), no basis in retrieved data: ${fabricated.slice(0, 4).join(", ")}`);
  if (derived.length) reasons.push(`${derived.length} figure(s) the model derived itself instead of calling compute: ${derived.slice(0, 4).join(", ")}`);

  const names = calls.map((x) => x.name);
  if (c.expectTool && !c.expectTool.some((t) => names.includes(t))) {
    reasons.push(`expected one of [${c.expectTool.join(", ")}], called [${names.join(", ") || "none"}]`);
  }
  if (c.expectBoard && !calls.some((x) => x.args?.board === c.expectBoard)) {
    reasons.push(`expected the ${c.expectBoard} board`);
  }
  if (c.expectResolved) {
    const seen = JSON.stringify(calls);
    const lower = answer.toLowerCase();
    const missing = c.expectResolved.filter((v) => !seen.includes(v) && !lower.includes(v.toLowerCase()));
    if (missing.length) reasons.push(`did not resolve onto: ${missing.join(", ")}`);
  }
  if (c.expectMentions) {
    const lower = answer.toLowerCase();
    if (!c.expectMentions.some((m) => lower.includes(m))) reasons.push(`answer mentions none of: ${c.expectMentions.join(" / ")}`);
  }

  const status = reasons.length ? "fail" : "pass";
  results.push({ id: c.id, status, reasons, grounded: prose.length - ungrounded.length, checked: prose.length, ungrounded, derived, fabricated, tools: names, ms });
  console.log(`${status === "pass" ? "PASS" : "FAIL"}  ${c.id}  (${prose.length - ungrounded.length}/${prose.length} figures grounded, ${(ms / 1000).toFixed(1)}s)`);

  await new Promise((r) => setTimeout(r, PAUSE_MS)); // stay inside free-tier limits
}

/* ----------------------------------------------------------------- report */

const ran = results.filter((r) => r.status !== "skip");
const passed = ran.filter((r) => r.status === "pass").length;
const checked = ran.reduce((n, r) => n + r.checked, 0);
const grounded = ran.reduce((n, r) => n + r.grounded, 0);
const skipped = results.length - ran.length;

console.log(`\n${"=".repeat(74)}`);
console.log(`  cases      ${passed}/${ran.length} passed${skipped ? `  (${skipped} skipped: free-tier limits)` : ""}`);
const derivedTotal = ran.reduce((n, r) => n + r.derived.length, 0);
const fabricatedTotal = ran.reduce((n, r) => n + r.fabricated.length, 0);
console.log(`  grounded   ${grounded}/${checked} figures traced to a tool result${checked ? ` (${((grounded / checked) * 100).toFixed(1)}%)` : ""}`);
console.log(`  derived    ${derivedTotal}  (arithmetic the model did itself - should have called compute)`);
console.log(`  fabricated ${fabricatedTotal}  (no basis in retrieved data)`);
if (ran.length) console.log(`  latency    ${(ran.reduce((n, r) => n + r.ms, 0) / ran.length / 1000).toFixed(1)}s average`);
console.log("=".repeat(74));

for (const r of results.filter((x) => x.reasons.length)) {
  console.log(`\n${r.status.toUpperCase()}  ${r.id}   tools: ${r.tools.join(" → ") || "none"}`);
  for (const reason of r.reasons) console.log(`      ${reason}`);
}

process.exit(results.some((r) => r.status === "fail") ? 1 : 0);
