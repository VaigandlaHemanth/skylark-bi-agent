# Decision Log: monday.com Business Intelligence Agent

## 1. Assumptions

The app assumes nothing about column names. Built before the spreadsheets arrived, it reads each board's real schema and scores every column against a synonym list per canonical field, boosted by monday's column type. Against the real export (344 deals, 176 work orders across 38 columns) all 12 deal columns and 33 of 38 work order columns mapped with no code change; the five that missed are empty.

The boards carry Skylark's own taxonomy: sectors run Renewables, Mining, Railways, Powerline, DSP, Tender, Others, and Deal Stage is a lettered ladder from "A. Lead Generated" to "O. Not Relevant at all". I assumed a founder asks in plain English and still expects the answer to reconcile with monday. Two of those sectors are procurement routes rather than industries, and Tender alone carries 77% of open pipeline value on four deals, so the engine flags any total one group dominates.

Values are masked and scaled, mixing 264398.08 with 1.2332 in one column, so magnitudes are reported exactly as stored and never with a currency symbol. Multipliers inside a cell (12 lakhs, $1.2M) are expanded and recorded on the row.

Quarter means the calendar quarter; "FY26" gives the Indian April to March year, and the agent says which it used. Revenue is ambiguous: won deal value on the sales side, billed or collected on the work order side. The agent picks the likelier reading, names it, offers the other in a clause. Close dates cluster, so a short window often contains nothing decided; the brief then gives the lifetime rate, 57% on 165 of 292, rather than shrugging.

monday access is read only. The only code that writes is a one-time import script the running app never touches.

## 2. Trade-offs

### The model never does arithmetic

The LLM emits a structured query: filters, group-by, metrics. A deterministic engine in `src/lib/query.ts` computes it and returns the figures with their data quality caveats. Every step is inspectable: click a step chip and the query, the resolved values, the rows matched and the caveats are there, so the claim is checkable rather than trusted. The agent can only answer what that DSL expresses, and a new calculation needs new tool code. In exchange no number is invented. With `Masked Deal value` only 48% filled, a confidently wrong sum was the failure mode I most wanted gone. An adversarial review fixed 26 defects; the instructive one was `parseNumber` concatenating digit runs, so "1,00,000 - 2,00,000" entered a sum as 100 billion, uncaveated.

### Values stay verbatim; the question gets translated

My first version canonicalised at import: Renewables became Energy, "F. Negotiations" became Negotiation. Profiling the real export showed that collapses a clean 11-value sector list into a lossy 6-value one and silently discards DSP and Tender. So the concept tables run the other way, at query time: "energy" resolves to Renewables plus Powerline, and the resolution is reported inside the answer. The cost is over-matching, since "lead" also returns "Sales Qualified Leads" — stated in the answer, so it stays correctable.

### Caveats as data

Every result carries a `caveats[]` array built by the engine: nulls excluded from sums, blank groups, unresolved terms, dropped duplicate header rows, low fill rates, totals dominated by one group. The model folds the material ones into prose. Answers run longer and become defensible.

### API rather than MCP

The brief allowed either. monday's MCP server is a local stdio process or an interactive OAuth flow, and a Vercel function has neither, so MCP could not have reached production. It wraps the same GraphQL endpoint anyway, and I wanted control over pagination, retries and the column-schema read.

### A five minute cache

Both boards are pulled whole and cached in process, so answers can be five minutes stale and the cache dies on a cold start. In exchange a six-tool question makes one round trip instead of six, inside the function timeout. Right at 520 rows. Wrong at 100,000.

### Next.js on Vercel, Gemini on the free tier

One deployable, one deploy command, server-sent events so the user watches each tool call. No database: the data fits in memory and the brief asked for dynamic reads. Whichever model key is present is used, failing over across Gemini, Groq and Anthropic, so the demo runs without a billing account. Free models are weak at multi-step tool use, so the DSL is shallow and string-valued and the board's vocabulary goes into the system prompt.

## 3. How I read "help prepare data for leadership updates"

A founder should not have to ask six questions to write the weekly update. `leadership_brief` is one call that assembles the snapshot deterministically: open pipeline by stage, sector and closure probability with the largest deals named; won against lost with a win rate; active work orders and their status mix; cash, meaning order book, billed, collected, still to bill and receivables with the top accounts; risk, meaning open deals past their expected close and work orders past their end date; and deal value against work order value per sector, showing where sales is landing work delivery has not caught up to.

The cash block was not in my original design. The work order board turned out to be as much a receivables ledger as a delivery tracker, and receivables are what founders ask about. The model only narrates; the structure is fixed in code, so every week's update has the same shape.

## 4. Measuring the claim

"The model never does arithmetic" is easy to assert, so `npm run eval` measures it. Ten founder questions run against the live agent and live boards; every figure in the prose must trace back to one the engine returned. Misses are classified **derived** (arithmetic the engine should have done) or **fabricated** (no basis in retrieved data).

The first run scored 85.7%, and every miss was a percentage divided in the model's head — asked about receivables it wrote "the top three account for over 53%", right that time and reproducible never. So `compute` became a tool and every grouped result carries `share_pct`:

```
grounded   91/94 figures traced to a tool result (96.8%)
derived    3        fabricated 0
```

Zero fabricated is the number that matters. The eval also caught a bug in itself: it flagged "48% filled" as fabricated when that reaches the model through the schema summary, the same deterministic layer.

## 5. What I would do differently

Ten questions is thin. Forty would be better, and each costs several free-tier requests, so a bad minute rate-limits some into skips.

Getting derived to zero is next. `compute` is used when the model remembers it, which is the wrong reliability model; refusing to render a percentage absent from a tool result would enforce it rather than ask. Then a normalised snapshot in Postgres on a scheduled sync, which survives cold starts and makes "versus last quarter" cheap; a join across both boards on the masked deal name, so one deal is followable from "A. Lead Generated" to collected; and a chart spec returned with the prose.

## 6. AI tools used

Claude, via Claude Code, for normalisation edge cases and drafting. The architectural calls are mine: model plans and code computes, values stay verbatim, mapping discovered at runtime, dates disambiguated per column.
