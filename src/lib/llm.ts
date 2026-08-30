/**
 * Pluggable LLM layer.
 *
 * The agent only needs one capability from the model: read a question, pick tool
 * calls, then write prose over the tool results. That is small enough to run on a
 * free-tier model, so the provider is swappable by environment variable.
 *
 *   GEMINI_API_KEY    -> Google Gemini      (default; free tier, no card needed)
 *   GROQ_API_KEY      -> Groq               (free tier, OpenAI-compatible)
 *   ANTHROPIC_API_KEY -> Claude             (paid, best quality)
 */

// Type-only: the SDK is loaded lazily below, so it costs nothing when unused.
import type Anthropic from "@anthropic-ai/sdk";

export type JSONSchema = {
  type: string;
  description?: string;
  enum?: string[];
  items?: JSONSchema;
  properties?: Record<string, JSONSchema>;
  required?: string[];
};

export type ToolSpec = { name: string; description: string; parameters: JSONSchema };
export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

export type Turn =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; callId: string; name: string; content: string };

export type Provider = "gemini" | "groq" | "anthropic";

export class LLMError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "LLMError";
  }
}

export function providerInfo(): { provider: Provider | null; model: string; configured: boolean } {
  const forced = process.env.LLM_PROVIDER as Provider | undefined;
  const has = {
    gemini: !!process.env.GEMINI_API_KEY,
    groq: !!process.env.GROQ_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
  };
  const provider: Provider | null =
    forced && has[forced] ? forced : has.gemini ? "gemini" : has.groq ? "groq" : has.anthropic ? "anthropic" : null;

  const model =
    provider === "gemini"
      ? process.env.GEMINI_MODEL || "gemini-2.5-flash"
      : provider === "groq"
        ? process.env.GROQ_MODEL || "llama-3.3-70b-versatile"
        : provider === "anthropic"
          ? process.env.ANTHROPIC_MODEL || "claude-opus-5"
          : "-";

  return { provider, model, configured: !!provider };
}

export async function complete(
  system: string,
  turns: Turn[],
  tools: ToolSpec[],
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const { provider } = providerInfo();
  if (!provider) {
    throw new LLMError(
      "No model provider is configured on the server.",
      "Set GEMINI_API_KEY (free at aistudio.google.com/apikey), GROQ_API_KEY, or ANTHROPIC_API_KEY.",
    );
  }
  if (provider === "gemini") return gemini(system, turns, tools);
  if (provider === "groq") return groq(system, turns, tools);
  return anthropic(system, turns, tools);
}

/* ----------------------------------------------------------------- helpers */

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((r) => setTimeout(r, 800 * 2 ** i));
    try {
      return await fn();
    } catch (err) {
      last = err;
      const msg = err instanceof Error ? err.message : String(err);
      // 4xx other than rate limiting will not fix themselves.
      if (/\b(400|401|403|404)\b/.test(msg)) throw err;
    }
  }
  throw new LLMError(`${label} failed after 3 attempts: ${last instanceof Error ? last.message : String(last)}`);
}

let callSeq = 0;
const nextId = () => `call_${++callSeq}_${Math.random().toString(36).slice(2, 8)}`;

/* ------------------------------------------------------------ Google Gemini */

/** Gemini wants OpenAPI-style uppercase types and rejects unknown schema keys. */
function toGeminiSchema(s: JSONSchema): Record<string, unknown> {
  const out: Record<string, unknown> = { type: s.type.toUpperCase() };
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.items) out.items = toGeminiSchema(s.items);
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
  }
  if (s.required?.length) out.required = s.required;
  return out;
}

async function gemini(system: string, turns: Turn[], tools: ToolSpec[]) {
  const key = process.env.GEMINI_API_KEY!;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  const contents: Array<Record<string, unknown>> = [];
  for (const t of turns) {
    if (t.role === "user") {
      contents.push({ role: "user", parts: [{ text: t.content }] });
    } else if (t.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      if (t.content) parts.push({ text: t.content });
      for (const c of t.toolCalls) parts.push({ functionCall: { name: c.name, args: c.args } });
      if (parts.length) contents.push({ role: "model", parts });
    } else {
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: t.name, response: { result: t.content } } }],
      });
    }
  }

  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents,
    tools: tools.length
      ? [{ function_declarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) })) }]
      : undefined,
    generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
  };

  return withRetry("Gemini", async () => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );

    if (!res.ok) {
      const detail = await res.text();
      if (res.status === 429) throw new LLMError("Gemini free-tier rate limit hit (429). Wait a few seconds and ask again.");
      throw new LLMError(`Gemini HTTP ${res.status}: ${detail.slice(0, 400)}`);
    }

    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }> }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
    };

    if (json.promptFeedback?.blockReason) throw new LLMError(`Gemini blocked the request (${json.promptFeedback.blockReason}).`);

    const parts = json.candidates?.[0]?.content?.parts ?? [];
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const p of parts) {
      if (p.text) text += p.text;
      if (p.functionCall) toolCalls.push({ id: nextId(), name: p.functionCall.name, args: p.functionCall.args ?? {} });
    }
    return { text: text.trim(), toolCalls };
  });
}

/* ------------------------------------------------------------------- Groq */

async function groq(system: string, turns: Turn[], tools: ToolSpec[]) {
  const key = process.env.GROQ_API_KEY!;
  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

  const messages: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const t of turns) {
    if (t.role === "user") messages.push({ role: "user", content: t.content });
    else if (t.role === "assistant") {
      messages.push({
        role: "assistant",
        content: t.content || null,
        tool_calls: t.toolCalls.length
          ? t.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }))
          : undefined,
      });
    } else messages.push({ role: "tool", tool_call_id: t.callId, content: t.content });
  }

  return withRetry("Groq", async () => {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.1,
        max_tokens: 8000,
        tools: tools.length ? tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) : undefined,
      }),
    });

    if (!res.ok) throw new LLMError(`Groq HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
    };
    const msg = json.choices?.[0]?.message;
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      args: safeParse(c.function.arguments),
    }));
    return { text: (msg?.content ?? "").trim(), toolCalls };
  });
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/* -------------------------------------------------------------- Anthropic */

async function anthropic(system: string, turns: Turn[], tools: ToolSpec[]) {
  const { default: AnthropicSDK } = await import("@anthropic-ai/sdk");
  const client = new AnthropicSDK({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-5";

  const messages: Anthropic.MessageParam[] = [];
  for (const t of turns) {
    if (t.role === "user") messages.push({ role: "user", content: t.content });
    else if (t.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (t.content) content.push({ type: "text", text: t.content });
      for (const c of t.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      if (content.length) messages.push({ role: "assistant", content });
    } else {
      const prev = messages[messages.length - 1];
      const block: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: t.callId, content: t.content };
      if (prev?.role === "user" && Array.isArray(prev.content)) prev.content.push(block);
      else messages.push({ role: "user", content: [block] });
    }
  }

  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    system,
    messages,
    tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })),
  });

  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of response.content) {
    if (block.type === "text") text += block.text;
    if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, args: block.input as Record<string, unknown> });
  }
  return { text: text.trim(), toolCalls };
}
