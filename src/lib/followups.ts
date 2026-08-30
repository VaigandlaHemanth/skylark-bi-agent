import type { TraceDetail } from "./agent";

/**
 * Follow-up questions derived from what the tools actually did.
 *
 * A static list repeats itself and ignores the conversation; asking the model
 * for suggestions costs another free-tier call and can invent a question the
 * boards cannot answer. So follow-ups are computed from the trace: the board
 * that was read, the group that carried the total, the caveats that fired.
 * Every suggestion is therefore answerable by construction, and it costs
 * nothing to produce.
 */

export type FollowUpStep = { name?: string; trace?: TraceDetail };

const BOARD_LABEL: Record<string, string> = { deals: "deals", work_orders: "work orders" };

/** An `in` filter arrives comma-joined; a sentence wants it spelled out. */
function phrase(s: string): string {
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  const head = parts.length > 2 ? [...parts.slice(0, 2), "others"] : parts;
  const joined = head.length > 1 ? `${head.slice(0, -1).join(", ")} and ${head[head.length - 1]}` : (head[0] ?? s);
  return joined.replace(/^[a-z]/, (c) => c.toUpperCase());
}

/** Internal field keys are not what a founder calls the column. */
const FIELD_LABEL: Record<string, string> = {
  value: "deal value",
  close_date: "close date",
  billed: "billed amount",
  receivable: "amount receivable",
  collected: "amount collected",
  owner: "owner",
  stage: "deal stage",
  quantity: "quantity",
};

function humanField(f: string): string {
  return FIELD_LABEL[f] ?? f.replace(/_/g, " ");
}

/** Pull the column name out of a caveat that names one in quotes. */
function quotedName(caveat: string): string | null {
  const m = caveat.match(/"([^"]+)"/);
  if (!m) return null;
  // Two caveat shapes quote a name: the store's names the spreadsheet heading,
  // the engine's names the internal field. Only the first reads as a column.
  return FIELD_LABEL[m[1]] ?? m[1];
}

export function deriveFollowUps(opts: {
  answer: string;
  steps: FollowUpStep[];
  /** Steps from every earlier turn, so ground already covered is not re-offered. */
  priorSteps?: FollowUpStep[];
  asked: string[];
  fallback: string[];
  limit?: number;
}): string[] {
  const { answer, steps, asked, fallback } = opts;
  const limit = opts.limit ?? 3;
  const prior = (opts.priorSteps ?? []).map((s) => s.trace).filter((t): t is TraceDetail => !!t);

  const traces = steps.map((s) => s.trace).filter((t): t is TraceDetail => !!t);
  const tools = new Set(steps.map((s) => s.name).filter(Boolean) as string[]);
  const boards = new Set(traces.map((t) => t.board).filter(Boolean) as string[]);
  const caveats = traces.flatMap((t) => t.caveats ?? []);
  const top = traces.find((t) => t.top)?.top;
  const filters = traces.flatMap((t) => t.filters ?? []);
  const resolved = traces.flatMap((t) => t.resolved ?? []);
  const timeframe = traces.find((t) => t.timeframe)?.timeframe;

  // Only sector and owner exist on both boards - compare.ts refuses anything
  // else because client codes do not overlap. Scoping the cross-board pivot by
  // any other dimension asks a question the boards cannot answer: a deal
  // grouped by status yields "how is delivery tracking for Won", which is not
  // a thing work orders have.
  const SHARED = new Set(["sector", "owner"]);
  const pivotSubject =
    filters.find((f) => SHARED.has(f.field))?.value ??
    (top && SHARED.has(traces.find((t) => t.top)?.groupBy ?? "") ? top.label : undefined);

  // A suggestion is only worth making the first time its evidence appears.
  // Without this the pivot bounces between the two boards on the same subject,
  // and a caveat that fires on every query proposes the same question forever.
  const seenPair = new Set(
    [...prior, ...traces].flatMap((t) => {
      if (!t.board) return [];
      const subs = (t.filters ?? [])
        .filter((f) => f.field === "sector" || f.field === "client" || f.field === "owner")
        .map((f) => f.value);
      if (t.top) subs.push(t.top.label);
      return subs.map((v) => `${t.board}|${v}`);
    }),
  );
  const spent = (kind: string, key: string) => {
    const priorKeys = new Set(
      prior.flatMap((t) => [
        ...(t.caveats ?? []).map((c) => `thin|${quotedName(c) ?? ""}`),
        ...(t.top && (t.caveats ?? []).some((c) => /concentrated in one group/i.test(c)) ? [`conc|${t.top.label}`] : []),
        ...(t.resolved ?? []).filter((r) => r.used.length > 1).map((r) => `split|${r.used.join(",")}`),
      ]),
    );
    return priorKeys.has(`${kind}|${key}`);
  };

  const out: string[] = [];
  const add = (q: string) => {
    if (out.length < limit && !out.includes(q)) out.push(q);
  };

  // An answer that ends by asking something needs an answer, not a new topic.
  // The bold spans are the offered readings - but only the ones that read as a
  // choice. phrase() must not be used here: it splits on commas to expand an
  // `in` list, so a bolded figure like "1,240" came back as the chip
  // "1 and 240", and a bolded single word made a chip that answers nothing.
  if (/\?\s*$/.test(answer.trim())) {
    const choices = (answer.match(/\*\*([^*]{3,40})\*\*/g) ?? [])
      .map((m) => m.replace(/\*/g, "").trim())
      .filter((o) => o.split(/\s+/).length >= 2 && /[a-z]{3}/i.test(o) && !/^[\d,.\s%₹$€£]+$/.test(o));
    for (const o of choices.slice(0, 2)) add(o.replace(/^[a-z]/, (c) => c.toUpperCase()));
    if (out.length) return out;
  }

  // 1. The cross-board pivot — the question neither board answers alone.
  if (boards.size === 1) {
    const only = [...boards][0];
    const other = only === "deals" ? "work_orders" : "deals";
    const covered = pivotSubject ? seenPair.has(`${other}|${pivotSubject}`) : prior.some((t) => t.board === other);
    if (!covered) {
      if (only === "deals") {
        add(pivotSubject ? `How is delivery tracking for ${phrase(pivotSubject)}?` : "How does that compare with what we are delivering?");
      } else if (only === "work_orders") {
        add(pivotSubject ? `What does the pipeline look like for ${phrase(pivotSubject)}?` : "How does that compare with what we are selling?");
      }
    }
  }

  // 2. Concentration — a headline one group carries is the thing to interrogate.
  const conc = caveats.find((c) => /concentrated in one group/i.test(c));
  if (conc && top && !spent("conc", top.label)) add(`Why does ${phrase(top.label)} account for so much of that?`);

  // 3. A caveat about coverage is an invitation to check the data itself.
  // The store's fill-rate caveat names the spreadsheet heading, so it makes a
  // better question than the engine's, which names the internal field.
  const thin = caveats.find((c) => /% filled/i.test(c)) ?? caveats.find((c) => /excluded from sums/i.test(c));
  if (thin && !spent("thin", quotedName(thin) ?? "")) {
    const col = quotedName(thin);
    add(col ? `How reliable is the ${col} column?` : "How complete is the data behind that?");
  }

  // 4. A word that resolved onto several board values can be split apart.
  const multi = resolved.find((r) => r.used.length > 1);
  if (multi && !spent("split", multi.used.join(","))) add(`Split ${multi.used.slice(0, 2).join(" and ")} out separately.`);

  // 5. A grouped answer hides the individual records underneath it. The noun
  //    has to follow the board actually read, or a work-order answer offers to
  //    show deals that were never queried.
  const topBoard = traces.find((t) => t.top)?.board;
  if (top && !tools.has("sample_rows")) {
    const noun = BOARD_LABEL[topBoard ?? ""] ?? "records";
    add(`Which are the largest ${phrase(top.label)} ${noun}?`);
  }

  // 6. A period figure invites the comparison against the one before it.
  const timeframeFailed = caveats.some((c) => /Could not interpret the timeframe|no usable date column/i.test(c));
  if (timeframe && !timeframeFailed) add(`How does ${timeframe} compare with the period before it?`);

  // 7. A brief is a starting point for the risks inside it.
  if (tools.has("leadership_brief")) add("What are the biggest risks in that?");

  // 8. A grouped answer on one field is worth cutting a different way.
  const grouped = traces.find((t) => t.groupBy)?.groupBy;
  if (grouped && grouped !== "owner") add(`Break that down by owner instead of ${humanField(grouped)}.`);

  const seen = new Set(asked.map((a) => a.trim().toLowerCase()));
  const fresh = out.filter((q) => !seen.has(q.toLowerCase()));
  for (const f of fallback) {
    if (fresh.length >= limit) break;
    if (!seen.has(f.toLowerCase()) && !fresh.includes(f)) fresh.push(f);
  }
  return fresh.slice(0, limit);
}

