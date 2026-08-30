/**
 * "The agent should help prepare data for leadership updates."
 *
 * Interpretation: a founder should not have to ask six questions to build a
 * weekly update. This assembles the whole exec snapshot in one deterministic
 * pass - pipeline, conversion, delivery, risk, and the data caveats that belong
 * in a footnote - and hands it to the model to narrate.
 */

import { OPEN_STAGES } from "./normalize";
import { resolveTimeframe, runQuery } from "./query";
import { getDataset } from "./store";

export async function leadershipBrief(timeframe = "this quarter", sector?: string) {
  const tf = resolveTimeframe(timeframe);
  const period = tf?.label ?? "all time";
  const sectorFilter = sector ? [{ field: "sector", op: "contains", value: sector }] : [];

  const brief: Record<string, unknown> = {
    period,
    sector_scope: sector ?? "all sectors",
    generated_for: "leadership update",
  };
  const caveats = new Set<string>();
  const collect = (c: string[]) => c.forEach((x) => caveats.add(x));

  /* ---------------------------------------------------------------- deals */
  try {
    const deals = await getDataset("deals");
    const has = (f: string) => deals.mapping.some((m) => m.field === f);

    const openFilters = [...sectorFilter, ...(has("stage") ? [{ field: "stage", op: "in", value: OPEN_STAGES.join(",") }] : [])];

    const openPipeline = runQuery(deals, { filters: openFilters, metrics: ["count", "sum:value", "avg:value"] });
    const byStage = runQuery(deals, { filters: openFilters, group_by: "stage", metrics: ["count", "sum:value"], sort: "sum_value desc" });
    const bySector = runQuery(deals, { filters: openFilters, group_by: "sector", metrics: ["count", "sum:value"], sort: "sum_value desc", limit: 10 });
    const topDeals = runQuery(deals, { filters: openFilters, metrics: ["count"], return_rows: true, limit: 8, sort: "sum_value desc" });

    const won = runQuery(deals, { filters: [...sectorFilter, { field: "stage", op: "eq", value: "Won" }], timeframe, metrics: ["count", "sum:value"] });
    const lost = runQuery(deals, { filters: [...sectorFilter, { field: "stage", op: "eq", value: "Lost" }], timeframe, metrics: ["count", "sum:value"] });

    const decided = (won.matched ?? 0) + (lost.matched ?? 0);

    // Open deals whose expected close date has already passed.
    const stale = has("close_date")
      ? runQuery(deals, {
          filters: [...openFilters, { field: "close_date", op: "before", value: new Date().toISOString().slice(0, 10) }],
          metrics: ["count", "sum:value"],
          return_rows: true,
          limit: 8,
        })
      : null;

    brief.pipeline = {
      open_deals: openPipeline.matched,
      open_value: openPipeline.totals.sum_value,
      average_open_deal: openPipeline.totals.avg_value,
      by_stage: byStage.groups,
      by_sector: bySector.groups,
      largest_open_deals: topDeals.rows?.slice(0, 8),
    };
    brief.conversion = {
      window: period,
      won_count: won.matched,
      won_value: won.totals.sum_value,
      lost_count: lost.matched,
      lost_value: lost.totals.sum_value,
      win_rate_pct: decided ? Math.round((won.matched / decided) * 100) : null,
      note: decided ? undefined : "No deals were marked Won or Lost in this window, so win rate cannot be computed.",
    };
    if (stale) {
      brief.slipping_deals = {
        count: stale.matched,
        value: stale.totals.sum_value,
        examples: stale.rows?.slice(0, 8),
        definition: "Still in an open stage but the expected close date is in the past.",
      };
    }

    collect(openPipeline.caveats);
    collect(won.caveats);
    if (stale) collect(stale.caveats);
    collect(deals.quality.warnings);
  } catch (err) {
    brief.pipeline = { error: err instanceof Error ? err.message : String(err) };
  }

  /* ---------------------------------------------------------- work orders */
  try {
    const wo = await getDataset("work_orders");
    const has = (f: string) => wo.mapping.some((m) => m.field === f);
    const todayIso = new Date().toISOString().slice(0, 10);

    const active = runQuery(wo, { filters: [...sectorFilter, ...(has("status") ? [{ field: "status", op: "in", value: "Not Started,In Progress,On Hold" }] : [])], metrics: ["count", "sum:value"] });
    const byStatus = runQuery(wo, { filters: sectorFilter, group_by: "status", metrics: ["count", "sum:value"], sort: "count desc" });
    const delivered = runQuery(wo, { filters: [...sectorFilter, { field: "status", op: "eq", value: "Completed" }], timeframe, metrics: ["count", "sum:value"] });
    const bySector = runQuery(wo, { filters: sectorFilter, group_by: "sector", metrics: ["count", "sum:value"], sort: "sum_value desc", limit: 10 });

    const overdue = has("end_date")
      ? runQuery(wo, {
          filters: [...sectorFilter, { field: "status", op: "not_in", value: "Completed,Cancelled" }, { field: "end_date", op: "before", value: todayIso }],
          metrics: ["count", "sum:value"],
          return_rows: true,
          limit: 8,
        })
      : null;

    brief.delivery = {
      active_work_orders: active.matched,
      active_value: active.totals.sum_value,
      by_status: byStatus.groups,
      by_sector: bySector.groups,
      completed_in_window: { window: period, count: delivered.matched, value: delivered.totals.sum_value },
    };
    if (overdue) {
      brief.overdue_work = {
        count: overdue.matched,
        value: overdue.totals.sum_value,
        examples: overdue.rows?.slice(0, 8),
        definition: "Not Completed or Cancelled, and the end/due date has already passed.",
      };
    }

    collect(active.caveats);
    collect(delivered.caveats);
    if (overdue) collect(overdue.caveats);
    collect(wo.quality.warnings);
  } catch (err) {
    brief.delivery = { error: err instanceof Error ? err.message : String(err) };
  }

  /* --------------------------------------------------- cross-board signal */
  try {
    const [deals, wo] = await Promise.all([getDataset("deals"), getDataset("work_orders")]);
    const dealSectors = new Map<string, number>();
    for (const r of deals.rows) {
      const s = r.f.sector as string | null;
      const v = (r.f.value as number | null) ?? 0;
      if (s) dealSectors.set(s, (dealSectors.get(s) ?? 0) + v);
    }
    const woSectors = new Map<string, number>();
    for (const r of wo.rows) {
      const s = r.f.sector as string | null;
      const v = (r.f.value as number | null) ?? 0;
      if (s) woSectors.set(s, (woSectors.get(s) ?? 0) + v);
    }
    brief.sector_pipeline_vs_delivery = [...new Set([...dealSectors.keys(), ...woSectors.keys()])]
      .map((s) => ({ sector: s, pipeline_value: dealSectors.get(s) ?? 0, delivered_value: woSectors.get(s) ?? 0 }))
      .sort((a, b) => b.pipeline_value - a.pipeline_value)
      .slice(0, 10);
  } catch {
    /* one board already reported its own error above */
  }

  brief.data_caveats = [...caveats].slice(0, 12);
  brief.instruction_to_agent =
    "Write this as a short leadership update: 3-5 headline numbers, then what changed and why it matters, then risks (slipping deals, overdue work), then one recommended action. Put data caveats in a short footnote. Round large numbers. Do not invent figures that are not in this payload.";

  return brief;
}
