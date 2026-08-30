# Skylark BI Agent

A conversational business-intelligence agent over two live **monday.com** boards — *Work Orders* (project execution) and *Deals* (sales funnel).

Ask *"How's our pipeline looking for the energy sector this quarter?"* and it interprets the question, queries both boards through the monday.com API, cleans the messy values, computes the numbers in code, and answers with the caveats attached.

---

## The one design decision that matters

> **The model decides *what* to compute. Code does the computing.**

The LLM never adds, averages or estimates anything. It emits a structured query — filters, group-by, metrics — and a deterministic engine ([`src/lib/query.ts`](src/lib/query.ts)) returns the numbers plus a list of data-quality caveats. The model's only jobs are understanding the question and narrating the result.

That removes the single biggest failure mode of an LLM-over-spreadsheet tool: confidently wrong arithmetic.

---

## Architecture

```
Browser (Next.js client)
   │  POST /api/chat        Server-Sent Events: status · tool · tool_result · answer
   ▼
Agent loop  ─ src/lib/agent.ts        max 6 tool steps, board schema injected into the system prompt
   │
   ├── LLM adapter ─ src/lib/llm.ts   Gemini (default, free) │ Groq │ Anthropic — chosen by env var
   │
   └── Tools ─ src/lib/tools.ts
         ├── list_boards_and_fields   schema + column mapping + warnings
         ├── query_board              filter · group · aggregate  ← every number comes from here
         ├── sample_rows              raw + cleaned cells, per-row issues
         ├── data_quality             fill rates, unmapped values, duplicate clients
         └── leadership_brief         full exec snapshot in one call
                    │
                    ▼
         Store ─ src/lib/store.ts     board discovery · fuzzy column mapping · 5-min cache
         Normalize ─ src/lib/normalize.ts
                    │
                    ▼
         monday.com GraphQL v2 ─ src/lib/monday.ts     READ ONLY, cursor-paginated, retried
```

| File | Responsibility |
| --- | --- |
| `src/lib/monday.ts` | GraphQL client. Pagination, retry/backoff, typed errors, a fallback query for older API versions. |
| `src/lib/normalize.ts` | Dates (7 formats + Excel serials + quarters), currency (`₹1.2L`, `45k`, `(500)`), controlled vocabularies, company-name keys. |
| `src/lib/store.ts` | Reads the board's **real** schema and maps columns onto canonical fields by synonym + column-type scoring. Builds the data-quality report. |
| `src/lib/query.ts` | Filter / group / aggregate engine, timeframe resolution, caveat generation. |
| `src/lib/brief.ts` | The "leadership update" assembly. |
| `src/lib/agent.ts` | System prompt + tool loop. |
| `src/app/page.tsx` | Chat UI — Apple-HIG-influenced: system type, translucent chrome, spring easing, reduced-motion/transparency/contrast support. |

### No hardcoded CSV

Nothing from the source spreadsheets is committed. Every figure is fetched from monday.com at request time (5-minute in-process cache). Delete the boards and the app correctly reports that it has no data.

### Column mapping is discovered, not assumed

The app does **not** assume the import produced particular headers. It reads `boards { columns { id title type } }` and scores each column against a synonym list per canonical field, boosted by monday's own column type:

```
value  ← "Deal Value (INR)"   numbers   94% match
sector ← "Industry"           dropdown  88% match
close_date ← "Expected Close" date      91% match
```

So renaming a column, reordering, or importing under different headers does not break it. Unmapped columns are still readable — filter on the exact column title and the query engine falls back to raw cell text.

---

## Setup

### 1. monday.com

1. Create a free account at [monday.com](https://monday.com).
2. Import each spreadsheet as its own board — **Add → Import data → Excel**:
   - `Work_Order_Tracker Data.xlsx` → board named e.g. **Work Orders**
   - `Deal funnel Data.xlsx` → board named e.g. **Deals**
3. During import, set column types where monday offers: **Date** for date columns, **Numbers** for value/amount, **Status** or **Dropdown** for sector/stage/status. *(Not required — the app parses text columns too — but it makes monday itself nicer to browse.)*
4. Get a token: **avatar → Developers → My access tokens → Show**. Read scope is enough.

Then confirm what the app will see:

```bash
node scripts/inspect-boards.mjs
```

It prints every board id, every column with its type, and two sample rows.

### 2. Model key (free)

Get a **Google AI Studio** key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — no credit card, free tier is ~15 req/min.

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

Two suites, no network and no API keys:

- **`npm run selftest`** — 63 checks on the deterministic layer: every date format, currency form, vocabulary alias, timeframe expression, and the filter/group/aggregate engine including null handling and caveat generation.
- **`npm run e2etest`** — 39 checks on the full chain with `fetch` stubbed to serve a messy monday.com board whose headers deliberately *do not* match the canonical field names (`Industry`, `Funnel Stage`, `Deal Value (INR)`, `Expected Closure`). It asserts the mapper resolves them anyway, then runs the real agent loop end to end.

---

## What it handles

**Messy data.** Dates as `2026-07-15`, `15/07/2026`, `15-Jul-26`, `Jul 2026`, `Q3 2026`, or an Excel serial. Amounts as `₹12,00,000`, `$1.2M`, `45k`, `12 lakhs`, `(5000)`. Sectors as `Energy`, `energy sector`, `Renewables`, `Solar EPC` — all folded to one label. Blanks as ``, `-`, `N/A`, `TBD`, `#N/A`.

**Ambiguity it can't resolve alone.** `03/04/2026` is genuinely ambiguous. Rather than guess per row, the app scans the whole column: if any value has a first component above 12 the column must be day-first. If the column is *entirely* ambiguous it assumes day-first **and says so in the answer**.

**Missing data.** Never silently dropped. Rows with a null in an aggregated field are excluded from that sum and counted in a caveat: *"18 of 74 matched deals have no value; they're excluded from the total."*

**API failures.** Bad token, missing board, rate limit, network error — each surfaces as a specific message with the fix, both in the chat and in the setup banner.

---

## Example questions

- How's our pipeline looking for the energy sector this quarter?
- Prepare the leadership update for this quarter
- Which sectors are we winning in, and which are stalling?
- Any work orders running late?
- Which clients appear in both the deal funnel and the work order tracker?
- How reliable is the deals data?

---

## Trade-offs and limits

See [`DECISION_LOG.md`](DECISION_LOG.md). Briefly: read-only by design; a 5-minute cache instead of live-per-query; a single-process cache that resets on cold start; calendar quarters by default (Indian FY supported via "FY26" wording); and a fixed 6-step tool budget per question.
