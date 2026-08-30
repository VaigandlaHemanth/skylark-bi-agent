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
export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Provider-specific data that must be echoed back verbatim (Gemini 3 thought signatures). */
  signature?: string;
};

export type Turn =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; callId: string; name: string; content: string };

export type Provider = "gemini" | "groq" | "anthropic";

export class LLMError extends Error {
  constructor(message: string, readonly hint?: string, readonly status?: number) {
    super(message);
    this.name = "LLMError";
  }
}

function modelFor(p: Provider): string {
  if (p === "gemini") return process.env.GEMINI_MODEL || "gemini-3.6-flash";
  if (p === "groq") return process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  return process.env.ANTHROPIC_MODEL || "claude-opus-5";
}

/**
 * Every configured provider, in the order they will be tried. Free tiers go
 * down (Gemini returned 503 "high demand" during development), so the agent
 * falls through to the next one rather than failing the user's question.
 * LLM_PROVIDER, when set, is moved to the front rather than made exclusive.
 */
export function providerChain(): Array<{ provider: Provider; model: string }> {
  const chain: Array<{ provider: Provider; model: string }> = [];
  if (process.env.GEMINI_API_KEY) {
    chain.push({ provider: "gemini", model: modelFor("gemini") });
    // Free-tier rate limits are PER MODEL, so a lite rung on the same key is
    // a separate quota bucket - real extra capacity for free.
    const lite = process.env.GEMINI_FALLBACK_MODEL || "gemini-flash-lite-latest";
    if (lite !== modelFor("gemini")) chain.push({ provider: "gemini", model: lite });
  }
  if (process.env.GROQ_API_KEY) chain.push({ provider: "groq", model: modelFor("groq") });
  if (process.env.ANTHROPIC_API_KEY) chain.push({ provider: "anthropic", model: modelFor("anthropic") });

  const preferred = process.env.LLM_PROVIDER as Provider | undefined;
  if (preferred && chain.some((c) => c.provider === preferred)) {
    return [...chain.filter((c) => c.provider === preferred), ...chain.filter((c) => c.provider !== preferred)];
  }
  return chain;
}

export function providerInfo(): { provider: Provider | null; model: string; configured: boolean; fallbacks: string[] } {
  const chain = providerChain();
  return {
    provider: chain[0]?.provider ?? null,
    model: chain[0]?.model ?? "-",
    configured: chain.length > 0,
    fallbacks: chain.slice(1).map((c) => `${c.provider}/${c.model}`),
  };
}

export type Completion = { text: string; toolCalls: ToolCall[]; provider: Provider; model: string };

export async function complete(system: string, turns: Turn[], tools: ToolSpec[], prefer?: Provider): Promise<Completion> {
  // Stickiness: once a step succeeded on provider X, later steps of the same
  // question try X first, so the tool-call history stays in one dialect
  // (Gemini thought signatures do not replay across providers).
  let chain = providerChain();
  if (prefer && chain.some((c) => c.provider === prefer)) {
    chain = [...chain.filter((c) => c.provider === prefer), ...chain.filter((c) => c.provider !== prefer)];
  }
  if (!chain.length) {
    throw new LLMError(
      "No model provider is configured on the server.",
      "Set GEMINI_API_KEY (free at aistudio.google.com/apikey), GROQ_API_KEY, or ANTHROPIC_API_KEY.",
    );
  }

  const failures: string[] = [];

  for (let i = 0; i < chain.length; i++) {
    const { provider, model } = chain[i];
    // Retry only on the last rung. Anywhere else, failing over is faster than
    // waiting out a backoff.
    const isLast = i === chain.length - 1;
    const attempts = isLast ? 3 : 1;
    try {
      const run = provider === "gemini" ? gemini : provider === "groq" ? groq : anthropic;
      const result = await run(system, turns, tools, model, attempts, isLast);
      // An empty turn with no tool call is a dead end; let the next provider try.
      if (!result.text && !result.toolCalls.length && chain.length > 1) {
        throw new LLMError(`${provider} returned an empty response`);
      }
      return { ...result, provider, model };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${provider}/${model}: ${message.slice(0, 160)}`);
      console.warn(`[llm] ${provider} failed, trying next provider — ${message.slice(0, 200)}`);
    }
  }

  throw new LLMError(
    `Every configured model provider failed. ${failures.join(" | ")}`,
    "Free tiers rate-limit and occasionally return 503. Wait a moment and ask again, or add another provider key.",
  );
}

/* ----------------------------------------------------------------- helpers */

/**
 * Retry only what a retry can fix. A rate limit or an over-size request will not
 * clear in two seconds, and burning three backoffs on it only delays the
 * failover to a provider that is free right now.
 */
const NOT_WORTH_RETRYING = new Set([400, 401, 403, 404, 413, 429]);

/**
 * A slow provider is worse than a failed one: measured in production, a single
 * hanging Gemini call retried three times cost 26 of a question's 30 seconds,
 * while the fallback answered the whole question in 5. So a request is capped,
 * and when another provider is waiting the chain moves on instead of retrying.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 15000);

/**
 * Whether a rate limit is worth waiting out depends on what is behind this
 * provider. With a fallback available, failing over is faster. With nothing
 * left, a few seconds of backoff is the difference between an answer and an
 * error - free-tier limits are per minute and do clear.
 */
async function withRetry<T>(label: string, fn: (signal: AbortSignal) => Promise<T>, attempts = 3, isLast = false): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i) {
      const rateLimited = last instanceof LLMError && last.status === 429;
      await new Promise((r) => setTimeout(r, rateLimited ? 4000 * i : 700 * 2 ** i));
    }
    try {
      return await fn(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    } catch (err) {
      last = err;
      const status = err instanceof LLMError ? err.status : undefined;
      if (status === undefined) continue; // network or timeout: worth another go
      // On the last rung a rate limit is worth waiting out; everywhere else the
      // chain should move on. Everything else in the set stays fatal.
      if (status === 429 && isLast) continue;
      if (NOT_WORTH_RETRYING.has(status)) throw err;
    }
  }
  const why = last instanceof Error ? last.message : String(last);
  throw new LLMError(
    attempts === 1 ? `${label}: ${why}` : `${label} failed after ${attempts} attempts: ${why}`,
    undefined,
    last instanceof LLMError ? last.status : undefined,
  );
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

async function gemini(system: string, turns: Turn[], tools: ToolSpec[], model: string, attempts = 3, isLast = false) {
  const key = process.env.GEMINI_API_KEY!;

  const contents: Array<Record<string, unknown>> = [];
  for (const t of turns) {
    if (t.role === "user") {
      contents.push({ role: "user", parts: [{ text: t.content }] });
    } else if (t.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      if (t.content) parts.push({ text: t.content });
      for (const c of t.toolCalls) {
        parts.push({
          functionCall: { name: c.name, args: c.args },
          // Gemini 3 requires a thoughtSignature on replayed function calls.
          // Calls authored by a fallback provider have none, so send Google's
          // documented placeholder rather than 400 on the whole request.
          thoughtSignature: c.signature ?? "context_engineering_is_the_way_to_go",
        });
      }
      if (parts.length) contents.push({ role: "model", parts });
    } else {
      // Parallel tool results must be PARTS of one user turn - Gemini rejects
      // consecutive user turns that each carry a lone functionResponse.
      const part = { functionResponse: { name: t.name, response: { result: t.content } } };
      const prev = contents[contents.length - 1] as { role: string; parts: Array<Record<string, unknown>> } | undefined;
      if (prev?.role === "user" && prev.parts.every((p) => "functionResponse" in p)) prev.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
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

  return withRetry("Gemini", async (signal) => {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      signal,
      // Header, not a query param: newer "auth keys" (AQ....) require it, and a
      // credential must never travel in a URL where it can be logged.
      headers: { "Content-Type": "application/json", "X-goog-api-key": key },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text();
      if (res.status === 429) throw new LLMError("Gemini 429: free-tier rate limit.", undefined, 429);
      throw new LLMError(`Gemini HTTP ${res.status}: ${detail.slice(0, 400)}`, undefined, res.status);
    }

    const json = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; thoughtSignature?: string; functionCall?: { name: string; args: Record<string, unknown> } }> };
        finishReason?: string;
      }>;
      promptFeedback?: { blockReason?: string };
    };

    if (json.promptFeedback?.blockReason) throw new LLMError(`Gemini blocked the request (${json.promptFeedback.blockReason}).`);

    const parts = json.candidates?.[0]?.content?.parts ?? [];
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const p of parts) {
      if (p.text) text += p.text;
      if (p.functionCall) {
        toolCalls.push({ id: nextId(), name: p.functionCall.name, args: p.functionCall.args ?? {}, signature: p.thoughtSignature });
      }
    }
    return { text: text.trim(), toolCalls };
  }, attempts, isLast);
}

/* ------------------------------------------------------------------- Groq */

async function groq(system: string, turns: Turn[], tools: ToolSpec[], model: string, attempts = 3, isLast = false) {
  const key = process.env.GROQ_API_KEY!;

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

  return withRetry("Groq", async (signal) => {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.1,
        max_tokens: 8000,
        tools: tools.length ? tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) : undefined,
      }),
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      // Groq's free tier is capped at 8k tokens/minute org-wide, so a long
      // transcript can exceed what one request is allowed to carry.
      if (res.status === 413) throw new LLMError(`Groq 413: conversation exceeds the free-tier tokens-per-minute cap. ${detail}`, undefined, 413);
      throw new LLMError(`Groq HTTP ${res.status}: ${detail}`, undefined, res.status);
    }

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
  }, attempts, isLast);
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    // Surface the corruption to the tool layer instead of silently running
    // the tool with empty (and therefore default) arguments.
    return { _malformed_arguments: s.slice(0, 200) };
  }
}

/* -------------------------------------------------------------- Anthropic */

async function anthropic(system: string, turns: Turn[], tools: ToolSpec[], model: string, _attempts = 3, _isLast = false) {
  const { default: AnthropicSDK } = await import("@anthropic-ai/sdk");
  const client = new AnthropicSDK({ apiKey: process.env.ANTHROPIC_API_KEY });

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
