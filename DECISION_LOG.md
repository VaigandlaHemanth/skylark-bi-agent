# Decision Log: monday.com Business Intelligence Agent

## 1. Assumptions

The app assumes nothing about column names. Built before the spreadsheets arrived, it reads each board's real schema from monday and scores every column against a synonym list per canonical field, boosted by monday's column type. Against the real export (344 deals, 176 work orders across 38 columns) all 12 deal columns and 33 of 38 work order columns mapped with no code change. The five that missed are empty.

The boards carry Skylark's own taxonomy: sectors are Renewables, Mining, Railways, Powerline, DSP, Tender and Others, and Deal Stage is a lettered ladder from "A. Lead Generated" to "O. Not Relevant at all". I assumed a founder asks in plain English, says "energy" and "negotiation", and still expects the answer to reconcile with what monday shows.

Values are masked and scaled: the work order value column mixes 264398.08 with 1.2332 in the same field, so I report magnitudes exactly as stored and never attach a currency symbol. Multipliers inside a cell (12 lakhs, $1.2M) are expanded and recorded on the row.

Quarter means the calendar quarter; "FY26" gives the Indian April to March year, and the agent says which it used. Revenue is ambiguous here: won deal value on the sales side, billed or collected value on the work order side. The agent picks the likelier reading, names it, and offers the other in a clause.

monday access is read only. The only code that writes is a one-time CSV import script, which the running app never touches.

## 2. Trade-offs

### The model never does arithmetic

The LLM emits a structured query: filters, group-by, metrics. A deterministic engine in `src/lib/query.ts` computes it and returns the figures with a list of data quality caveats. The agent can only answer questions expressible in that DSL, and a new calculation needs new tool code. In exchange no number is invented and every one is reproducible. With `Masked Deal value` only 48% filled, a confidently wrong sum was the failure mode I most wanted gone. An adversarial review before submission fixed 26 defects; the instructive one was `parseNumber` concatenating digit runs, so a range cell like "1,00,000 - 2,00,000" entered a sum as 100 billion with no caveat attached.

### Values stay verbatim; the question gets translated

My first version canonicalised at import: Renewables became Energy, "F. Negotiations" became Negotiation. Profiling the real export showed that collapses a clean 11-value sector list into a lossy 6-value one and silently discards DSP and Tender. So the concept tables run the other way, at query time. "energy" resolves to Renewables plus Powerline, and the resolution is reported inside the answer so the founder can correct it. The cost is over-matching: ask for "lead" and you also get "Sales Qualified Leads", which the answer states, so it stays correctable.

### Caveats as data

Every result carries a `caveats[]` array built by the engine: nulls excluded from sums, blank groups, unresolved filter terms, dropped duplicate header rows, low fill rates. The model folds the material ones into prose. Answers run longer and become defensible.

### A five minute cache

Both boards are pulled whole and cached in process, so answers can be five minutes stale and the cache dies on a cold start. In exchange a six-tool question makes one API round trip instead of six, which keeps it inside the function timeout. Right at 520 rows. Wrong at 100,000.

### Next.js on Vercel, Gemini on the free tier

One deployable, one deploy command, and server-sent events so the user watches each tool call. No database: the data fits in memory and the brief asked for dynamic reads. Whichever model key is present is used, with failover across Gemini, Groq and Anthropic, so the demo runs without a billing account. Free models are weak at multi-step tool use, so the tool DSL is shallow and string-valued and the board's vocabulary goes into the system prompt.

## 3. How I read "help prepare data for leadership updates"

A founder should not have to ask six questions to write the weekly update. `leadership_brief` is one call that assembles the snapshot deterministically: open pipeline by stage, sector and closure probability with the largest deals named; won against lost with a win rate, or an explicit "cannot be computed" when nothing closed; active work orders and their execution status mix; cash, meaning order book, billed, collected, still to bill and receivables outstanding with the top accounts; risk, meaning open deals past their expected close date and work orders past their end date; and deal value against work order value per sector, where sales is landing work delivery has not caught up to.

The cash block was not in my original design. The work order board turned out to be as much a receivables ledger as a delivery tracker, and receivables are what founders ask about. The model only narrates, and the structure is fixed in code, so every week's update has the same shape.

## 4. What I would do differently

I have no evaluation set, and that is the honest gap. The deterministic engine has 160 automated checks covering every date format, currency form, timeframe expression and the filter and aggregate paths. The agent's tool choices have none. I do not know how often the model picks the wrong tool or filter, because I never measured it. That comes first: roughly 40 founder questions with expected answers, run on every change.

Then I would persist the normalised snapshot in Postgres on a scheduled sync, which survives cold starts and makes "versus last quarter" cheap. I would join the two boards on the masked deal name so the agent can follow one deal from "A. Lead Generated" through to collected. And I would return a chart spec with the prose, since several answers read better as a picture.

## 5. AI tools used

Claude, via Claude Code, for normalisation edge cases and drafting. The architectural calls are mine: model plans and code computes, values stay verbatim, mapping discovered at runtime, dates disambiguated per column.
