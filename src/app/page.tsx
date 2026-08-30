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

const SUGGESTIONS: Array<{ cat: string; q: string }> = [
  { cat: "Pipeline", q: "How's our pipeline looking for the energy sector?" },
  { cat: "Leadership", q: "Prepare the leadership update for FY26" },
  { cat: "Sales", q: "What's our win rate, and where are we losing?" },
  { cat: "Cash", q: "How much is sitting in receivables, and with whom?" },
  { cat: "Delivery", q: "How much work is overdue?" },
  { cat: "Data quality", q: "How reliable is the deal value column?" },
];

const TOOL_LABELS: Record<string, string> = {
  list_boards_and_fields: "Reading board schema",
  distinct_values: "Checking board vocabulary",
  query_board: "Querying monday.com",
  sample_rows: "Inspecting records",
  data_quality: "Checking data quality",
  leadership_brief: "Assembling exec snapshot",
};

/* ------------------------------------------------------------------- icons */

const Icon = {
  send: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 12.5v-9M4.2 7.2 8 3.4l3.8 3.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  stop: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  ),
  copy: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.8" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 3.5h-6a2 2 0 0 0-2 2v6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  check: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  plus: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  ),
  down: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3.5v9M4.2 8.8 8 12.6l3.8-3.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

export default function Page() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [hintIdx, setHintIdx] = useState(0);
  const [showJump, setShowJump] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);

  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // The conversation survives a refresh - per-browser convenience only.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("skylark-chat");
      if (saved) {
        const parsed = JSON.parse(saved) as Turn[];
        if (Array.isArray(parsed) && parsed.length) setTurns(parsed.slice(-24));
      }
    } catch {
      /* corrupted or unavailable storage - start fresh */
    }
  }, []);

  useEffect(() => {
    if (busy) return; // save settled conversations only
    try {
      if (turns.length) localStorage.setItem("skylark-chat", JSON.stringify(turns.slice(-24)));
    } catch {
      /* storage full or unavailable */
    }
  }, [turns, busy]);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  // Rotate the ghost hint while the field is idle.
  useEffect(() => {
    if (draft || busy) return;
    const id = setInterval(() => setHintIdx((i) => (i + 1) % SUGGESTIONS.length), 7000);
    return () => clearInterval(id);
  }, [draft, busy]);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    // Follow the stream only if the user is already near the bottom -
    // never yank them down while they are reading scrollback.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const onThreadScroll = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 320);
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = threadRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  const grow = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
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

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })) }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(detail?.error ?? `Server returned ${res.status}`);
        }
        if (!res.body) throw new Error("The server sent no response stream.");

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
                let last = -1; // findLastIndex, minus the browser-support risk
                for (let j = steps.length - 1; j >= 0; j--) {
                  if (steps[j].kind === "run") { last = j; break; }
                }
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
        if (err instanceof DOMException && err.name === "AbortError") {
          patch((t) => ({
            ...t,
            content: t.content || "Stopped.",
            steps: (t.steps ?? []).map((s) => (s.kind === "run" ? { ...s, kind: "done" } : s)),
          }));
        } else {
          patch((t) => ({ ...t, content: `**Could not reach the agent.**\n\n${err instanceof Error ? err.message : String(err)}`, steps: [] }));
        }
      } finally {
        // If the stream died mid-flight (network drop, serverless timeout),
        // close out the pulsing step chips and say so instead of hanging.
        patch((t) =>
          t.content
            ? t
            : {
                ...t,
                content: "The connection dropped before the answer arrived. Ask again - the boards are cached, so the retry is fast.",
                steps: (t.steps ?? []).map((s) => (s.kind === "run" ? { ...s, kind: "err" } : s)),
              },
        );
        abortRef.current = null;
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [busy, grow, turns],
  );

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    setTurns([]);
    try {
      localStorage.removeItem("skylark-chat");
    } catch {
      /* storage unavailable */
    }
    inputRef.current?.focus();
  }, []);

  const copyAnswer = useCallback((index: number, content: string) => {
    navigator.clipboard?.writeText(content).then(() => {
      setCopied(index);
      setTimeout(() => setCopied((c) => (c === index ? null : c)), 1600);
    });
  }, []);

  const provider = health?.llm.provider;
  const rows = health?.monday.datasets?.reduce((n, d) => n + (d.rows ?? 0), 0) ?? 0;
  const hint = SUGGESTIONS[hintIdx].q;

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
        {turns.length > 0 && (
          <button className="newchat" onClick={newChat} disabled={busy}>
            {Icon.plus}
            <span>New chat</span>
          </button>
        )}
        <span className="status" title={provider ? `${provider} / ${health?.llm.model}` : "Not configured"}>
          <span className="dot" data-state={health ? (health.ready ? "ok" : "bad") : undefined} />
          {health ? (health.ready ? "Connected" : "Setup needed") : "Checking"}
        </span>
      </header>

      <div className="thread" ref={threadRef} onScroll={onThreadScroll}>
        {health && !health.ready && <SetupBanner health={health} />}

        {!turns.length && (
          <div className="empty">
            <h1 className="lede">Ask anything about the business.</h1>
            <p className="lede-sub">
              I read your monday.com work orders and deals live, clean the messy bits, and tell you what the numbers mean — with the caveats attached.
            </p>
            <div className="cards" role="list">
              {SUGGESTIONS.map((s, i) => (
                <button key={s.q} role="listitem" className="card" style={{ animationDelay: `${80 + i * 45}ms` }} onClick={() => ask(s.q)} disabled={busy}>
                  <span className="cat">{s.cat}</span>
                  <span className="q">{s.q}</span>
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
                <div className="msghead">
                  <span className="mark mini" aria-hidden>◈</span>
                  <span className="who">Skylark BI</span>
                  {t.content && !t.content.startsWith("**Something went wrong") && (
                    <button
                      className="copy"
                      onClick={() => copyAnswer(i, t.content)}
                      aria-label={copied === i ? "Copied" : "Copy answer"}
                      data-done={copied === i || undefined}
                    >
                      {copied === i ? Icon.check : Icon.copy}
                      <span>{copied === i ? "Copied" : "Copy"}</span>
                    </button>
                  )}
                </div>
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

      {showJump && (
        <button className="jump" onClick={jumpToLatest} aria-label="Jump to latest">
          {Icon.down}
        </button>
      )}

      <div className="composer">
        <div className="field">
          <div className="inputwrap">
            {!draft && (
              <span className="ghost" key={hintIdx} aria-hidden>
                {hint}
              </span>
            )}
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              aria-label="Ask a question about the business"
              onChange={(e) => {
                setDraft(e.target.value);
                grow();
              }}
              onKeyDown={(e) => {
                // Tab accepts the ghost suggestion, like inline autocomplete.
                if (e.key === "Tab" && !e.shiftKey && !draft.trim() && !busy) {
                  e.preventDefault();
                  setDraft(hint);
                  requestAnimationFrame(grow);
                  return;
                }
                // isComposing: Enter during IME composition confirms the
                // characters - it must not send the message.
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  ask(draft);
                }
              }}
              disabled={busy}
            />
          </div>
          {busy ? (
            <button className="send stop" onClick={stop} aria-label="Stop generating">
              {Icon.stop}
            </button>
          ) : (
            <button className="send" onClick={() => ask(draft)} disabled={!draft.trim()} aria-label="Send">
              {Icon.send}
            </button>
          )}
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

    // Paragraph. MUST consume at least one line no matter what it starts with —
    // a line like "**Total:** 42" or "31 deals open" is a paragraph, and
    // refusing it here would loop forever. Continuation stops only at real
    // structure: a blank line, heading, list item (marker + space), or table.
    const isStructural = (l: string) =>
      !l.trim() || /^#{1,6}\s/.test(l) || /^\s*[-*•]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l) || isTableRow(l);
    const para: string[] = [lines[i++]];
    while (i < lines.length && !isStructural(lines[i])) {
      para.push(lines[i++]);
    }
    const text = para.join(" ");
    // A whole paragraph in italics at the end is the caveat footnote.
    if (/^\*[^*].*\*$/.test(text.trim())) out.push(<em className="caveat" key={k++}>{text.trim().slice(1, -1)}</em>);
    else out.push(<p key={k++}>{inline(text, `p${k}`)}</p>);
  }

  return out;
}
