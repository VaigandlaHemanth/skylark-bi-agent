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
      "List the monday.com boards, row counts, which board column was mapped to which business field, the values that actually exist on each board, unmapped columns, and known data-quality warnings. Call this when unsure whether a field or a value exists.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "distinct_values",
    description:
      "List every value that actually appears in one field, with row counts. Use this BEFORE filtering on a value you are unsure about - the boards use Skylark's own wording (for example the sector list includes 'Renewables' and 'Powerline' rather than 'Energy').",
    parameters: {
      type: "object",
      properties: { board: BOARD_ARG, field: { type: "string", description: "Field name, e.g. sector, status, stage, invoice_status, owner, client." } },
      required: ["board", "field"],
    },
  },
  {
    name: "query_board",
    description:
      "Filter, group and aggregate one board. This is the only way to produce a number - never do arithmetic yourself. Filter values are matched against the board's real vocabulary, so filtering sector = 'energy' will resolve to the energy-type values the board actually uses and report which ones it used.",
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
                description: 'Comparison. Use "in" with a comma-separated list. Use "between" with "low,high". Dates use YYYY-MM-DD.',
              },
              value: { type: "string", description: "Value to compare against." },
            },
            required: ["field", "op"],
          },
        },
        timeframe: {
          type: "string",
          description:
            'Natural-language period: "this quarter", "last quarter", "Q3 2026", "last 90 days", "FY26" (Indian Apr-Mar), "2025", or "2025-01-01 to 2025-03-31". Applied to close_date on deals and end_date on work orders unless date_field says otherwise.',
        },
        date_field: { type: "string", description: "Which date field the timeframe applies to. Optional." },
        group_by: { type: "string", description: 'Field to break results down by, e.g. sector, status, stage, client, owner, invoice_status.' },
        metrics: {
          type: "array",
          description: 'Metrics as "fn" or "fn:field". fn is one of count, sum, avg, min, max, median, distinct. Example: ["count","sum:value","avg:value"]. Defaults to ["count"].',
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
      "Read a handful of real records including the raw uncleaned cell values and per-row data-quality issues. Use this when a result looks surprising or a filter returns nothing.",
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
      "Full data-quality report for a board: fill rate and distinct count per field, values that could not be parsed, duplicate client spellings, dropped header rows, and parsing warnings. Use this to answer 'how reliable is this' or to footnote an answer.",
    parameters: { type: "object", properties: { board: BOARD_ARG }, required: ["board"] },
  },
  {
    name: "leadership_brief",
    description:
      "Assemble a complete executive snapshot in one call: open pipeline by stage, sector and probability; win rate; largest open deals; slipping deals; work-order status mix; overdue delivery; cash (billed, collected, still to bill, receivable, top receivable accounts); sector pipeline vs delivery; and data caveats. Use this for 'prepare the board update', 'weekly leadership summary' or 'how is the business doing'.",
    parameters: {
      type: "object",
      properties: {
        timeframe: { type: "string", description: 'Reporting window, default "this quarter".' },
        sector: { type: "string", description: "Optional: restrict the whole brief to one sector." },
      },
    },
  },
];

export async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const board = (args.board as BoardKey) ?? "deals";

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
      return runQuery(ds, {
        filters: (args.filters as Filter[]) ?? [],
        timeframe: args.timeframe as string | undefined,
        date_field: args.date_field as string | undefined,
        group_by: args.group_by as string | undefined,
        metrics: args.metrics as string[] | undefined,
        sort: args.sort as string | undefined,
        limit: args.limit as number | undefined,
        return_rows: args.return_rows as boolean | undefined,
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
