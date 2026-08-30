"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

type Role = "user" | "assistant";
type Step = { label: string; detail?: string; kind: "run" | "done" | "err" };
type Turn = { role: Role; content: string; steps?: Step[] };

type Health = {
  ready: boolean;
  llm: { provider: string | null; model: string; configured: boolean };
  monday: { tokenSet: boolean; error?: string; datasets?: Array<{ board: string; name: string | null; rows: number; error: string | null }> };
};

const SUGGESTIONS = [
  "How's our pipeline looking for the energy sector?",
  "Prepare the leadership update for FY26",
  "What's our win rate, and where are we losing?",
  "How much is sitting in receivables, and with whom?",
  "How much work is overdue?",
  "How reliable is the deal value column?",
];

const TOOL_LABELS: Record<string, string> = {
  list_boards_and_fields: "Reading board schema",
  distinct_values: "Checking board vocabulary",
  query_board: "Querying monday.com",
  sample_rows: "Inspecting records",
  data_quality: "Checking data quality",
  leadership_brief: "Assembling exec snapshot",
};

export default function Page() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);

  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const grow = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, []);

  const ask = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text || busy) return;

      setDraft("");
      requestAnimationFrame(grow);
      setBusy(true);

      const history = [...turns, { role: "user" as const, content: text }];
      setTurns([...history, { role: "assistant", content: "", steps: [] }]);

      const patch = (fn: (t: Turn) => Turn) =>
        setTurns((prev) => prev.map((t, i) => (i === prev.length - 1 ? fn(t) : t)));

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })) }),
        });

        if (!res.ok || !res.body) throw new Error(`Server returned ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";

          for (const chunk of chunks) {
            const line = chunk.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;

            let ev: Record<string, string>;
            try {
              ev = JSON.parse(line.slice(6));
            } catch {
              continue;
            }

            if (ev.type === "status") {
              patch((t) => ({ ...t, steps: [...(t.steps ?? []).filter((s) => s.kind !== "run"), { label: ev.text, kind: "run" }] }));
            } else if (ev.type === "tool") {
              patch((t) => ({
                ...t,
                steps: [...(t.steps ?? []).filter((s) => s.kind !== "run"), { label: TOOL_LABELS[ev.name] ?? ev.name, kind: "run" }],
              }));
            } else if (ev.type === "tool_result") {
              patch((t) => {
                const steps = [...(t.steps ?? [])];
                const last = steps.findLastIndex((s) => s.kind === "run");
                const failed = ev.summary?.startsWith("failed");
                if (last >= 0) steps[last] = { ...steps[last], kind: failed ? "err" : "done", detail: ev.summary };
                return { ...t, steps };
              });
            } else if (ev.type === "answer") {
              patch((t) => ({ ...t, content: ev.text, steps: (t.steps ?? []).map((s) => (s.kind === "run" ? { ...s, kind: "done" } : s)) }));
            } else if (ev.type === "error") {
              patch((t) => ({
                ...t,
                content: `**Something went wrong.**\n\n${ev.text}${ev.hint ? `\n\n${ev.hint}` : ""}`,
                steps: (t.steps ?? []).map((s) => (s.kind === "run" ? { ...s, kind: "err" } : s)),
              }));
            }
          }
        }
      } catch (err) {
        patch((t) => ({ ...t, content: `**Could not reach the agent.**\n\n${err instanceof Error ? err.message : String(err)}`, steps: [] }));
      } finally {
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [busy, grow, turns],
  );

  const provider = health?.llm.provider;
  const rows = health?.monday.datasets?.reduce((n, d) => n + (d.rows ?? 0), 0) ?? 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="mark" aria-hidden>◈</div>
        <div className="titles">
          <span className="title">Skylark BI Agent</span>
          <span className="subtitle">
            {health?.ready ? `${rows.toLocaleString()} live rows across 2 monday.com boards` : "Business intelligence over monday.com"}
          </span>
        </div>
        <span className="status" title={provider ? `${provider} / ${health?.llm.model}` : "Not configured"}>
          <span className="dot" data-state={health ? (health.ready ? "ok" : "bad") : undefined} />
          {health ? (health.ready ? "Connected" : "Setup needed") : "Checking"}
        </span>
      </header>

      <div className="thread" ref={threadRef}>
        {health && !health.ready && <SetupBanner health={health} />}

        {!turns.length && (
          <div className="empty">
            <h1 className="lede">Ask anything about the business.</h1>
            <p className="lede-sub">
              I read your monday.com work orders and deals live, clean the messy bits, and tell you what the numbers mean — with the caveats attached.
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion" onClick={() => ask(s)} disabled={busy}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t, i) => (
          <div className="turn" data-role={t.role} key={i}>
            {t.role === "user" ? (
              <div className="bubble">{t.content}</div>
            ) : (
              <>
                {!!t.steps?.length && (
                  <div className="trace">
                    {t.steps.map((s, j) => (
                      <span className="step" data-kind={s.kind === "err" ? "err" : undefined} key={j} title={s.detail}>
                        {s.kind === "run" ? <span className="pulse" /> : s.kind === "err" ? "!" : "✓"}
                        {s.label}
                      </span>
                    ))}
                  </div>
                )}
                {t.content && <div className="answer">{renderMarkdown(t.content)}</div>}
              </>
            )}
          </div>
        ))}
      </div>

      <div className="composer">
        <div className="field">
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder="How's our pipeline looking for energy this quarter?"
            onChange={(e) => {
              setDraft(e.target.value);
              grow();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask(draft);
              }
            }}
            disabled={busy}
          />
          <button className="send" onClick={() => ask(draft)} disabled={busy || !draft.trim()} aria-label="Send">
            {busy ? "…" : "↑"}
          </button>
        </div>
        <p className="foot">Read-only. Figures are computed in code from live board data, never written by the model.</p>
      </div>
    </div>
  );
}

function SetupBanner({ health }: { health: Health }) {
  const missing: ReactNode[] = [];
  if (!health.llm.configured) missing.push(<span key="llm">Set <code>GEMINI_API_KEY</code> (free at aistudio.google.com/apikey), <code>GROQ_API_KEY</code> or <code>ANTHROPIC_API_KEY</code>.</span>);
  if (!health.monday.tokenSet) missing.push(<span key="tok">Set <code>MONDAY_API_TOKEN</code>.</span>);
  else if (health.monday.error) missing.push(<span key="err">monday.com: {health.monday.error}</span>);
  for (const d of health.monday.datasets ?? []) {
    if (d.error) missing.push(<span key={d.board}>{d.board}: {d.error}</span>);
  }

  return (
    <div className="banner">
      <span aria-hidden>⚠</span>
      <div>
        <strong>Setup incomplete.</strong>
        <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.1rem" }}>
          {missing.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ------------------------------------------- tiny markdown subset renderer */

function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;

  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith("**")) out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`")) out.push(<code key={key}>{token.slice(1, -1)}</code>);
    else out.push(<em key={key}>{token.slice(1, -1)}</em>);
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderMarkdown(src: string): ReactNode[] {
  const lines = src.replace(/\r/g, "").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;

  const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    if (/^#{1,6}\s/.test(line)) {
      out.push(<h3 key={k++}>{inline(line.replace(/^#{1,6}\s*/, ""), `h${k}`)}</h3>);
      i++;
      continue;
    }

    if (isTableRow(line) && isTableRow(lines[i + 1] ?? "") && /^[\s|:-]+$/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) body.push(cells(lines[i++]));
      out.push(
        <div className="tablewrap" key={k++}>
          <table>
            <thead>
              <tr>{head.map((c, j) => <th key={j}>{inline(c, `th${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => <td key={ci}>{inline(c, `td${ri}-${ci}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*•]\s+/, ""));
      out.push(<ul key={k++}>{items.map((it, j) => <li key={j}>{inline(it, `li${j}`)}</li>)}</ul>);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      out.push(<ol key={k++}>{items.map((it, j) => <li key={j}>{inline(it, `oi${j}`)}</li>)}</ol>);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,6}\s/.test(lines[i]) && !/^\s*[-*•\d]/.test(lines[i]) && !isTableRow(lines[i])) {
      para.push(lines[i++]);
    }
    const text = para.join(" ");
    // A whole paragraph in italics at the end is the caveat footnote.
    if (/^\*[^*].*\*$/.test(text.trim())) out.push(<em className="caveat" key={k++}>{text.trim().slice(1, -1)}</em>);
    else out.push(<p key={k++}>{inline(text, `p${k}`)}</p>);
  }

  return out;
}
