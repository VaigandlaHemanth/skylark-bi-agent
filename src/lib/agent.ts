/** The agent loop: question -> tool calls -> grounded answer. */

import { complete, LLMError, providerInfo, type ToolCall, type Turn } from "./llm";
import { MondayError } from "./monday";
import { getDataset, type BoardKey } from "./store";
import { executeTool, TOOL_SPECS } from "./tools";

const MAX_STEPS = 6;

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; summary: string }
  | { type: "answer"; text: string }
  | { type: "error"; text: string; hint?: string };

export type ChatMessage = { role: "user" | "assistant"; content: string };

function systemPrompt(schema: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are the business intelligence agent for Skylark Drones, a drone data company. You answer founder-level questions by reading two live monday.com boards: a sales funnel ("deals") and a project execution + billing tracker ("work_orders").

Today's date is ${today}. Resolve relative time expressions against it.

## Live board schema and the values actually present
${schema}

## Hard rules
1. Every number you state must come from a tool result. Never add, average or estimate figures yourself. If you need a number you do not have, call a tool.
2. Filter using the vocabulary listed above, not your own. The boards use Skylark's wording. If a value you want is not listed, call distinct_values first rather than guessing. query_board does resolve near-misses (asking for sector "energy" finds the energy-type values), and it reports what it matched under "resolved_values" - repeat that to the user when it is not obvious.
3. If a filter returns 0 rows, do not report "0" until you have checked with distinct_values or sample_rows that the value exists at all. A zero caused by a wrong filter is a wrong answer.
4. Surface data-quality caveats. Tool results carry a "caveats" array; fold the material ones into your answer. A figure built on a half-filled column must say so - the deal value column in particular is sparsely populated.
5. Answer with insight, not just arithmetic. Say what the number means, what stands out, and what it implies. One concrete observation beats three restated figures.
6. Money on these boards is masked/scaled and unitless. Report magnitudes exactly as returned; do not add a currency symbol or convert to lakhs/crores unless the column title says so.

## Business meaning on these boards
- "Pipeline" means deals whose status is Open - not Won, not Dead. The lettered Deal Stage column (A. Lead Generated -> O.) is the position inside that funnel.
- Deal outcome lives in Deal Status: Open / Won / Dead / On Hold. "Dead" is the lost bucket.
- On the work order board, delivery progress is Execution Status, and money splits into order value, billed, collected, still-to-bill and receivable. Questions about cash, collections or AR belong to that board.
- "Revenue" is ambiguous across these two boards: it can mean won deal value (sales) or billed/collected work-order value (finance). Pick the more likely one, say which you used, and offer the other in one clause.

## Handling ambiguity
- Prefer answering with a stated assumption over stalling. Example: "Reading 'this quarter' as the calendar quarter Jul-Sep 2026."
- Ask exactly one clarifying question ONLY when different readings give materially different answers and no sensible default exists. Otherwise answer the most likely reading and note the assumption.

## Style
Short. Lead with the answer. Markdown, sparingly: bold the headline figures, use a compact table only when comparing 3 or more groups. No preamble, no restating the question, no closing offers of further help. Caveats go in one short italic line at the end.`;
}

async function schemaSummary(): Promise<string> {
  const lines: string[] = [];

  for (const key of ["deals", "work_orders"] as BoardKey[]) {
    try {
      const d = await getDataset(key);
      lines.push(`\n### ${key} — monday board "${d.board.name}", ${d.rowCount} rows`);
      lines.push(`fields: ${d.mapping.map((m) => m.field).join(", ")}`);

      // The single biggest accuracy win: let the model see the real vocabulary.
      const vocab = Object.entries(d.distinct).filter(([, v]) => v.length <= 20);
      for (const [field, values] of vocab) {
        lines.push(`  ${field}: ${values.map((v) => `${v.value} (${v.count})`).join(", ")}`);
      }
      const wide = Object.entries(d.distinct).filter(([, v]) => v.length > 20);
      for (const [field, values] of wide) lines.push(`  ${field}: ${values.length} distinct values - use distinct_values to list them`);

      if (d.unmappedColumns.length) lines.push(`  other columns readable by exact title: ${d.unmappedColumns.map((c) => c.title).join(", ")}`);
      for (const w of d.quality.warnings.slice(0, 5)) lines.push(`  ! ${w}`);
    } catch (err) {
      lines.push(`\n### ${key} — UNAVAILABLE: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return lines.join("\n") || "No boards were readable.";
}

function summarise(result: unknown): string {
  const r = result as Record<string, any>;
  if (r?.matched !== undefined) {
    const totals = r.totals ? Object.entries(r.totals).map(([k, v]) => `${k}=${v ?? "n/a"}`).join(", ") : "";
    return `${r.matched} of ${r.scanned} rows${totals ? ` — ${totals}` : ""}${r.groups ? `, ${r.groups.length} groups` : ""}`;
  }
  if (r?.completeness) return `${r.rows} rows, ${r.warnings?.length ?? 0} warnings`;
  if (r?.values) return `${r.values.length} distinct values`;
  if (r?.period) return `brief for ${r.period}`;
  if (r?.datasets) return `${r.datasets.length} boards`;
  if (Array.isArray(r?.rows)) return `${r.rows.length} sample rows`;
  return "ok";
}

export async function* runAgent(history: ChatMessage[]): AsyncGenerator<AgentEvent> {
  const { configured, provider, model } = providerInfo();
  if (!configured) {
    yield {
      type: "error",
      text: "No model provider is configured.",
      hint: "Set GEMINI_API_KEY (free, no card: aistudio.google.com/apikey), GROQ_API_KEY or ANTHROPIC_API_KEY in the deployment environment.",
    };
    return;
  }

  yield { type: "status", text: "Reading boards from monday.com" };
  const system = systemPrompt(await schemaSummary());

  const turns: Turn[] = history.map((m) =>
    m.role === "user" ? { role: "user" as const, content: m.content } : { role: "assistant" as const, content: m.content, toolCalls: [] },
  );

  for (let step = 0; step < MAX_STEPS; step++) {
    let reply: { text: string; toolCalls: ToolCall[] };
    try {
      yield { type: "status", text: step === 0 ? `Thinking (${provider}/${model})` : "Interpreting results" };
      reply = await complete(system, turns, TOOL_SPECS);
    } catch (err) {
      if (err instanceof LLMError) yield { type: "error", text: err.message, hint: err.hint };
      else yield { type: "error", text: err instanceof Error ? err.message : String(err) };
      return;
    }

    if (!reply.toolCalls.length) {
      yield { type: "answer", text: reply.text || "I could not produce an answer for that. Try rephrasing the question." };
      return;
    }

    turns.push({ role: "assistant", content: reply.text, toolCalls: reply.toolCalls });

    for (const call of reply.toolCalls) {
      yield { type: "tool", name: call.name, args: call.args };
      let payload: unknown;
      try {
        payload = await executeTool(call.name, call.args);
        yield { type: "tool_result", name: call.name, summary: summarise(payload) };
      } catch (err) {
        const message =
          err instanceof MondayError
            ? `monday.com error: ${err.message}${err.hint ? ` (${err.hint})` : ""}`
            : err instanceof Error
              ? err.message
              : String(err);
        payload = { error: message, advice: "Tell the user plainly that this data could not be read, and what would fix it. Do not retry the same call." };
        yield { type: "tool_result", name: call.name, summary: `failed: ${message.slice(0, 120)}` };
      }

      let content = JSON.stringify(payload);
      if (content.length > 60_000) content = `${content.slice(0, 60_000)}... [truncated - narrow the query with filters or a limit]`;
      turns.push({ role: "tool", callId: call.id, name: call.name, content });
    }
  }

  yield {
    type: "answer",
    text: "I hit the tool-call limit for this question. Try asking something narrower - one metric, one board, one timeframe.",
  };
}
