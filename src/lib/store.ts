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
  cleanText,
  companyKey,
  DEAL_STAGE_CONCEPTS,
  DEAL_STATUS_CONCEPTS,
  detectDayOrder,
  INVOICE_CONCEPTS,
  isBlank,
  normKey,
  parseDate,
  parseNumber,
  parseQuantity,
  SECTOR_CONCEPTS,
  WORK_STATUS_CONCEPTS,
  type DayOrder,
  type Vocab,
} from "./normalize";

export type BoardKey = "deals" | "work_orders";
export type FieldType = "text" | "company" | "number" | "money" | "quantity" | "date";

type FieldSpec = {
  key: string;
  type: FieldType;
  label: string;
  /** Concept table used to match the user's wording against this field's values. */
  vocab?: Vocab;
  synonyms: string[];
  /** monday column types that make this mapping more likely */
  prefers?: string[];
  boards: BoardKey[];
};

const MONEY = ["numbers", "numeric", "formula"];
const DATE = ["date", "timeline"];

const FIELDS: FieldSpec[] = [
  /* ------------------------------------------------------------- shared */
  { key: "client", type: "company", label: "Client / account", boards: ["deals", "work_orders"],
    synonyms: ["client code", "customer name code", "client name", "customer name", "client", "customer", "account name", "account", "company name", "company", "organisation", "organization"] },
  { key: "owner", type: "text", label: "Owner", boards: ["deals", "work_orders"], prefers: ["people", "person"],
    synonyms: ["owner code", "bd kam personnel code", "bd kam personnel", "personnel code", "personnel", "sales owner", "account owner", "owner", "assigned to", "assignee", "sales rep", "rep", "project manager", "responsible", "handled by"] },
  { key: "sector", type: "text", label: "Sector", vocab: SECTOR_CONCEPTS, boards: ["deals", "work_orders"], prefers: ["status", "dropdown", "color"],
    synonyms: ["sector service", "sector", "industry", "vertical", "domain", "segment", "market"] },
  { key: "deal_name", type: "text", label: "Deal name", boards: ["deals", "work_orders"],
    synonyms: ["deal name masked", "deal name", "opportunity name", "project name"] },
  { key: "notes", type: "text", label: "Notes", boards: ["deals", "work_orders"], prefers: ["long-text"],
    synonyms: ["notes", "remarks", "comments", "description", "details", "next steps"] },

  /* -------------------------------------------------------------- deals */
  { key: "status", type: "text", label: "Deal status", vocab: DEAL_STATUS_CONCEPTS, boards: ["deals"], prefers: ["status", "color", "dropdown"],
    synonyms: ["deal status", "opportunity status", "status", "state"] },
  { key: "stage", type: "text", label: "Deal stage", vocab: DEAL_STAGE_CONCEPTS, boards: ["deals"], prefers: ["status", "color", "dropdown"],
    synonyms: ["deal stage", "funnel stage", "pipeline stage", "sales stage", "stage"] },
  { key: "value", type: "money", label: "Deal value", boards: ["deals"], prefers: MONEY,
    synonyms: ["masked deal value", "deal value", "deal size", "contract value", "order value", "opportunity value", "value", "amount", "revenue", "price", "tcv", "acv"] },
  { key: "close_date", type: "date", label: "Expected close date", boards: ["deals"], prefers: DATE,
    synonyms: ["tentative close date", "expected close date", "expected closure", "expected close", "target close date", "probable close date", "close date", "closing date"] },
  { key: "actual_close_date", type: "date", label: "Actual close date", boards: ["deals"], prefers: DATE,
    synonyms: ["close date a", "actual close date", "actual closure date", "date closed", "closed on"] },
  { key: "probability", type: "text", label: "Closure probability", boards: ["deals"], prefers: ["status", "dropdown", "color"],
    synonyms: ["closure probability", "win probability", "probability", "confidence", "likelihood"] },
  { key: "product", type: "text", label: "Product mix", boards: ["deals"], prefers: ["dropdown", "status"],
    synonyms: ["product deal", "product", "offering", "solution", "product mix"] },
  { key: "created_date", type: "date", label: "Created date", boards: ["deals"], prefers: ["date", "creation_log"],
    synonyms: ["created date", "date created", "created at", "created", "enquiry date", "lead date", "opened"] },

  /* -------------------------------------------------------- work orders */
  { key: "wo_id", type: "text", label: "Work order reference", boards: ["work_orders"],
    synonyms: ["serial", "serial no", "serial number", "work order id", "wo id", "wo number", "reference", "ref"] },
  { key: "status", type: "text", label: "Execution status", vocab: WORK_STATUS_CONCEPTS, boards: ["work_orders"], prefers: ["status", "color", "dropdown"],
    synonyms: ["execution status", "work order status", "project status", "delivery status", "status", "state"] },
  { key: "work_nature", type: "text", label: "Nature of work", boards: ["work_orders"], prefers: ["dropdown", "status"],
    synonyms: ["nature of work", "contract type", "engagement type", "project type"] },
  { key: "service", type: "text", label: "Type of work", boards: ["work_orders"], prefers: ["dropdown", "status"],
    synonyms: ["type of work", "work type", "service type", "scope of work", "service", "scope", "deliverable", "survey type"] },
  { key: "value", type: "money", label: "Order value (excl GST)", boards: ["work_orders"], prefers: MONEY,
    synonyms: ["amount in rupees excl of gst masked", "amount in rupees excl of gst", "amount excl of gst", "amount excl gst", "order value", "contract value", "po value", "value", "amount"] },
  { key: "value_incl_gst", type: "money", label: "Order value (incl GST)", boards: ["work_orders"], prefers: MONEY,
    synonyms: ["amount in rupees incl of gst masked", "amount in rupees incl of gst", "amount incl of gst", "amount incl gst"] },
  { key: "billed", type: "money", label: "Billed value", boards: ["work_orders"], prefers: MONEY,
    synonyms: ["billed value in rupees excl of gst masked", "billed value in rupees excl of gst", "billed value excl gst", "billed value", "billed amount", "billed"] },
  { key: "billed_incl_gst", type: "money", label: "Billed value (incl GST)", boards: ["work_orders"], prefers: MONEY,
    synonyms: ["billed value in rupees incl of gst masked", "billed value in rupees incl of gst", "billed value incl gst"] },
  { key: "collected", type: "money", label: "Collected", boards: ["work_orders"], prefers: MONEY,
    synonyms: ["collected amount in rupees incl of gst masked", "collected amount in rupees incl of gst", "collected amount", "amount collected", "collected", "collection amount"] },
  { key: "unbilled", type: "money", label: "Still to bill", boards: ["work_orders"], prefers: MONEY,
    synonyms: ["amount to be billed in rs exl of gst masked", "amount to be billed in rs exl of gst", "amount to be billed excl gst", "amount to be billed", "to be billed", "unbilled", "yet to bill"] },
  { key: "unbilled_incl_gst", type: "money", label: "Still to bill (incl GST)", boards: ["work_orders"], prefers: MONEY,
    synonyms: ["amount to be billed in rs incl of gst masked", "amount to be billed in rs incl of gst", "amount to be billed incl gst"] },
  { key: "receivable", type: "money", label: "Receivable", boards: ["work_orders"], prefers: MONEY,
    synonyms: ["amount receivable masked", "amount receivable", "receivable", "receivables", "outstanding", "ar", "accounts receivable"] },
  { key: "ar_priority", type: "text", label: "AR priority", boards: ["work_orders"], prefers: ["status", "dropdown"],
    synonyms: ["ar priority account", "ar priority", "priority account", "priority"] },
  { key: "invoice_status", type: "text", label: "Invoice status", vocab: INVOICE_CONCEPTS, boards: ["work_orders"], prefers: ["status", "dropdown", "color"],
    synonyms: ["invoice status", "invoicing status"] },
  { key: "billing_status", type: "text", label: "Billing status", vocab: INVOICE_CONCEPTS, boards: ["work_orders"], prefers: ["status", "dropdown", "color"],
    synonyms: ["billing status"] },
  { key: "wo_status", type: "text", label: "WO open/closed", boards: ["work_orders"], prefers: ["status", "dropdown", "color"],
    synonyms: ["wo status billed", "wo status", "work order open closed"] },
  { key: "start_date", type: "date", label: "Start date", boards: ["work_orders"], prefers: DATE,
    synonyms: ["probable start date", "planned start date", "actual start date", "start date", "kickoff", "commencement", "start"] },
  { key: "end_date", type: "date", label: "End / due date", boards: ["work_orders"], prefers: DATE,
    synonyms: ["probable end date", "planned end date", "actual end date", "end date", "completion date", "due date", "target date", "deadline", "finish date", "end"] },
  { key: "delivery_date", type: "date", label: "Data delivery date", boards: ["work_orders"], prefers: DATE,
    synonyms: ["data delivery date", "delivery date", "delivered on", "handover date"] },
  { key: "po_date", type: "date", label: "PO / LOI date", boards: ["work_orders"], prefers: DATE,
    synonyms: ["date of po loi", "date of po", "po date", "loi date", "order date", "award date"] },
  { key: "last_invoice_date", type: "date", label: "Last invoice date", boards: ["work_orders"], prefers: DATE,
    synonyms: ["last invoice date", "latest invoice date", "invoice date"] },
  { key: "invoice_no", type: "text", label: "Latest invoice no.", boards: ["work_orders"],
    synonyms: ["latest invoice no", "invoice no", "invoice number"] },
  { key: "billing_month", type: "text", label: "Actual billing month", boards: ["work_orders"],
    synonyms: ["actual billing month", "expected billing month", "billing month"] },
  { key: "quantity_po", type: "quantity", label: "Quantity per PO", boards: ["work_orders"],
    synonyms: ["quantities as per po", "quantity as per po", "quantity per po", "po quantity"] },
  { key: "quantity_ops", type: "quantity", label: "Quantity by ops", boards: ["work_orders"],
    synonyms: ["quantity by ops", "quantity ops", "ops quantity", "area covered", "area"] },
  { key: "quantity_billed", type: "quantity", label: "Quantity billed", boards: ["work_orders"],
    synonyms: ["quantity billed till date", "quantity billed", "billed quantity"] },
  { key: "quantity_balance", type: "quantity", label: "Quantity remaining", boards: ["work_orders"],
    synonyms: ["balance in quantity", "balance quantity", "remaining quantity"] },
  { key: "platform", type: "text", label: "Skylark platform in deal", boards: ["work_orders"], prefers: ["dropdown", "status"],
    synonyms: ["is any skylark software platform part of the client deliverables in this deal", "skylark software platform", "software platform", "platform"] },
  { key: "document_type", type: "text", label: "Document type", boards: ["work_orders"], prefers: ["dropdown", "status"],
    synonyms: ["document type", "doc type"] },
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
  if (best > 0 && (spec.type === "money" || spec.type === "number") && column.type === "date") best -= 40;
  if (best > 0 && spec.type === "date" && MONEY.includes(column.type)) best -= 25;
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

/**
 * Both boards have a field called "status" with completely different meanings,
 * so the concept table must be looked up per board, never by field name alone.
 */
export function vocabFor(field: string, board?: BoardKey): Vocab | undefined {
  const specs = FIELDS.filter((f) => f.key === field && (!board || f.boards.includes(board)));
  return specs.find((f) => f.vocab)?.vocab;
}

/* ------------------------------------------------------------- the dataset */

export type Row = {
  id: string;
  name: string;
  /** canonical field -> cleaned value (board vocabulary preserved verbatim) */
  f: Record<string, string | number | null>;
  /** original column title -> raw cell text (nothing is thrown away) */
  raw: Record<string, string>;
  /** per-row data quality notes */
  issues: string[];
};

export type FieldQuality = {
  field: string;
  column: string;
  type: FieldType;
  filled: number;
  missing: number;
  fillRate: number;
  distinct: number;
  unreadable?: string[];
};

export type Dataset = {
  key: BoardKey;
  board: { id: string; name: string };
  rowCount: number;
  droppedRows: number;
  mapping: Mapping[];
  unmappedColumns: Array<{ id: string; title: string; type: string }>;
  rows: Row[];
  /** actual values present on the board, for low-cardinality fields */
  distinct: Record<string, Array<{ value: string; count: number }>>;
  quality: {
    fields: FieldQuality[];
    warnings: string[];
    duplicateClients: Array<{ client: string; variants: string[] }>;
  };
  fetchedAt: string;
};

const DISTINCT_LIMIT = 60;

function buildDataset(key: BoardKey, board: BoardMeta, items: Awaited<ReturnType<typeof fetchItems>>): Dataset {
  const { mapping, unmapped } = mapColumns(key, board.columns);
  const byField = new Map(mapping.map((m) => [m.field, m]));
  const warnings: string[] = [];

  // Spreadsheet exports often carry the header row again partway down. After
  // import those become real monday items and would pollute every count.
  const titleById = new Map(board.columns.map((c) => [c.id, normKey(c.title)]));
  const usable = items.filter((it) => {
    const echoes = Object.entries(it.values).filter(([id, v]) => v && titleById.get(id) === normKey(v)).length;
    return echoes < 3;
  });
  const dropped = items.length - usable.length;
  if (dropped) warnings.push(`${dropped} row(s) were repeated header rows from the original spreadsheet and have been excluded from every figure.`);

  // Resolve dd/mm vs mm/dd once per date column, from the whole column.
  const dayOrder = new Map<string, DayOrder>();
  for (const m of mapping) {
    if (m.type !== "date") continue;
    const { order, ambiguous } = detectDayOrder(usable.map((it) => it.values[m.columnId]));
    dayOrder.set(m.field, order);
    if (ambiguous) warnings.push(`"${m.columnTitle}" has slash dates with no day above 12, so day-first vs month-first is genuinely ambiguous. Assumed day-first (DD/MM/YYYY).`);
  }

  const unreadable = new Map<string, Set<string>>();
  const nameByKey = new Map<string, Set<string>>();

  const rows: Row[] = usable.map((it) => {
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
          if (value == null) push(unreadable, m.field, String(cell));
        }
      } else if (m.type === "quantity") {
        const { value, unit, note } = parseQuantity(cell);
        f[m.field] = value;
        if (unit) f[`${m.field}_unit`] = unit;
        if (note) {
          issues.push(`${m.columnTitle}: ${note}`);
          if (value == null) push(unreadable, m.field, String(cell));
        }
      } else if (m.type === "date") {
        const { value, note } = parseDate(cell, dayOrder.get(m.field) ?? "dmy");
        f[m.field] = value;
        if (note) {
          issues.push(`${m.columnTitle}: ${note}`);
          if (value == null) push(unreadable, m.field, String(cell));
        }
      } else if (m.type === "company") {
        const text = cleanText(cell);
        f[m.field] = text;
        const k = companyKey(text);
        if (k && text) {
          if (!nameByKey.has(k)) nameByKey.set(k, new Set());
          nameByKey.get(k)!.add(text);
        }
      } else {
        // Board vocabulary is preserved exactly as monday stores it.
        f[m.field] = cleanText(cell);
      }
    }

    if (!byField.has("client")) f.client = cleanText(it.name);

    return { id: it.id, name: it.name, f, raw, issues };
  });

  /* ------------------------------------------------------ distinct index */

  const distinct: Record<string, Array<{ value: string; count: number }>> = {};
  for (const m of mapping) {
    if (m.type !== "text" && m.type !== "company") continue;
    const counts = new Map<string, { value: string; count: number }>();
    for (const r of rows) {
      const v = r.f[m.field];
      if (v == null || v === "") continue;
      const k = normKey(String(v));
      const hit = counts.get(k);
      if (hit) hit.count++;
      else counts.set(k, { value: String(v), count: 1 });
    }
    if (counts.size && counts.size <= DISTINCT_LIMIT) {
      distinct[m.field] = [...counts.values()].sort((a, b) => b.count - a.count);
    }
  }

  /* -------------------------------------------------------------- quality */

  const fields: FieldQuality[] = mapping.map((m) => {
    const filled = rows.filter((r) => r.f[m.field] != null && r.f[m.field] !== "").length;
    const uniq = new Set(rows.map((r) => r.f[m.field]).filter((v) => v != null && v !== "")).size;
    const un = [...(unreadable.get(m.field) ?? [])].slice(0, 8);
    return {
      field: m.field,
      column: m.columnTitle,
      type: m.type,
      filled,
      missing: rows.length - filled,
      fillRate: rows.length ? Math.round((filled / rows.length) * 100) : 0,
      distinct: uniq,
      ...(un.length ? { unreadable: un } : {}),
    };
  });

  const MATERIAL = new Set(["value", "sector", "stage", "status", "close_date", "end_date", "start_date", "client", "receivable", "billed"]);
  for (const q of fields) {
    if (q.fillRate < 80 && MATERIAL.has(q.field)) {
      warnings.push(`"${q.column}" (${q.field}) is only ${q.fillRate}% filled - ${q.missing} of ${rows.length} rows are blank. Any figure using it excludes those rows.`);
    }
    if (q.unreadable?.length) {
      warnings.push(`"${q.column}" has ${q.unreadable.length}+ value(s) that could not be read as ${q.type}: ${q.unreadable.slice(0, 4).map((v) => `"${v}"`).join(", ")}.`);
    }
  }

  const missingFields = ["value", "sector", "status", "close_date", "end_date"].filter(
    (k) => FIELDS.some((s) => s.key === k && s.boards.includes(key)) && !byField.has(k),
  );
  if (missingFields.length) warnings.push(`No column on "${board.name}" could be matched to: ${missingFields.join(", ")}. Questions needing those fields cannot be answered from this board.`);

  const duplicateClients = [...nameByKey.entries()]
    .filter(([, v]) => v.size > 1)
    .map(([, v]) => ({ client: [...v][0], variants: [...v] }))
    .slice(0, 15);
  if (duplicateClients.length) warnings.push(`${duplicateClients.length} client name(s) appear under more than one spelling; they are grouped together when you group by client.`);

  return {
    key,
    board: { id: board.id, name: board.name },
    rowCount: rows.length,
    droppedRows: dropped,
    mapping,
    unmappedColumns: unmapped,
    rows,
    distinct,
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
  work_orders: /work[\s_-]*order|wo[\s_-]*tracker|execution|delivery|operations|project/i,
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

  const other = key === "deals" ? HINTS.work_orders : HINTS.deals;
  const matches = all.filter((b) => HINTS[key].test(b.name));
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
        values_on_this_board: Object.fromEntries(
          Object.entries(d.distinct)
            .filter(([, v]) => v.length <= 25)
            .map(([f, v]) => [f, v.map((x) => `${x.value} (${x.count})`)]),
        ),
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
