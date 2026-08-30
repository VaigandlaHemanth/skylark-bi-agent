/**
 * monday.com GraphQL client (READ ONLY).
 * Everything the agent knows about the business comes through here at runtime —
 * no CSV is bundled with the app.
 */

const ENDPOINT = "https://api.monday.com/v2";
const API_VERSION = "2024-10";
const PAGE_SIZE = 500; // monday's max for items_page

export class MondayError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "MondayError";
  }
}

export type ColumnMeta = { id: string; title: string; type: string };
export type BoardMeta = { id: string; name: string; itemCount: number; columns: ColumnMeta[] };
export type RawItem = { id: string; name: string; values: Record<string, string> };

function token(): string {
  const t = process.env.MONDAY_API_TOKEN;
  if (!t) {
    throw new MondayError(
      "MONDAY_API_TOKEN is not configured on the server.",
      "Add it in your hosting provider's environment variables and redeploy.",
    );
  }
  return t.trim();
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  let lastErr: unknown;
  let rateLimited = false;
  // monday says how long to wait on a 429. Guessing instead means retrying
  // into the same closed window and burning all three attempts in 3.6s.
  let waitMs = 0;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      // Jitter, because several serverless instances rate-limited together
      // would otherwise retry in lockstep and trip the limit again.
      const backoff = waitMs || 600 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, backoff + Math.floor(Math.random() * 250)));
      waitMs = 0;
    }
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: token(),
          "API-Version": API_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        cache: "no-store",
      });

      if (res.status === 401 || res.status === 403) {
        throw new MondayError("monday.com rejected the API token (401/403).", "Check MONDAY_API_TOKEN and that the token's user can see both boards.");
      }
      if (res.status === 429 || res.status >= 500) {
        if (res.status === 429) {
          rateLimited = true;
          // Retry-After is seconds; honour it, but not past the request budget.
          const after = Number(res.headers.get("Retry-After"));
          if (Number.isFinite(after) && after > 0) waitMs = Math.min(after * 1000, 8000);
        }
        lastErr = new MondayError(`monday.com returned HTTP ${res.status}.`);
        continue; // retryable
      }

      const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }>; error_message?: string };
      if (body.errors?.length) {
        throw new MondayError(`monday.com GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
      }
      if (body.error_message) throw new MondayError(`monday.com error: ${body.error_message}`);
      if (!body.data) throw new MondayError("monday.com returned an empty response.");
      return body.data;
    } catch (err) {
      if (err instanceof MondayError && !String(err.message).includes("HTTP")) throw err;
      lastErr = err;
    }
  }

  if (rateLimited) {
    throw new MondayError(
      "monday.com rate-limited this request (HTTP 429) and was still limiting after 3 attempts.",
      "The boards are reachable and the token is valid - the account's API quota is momentarily exhausted. Wait about a minute and ask again.",
    );
  }
  throw lastErr instanceof Error
    ? new MondayError(`monday.com is unreachable after 3 attempts: ${lastErr.message}`)
    : new MondayError("monday.com is unreachable after 3 attempts.");
}

/** All boards the token can read, with their column schema. */
export async function listBoards(): Promise<BoardMeta[]> {
  const data = await gql<{ boards: Array<{ id: string; name: string; items_count: number | null; columns: ColumnMeta[] }> }>(`
    query {
      boards(limit: 100, state: active) {
        id
        name
        items_count
        columns { id title type }
      }
    }
  `);
  return (data.boards ?? []).map((b) => ({
    id: String(b.id),
    name: b.name,
    itemCount: b.items_count ?? 0,
    columns: (b.columns ?? []).filter((c) => c.type !== "subtasks"),
  }));
}

const ITEMS_QUERY = `
  query ($boardId: ID!, $cursor: String, $limit: Int!) {
    boards(ids: [$boardId]) {
      items_page(limit: $limit, cursor: $cursor) {
        cursor
        items {
          id
          name
          column_values {
            id
            text
            ... on MirrorValue { display_value }
            ... on BoardRelationValue { display_value }
            ... on FormulaValue { display_value }
          }
        }
      }
    }
  }
`;

/** Fallback for API versions that don't expose the display_value fragments. */
const ITEMS_QUERY_SIMPLE = `
  query ($boardId: ID!, $cursor: String, $limit: Int!) {
    boards(ids: [$boardId]) {
      items_page(limit: $limit, cursor: $cursor) {
        cursor
        items { id name column_values { id text } }
      }
    }
  }
`;

type ItemsPage = {
  boards: Array<{
    items_page: {
      cursor: string | null;
      items: Array<{ id: string; name: string; column_values: Array<{ id: string; text: string | null; display_value?: string | null }> }>;
    };
  }>;
};

/** Every item on a board, following the cursor to the end. */
export async function fetchItems(boardId: string): Promise<RawItem[]> {
  const items: RawItem[] = [];
  let cursor: string | null = null;
  let query = ITEMS_QUERY;

  for (let page = 0; page < 50; page++) {
    let data: ItemsPage;
    try {
      data = await gql<ItemsPage>(query, { boardId, cursor, limit: PAGE_SIZE });
    } catch (err) {
      if (query === ITEMS_QUERY && err instanceof MondayError && err.message.includes("GraphQL")) {
        query = ITEMS_QUERY_SIMPLE; // older API version — retry without fragments
        data = await gql<ItemsPage>(query, { boardId, cursor, limit: PAGE_SIZE });
      } else throw err;
    }

    const board = data.boards?.[0];
    if (!board) throw new MondayError(`Board ${boardId} not found or not readable by this token.`);

    for (const it of board.items_page.items) {
      const values: Record<string, string> = {};
      for (const cv of it.column_values) values[cv.id] = (cv.display_value ?? cv.text ?? "").trim();
      items.push({ id: String(it.id), name: (it.name ?? "").trim(), values });
    }

    cursor = board.items_page.cursor;
    if (!cursor) break;
  }

  return items;
}
