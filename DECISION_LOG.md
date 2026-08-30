# Decision Log: monday.com Business Intelligence Agent

## 1. Assumptions

The app assumes nothing about column names. Built before the spreadsheets arrived, it reads each board's schema and scores every column against a synonym list, boosted by monday's column type. Against the real export all 12 deal columns and 33 of 38 work order columns mapped unchanged; the five misses are empty.

The boards carry Skylark's own taxonomy: sectors run Renewables, Mining, Railways, Powerline, DSP, Tender, Others, and Deal Stage is a lettered ladder from "A. Lead Generated" to "O. Not Relevant at all". I assumed a founder asks in plain English and still expects the answer to reconcile with monday. Two of those sectors are procurement routes, not industries, and Tender alone carries 77% of open pipeline value on four deals — so the engine flags any total one group dominates.

Values are masked and scaled, mixing 264398.08 with 1.2332 in one column, so magnitudes are reported exactly as stored, never with a currency symbol. Multipliers inside a cell are expanded and recorded on the row.

Quarter means the calendar quarter; "FY26" gives the Indian April–March year, and the agent says which it used. Revenue is the one genuine ambiguity — won deal value against billed value, differing by roughly half — so a bare "what is our revenue" is where the agent asks rather than picks. Close dates cluster, so a short window often contains nothing decided; the brief then gives the lifetime rate, 57% on 165 of 292, rather than shrugging.

Access is read only. The only code that writes is a one-time import script the running app never touches.

## 2. Trade-offs

**The model never does arithmetic.** The LLM emits a structured query; a deterministic engine computes it and returns the figures with their caveats. Every step is inspectable, so the claim is checkable rather than trusted. The agent can only answer what that DSL expresses, and a new calculation needs new tool code. In exchange no number is invented — the failure mode I most wanted gone, with `Masked Deal value` only 48% filled. Adversarial review fixed 26 defects, the instructive one being `parseNumber` concatenating digit runs so "1,00,000 - 2,00,000" entered a sum as 100 billion, uncaveated.

**Values stay verbatim; the question gets translated.** My first version canonicalised at import: Renewables became Energy. That collapses a clean 11-value sector list into a lossy 6-value one and discards DSP and Tender. So the concept tables run the other way, at query time: "energy" resolves to Renewables plus Powerline, reported inside the answer. The cost is over-matching — "lead" also returns "Sales Qualified Leads" — which is stated, so it stays correctable.

**Cross-board comparison without a join key.** The boards share no row-level key: client codes have zero overlap (199 against 51) and deal names repeat, one 27 times, multiplying rows fourfold on a join. They do line up on sector (all six values) and owner (six of seven), so `compare_boards` joins at group level and refuses anything else with the reason. It answers what neither board can alone: Railways carries 59.9M of work orders at 0.4% billed; Tender holds 532M of pipeline with no work orders at all.

**Caveats as data.** Every result carries a `caveats[]` array: nulls excluded from sums, blank groups, unresolved terms, dropped header rows, low fill rates, totals one group dominates, groups merged under a repeated name. The material ones are enforced, not requested — an answer that drops every one gets it appended verbatim, because the eval caught the model quietly omitting a 48% fill rate under a total.

**API rather than MCP.** The brief allowed either. monday's MCP server is a local stdio process or an interactive OAuth flow, and a Vercel function has neither, so MCP could not have reached production. It wraps the same GraphQL endpoint anyway, and I wanted control over pagination, retries and the column-schema read.

**A five minute cache.** Both boards are pulled whole and cached in process, so answers can be five minutes stale and the cache dies on a cold start. In exchange a six-tool question makes one round trip, not six. Right at 520 rows. Wrong at 100,000.

**Next.js on Vercel, Gemini on the free tier.** One deployable, server-sent events so the user watches each tool call. No database: the data fits in memory. Free models are weak at multi-step tool use, so the DSL is shallow and string-valued and the board's vocabulary goes into the prompt.

Free tiers cost latency. Timing a session in production showed 30–56 seconds an answer, 26 of one question's 30 spent on a hanging call retried three times while the fallback answered it in five. Requests are capped at 15 seconds, and a provider with a rung behind it gets one attempt — failing over beats a backoff. Limits are per model, so the chain is four Gemini models on one key plus Groq. Answers land in 8–15 seconds.

## 3. "Help prepare data for leadership updates"

A founder should not have to ask six questions to write the weekly update. `leadership_brief` is one call assembling the snapshot deterministically: open pipeline by stage, sector and probability with the largest deals named; won against lost with a win rate; active work orders and their status mix; cash, meaning order book, billed, collected, still to bill and receivables with top accounts; risk, meaning deals and work orders past their dates; and deal value against work order value per sector.

The cash block was not in my original design — the work order board turned out to be as much a receivables ledger as a delivery tracker, and receivables are what founders ask about. The model only narrates; the structure is fixed in code, so every update has the same shape.

An update left in a chat window has not been prepared, so any answer exports as Markdown carrying the question, the boards and when they were read, and the verification verdict.

## 4. Measuring the claim

"The model never does arithmetic" is easy to assert, so it is enforced rather than requested: before an answer ships, every figure is matched against everything the tools returned, and one that fails goes back with the offending numbers named. `npm run eval` runs the same check over 15 founder questions against the live boards — currently 100% of figures traced, zero fabricated — and `src/lib/grounding.ts` is the same module in both places, so the measured number is the enforced one. The README carries the detail.

## 5. What I would do differently

Fifteen questions is thin; forty would be better, and each costs several free-tier requests, so a bad minute rate-limits some into skips.

Then a normalised snapshot in Postgres on a scheduled sync, surviving cold starts and making "versus last quarter" cheap; and a chart spec returned with the prose. Per-record linkage between the boards needs a key the export does not carry — monday would have to put a deal id on both.

## 6. AI tools used

Claude, via Claude Code, for normalisation edge cases and drafting. The architectural calls are mine: model plans and code computes, values stay verbatim, mapping discovered at runtime, dates disambiguated per column.
