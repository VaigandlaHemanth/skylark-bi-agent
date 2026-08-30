import { runAgent, type ChatMessage } from "@/lib/agent";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * This endpoint fronts paid/free-tier LLM quotas, so it gets a per-IP sliding
 * window. In-memory, so it only bounds each serverless instance - an honest
 * speed bump for a public demo, not real abuse protection (that would need a
 * shared store; see the Decision Log).
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 8;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 1000) hits.clear(); // bound memory on a long-lived instance
  return recent.length > MAX_PER_WINDOW;
}

const MAX_MESSAGE_CHARS = 4_000;
const MAX_HISTORY = 12;

export async function POST(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") ?? "anon").split(",")[0].trim();
  if (rateLimited(ip)) {
    return Response.json({ error: "Too many requests - wait a minute and try again." }, { status: 429 });
  }

  let messages: ChatMessage[];
  try {
    const body = (await req.json()) as { messages?: ChatMessage[] };
    messages = (body.messages ?? [])
      .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }))
      .slice(-MAX_HISTORY);
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!messages.length) return Response.json({ error: "No messages supplied." }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // enqueue throws once the client is gone; treat that as "stop working",
      // not as an error - otherwise an abandoned tab burns the full 60s of
      // function time and LLM quota for an answer nobody reads.
      const send = (event: unknown): boolean => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          return true;
        } catch {
          return false;
        }
      };

      try {
        for await (const event of runAgent(messages)) {
          if (req.signal.aborted || !send(event)) break;
        }
      } catch (err) {
        send({ type: "error", text: err instanceof Error ? err.message : String(err) });
      } finally {
        send({ type: "done" });
        try {
          controller.close();
        } catch {
          /* already closed by the client disconnecting */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
