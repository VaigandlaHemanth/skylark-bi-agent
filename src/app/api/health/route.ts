import { providerInfo } from "@/lib/llm";
import { boardsOverview } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Setup check: is the model configured, and can we actually read both boards? */
export async function GET() {
  const llm = providerInfo();
  const monday = { tokenSet: !!process.env.MONDAY_API_TOKEN } as Record<string, unknown>;

  if (monday.tokenSet) {
    try {
      const overview = await boardsOverview();
      monday.visibleBoards = overview.visible_boards;
      monday.datasets = (overview.datasets as Array<Record<string, unknown>>).map((d) => ({
        board: d.board_key,
        name: d.monday_board ?? null,
        rows: d.rows ?? 0,
        mapped: Array.isArray(d.mapped_fields) ? (d.mapped_fields as string[]).length : 0,
        warnings: Array.isArray(d.warnings) ? (d.warnings as string[]).length : 0,
        error: d.error ?? null,
      }));
    } catch (err) {
      monday.error = err instanceof Error ? err.message : String(err);
    }
  }

  const ready = llm.configured && !!monday.tokenSet && !monday.error;
  return Response.json({ ready, llm, monday }, { status: ready ? 200 : 503 });
}
