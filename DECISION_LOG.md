# Decision Log — monday.com Business Intelligence Agent

## 1. Assumptions

**About the data.** I built schema discovery before I had the spreadsheets, so the app assumes nothing about column names — it reads the board's real schema and maps it. When the real export arrived (344 deals × 12 columns, 176 work orders × 38 columns) all 12 deal columns and 33 of 38 work-order columns mapped without a code change. The five that did not are entirely empty in the export.

**About vocabulary.** The boards carry Skylark's own taxonomy: sectors are `Renewables / Mining / Railways / Powerline / DSP / Tender / Others`, and Deal Stage is a lettered ladder `A. Lead Generated → O. Not Relevant at all`. I assumed a founder would ask in plain English ("energy", "negotiation") and expect the answer to still line up with what monday shows. See §2.

**About units.** Values are masked and scaled — the work order board mixes `264398.08` with `1.2332` in the same column. I report magnitudes exactly as stored and never attach a currency symbol, because a wrong unit on a founder-facing number is worse than an unadorned one. Multipliers written *inside* a cell (`12 lakhs`, `$1.2M`) are expanded, and the expansion is recorded per row.

**About quarters.** Default is the **calendar** quarter; `FY26` and "this financial year" give the Indian Apr–Mar year. Silently switching would be worse than stating the assumption, so the agent always says which it used.

**About "revenue".** It is genuinely ambiguous across these two boards — won deal value (sales) or billed/collected work-order value (finance). The agent picks the likelier reading, says which, and offers the other in one clause.

**About scope.** monday.com access is read-only, as specified. Nothing writes back.

---

## 2. Key trade-offs

### The model never does arithmetic
The LLM emits a structured query; a deterministic engine computes it. **Cost:** the agent can only answer questions expressible in that DSL, and a genuinely novel calculation needs new tool code. **Benefit:** no hallucinated figures, and every number is reproducible and auditable. For a founder-facing BI tool that trade was not close.

### Preserve the board's vocabulary; translate the user's words instead
My first design canonicalised values at ingest — `Renewables → Energy`, `F. Negotiations → Negotiation`. The real data showed that is actively harmful: it destroys Skylark's own taxonomy, makes totals disagree with monday, and silently drops values that fit no bucket (`DSP`, `Tender`). So values are stored verbatim and the concept tables run the other way, at query time: the user's word is resolved onto the values the board holds (`"energy"` → `Renewables + Powerline`), and the resolution is reported back in the answer.

**Cost:** a resolution step on every text filter, and matching precedence (exact → substring → concept) that occasionally over-matches — asking for "lead" also returns "Sales Qualified Leads". **Benefit:** answers always reconcile with the board, unmapped values survive, and a wrong interpretation is visible rather than silent. The over-match is the right failure direction: it is stated, so the user can narrow it.

### Fuzzy column mapping over a hardcoded schema
Columns are matched by synonym scoring boosted by monday's column type. **Cost:** ~130 lines of scoring, and a mis-map is possible. **Benefit:** it survived first contact with a 38-column sheet I had never seen, and the mapping is exposed (`data_quality` shows `receivable ← "Amount Receivable (Masked)" · 100%`), so a mis-map is visible.

### Column-level date disambiguation
`03/04/2026` cannot be resolved from one row. I scan the whole column: if *any* value has a first component above 12, the column is day-first. Only if the column is entirely ambiguous do I default to day-first — and surface it as a caveat.

### Caveats as data, not prose
Every result carries a `caveats[]` array built by the engine (nulls excluded from sums, blank groups, unresolved filter terms, dropped header rows, low fill rates). The model is told to fold the material ones in. **Cost:** longer answers. **Benefit:** with `Masked Deal value` only 48% filled, this is the difference between a defensible number and a misleading one — and the caveat is generated whether or not the model thinks to mention it.

### Pluggable LLM, free tier by default
Gemini (free tier), Groq, or Anthropic, chosen by whichever key is present. **Cost:** an adapter layer instead of one SDK; free models are weaker at multi-step tool use. **Benefit:** the hosted demo runs with no billing account, which is what makes it testable by a reviewer. The tool DSL was deliberately kept string-valued and shallow so a free-tier model can drive it, and the board's actual vocabulary is injected into the system prompt so the model rarely has to guess a value at all.

### 5-minute cache instead of per-query fetching
Both boards are pulled whole and cached in-process. **Cost:** answers can be up to 5 minutes stale; the cache dies on a serverless cold start. **Benefit:** a multi-tool question makes one API round trip instead of six, which keeps responses inside a serverless timeout and well inside monday's rate limits. At 520 rows this is clearly right; at 100k rows it would not be.

### Next.js single deployable
One app, one deploy, SSE streaming so the user watches each tool call rather than a 20-second blank. **Cost:** no separate API for other consumers. **Benefit:** meets "testable without local setup" with one `vercel` command.

---

## 3. How I interpreted "help prepare data for leadership updates"

**A founder should not have to ask six questions to write the weekly update.**

`leadership_brief` is one tool call that assembles the whole snapshot deterministically:

- **Pipeline** — open deals (Deal Status = Open), open value, average size, split by stage, by sector and by closure probability, plus the largest open deals
- **Conversion** — won vs lost in the window, win rate, or an explicit "cannot be computed" when nothing closed
- **Delivery** — active work orders, execution-status mix, completed in window
- **Cash** — order book, billed, collected, still-to-bill, receivable outstanding, and the top receivable accounts. This was not in my original design; the work order board turned out to be as much an AR ledger as a delivery tracker, and receivables are exactly what a founder asks about
- **Risk** — *slipping deals* (open, expected close date passed) and *overdue delivery* (not complete, end date passed), each with named examples
- **Cross-board** — deal value vs work-order value per sector: where sales is landing work the delivery side is not yet reflecting
- **Caveats** — deduplicated across every sub-query, for the footnote

The model only narrates: headline numbers, what stands out, risks, one recommended action. The structure is fixed in code so the update has the same shape every week, which is what makes it comparable.

---

## 4. What I would do differently with more time

1. **An evaluation set.** ~40 founder questions with expected numeric answers, run on every change. The *engine* is covered by 160 automated checks; the *agent's tool choices* are not measured. This is the largest gap.
2. **Confidence-scored entity resolution.** Client codes are already clean here, but the noise-word key (`Adani Green Pvt Ltd → adani green`) would need fuzzy scoring plus a review queue on real names — collapsing two different clients is a silent data error.
3. **Persist the normalised snapshot.** Postgres or Redis with a scheduled sync: survives cold starts, makes trend questions ("versus last quarter") cheap, and lets me record *when* each row changed, which the boards do not expose.
4. **Charts.** Several of these answers are better as a picture. The agent would return a chart spec alongside the prose.
5. **Reconcile the two boards on deal name.** Both carry a masked deal name; joining them would let the agent follow a single deal from `A. Lead Generated` through to `Collected`, which is the question a founder actually wants answered.
6. **Monday MCP instead of a hand-rolled client.** I used GraphQL directly for control over pagination, retries and the column-schema read. MCP would reduce client code at the cost of that control.
7. **Per-token streaming** of the final answer, not just tool events.

---

## 5. Verification: an adversarial audit pass

Before submission I ran a five-dimension review (data engine, agent loop, frontend, security, performance) in which independent reviewers proposed defects and a second adversarial pass tried to refute each one against the actual code. 36 claims were checked; 26 survived and were fixed. The three most instructive:

- **The markdown renderer could freeze the browser.** Its paragraph collector refused to consume lines starting with bold text or a digit - which is how almost every BI answer begins - looping forever. No test had ever rendered a real answer in a browser, which is exactly the kind of gap adversarial review finds.
- **`parseNumber` concatenated digit runs**, so a range cell like "1,00,000 - 2,00,000" silently became 100 billion in a sum, with no caveat - the worst possible failure for a tool whose whole premise is trustworthy numbers. It now takes the first number and flags the rest.
- **`group_by` split case variants while the quality warning claimed they merge** - the engine and its own caveat contradicted each other. Buckets now key on the normalized form and display the majority spelling.

The remaining fixes: FY range notation ("FY 2025-26") resolving a year early, two-digit quarter years, slash-dates with time suffixes, an IST off-by-one-day in the loose date fallback, an over-aggressive company-name normalizer, tool-argument coercion for schema-drifting free models, Gemini's parallel-tool-result format, transcript compaction that could trim results the model had not yet read, provider stickiness within a question, a forced final answer when the tool budget runs out, per-IP rate limiting, client-disconnect handling, and a `--replace` guard on the import script's destructive path.

## 6. AI tools used

Claude (Anthropic) via Claude Code, for scaffolding, normalisation edge cases, and this document. The architectural decisions — model-plans/code-computes, preserve-board-vocabulary, fuzzy column mapping, column-level date disambiguation, caveats-as-data — are mine; the assistant accelerated writing them.

## 7. Challenges

**Building before seeing the data.** Solved by making schema discovery a runtime feature. It paid off: the 38-column work-order sheet mapped on first contact.

**Getting normalisation backwards.** My first pass rewrote board values into a generic taxonomy. Profiling the real export showed that would have turned a clean 11-value sector list into a lossy 6-value one. Inverting the direction — translate the question, not the data — was the single most important correction in the build.

**The two `status` fields.** Both boards have a field the app calls `status`, meaning completely different things (Open/Won/Dead vs Completed/Ongoing/Not Started). The concept lookup was keyed by field name alone, so work-order queries were silently resolved against the *deals* vocabulary — "in progress" matched `Ongoing` but missed `Executed until current month`. The end-to-end test caught it; the lookup is now per board.

**Free-tier tool calling.** Gemini's function-declaration schema rejects `additionalProperties` and handles nested unions poorly. Schemas are converted at the adapter boundary and every filter value is a plain string (`"low,high"` for ranges, comma lists for `in`) — uglier than a typed union, but reliable across all three providers.

**Deciding what counts as an error worth showing.** Early versions surfaced every parse note and buried the answer. The fix was two tiers: per-row `issues` (available via `sample_rows` when you go looking) and aggregate `caveats` (surfaced only when they materially affect the number).
