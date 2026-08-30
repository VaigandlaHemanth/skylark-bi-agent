# Decision Log — monday.com Business Intelligence Agent

## 1. Assumptions

**About the data.** I designed against the *shape* the brief describes rather than against fixed headers: a sales funnel with client / sector / stage / value / expected-close, and an execution tracker with client / sector / status / value / start / end. I never assume the import produced particular column names — the app reads the board's real schema and maps it. That was the single most important assumption to avoid making, because the spreadsheets get imported by someone else and column titles will not match mine.

**About the questions.** A founder asks in outcomes, not fields: *"how's the energy pipeline"*, *"are we slipping"*. So the agent gets business vocabulary as first-class concepts — "pipeline" means open stages, not all deals; "this quarter" means a resolved date range, stated back to the user.

**About units.** Deal values are reported at the magnitude stored on the board. I do not infer a currency or convert lakhs/crores into a display format, because guessing wrong on a founder-facing number is worse than being unitless. Multipliers written *inside* a cell (`1.2M`, `12 lakhs`) *are* expanded, and the expansion is flagged per row.

**About quarters.** Default is the **calendar** quarter. Skylark is an Indian company, so a financial-year reading (Apr–Mar) is plausible — but silently switching would be worse than stating the assumption. Both work: "this quarter" is calendar, "FY26" or "this financial year" is Apr–Mar. The agent always says which it used.

**About scope.** monday.com access is read-only, as specified. Nothing writes back.

---

## 2. Key trade-offs

### The model never does arithmetic
The LLM emits a structured query (filters, group-by, metrics); a deterministic engine computes it. **Cost:** the agent can only answer questions expressible in that DSL, and a genuinely novel calculation needs new tool code. **Benefit:** no hallucinated figures, ever, and every number is reproducible and auditable. For a founder-facing BI tool, a wrong number is worse than a missing one — that trade was not close.

### Fuzzy column mapping over a hardcoded schema
Columns are matched to canonical fields by synonym scoring, boosted by monday's own column type (`numbers`, `date`, `status`). **Cost:** ~120 lines of scoring logic, and a mis-map is possible. **Benefit:** the app survives whatever the import produced, and the mapping is exposed to the user (`data_quality` shows `value ← "Deal Value (INR)" · 94% match`), so a mis-map is visible rather than silent. A hardcoded schema would have been faster to write and would have broken on someone else's import.

### Column-level date disambiguation
`03/04/2026` cannot be resolved from one row. I scan the whole column: if *any* value has a first component above 12, the column is day-first. Only if the column is entirely ambiguous do I default to day-first — **and surface it as a caveat**. **Cost:** a full pass over the column before parsing. **Benefit:** it is correct for most real columns instead of guessing on every row.

### Caveats as data, not prose
Every query result carries a `caveats[]` array built by the engine (nulls excluded from sums, blank groups, unmatched filters, low fill rates). The model is instructed to fold the material ones into its answer. **Cost:** answers are longer. **Benefit:** the agent cannot quietly present a number computed on 55%-complete data — the caveat is generated whether or not the model thinks to mention it.

### Pluggable LLM, free tier by default
Gemini (free tier), Groq, or Anthropic, selected by whichever key is present. **Cost:** an adapter layer instead of one SDK; the free models are weaker at multi-step tool use. **Benefit:** the hosted demo runs with no billing account, which is what actually makes it testable by a reviewer. The narrow tool DSL — string-valued filters, no nested unions — was deliberately shaped so a free-tier model can drive it reliably.

### 5-minute cache instead of per-query fetching
Both boards are pulled whole and cached in-process for 5 minutes. **Cost:** answers can be up to 5 minutes stale, and the cache dies on a serverless cold start. **Benefit:** a multi-tool question makes one API round trip instead of six, which keeps responses inside a serverless timeout and well inside monday's rate limits. At board sizes of a few hundred rows this is clearly right; at 100k rows it would not be.

### Next.js single deployable
One app, one deploy, SSE streaming so the user sees each tool call as it happens rather than a 20-second blank. **Cost:** no separate API surface for other consumers. **Benefit:** it meets "testable without local setup" with one `vercel` command.

---

## 3. How I interpreted "help prepare data for leadership updates"

I read it as: **a founder should not have to ask six questions to write the weekly update.**

So `leadership_brief` is one tool call that assembles the whole snapshot deterministically:

- **Pipeline** — open deals, open value, average deal size, breakdown by stage and by sector, largest open deals
- **Conversion** — won vs lost count and value in the window, win rate (or an explicit "cannot be computed" when nothing closed)
- **Risk** — *slipping deals* (open, but the expected close date has passed) and *overdue work* (not Completed/Cancelled, past the due date), each with named examples
- **Delivery** — active work orders, status mix, completed in window
- **Cross-board signal** — pipeline value vs delivered value per sector, which is the thing neither board can show alone: where sales is landing work the delivery side is not yet reflecting
- **Data caveats** — deduplicated across every sub-query, to be used as a footnote

The model's job is only to narrate it: headline numbers, what changed, risks, one recommended action, caveats in a footnote. The structure is fixed in code so the update is the same shape every week — which is what makes it comparable week over week.

---

## 4. What I would do differently with more time

1. **Confidence-scored entity resolution.** Client names are currently normalised with a noise-word key (`Adani Green Pvt Ltd` → `adani green`). Real dedup needs fuzzy scoring with a review queue, because collapsing two genuinely different clients is a silent data error.
2. **Persist the normalised snapshot.** Move the in-process cache to Postgres or Redis with a scheduled sync. That survives cold starts, makes trend questions ("versus last quarter") cheap, and lets me store *when* each row changed — which the boards themselves do not expose.
3. **Charts.** Some answers are much better as a picture. I would have the agent optionally return a chart spec alongside the prose and render it inline.
4. **An evaluation set.** ~40 founder questions with expected numeric answers, run on every change. Right now correctness of the *engine* is verifiable by reading it, but correctness of the *agent's tool choices* is not measured. This is the largest gap.
5. **Monday MCP instead of a hand-rolled client.** I used the GraphQL API directly for full control over pagination, retries and the column-schema read. With more time I would put the official MCP server behind the same tool interface and compare — MCP would reduce the client code, at the cost of less control over exactly what gets fetched.
6. **Streaming tokens, not just tool events.** The final answer currently arrives in one piece. Per-token streaming would cut perceived latency further.
7. **Write-back, if it were ever in scope.** It is explicitly not — but the natural next step is "flag these 6 slipping deals in monday" with a confirmation step, never an automatic write.

---

## 5. AI tools used

Claude (Anthropic) via Claude Code, for scaffolding, the normalisation edge cases, and this document. Every architectural decision above — the model-plans/code-computes split, fuzzy column mapping, column-level date disambiguation, caveats-as-data — is mine; the assistant accelerated the writing of them.

## 6. Challenges

**Not having the real spreadsheets while building.** Solved by making schema discovery a runtime feature rather than a build-time assumption. This turned out better than hardcoding would have been.

**Free-tier tool calling.** Gemini's function-declaration schema rejects `additionalProperties` and handles nested unions poorly. I converted schemas at the adapter boundary and kept every filter value a plain string (`"low,high"` for ranges, comma lists for `in`), which is uglier than a typed union but works reliably across all three providers.

**Deciding what counts as an error worth showing.** Early versions surfaced every parse note, which buried the answer. The fix was two tiers: per-row `issues` (available via `sample_rows` when you go looking) and aggregate `caveats` (surfaced in the answer only when they materially affect the number).
