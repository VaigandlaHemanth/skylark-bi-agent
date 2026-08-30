/**
 * Board discovery, fuzzy column mapping, normalization and the data-quality report.
 *
 * The app never assumes the imported spreadsheet used particular headers. It reads
 * the board's real schema from monday.com and maps each column onto a canonical
 * business field by synonym + column-type scoring, so it survives renamed or
 * reordered columns.
 */

import { fetchItems, listBoards, MondayError, type BoardMeta } from "./monday";
import {
  canonical,
  cleanText,
  companyKey,
  DEAL_STAGES,
  detectDayOrder,
  isBlank,
  parseDate,
  parseNumber,
  parsePercent,
  SECTORS,
  WORK_STATUSES,
  type DayOrder,
  type Vocab,
} from "./normalize";

export type BoardKey = "deals" | "work_orders";
export type FieldType = "text" | "company" | "number" | "money" | "date" | "percent" | "enum";

type FieldSpec = {
  key: string;
  type: FieldType;
  label: string;
  vocab?: Vocab;
  synonyms: string[];
  /** monday column types that make this mapping more likely */
  prefers?: string[];
  boards: BoardKey[];
};

const FIELDS: FieldSpec[] = [
  { key: "client", type: "company", label: "Client / account", boards: ["deals", "work_orders"],
    synonyms: ["client", "client name", "customer", "customer name", "account", "account name", "company", "company name", "organisation", "organization", "partner"] },
  { key: "sector", type: "enum", label: "Sector", vocab: SECTORS, boards: ["deals", "work_orders"], prefers: ["status", "dropdown", "color"],
    synonyms: ["sector", "industry", "vertical", "domain", "segment", "market", "business vertical", "industry type"] },
  { key: "stage", type: "enum", label: "Deal stage", vocab: DEAL_STAGES, boards: ["deals"], prefers: ["status", "color", "dropdown"],
    synonyms: ["stage", "deal stage", "pipeline stage", "sales stage", "funnel stage", "status", "deal status", "opportunity stage"] },
  { key: "status", type: "enum", label: "Work order status", vocab: WORK_STATUSES, boards: ["work_orders"], prefers: ["status", "color", "dropdown"],
    synonyms: ["status", "work order status", "project status", "execution status", "job status", "state", "current status", "stage"] },
  { key: "value", type: "money", label: "Value", boards: ["deals", "work_orders"], prefers: ["numbers", "numeric", "formula"],
    synonyms: ["value", "deal value", "deal size", "amount", "revenue", "contract value", "order value", "project value", "estimated value", "total value", "price", "billing", "billing amount", "invoice amount", "budget", "quote value", "tcv", "acv", "cost"] },
  { key: "owner", type: "text", label: "Owner", boards: ["deals", "work_orders"], prefers: ["people", "person", "multiple-person"],
    synonyms: ["owner", "sales owner", "account owner", "assigned to", "assignee", "person", "sales rep", "rep", "bd owner", "project manager", "pm", "manager", "responsible", "handled by", "lead by", "team"] },
  { key: "close_date", type: "date", label: "Expected close date", boards: ["deals"], prefers: ["date", "timeline"],
    synonyms: ["close date", "expected close", "expected close date", "expected closure", "closing date", "decision date", "target close", "close"] },
  { key: "created_date", type: "date", label: "Created / enquiry date", boards: ["deals"], prefers: ["date", "creation_log"],
    synonyms: ["created", "created date", "created at", "date created", "enquiry date", "inquiry date", "lead date", "opened", "date received", "received on"] },
  { key: "start_date", type: "date", label: "Start date", boards: ["work_orders"], prefers: ["date", "timeline"],
    synonyms: ["start date", "start", "kickoff", "kick off", "commencement", "planned start", "actual start", "wo date", "order date", "date"] },
  { key: "end_date", type: "date", label: "End / due date", boards: ["work_orders"], prefers: ["date", "timeline"],
    synonyms: ["end date", "end", "completion date", "completed on", "delivery date", "due date", "deadline", "target date", "planned end", "actual end", "finish date", "closure date"] },
  { key: "region", type: "text", label: "Region / site", boards: ["deals", "work_orders"], prefers: ["location", "text"],
    synonyms: ["region", "location", "site", "site name", "city", "state", "geography", "zone", "territory", "area name", "project location"] },
  { key: "service", type: "text", label: "Service / project type", boards: ["deals", "work_orders"], prefers: ["dropdown", "status", "text"],
    synonyms: ["service", "service type", "product", "offering", "solution", "work type", "project type", "scope", "scope of work", "deliverable", "survey type", "job type"] },
  { key: "probability", type: "percent", label: "Win probability", boards: ["deals"], prefers: ["numbers", "numeric"],
    synonyms: ["probability", "win probability", "confidence", "likelihood", "chance", "win %", "probability %"] },
  { key: "progress", type: "percent", label: "Progress", boards: ["work_orders"], prefers: ["numbers", "progress", "numeric"],
    synonyms: ["progress", "completion", "% complete", "percent complete", "completion %", "% done", "progress %"] },
  { key: "priority", type: "text", label: "Priority", boards: ["deals", "work_orders"], prefers: ["status", "color", "dropdown"],
    synonyms: ["priority", "urgency", "criticality"] },
  { key: "area", type: "number", label: "Area covered", boards: ["work_orders"], prefers: ["numbers", "numeric"],
    synonyms: ["area", "acres", "acreage", "sq km", "sqkm", "square km", "hectares", "coverage", "area covered", "size", "km"] },
  { key: "source", type: "text", label: "Lead source", boards: ["deals"], prefers: ["dropdown", "status", "text"],
    synonyms: ["source", "lead source", "channel", "origin", "referral", "came from"] },
  { key: "notes", type: "text", label: "Notes", boards: ["deals", "work_orders"], prefers: ["long-text", "text"],
    synonyms: ["notes", "note", "remarks", "comments", "comment", "description", "details", "next step", "next steps"] },
];

/* ---------------------------------------------------------- column mapping */

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function score(spec: FieldSpec, column: { title: string; type: string }): number {
  const title = slug(column.title);
  if (!title) return 0;
  const compact = title.replace(/ /g, "");
  let best = 0;

  spec.synonyms.forEach((syn, i) => {
    const s = slug(syn);
    const c = s.replace(/ /g, "");
    let hit = 0;
    if (title === s || compact === c) hit = 100 - i;
    else if (title.startsWith(`${s} `) || title.endsWith(` ${s}`)) hit = 78 - i;
    else if (new RegExp(`(^| )${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(title)) hit = 62 - i;
    else if (s.length > 4 && compact.includes(c)) hit = 45 - i;
    if (hit > best) best = hit;
  });

  if (best > 0 && spec.prefers?.some((t) => column.type.includes(t))) best += 12;
  // A date-typed column can never be the money field, and vice versa.
  if (best > 0 && (spec.type === "money" || spec.type === "number") && column.type === "date") best -= 40;
  if (best > 0 && spec.type === "date" && (column.type === "numbers" || column.type === "numeric")) best -= 25;
  return best;
}

export type Mapping = { field: string; label: string; type: FieldType; columnId: string; columnTitle: string; columnType: string; confidence: number };

function mapColumns(boardKey: BoardKey, columns: Array<{ id: string; title: string; type: string }>) {
  const specs = FIELDS.filter((f) => f.boards.includes(boardKey));
  const pairs: Array<{ spec: FieldSpec; col: (typeof columns)[number]; s: number }> = [];

  for (const spec of specs) {
    for (const col of columns) {
      const s = score(spec, col);
      if (s >= 40) pairs.push({ spec, col, s });
    }
  }
  pairs.sort((a, b) => b.s - a.s);

  const mapping: Mapping[] = [];
  const usedFields = new Set<string>();
  const usedCols = new Set<string>();

  for (const p of pairs) {
    if (usedFields.has(p.spec.key) || usedCols.has(p.col.id)) continue;
    usedFields.add(p.spec.key);
    usedCols.add(p.col.id);
    mapping.push({
      field: p.spec.key,
      label: p.spec.label,
      type: p.spec.type,
      columnId: p.col.id,
      columnTitle: p.col.title,
      columnType: p.col.type,
      confidence: Math.min(100, p.s),
    });
  }

  const unmapped = columns.filter((c) => !usedCols.has(c.id)).map((c) => ({ id: c.id, title: c.title, type: c.type }));
  return { mapping, unmapped };
}

/* ------------------------------------------------------------- the dataset */

export type Row = {
  id: string;
  name: string;
  /** canonical field -> cleaned value */
  f: Record<string, string | number | null>;
  /** original column title -> raw cell text (nothing is thrown away) */
  raw: Record<string, string>;
  /** per-row data quality notes */
  issues: string[];
};

export type FieldQuality = {
  field: string;
  column: string;
  filled: number;
  missing: number;
  fillRate: number;
  distinct?: number;
  unrecognised?: string[];
  notes?: string[];
};

export type Dataset = {
  key: BoardKey;
  board: { id: string; name: string };
  rowCount: number;
  mapping: Mapping[];
  unmappedColumns: Array<{ id: string; title: string; type: string }>;
  rows: Row[];
  quality: {
    fields: FieldQuality[];
    warnings: string[];
    duplicateClients: Array<{ client: string; variants: string[] }>;
  };
  fetchedAt: string;
};

function buildDataset(key: BoardKey, board: BoardMeta, items: Awaited<ReturnType<typeof fetchItems>>): Dataset {
  const { mapping, unmapped } = mapColumns(key, board.columns);
  const byField = new Map(mapping.map((m) => [m.field, m]));
  const warnings: string[] = [];

  // Resolve dd/mm vs mm/dd once per date column, from the whole column.
  const dayOrder = new Map<string, DayOrder>();
  for (const m of mapping) {
    if (m.type !== "date") continue;
    const col = items.map((it) => it.values[m.columnId]);
    const { order, ambiguous } = detectDayOrder(col);
    dayOrder.set(m.field, order);
    if (ambiguous) {
      warnings.push(`"${m.columnTitle}" has slash dates with no day above 12, so day-first vs month-first is genuinely ambiguous. Assumed day-first (DD/MM/YYYY).`);
    }
  }

  const notes = new Map<string, string[]>();
  const unrecognised = new Map<string, Set<string>>();
  const nameByKey = new Map<string, Set<string>>();

  const rows: Row[] = items.map((it) => {
    const f: Record<string, string | number | null> = {};
    const raw: Record<string, string> = {};
    const issues: string[] = [];

    for (const col of board.columns) {
      const v = it.values[col.id];
      if (!isBlank(v)) raw[col.title] = v;
    }
    raw["Item name"] = it.name;

    for (const m of mapping) {
      const cell = it.values[m.columnId];

      if (m.type === "money" || m.type === "number") {
        const { value, note } = parseNumber(cell);
        f[m.field] = value;
        if (note) {
          issues.push(`${m.columnTitle}: ${note}`);
          if (value == null) push(unrecognised, m.field, String(cell));
        }
      } else if (m.type === "percent") {
        f[m.field] = parsePercent(cell);
      } else if (m.type === "date") {
        const { value, note } = parseDate(cell, dayOrder.get(m.field) ?? "dmy");
        f[m.field] = value;
        if (note) {
          issues.push(`${m.columnTitle}: ${note}`);
          if (value == null) push(unrecognised, m.field, String(cell));
        }
      } else if (m.type === "enum") {
        const { value, mapped } = canonical(cell, FIELDS.find((s) => s.key === m.field)!.vocab!);
        f[m.field] = value;
        if (!mapped && value) push(unrecognised, m.field, value);
      } else if (m.type === "company") {
        const text = cleanText(cell) ?? cleanText(it.name);
        f[m.field] = text;
        const k = companyKey(text);
        if (k && text) {
          if (!nameByKey.has(k)) nameByKey.set(k, new Set());
          nameByKey.get(k)!.add(text);
        }
      } else {
        f[m.field] = cleanText(cell);
      }

      if (f[m.field] == null && !isBlank(cell)) {
        // value present but unusable
      }
    }

    // Fall back to the item name when no client column exists at all.
    if (!byField.has("client")) f.client = cleanText(it.name);

    return { id: it.id, name: it.name, f, raw, issues };
  });

  const fields: FieldQuality[] = mapping.map((m) => {
    const filled = rows.filter((r) => r.f[m.field] != null && r.f[m.field] !== "").length;
    const distinct = new Set(rows.map((r) => r.f[m.field]).filter((v) => v != null)).size;
    const un = [...(unrecognised.get(m.field) ?? [])].slice(0, 8);
    return {
      field: m.field,
      column: m.columnTitle,
      filled,
      missing: rows.length - filled,
      fillRate: rows.length ? Math.round((filled / rows.length) * 100) : 0,
      distinct,
      ...(un.length ? { unrecognised: un } : {}),
      ...(notes.get(m.field)?.length ? { notes: notes.get(m.field) } : {}),
    };
  });

  for (const q of fields) {
    if (q.fillRate < 70) warnings.push(`"${q.column}" (${q.field}) is only ${q.fillRate}% filled - ${q.missing} of ${rows.length} rows are blank. Metrics using it exclude those rows.`);
    if (q.unrecognised?.length) warnings.push(`"${q.column}" has values outside the standard vocabulary, kept as-is: ${q.unrecognised.slice(0, 5).join(", ")}.`);
  }

  const expected = FIELDS.filter((s) => s.boards.includes(key)).map((s) => s.key);
  const missingFields = expected.filter((k) => !byField.has(k) && ["value", "sector", "stage", "status", "close_date", "end_date"].includes(k));
  if (missingFields.length) warnings.push(`No column on "${board.name}" could be matched to: ${missingFields.join(", ")}. Questions needing those fields cannot be answered from this board.`);

  const duplicateClients = [...nameByKey.entries()]
    .filter(([, v]) => v.size > 1)
    .map(([k, v]) => ({ client: [...v][0], variants: [...v] }))
    .slice(0, 15);
  if (duplicateClients.length) warnings.push(`${duplicateClients.length} client name(s) appear under more than one spelling; they are grouped together when you group by client.`);

  return {
    key,
    board: { id: board.id, name: board.name },
    rowCount: rows.length,
    mapping,
    unmappedColumns: unmapped,
    rows,
    quality: { fields, warnings, duplicateClients },
    fetchedAt: new Date().toISOString(),
  };
}

function push(map: Map<string, Set<string>>, key: string, value: string) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key)!.add(value);
}

/* ----------------------------------------------------------------- caching */

const TTL_MS = 5 * 60 * 1000;
let boardCache: { at: number; boards: BoardMeta[] } | null = null;
const dataCache = new Map<BoardKey, { at: number; data: Dataset }>();

async function boards(): Promise<BoardMeta[]> {
  if (boardCache && Date.now() - boardCache.at < TTL_MS) return boardCache.boards;
  const b = await listBoards();
  boardCache = { at: Date.now(), boards: b };
  return b;
}

const HINTS: Record<BoardKey, RegExp> = {
  work_orders: /work[\s_-]*order|wo[\s_-]*tracker|project|execution|delivery|operations/i,
  deals: /deal|funnel|pipeline|sales|opportunit|lead|crm/i,
};

export async function resolveBoard(key: BoardKey): Promise<BoardMeta> {
  const envId = key === "deals" ? process.env.MONDAY_DEALS_BOARD_ID : process.env.MONDAY_WORK_ORDERS_BOARD_ID;
  const all = await boards();

  if (envId?.trim()) {
    const found = all.find((b) => b.id === envId.trim());
    if (found) return found;
    throw new MondayError(`Board id ${envId} (${key}) is not visible to this token.`, `Boards this token can read: ${all.map((b) => `${b.name} (${b.id})`).join(", ") || "none"}`);
  }

  const matches = all.filter((b) => HINTS[key].test(b.name));
  const other = key === "deals" ? HINTS.work_orders : HINTS.deals;
  const best = matches.find((b) => !other.test(b.name)) ?? matches[0];
  if (best) return best;

  throw new MondayError(
    `Could not find the ${key.replace("_", " ")} board on monday.com.`,
    `Set ${key === "deals" ? "MONDAY_DEALS_BOARD_ID" : "MONDAY_WORK_ORDERS_BOARD_ID"}. Boards visible to this token: ${all.map((b) => `${b.name} (${b.id})`).join(", ") || "none"}`,
  );
}

export async function getDataset(key: BoardKey): Promise<Dataset> {
  const hit = dataCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const board = await resolveBoard(key);
  const items = await fetchItems(board.id);
  const data = buildDataset(key, board, items);
  dataCache.set(key, { at: Date.now(), data });
  return data;
}

export async function boardsOverview() {
  const all = await boards();
  const out: Array<Record<string, unknown>> = [];
  for (const key of ["deals", "work_orders"] as BoardKey[]) {
    try {
      const d = await getDataset(key);
      out.push({
        board_key: key,
        monday_board: d.board.name,
        board_id: d.board.id,
        rows: d.rowCount,
        mapped_fields: d.mapping.map((m) => `${m.field} <- "${m.columnTitle}" (${m.columnType}, ${m.confidence}% match)`),
        unmapped_columns: d.unmappedColumns.map((c) => c.title),
        warnings: d.quality.warnings,
      });
    } catch (err) {
      out.push({ board_key: key, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { visible_boards: all.map((b) => ({ id: b.id, name: b.name, items: b.itemCount })), datasets: out };
}

export function clearCache() {
  boardCache = null;
  dataCache.clear();
}
