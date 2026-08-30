# Decision Log: monday.com Business Intelligence Agent

## 1. Assumptions

The app assumes nothing about column names. Built before the spreadsheets arrived, it reads each board's schema and scores every column against a synonym list per canonical field, boosted by monday's column type. Against the real export (344 deals, 176 work orders, 38 columns) all 12 deal columns and 33 of 38 work order columns mapped unchanged; the five that missed are empty.

The boards carry Skylark's own taxonomy: sectors run Renewables, Mining, Railways, Powerline, DSP, Tender, Others, and Deal Stage is a lettered ladder from "A. Lead Generated" to "O. Not Relevant at all". I assumed a founder asks in plain English and still expects the answer to reconcile with monday. Two of those sectors are procurement routes rather than industries, and Tender alone carries 77% of open pipeline value on four deals, so the engine flags any total one group dominates.

Values are masked and scaled, mixing 264398.08 with 1.2332 in one column, so magnitudes are reported exactly as stored, never with a currency symbol. Multipliers inside a cell are expanded and recorded on the row.

Quarter means the calendar quarter; "FY26" gives the Indian April to March year, and the agent says which it used. Revenue is ambiguous — won deal value on the sales side, billed or collected on the work order side — so the agent names the reading it used and offers the other. Close dates cluster, so a short window often contains nothing decided; the brief then gives the lifetime rate, 57% on 165 of 292, rather than shrugging.

Access is read only. The only code that writes is a one-time import script the running app never touches.

## 2. Trade-offs

### The model never does arithmetic

The LLM emits a structured query: filters, group-by, metrics. A deterministic engine in `src/lib/query.ts` computes it and returns the figures with their caveats. Every step is inspectable — click a step chip for the query, the resolved values, the rows matched — so the claim is checkable rather than trusted. The agent can only answer what that DSL expresses, and a new calculation needs new tool code. In exchange no number is invented. With `Masked Deal value` only 48% filled, a confidently wrong sum was the failure mode I most wanted gone. An adversarial review fixed 26 defects, the instructive one being `parseNumber` concatenating digit runs so "1,00,000 - 2,00,000" entered a sum as 100 billion, uncaveated.

### Values stay verbatim; the question gets translated

My first version canonicalised at import: Renewables became Energy, "F. Negotiations" became Negotiation. Profiling the real export showed that collapses a clean 11-value sector list into a lossy 6-value one and silently discards DSP and Tender. So the concept tables run the other way, at query time: "energy" resolves to Renewables plus Powerline, reported inside the answer. The cost is over-matching, since "lead" also returns "Sales Qualified Leads" — stated, so it stays correctable.

### Caveats as data

Every result carries a `caveats[]` array built by the engine: nulls excluded from sums, blank groups, unresolved terms, dropped duplicate header rows, low fill rates, totals dominated by one group. The model folds the material ones into prose. Answers run longer and become defensible.

### API rather than MCP

The brief allowed either. MCP wraps the same GraphQL endpoint, and I wanted control over pagination, retries and the column-schema read. See §3 for why it could not have reached production.

### A five minute cache

Both boards are pulled whole and cached in process, so answers can be five minutes stale and the cache dies on a cold start. In exchange a six-tool question makes one round trip, not six. Right at 520 rows. Wrong at 100,000.

### Next.js on Vercel, Gemini on the free tier

One deployable, one deploy command, server-sent events so the user watches each tool call. No database: the data fits in memory and the brief asked for dynamic reads. Free models are weak at multi-step tool use, so the DSL is shallow and string-valued and the board's vocabulary goes into the system prompt.

Free tiers cost latency. Timing a four-question session in production showed 30 to 56 seconds an answer, 26 of one question's 30 spent on a hanging call retried three times while the fallback answered the whole thing in five. Requests are capped at 15 seconds and a provider with another rung behind it gets one attempt, since failing over beats a backoff; only the last rung waits. Limits are per model, so the chain is four Gemini models on one key plus Groq. Answers land in 8 to 15 seconds.

## 3. How I read "help prepare data for leadership updates"

A founder should not have to ask six questions to write the weekly update. `leadership_brief` is one call assembling the snapshot deterministically: open pipeline by stage, sector and probability with the largest deals named; won against lost with a win rate; active work orders and their status mix; cash, meaning order book, billed, collected, still to bill and receivables with the top accounts; risk, meaning deals and work orders past their dates; and deal value against work order value per sector, showing where sales is landing work delivery has not caught up to.

The cash block was not in my original design — the work order board turned out to be as much a receivables ledger as a delivery tracker, and receivables are what founders ask about. The model only narrates; the structure is fixed in code, so every update has the same shape.

The brief also allowed MCP. monday's MCP server is a local stdio process or an interactive OAuth flow, and a Vercel function has neither.

## 4. Measuring the claim

"The model never does arithmetic" is easy to assert, so `npm run eval` measures it: ten founder questions against the live agent and boards, every figure in the prose traced back to one the engine returned. Misses are **derived** (arithmetic the engine should have done) or **fabricated** (no basis in retrieved data).

The first run scored 85.7%, every miss a percentage divided in the model's head — asked about receivables it wrote "the top three account for over 53%", right that time and reproducible never. `compute` became a tool and grouped results gained `share_pct`, which reached 96.8%. But the prompt still only *asked*, so the same check now runs as a gate: before any answer ships, its figures are matched against everything the tools returned, and an answer that fails is sent back once with the offending numbers named.

```
grounded   95/95 figures traced to a tool result (100%)
derived    0        fabricated 0
```

Zero fabricated is the number that matters, and the metric is the guarantee: `src/lib/grounding.ts` is the same module in both places, so the eval measures what production enforces, and each answer carries the count it passed. Verifying the arithmetic itself then found a bug the gate could not. A bare `share_pct` beside both a count and a sum is ambiguous — Tender is 8% of open deals and 77% of open value — so reading the wrong one is a wrong answer built from a genuinely retrieved figure. Shares are now named for what they measure. The eval also caught a bug in itself, flagging "48% filled" as fabricated when that reaches the model through the schema summary, the same deterministic layer.

## 5. What I would do differently

Ten questions is thin; forty would be better, and each costs several free-tier requests, so a bad minute rate-limits some into skips.

Then a normalised snapshot in Postgres on a scheduled sync, surviving cold starts and making "versus last quarter" cheap; a join across both boards on the masked deal name, so one deal is followable from lead to collected; and a chart spec returned with the prose.

## 6. AI tools used

Claude, via Claude Code, for normalisation edge cases and drafting. The architectural calls are mine: model plans and code computes, values stay verbatim, mapping discovered at runtime, dates disambiguated per column.
