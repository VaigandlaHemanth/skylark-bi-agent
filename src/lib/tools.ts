/** Tool surface exposed to the model. Each one is deterministic. */

import { leadershipBrief } from "./brief";
import type { JSONSchema, ToolSpec } from "./llm";
import { runQuery, type Filter } from "./query";
import { boardsOverview, getDataset, type BoardKey } from "./store";

const BOARD_ARG: JSONSchema = {
  type: "string",
  enum: ["deals", "work_orders"],
  description: 'Which board to read. "deals" is the sales funnel, "work_orders" is project execution and billing.',
};

const DEAL_FIELDS = "client, sector, status (Open/Won/Dead/On Hold), stage (the lettered funnel ladder), value, close_date, actual_close_date, created_date, probability (High/Medium/Low), product, owner, deal_name";
const WO_FIELDS =
  "client, sector, status (execution status), service, work_nature, value, billed, collected, unbilled, receivable, invoice_status, billing_status, wo_status, start_date, end_date, delivery_date, po_date, owner, wo_id, quantity_po, quantity_billed, quantity_balance";

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "list_boards_and_fields",
    description:
      "Boards, row counts, field mapping, per-field vocabulary, unmapped columns and data-quality warnings. Call when unsure whether a field or value exists.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "distinct_values",
    description:
      "Every value present in one field, with row counts. Use before filtering on an uncertain value - the boards use their own wording (e.g. sectors are 'Renewables'/'Powerline', not 'Energy').",
    parameters: {
      type: "object",
      properties: { board: BOARD_ARG, field: { type: "string", description: "Field name, e.g. sector, status, stage, invoice_status, owner, client." } },
      required: ["board", "field"],
    },
  },
  {
    name: "query_board",
    description:
      "Filter, group and aggregate one board - the ONLY way to produce a number. Filter values resolve against the board's real vocabulary (sector='energy' finds Renewables+Powerline) and the result reports what matched.",
    parameters: {
      type: "object",
      properties: {
        board: BOARD_ARG,
        filters: {
          type: "array",
          description: "Conditions combined with AND.",
          items: {
            type: "object",
            properties: {
              field: { type: "string", description: `Business field or the exact monday column title. Deals: ${DEAL_FIELDS}. Work orders: ${WO_FIELDS}.` },
              op: {
                type: "string",
                enum: ["eq", "ne", "contains", "not_contains", "in", "not_in", "gt", "gte", "lt", "lte", "before", "after", "between", "is_empty", "not_empty"],
                description: '"in": comma list. "between": "low,high". Dates: YYYY-MM-DD.',
              },
              value: { type: "string", description: "Value to compare against." },
            },
            required: ["field", "op"],
          },
        },
        timeframe: {
          type: "string",
          description:
            'Period: "this quarter", "Q3 2026", "last 90 days", "FY26" (Apr-Mar), "2025", "2025-01-01 to 2025-03-31". Applies to close_date (deals) / end_date (work orders) unless date_field overrides.',
        },
        date_field: { type: "string", description: "Which date field the timeframe applies to. Optional." },
        group_by: { type: "string", description: 'Field to break results down by, e.g. sector, status, stage, client, owner, invoice_status.' },
        metrics: {
          type: "array",
          description: '"fn" or "fn:field"; fn: count|sum|avg|min|max|median|distinct. E.g. ["count","sum:value"]. Default ["count"].',
          items: { type: "string" },
        },
        sort: { type: "string", description: 'Sort key for groups, e.g. "sum_value desc" or "count desc".' },
        limit: { type: "number", description: "Max groups or rows to return." },
        return_rows: { type: "boolean", description: "Set true to see individual records rather than only aggregates." },
      },
      required: ["board"],
    },
  },
  {
    name: "sample_rows",
    description:
      "A few real records with raw cell values and per-row issues. Use when a result looks surprising or a filter matches nothing.",
    parameters: {
      type: "object",
      properties: {
        board: BOARD_ARG,
        search: { type: "string", description: "Optional free-text match across every column." },
        limit: { type: "number", description: "How many rows, default 5, max 15." },
      },
      required: ["board"],
    },
  },
  {
    name: "data_quality",
    description:
      "Data-quality report: per-field fill rates, unparseable values, duplicate client spellings, dropped header rows. Use for 'how reliable is this'.",
    parameters: { type: "object", properties: { board: BOARD_ARG }, required: ["board"] },
  },
  {
    name: "leadership_brief",
    description:
      "Full executive snapshot in one call: pipeline by stage/sector/probability, win rate, biggest and slipping deals, delivery status, overdue work, cash (billed/collected/unbilled/receivable), sector pipeline-vs-delivery, caveats. Use for 'board update' / 'how is the business doing'.",
    parameters: {
      type: "object",
      properties: {
        timeframe: { type: "string", description: 'Reporting window, default "this quarter".' },
        sector: { type: "string", description: "Optional: restrict the whole brief to one sector." },
      },
    },
  },
];

/** Free-tier models drift from the schema; coerce instead of crashing. */
function coerceFilters(raw: unknown): Filter[] {
  // Some models send the array JSON-encoded as a string.
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  // Lighter models write comparison symbols instead of the enum names.
  const OP_ALIASES: Record<string, string> = { "=": "eq", "==": "eq", "!=": "ne", "<>": "ne", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" };
  return raw
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f) => {
      const op = String(f.op ?? "eq").trim().toLowerCase();
      return {
        field: String(f.field ?? ""),
        op: OP_ALIASES[op] ?? op,
        ...(f.value === undefined || f.value === null ? {} : { value: String(f.value) }),
      };
    })
    .filter((f) => f.field);
}

const BOARD_SCOPED = new Set(["query_board", "sample_rows", "data_quality", "distinct_values"]);

/** "Deals", " deal funnel ", "WORK ORDERS" -> the canonical board key. */
function coerceBoard(raw: unknown): BoardKey | null {
  const b = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (b === "deals" || b === "deal" || b === "deal_funnel") return "deals";
  if (b === "work_orders" || b === "work_order" || b === "workorders" || b === "work_order_tracker") return "work_orders";
  return null;
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const board = coerceBoard(args.board) as BoardKey;
  if (BOARD_SCOPED.has(name) && board !== "deals" && board !== "work_orders") {
    // Refuse rather than silently defaulting - a wrong board is a wrong answer.
    return { error: `The "board" parameter is required and must be "deals" or "work_orders" (got ${JSON.stringify(args.board)}).` };
  }

  switch (name) {
    case "list_boards_and_fields":
      return boardsOverview();

    case "distinct_values": {
      const ds = await getDataset(board);
      const field = String(args.field ?? "");
      const values = ds.distinct[field];
      if (!values) {
        const numeric = ds.mapping.find((m) => m.field === field);
        return {
          board: ds.board.name,
          field,
          note: numeric
            ? `"${field}" is a ${numeric.type} field (column "${numeric.columnTitle}"), so it has no short value list. Use query_board with min/max/avg instead.`
            : `"${field}" is not a field on this board.`,
          available_fields: ds.mapping.map((m) => m.field),
        };
      }
      return { board: ds.board.name, field, total_rows: ds.rowCount, values };
    }

    case "query_board": {
      const ds = await getDataset(board);
      const limit = Number(args.limit);
      return runQuery(ds, {
        filters: coerceFilters(args.filters),
        timeframe: args.timeframe == null ? undefined : String(args.timeframe),
        date_field: args.date_field == null ? undefined : String(args.date_field),
        group_by: args.group_by == null ? undefined : String(args.group_by),
        metrics: Array.isArray(args.metrics) ? args.metrics.map(String) : undefined,
        sort: args.sort == null ? undefined : String(args.sort),
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        return_rows: args.return_rows === true || args.return_rows === "true",
      });
    }

    case "sample_rows": {
      const ds = await getDataset(board);
      const search = (args.search as string | undefined)?.toLowerCase().trim();
      const limit = Math.min(Number(args.limit) || 5, 15);
      const pool = search ? ds.rows.filter((r) => JSON.stringify(r.raw).toLowerCase().includes(search)) : ds.rows;
      return {
        board: ds.board.name,
        total_rows: ds.rowCount,
        matched: pool.length,
        rows: pool.slice(0, limit).map((r) => ({ item: r.name, cleaned: r.f, raw_cells: r.raw, issues: r.issues })),
      };
    }

    case "data_quality": {
      const ds = await getDataset(board);
      return {
        board: ds.board.name,
        rows: ds.rowCount,
        rows_dropped_as_repeated_headers: ds.droppedRows,
        fetched_at: ds.fetchedAt,
        field_mapping: ds.mapping.map((m) => ({ field: m.field, monday_column: m.columnTitle, column_type: m.columnType, match_confidence: m.confidence })),
        unmapped_columns: ds.unmappedColumns.map((c) => c.title),
        completeness: ds.quality.fields,
        duplicate_client_spellings: ds.quality.duplicateClients,
        warnings: ds.quality.warnings,
      };
    }

    case "leadership_brief":
      return leadershipBrief((args.timeframe as string) || "this quarter", args.sector as string | undefined);

    default:
      return { error: `Unknown tool "${name}".` };
  }
}
