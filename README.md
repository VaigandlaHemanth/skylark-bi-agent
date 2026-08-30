# Skylark BI Agent

A conversational business-intelligence agent over two live **monday.com** boards — the *Deal Funnel* (344 deals) and the *Work Order Tracker* (176 work orders, 38 columns).

Ask *"How's our pipeline looking for the energy sector this quarter?"* and it interprets the question, queries both boards through the monday.com API, cleans the messy values, computes the numbers in code, and answers with the caveats attached.

---

## Two decisions that shape everything

### 1. The model decides *what* to compute. Code does the computing.

The LLM never adds, averages or estimates anything. It emits a structured query — filters, group-by, metrics — and a deterministic engine ([`src/lib/query.ts`](src/lib/query.ts)) returns the numbers plus a list of data-quality caveats. The model's only jobs are understanding the question and narrating the result.

That removes the biggest failure mode of an LLM-over-spreadsheet tool: confidently wrong arithmetic.

It is **enforced, not asserted**. Before any answer ships, every figure in it is matched against everything the tools returned; one that fails is sent back with the offending numbers named. Each answer carries the count it passed, and clicking a step chip opens the query behind the figures — the filters, what the wording resolved to, the rows matched, the caveats.

`npm run eval` measures the same gate against the live agent and live boards:

```
grounded   95/95 figures traced to a tool result (100%)
derived    0        fabricated 0
```

`src/lib/grounding.ts` is the same module in both places, so the number reported is the number enforced. The first run scored 85.7% — every miss a percentage the model had divided in its head — which is what produced the `compute` tool and per-group shares.

### 2. The board's vocabulary is never rewritten. The *user's* wording is translated onto it.

The obvious move is to normalise `Renewables`, `Powerline` and `Solar` into one label like `Energy`. That is wrong here: these boards carry Skylark's own taxonomy, and rewriting it would make every answer disagree with what a founder sees in monday.com.

So values are stored verbatim, and the mapping runs the other way — at query time:

```
you ask:      sector = "energy"
board holds:  Renewables, Mining, Railways, Others, Powerline, Construction, DSP, Tender, …
agent uses:   Renewables + Powerline        ← and says so in the answer

you ask:      stage = "negotiation"
board holds:  A. Lead Generated … F. Negotiations … O. Not Relevant at all
agent uses:   F. Negotiations
```

Every resolution is reported back in `resolved_values`, so the founder can see and correct the interpretation. If a word resolves to nothing, the answer lists what the board *does* contain instead of silently returning zero.

---

## Architecture

```
Browser (Next.js client)
   │  POST /api/chat        Server-Sent Events: status · tool · tool_result · answer
   ▼
Agent loop  ─ src/lib/agent.ts     max 6 tool steps; the board's real schema AND its real
   │                                vocabulary are injected into the system prompt
   ├── LLM adapter ─ src/lib/llm.ts   Gemini (default, free) │ Groq │ Anthropic — by env var
   │
   └── Tools ─ src/lib/tools.ts
         ├── list_boards_and_fields   schema + mapping + vocabulary + warnings
         ├── distinct_values          what values a field actually holds
         ├── query_board              filter · group · aggregate  ← every number comes from here
         ├── sample_rows              raw + cleaned cells, per-row issues
         ├── data_quality             fill rates, unreadable values, duplicate clients
         ├── compute                  shares, deltas, ratios  ← so the model never divides
         └── leadership_brief         full exec snapshot in one call
                    │
                    ▼
         Store ─ src/lib/store.ts      board discovery · fuzzy column mapping ·
         Normalize ─ src/lib/normalize.ts    vocabulary index · 5-min cache
                    │
                    ▼
         monday.com GraphQL v2 ─ src/lib/monday.ts    READ ONLY, cursor-paginated, retried
```

| File | Responsibility |
| --- | --- |
| `src/lib/monday.ts` | GraphQL client. Pagination, retry/backoff, typed errors, a fallback query for older API versions. |
| `src/lib/normalize.ts` | Dates (8 formats + Excel serials + quarters), currency (`12,00,000`, `$1.2M`, `12 lakhs`, `(500)`), quantities with units (`5360 HA`), concept tables for term resolution. |
| `src/lib/store.ts` | Reads the board's **real** schema, maps columns onto canonical fields, indexes the vocabulary, drops repeated header rows, builds the data-quality report. |
| `src/lib/query.ts` | Filter / group / aggregate engine, term resolution, timeframe parsing, caveat generation. |
| `src/lib/brief.ts` | The "leadership update" assembly, including the cash/AR block. |
| `src/lib/agent.ts` | System prompt + tool loop. |
| `src/app/page.tsx` | Chat UI — Apple-HIG-influenced: system type with size-specific tracking, translucent chrome, spring easing, reduced-motion/transparency/contrast support. |

### No hardcoded CSV

Nothing from the source spreadsheets is committed. Every figure is fetched from monday.com at request time (5-minute in-process cache). Delete the boards and the app correctly reports that it has no data.

### Column mapping is discovered, not assumed

The app does **not** assume the import produced particular headers. It reads `boards { columns { id title type } }` and scores each column against a synonym list per canonical field, boosted by monday's own column type. Against the real assignment export it resolves all 12 deal columns and 33 of 38 work-order columns:

```
value             <- "Masked Deal value"                          100%
close_date        <- "Tentative Close Date"                       100%
actual_close_date <- "Close Date (A)"                             100%
receivable        <- "Amount Receivable (Masked)"                 100%
unbilled          <- "Amount to be billed in Rs. (Exl. of GST)"   100%
owner             <- "BD/KAM Personnel code"                       99%
```

The five unmatched work-order columns are empty in the export; they stay queryable by their exact title.

---

## Setup

### 1. monday.com

1. Create a free account at [monday.com](https://monday.com).
2. Get a token: **avatar → Developers → My access tokens → Show**, and put it in `.env.local`.
3. Create the boards, either way:

   **Scripted** (one command, picks column types from the data):

   ```bash
   npx tsx scripts/import-to-monday.mts <folder-with-the-two-csvs>
   ```

   Add `--dry` to see the plan without writing. It is idempotent — re-running replaces a half-finished board rather than duplicating it — and it uploads values **verbatim**, because the messy data is the point of the exercise. This is the only script that writes to monday; the agent itself is read-only.

   **By hand** — **Add → Import data → Excel**, once per file:
   - `Deal funnel Data.xlsx` → board **Deal Funnel**
   - `Work_Order_Tracker Data.xlsx` → board **Work Order Tracker**

   > The work order sheet has a **blank first row** — when monday asks which row holds the headers, pick row 2.

Then confirm what the app will see:

```bash
npm run inspect:boards
```

### 2. Model key (free)

Get a **Google AI Studio** key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — no credit card, free tier ~15 req/min.

`GROQ_API_KEY` and `ANTHROPIC_API_KEY` also work; whichever is set is used, with `LLM_PROVIDER` as an override.

### 3. Run

```bash
npm install
```

Create `.env.local`:

```
GEMINI_API_KEY=...
MONDAY_API_TOKEN=...
# optional — auto-detected from board names if omitted
MONDAY_WORK_ORDERS_BOARD_ID=
MONDAY_DEALS_BOARD_ID=
```

```bash
npm run dev
```

Open `http://localhost:3000`. `GET /api/health` reports whether the model and both boards are reachable, and the UI shows a setup banner listing anything missing.

### 4. Deploy (Vercel)

```bash
npx vercel
```

Add the same environment variables in **Project → Settings → Environment Variables**, then redeploy. No other configuration is needed — it is a single Next.js app.

### 5. Verify without any keys

```bash
npm test
```

**184 checks, no network and no API keys:**

- **`npm run selftest`** — 132 checks on the deterministic layer: every date format, currency form, quantity form, concept resolution, timeframe expression, and the filter/group/aggregate engine including null handling and caveat generation.
- **`npm run eval`** — measures the agent itself against live boards: 15 founder questions, checking that every figure in the prose traces back to a tool result. Needs API keys. Latest: **96.8% grounded, 0 fabricated**.
- **`npm run e2etest`** — 52 checks on the full chain, with `fetch` stubbed to serve two boards built from the **real** column headers and **real** vocabulary (`Masked Deal value`, `F. Negotiations`, `Executed until current month`, a repeated header row, `5360 HA`). It asserts the mapper resolves them, then runs the real agent loop end to end.

There is also a development aid for checking the mapping against the actual spreadsheets before importing them:

```bash
npx tsx scripts/verify-real-data.mts <folder-with-the-two-csvs>
```

It prints the inferred mapping, the vocabulary found, fill rates, warnings, and the answers to a battery of founder questions. The app itself never reads those files.

---

## What it handles in this data

| Reality in the export | What the app does |
| --- | --- |
| The header row is repeated twice inside the deals data | Detects rows echoing ≥3 column titles, drops them, and reports the count |
| Work order sheet starts with a blank row | Import guidance above; the app reads whatever monday ends up with |
| `Masked Deal value` is only **48% filled** | Sums exclude blanks and every answer carries the count that was excluded |
| Deal Stage is a lettered ladder (`A.` … `O.`) | Preserved verbatim; "negotiation" resolves to `F. Negotiations` |
| `Closure Probability` is High/Medium/Low, not a % | Treated as a label, and the brief groups open pipeline by it |
| `Quantities as per PO` mixes `5360 HA`, `45days`, `NA`, `Rate based on MW slabs` | Number and unit split apart; prose values become null **and are listed in the warnings** |
| `Balance in quantity` has negative values | Parsed, not discarded |
| The platform column answers `NONE` 127 times | Kept as a real answer, not treated as an empty cell |
| Two boards both have a field called `status` with different meanings | Concept tables are looked up per board |
| 38 money/quantity/status columns on the work order board | Mapped into `value`, `billed`, `collected`, `unbilled`, `receivable`, so cash questions work |

**Ambiguity it can't resolve alone.** `03/04/2026` is genuinely ambiguous. Rather than guess per row, the app scans the whole column: if any value has a first component above 12 the column must be day-first. If the column is *entirely* ambiguous it assumes day-first **and says so in the answer**.

**API failures.** Bad token, missing board, rate limit, network error — each surfaces as a specific message with the fix, both in the chat and in the setup banner.

---

## Example questions

- How's our pipeline looking for the energy sector this quarter?
- Prepare the leadership update for FY26
- What's our win rate, and where are we losing?
- How much is sitting in receivables, and with whom?
- How much work is overdue?
- Which sectors are we selling into but not delivering?
- How reliable is the deal value column?

---

## Trade-offs and limits

See [`DECISION_LOG.md`](DECISION_LOG.md). Briefly: read-only by design; a 5-minute cache instead of live-per-query; a single-process cache that resets on cold start; calendar quarters by default with Indian FY via "FY26" wording; and a fixed 6-step tool budget per question.
