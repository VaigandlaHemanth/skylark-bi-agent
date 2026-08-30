/** The agent loop: question -> tool calls -> grounded answer. */

import { complete, LLMError, providerInfo, type ToolCall, type Turn } from "./llm";
import { MondayError } from "./monday";
import { boardsOverview } from "./store";
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
  return `You are the business intelligence agent for Skylark Drones. You answer founder-level questions by reading two live monday.com boards: a sales funnel ("deals") and a project execution tracker ("work_orders").

Today's date is ${today}. Resolve relative time expressions against it.

## Live board schema
${schema}

## Hard rules
1. Every number you state must come from a tool result. Never add, average or estimate figures yourself. If you need a number you do not have, call a tool.
2. Never invent a field, sector, client or stage that is not in the schema above. If a filter returns 0 rows, call sample_rows or list_boards_and_fields to find out what the data actually contains, then retry - do not report "0" without checking.
3. Surface data-quality caveats. Tool results include a "caveats" array; fold the material ones into your answer as a short note. A number built on 60%-complete data must say so.
4. Answer with insight, not just arithmetic. Say what the number means, what stands out, and what it implies. One concrete observation beats three restated figures.
5. Currency units are whatever the board uses - report magnitudes as stored, do not convert or assume a currency symbol unless the board shows one.

## Handling ambiguity
- Prefer answering with a stated assumption over stalling. Example: "Reading 'this quarter' as the calendar quarter Jul-Sep 2026."
- Ask exactly one clarifying question ONLY when different readings give materially different answers and you cannot pick a sensible default - for instance "revenue" could mean won deal value or delivered work-order value. Offer the options, and if the user is vague, answer the most likely reading anyway.
- "Pipeline" means deals in an open stage (Lead, Qualified, Proposal, Negotiation, On Hold) - not Won or Lost.

## Style
Short. Lead with the answer. Markdown, but sparingly: bold the headline figures, use a compact table only when comparing 3+ groups. No preamble, no restating the question, no closing offers of further help. Caveats go in one short italic line at the end.`;
}

async function schemaSummary(): Promise<string> {
  try {
    const overview = await boardsOverview();
    const lines: string[] = [];
    for (const d of overview.datasets as Array<Record<string, any>>) {
      if (d.error) {
        lines.push(`- ${d.board_key}: UNAVAILABLE - ${d.error}`);
        continue;
      }
      lines.push(`- ${d.board_key} ("${d.monday_board}", ${d.rows} rows) fields: ${(d.mapped_fields as string[]).map((f) => f.split(" <- ")[0]).join(", ")}`);
      if ((d.unmapped_columns as string[]).length) lines.push(`  unmapped columns kept as raw text: ${(d.unmapped_columns as string[]).join(", ")}`);
      if ((d.warnings as string[]).length) lines.push(`  known issues: ${(d.warnings as string[]).slice(0, 4).join(" | ")}`);
    }
    return lines.join("\n") || "No boards were readable.";
  } catch (err) {
    return `Board schema could not be read: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function summarise(result: unknown): string {
  const r = result as Record<string, any>;
  if (r?.matched !== undefined) {
    const totals = r.totals ? Object.entries(r.totals).map(([k, v]) => `${k}=${v ?? "n/a"}`).join(", ") : "";
    return `${r.matched} of ${r.scanned} rows${totals ? ` - ${totals}` : ""}${r.groups ? `, ${r.groups.length} groups` : ""}`;
  }
  if (r?.completeness) return `${r.rows} rows, ${r.warnings?.length ?? 0} warnings`;
  if (r?.period) return `brief for ${r.period}`;
  if (r?.datasets) return `${r.datasets.length} boards`;
  if (r?.rows) return `${r.rows.length ?? 0} sample rows`;
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

  yield { type: "status", text: "Reading board schema from monday.com" };
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
    text: "I hit the tool-call limit for this question. Try asking something narrower - for example one metric, one board, one timeframe.",
  };
}
