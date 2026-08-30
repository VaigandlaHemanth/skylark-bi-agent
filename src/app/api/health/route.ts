import { providerInfo } from "@/lib/llm";
import { boardsOverview } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Setup check: is a model configured, and can we actually read both boards? */
export async function GET() {
  const llm = providerInfo();
  const monday: Record<string, unknown> = { tokenSet: !!process.env.MONDAY_API_TOKEN };
  let boardsOk = false;

  if (monday.tokenSet) {
    try {
      const overview = await boardsOverview();
      const datasets = (overview.datasets as Array<Record<string, unknown>>).map((d) => ({
        board: d.board_key,
        name: d.monday_board ?? null,
        rows: d.rows ?? 0,
        mapped: Array.isArray(d.mapped_fields) ? (d.mapped_fields as string[]).length : 0,
        warnings: Array.isArray(d.warnings) ? (d.warnings as string[]).length : 0,
        error: d.error ?? null,
      }));
      monday.datasets = datasets;
      // "Connected" means BOTH boards actually resolved and loaded - a board
      // that failed must surface the setup banner, not a green pill.
      boardsOk = datasets.length === 2 && datasets.every((d) => !d.error && (d.rows as number) > 0);
    } catch (err) {
      monday.error = err instanceof Error ? err.message : String(err);
    }
  }

  const ready = llm.configured && boardsOk;
  return Response.json({ ready, llm, monday }, { status: ready ? 200 : 503 });
}
