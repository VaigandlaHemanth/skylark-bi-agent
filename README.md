# Skylark BI Agent

Conversational business intelligence over two live **monday.com** boards — *Deal Funnel* (344 deals) and *Work Order Tracker* (176 work orders, 38 columns).

**Live:** https://skylark-bi-agent-chi.vercel.app

Ask *"How's our pipeline looking for the energy sector?"* and it interprets the question, queries both boards, cleans the messy values, computes the numbers in code, and answers with the caveats attached.

---

## Two decisions that shape everything

### 1. The model decides *what* to compute. Code does the computing.

The LLM emits a structured query — filters, group-by, metrics. A deterministic engine ([`query.ts`](src/lib/query.ts)) returns the numbers plus their data-quality caveats. The model only interprets and narrates.

**Enforced, not asserted.** Before any answer ships, every figure in it is matched against everything the tools returned; one that fails goes back with the offending numbers named. Each answer carries the count it passed, and clicking a step chip opens the query behind it.

`npm run eval` measures the same gate against the live agent:

```
grounded   89/89 figures traced to a tool result (100%)
derived    0        fabricated 0        14/15 cases
```

[`grounding.ts`](src/lib/grounding.ts) is the same module in both places, so the measured number is the enforced one. The first run scored 85.7% — every miss a percentage the model divided in its head — which is what produced the `compute` tool.

### 2. The board's vocabulary is never rewritten. *Your* wording is translated onto it.

```
you ask:      sector = "energy"
board holds:  Renewables, Mining, Railways, Powerline, DSP, Tender, …
agent uses:   Renewables + Powerline        ← and says so
```

Normalising `Renewables` into `Energy` would make every answer disagree with what a founder sees in monday. So values stay verbatim and the mapping runs the other way, at query time. Every resolution is reported back. A word that resolves to nothing lists what the board *does* contain instead of returning a silent zero.

---

## Architecture

```
Browser  ──POST /api/chat──▶  Agent loop (max 6 tool steps)
                                 │
                                 ├── LLM adapter — 4 Gemini rungs + Groq, by env var
                                 │
                                 └── Tools
                                     ├── list_boards_and_fields   schema, vocabulary, warnings
                                     ├── distinct_values          what a field actually holds
                                     ├── query_board              filter · group · aggregate
                                     ├── compute                  shares, deltas, ratios
                                     ├── compare_boards           sales vs delivery
                                     ├── sample_rows              raw cells, per-row issues
                                     ├── data_quality             fill rates, duplicates
                                     └── leadership_brief         exec snapshot in one call
                                              │
                            store.ts + normalize.ts — discovery, mapping, 5-min cache
                                              │
                            monday.com GraphQL v2 — READ ONLY, paginated, retried
```

| File | Does |
| --- | --- |
| `monday.ts` | GraphQL client: pagination, retry, typed errors |
| `normalize.ts` | 8 date formats, Excel serials, `12,00,000` / `$1.2M` / `12 lakhs`, quantities with units |
| `store.ts` | Reads the board's real schema, maps columns, indexes vocabulary, drops repeated header rows |
| `query.ts` | Filter / group / aggregate, term resolution, timeframes, caveats |
| `compare.ts` | Cross-board comparison on sector or owner |
| `grounding.ts` | The gate: every figure must trace to a tool result |
| `followups.ts` | Next questions derived from the trace, not from a static list |
| `agent.ts` | System prompt + tool loop |
| `page.tsx` | Chat UI — Apple-HIG-influenced, reduced-motion/transparency aware |

**No hardcoded CSV.** Every figure is fetched from monday at request time. Delete the boards and it correctly reports having no data.

**Column mapping is discovered.** It reads `boards { columns { id title type } }` and scores each against a synonym list, boosted by monday's column type. On the real export it resolved all 12 deal columns and 33 of 38 work-order columns with no code change:

```
value       ← "Masked Deal value"              close_date  ← "Tentative Close Date"
receivable  ← "Amount Receivable (Masked)"     owner       ← "BD/KAM Personnel code"
```

The five misses are empty columns; they stay queryable by exact title.

---

## Setup

**1. Keys** — a monday.com account, then **avatar → Developers → My access tokens**. A model key is free with no card: [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (`GROQ_API_KEY` and `ANTHROPIC_API_KEY` also work).

```bash
npm install
```

`.env.local` — needed before step 2, because the import script reads the same token:
```
GEMINI_API_KEY=...
MONDAY_API_TOKEN=...
MONDAY_DEALS_BOARD_ID=          # optional, auto-detected by name
MONDAY_WORK_ORDERS_BOARD_ID=
```

**2. Boards** — either way:

```bash
npx tsx scripts/import-to-monday.mts <folder-with-the-two-csvs>   # --dry to preview
```

Or **Add → Import data → Excel** per file. Two things matter if you import by hand:

- *The work order sheet has a blank first row — pick row 2 as the header.*
- Name the boards so auto-detection finds them: the deal board's name must contain **deal**, **funnel**, **pipeline**, **sales**, **lead** or **crm**; the work order board's must contain **work order**, **wo tracker**, **execution**, **delivery**, **operations** or **project**. Any other name works too — set the two board-id variables instead.

Values upload verbatim; the messy data is the point. This is the only script that writes to monday.

**3. Run**

```bash
npm run dev
```

`GET /api/health` reports whether the model and both boards are reachable; the UI shows a setup banner listing anything missing.

**4. Deploy** — `npx vercel`, add the same env vars, redeploy.

**5. Verify without keys**

```bash
npm test        # 264 checks, no network
```

- `npm run selftest` — 207 checks: every date format, currency form, timeframe, the filter/aggregate engine, the grounding gate
- `npm run e2etest` — 57 checks: full chain with `fetch` stubbed to a board whose headers deliberately *don't* match the field names
- `npm run eval` — needs keys: 15 founder questions against the live agent

Every push to `master` runs both suites in GitHub Actions and deploys to production only if they pass ([`deploy.yml`](.github/workflows/deploy.yml)).

---

## What it handles

**Messy data.** Dates as `2026-07-15`, `15/07/2026`, `Aug-25`, `Q3 2026`, or an Excel serial. Amounts as `12,00,000`, `$1.2M`, `12 lakhs`, `(5000)`. Quantities as `5360 HA`. Blanks as ``, `-`, `N/A`, `TBD`.

**Genuine ambiguity.** `03/04/2026` can't be resolved per row, so the whole column is scanned: any day above 12 settles it. If the column is entirely ambiguous it assumes day-first **and says so**.

**Missing data.** Never silently dropped. Rows with a null are excluded from that sum and counted in a caveat — and if the answer omits a material caveat, the engine appends it.

**API failures.** Bad token, missing board, rate limit — each surfaces with the specific fix.

---

## Try these

- How's our pipeline looking for the energy sector?
- Where is pipeline strong but delivery lagging?
- What's our win rate, and where are we losing?
- How much is sitting in receivables, and with whom?
- What is our revenue? *(it should ask which you mean)*
- Prepare the leadership update for FY26 → then **Export**

Trade-offs and limits: [`DECISION_LOG.md`](DECISION_LOG.md).
