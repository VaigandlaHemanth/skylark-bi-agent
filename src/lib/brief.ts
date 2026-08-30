/**
 * "The agent should help prepare data for leadership updates."
 *
 * Interpretation: a founder should not have to ask six questions to build a
 * weekly update. This assembles the whole exec snapshot in one deterministic
 * pass - pipeline, conversion, delivery, cash, risk, and the data caveats that
 * belong in a footnote - and hands it to the model to narrate.
 */

import { resolveTimeframe, runQuery } from "./query";
import { getDataset, type Dataset } from "./store";

const todayIso = () => new Date().toISOString().slice(0, 10);

/** Board values whose concept is X, so the brief works whatever the labels are. */
function valuesMeaning(ds: Dataset, field: string, ...concepts: string[]): string | null {
  const pool = ds.distinct[field];
  if (!pool) return null;
  const wanted = concepts.map((c) => c.toLowerCase());
  const hits = pool.map((p) => p.value).filter((v) => wanted.some((w) => v.toLowerCase().includes(w)));
  return hits.length ? hits.join(",") : null;
}

export async function leadershipBrief(timeframe = "this quarter", sector?: string) {
  const tf = resolveTimeframe(timeframe);
  const period = tf?.label ?? "all time";
  const sectorFilter = sector ? [{ field: "sector", op: "eq", value: sector }] : [];

  // Warm both boards concurrently before the serial sections below.
  await Promise.allSettled([getDataset("deals"), getDataset("work_orders")]);

  const brief: Record<string, unknown> = {
    period,
    sector_scope: sector ?? "all sectors",
    generated_for: "leadership update",
    as_of: todayIso(),
  };
  const caveats = new Set<string>();
  const collect = (c: string[]) => c.forEach((x) => caveats.add(x));

  /* ---------------------------------------------------------------- deals */
  try {
    const deals = await getDataset("deals");
    const has = (f: string) => deals.mapping.some((m) => m.field === f);

    const open = valuesMeaning(deals, "status", "open") ?? "Open";
    const won = valuesMeaning(deals, "status", "won") ?? "Won";
    const lost = valuesMeaning(deals, "status", "dead", "lost") ?? "Dead";

    const openFilters = has("status") ? [...sectorFilter, { field: "status", op: "in", value: open }] : sectorFilter;

    const pipeline = runQuery(deals, { filters: openFilters, metrics: ["count", "sum:value", "avg:value"] });
    const byStage = has("stage") ? runQuery(deals, { filters: openFilters, group_by: "stage", metrics: ["count", "sum:value"], sort: "count desc" }) : null;
    const bySector = runQuery(deals, { filters: openFilters, group_by: "sector", metrics: ["count", "sum:value"], sort: "sum_value desc", limit: 12 });
    const byProbability = has("probability") ? runQuery(deals, { filters: openFilters, group_by: "probability", metrics: ["count", "sum:value"], sort: "sum_value desc" }) : null;
    const biggest = runQuery(deals, { filters: [...openFilters, { field: "value", op: "not_empty" }], metrics: ["count"], return_rows: true, limit: 8, sort: "sum_value desc" });

    const wonQ = runQuery(deals, { filters: [...sectorFilter, { field: "status", op: "in", value: won }], timeframe, metrics: ["count", "sum:value"] });
    const lostQ = runQuery(deals, { filters: [...sectorFilter, { field: "status", op: "in", value: lost }], timeframe, metrics: ["count", "sum:value"] });
    const decided = wonQ.matched + lostQ.matched;

    const slipping = has("close_date")
      ? runQuery(deals, { filters: [...openFilters, { field: "close_date", op: "before", value: todayIso() }], metrics: ["count", "sum:value"], return_rows: true, limit: 8 })
      : null;

    brief.pipeline = {
      definition: `deals whose status is one of: ${open}`,
      open_deals: pipeline.matched,
      open_value: pipeline.totals.sum_value,
      average_open_deal: pipeline.totals.avg_value,
      by_stage: byStage?.groups,
      by_sector: bySector.groups,
      by_probability: byProbability?.groups,
      largest_open_deals: biggest.rows?.slice(0, 8),
    };

    brief.conversion = {
      window: period,
      won_count: wonQ.matched,
      won_value: wonQ.totals.sum_value,
      lost_count: lostQ.matched,
      lost_value: lostQ.totals.sum_value,
      win_rate_pct: decided ? Math.round((wonQ.matched / decided) * 100) : null,
    };

    // Close dates cluster, so short windows often contain nothing decided.
    // "Cannot be computed" is a shrug; the lifetime rate is the real answer,
    // clearly labelled as covering a different period.
    if (!decided) {
      const wonAll = runQuery(deals, { filters: [...sectorFilter, { field: "status", op: "in", value: won }], metrics: ["count", "sum:value"] });
      const lostAll = runQuery(deals, { filters: [...sectorFilter, { field: "status", op: "in", value: lost }], metrics: ["count", "sum:value"] });
      const decidedAll = wonAll.matched + lostAll.matched;
      (brief.conversion as Record<string, unknown>).note =
        `No deals closed inside ${period}, so no win rate exists for that window. Lifetime figures are given instead and must be labelled as such.`;
      (brief.conversion as Record<string, unknown>).lifetime = {
        basis: "all deals on the board, regardless of close date",
        won_count: wonAll.matched,
        won_value: wonAll.totals.sum_value,
        lost_count: lostAll.matched,
        lost_value: lostAll.totals.sum_value,
        win_rate_pct: decidedAll ? Math.round((wonAll.matched / decidedAll) * 100) : null,
      };
    }

    if (slipping) {
      brief.slipping_deals = {
        definition: "still open, but the expected close date has already passed",
        count: slipping.matched,
        value: slipping.totals.sum_value,
        examples: slipping.rows?.slice(0, 8),
      };
    }

    collect(pipeline.caveats);
    // The sector breakdown is where concentration shows up (Tender is 77% of
    // open value on four deals) - that caveat has to reach the footnote.
    collect(bySector.caveats);
    if (byStage) collect(byStage.caveats);
    collect(wonQ.caveats);
    if (slipping) collect(slipping.caveats);
    collect(deals.quality.warnings);
  } catch (err) {
    brief.pipeline = { error: err instanceof Error ? err.message : String(err) };
  }

  /* ---------------------------------------------------------- work orders */
  try {
    const wo = await getDataset("work_orders");
    const has = (f: string) => wo.mapping.some((m) => m.field === f);

    const done = valuesMeaning(wo, "status", "complet", "delivered") ?? "Completed";
    const live = valuesMeaning(wo, "status", "ongoing", "progress", "not started", "executed", "pause", "pending") ?? "Ongoing,Not Started";

    const active = has("status") ? runQuery(wo, { filters: [...sectorFilter, { field: "status", op: "in", value: live }], metrics: ["count", "sum:value"] }) : null;
    const byStatus = runQuery(wo, { filters: sectorFilter, group_by: "status", metrics: ["count", "sum:value"], sort: "count desc" });
    const bySector = runQuery(wo, { filters: sectorFilter, group_by: "sector", metrics: ["count", "sum:value"], sort: "sum_value desc", limit: 12 });
    const delivered = runQuery(wo, { filters: [...sectorFilter, { field: "status", op: "in", value: done }], timeframe, metrics: ["count", "sum:value"] });

    const overdue = has("end_date") && has("status")
      ? runQuery(wo, {
          filters: [...sectorFilter, { field: "status", op: "not_in", value: done }, { field: "end_date", op: "before", value: todayIso() }],
          metrics: ["count", "sum:value"],
          return_rows: true,
          limit: 8,
        })
      : null;

    brief.delivery = {
      active_work_orders: active?.matched,
      active_order_value: active?.totals.sum_value,
      by_status: byStatus.groups,
      by_sector: bySector.groups,
      completed_in_window: { window: period, count: delivered.matched, value: delivered.totals.sum_value },
    };

    if (overdue) {
      brief.overdue_delivery = {
        definition: "not marked complete, and the end date has already passed",
        count: overdue.matched,
        value: overdue.totals.sum_value,
        examples: overdue.rows?.slice(0, 8),
      };
    }

    /* ------------------------------------------------------------- cash */
    if (has("receivable") || has("unbilled") || has("billed")) {
      const cash = runQuery(wo, { filters: sectorFilter, metrics: ["sum:value", "sum:billed", "sum:collected", "sum:unbilled", "sum:receivable"] });
      const topAR = has("receivable")
        ? runQuery(wo, { filters: [...sectorFilter, { field: "receivable", op: "gt", value: "0" }], group_by: "client", metrics: ["count", "sum:receivable"], sort: "sum_receivable desc", limit: 8 })
        : null;
      const notBilled = has("invoice_status")
        ? runQuery(wo, { filters: [...sectorFilter, { field: "invoice_status", op: "in", value: valuesMeaning(wo, "invoice_status", "not billed", "partially") ?? "Not billed yet" }], metrics: ["count", "sum:unbilled"] })
        : null;

      brief.cash = {
        order_book_value: cash.totals.sum_value,
        billed_to_date: cash.totals.sum_billed,
        collected_to_date: cash.totals.sum_collected,
        still_to_bill: cash.totals.sum_unbilled,
        receivable_outstanding: cash.totals.sum_receivable,
        top_receivable_accounts: topAR?.groups,
        not_fully_billed: notBilled ? { count: notBilled.matched, value: notBilled.totals.sum_unbilled } : undefined,
      };
      collect(cash.caveats);
    }

    if (active) collect(active.caveats);
    collect(bySector.caveats);
    collect(delivered.caveats);
    if (overdue) collect(overdue.caveats);
    collect(wo.quality.warnings);
  } catch (err) {
    brief.delivery = { error: err instanceof Error ? err.message : String(err) };
  }

  /* --------------------------------------------------- cross-board signal */
  try {
    const [deals, wo] = await Promise.all([getDataset("deals"), getDataset("work_orders")]);
    const tally = (ds: Dataset, valueField: string) => {
      const m = new Map<string, { value: number; count: number }>();
      for (const r of ds.rows) {
        const s = r.f.sector as string | null;
        if (!s) continue;
        const cur = m.get(s) ?? { value: 0, count: 0 };
        cur.value += (r.f[valueField] as number | null) ?? 0;
        cur.count += 1;
        m.set(s, cur);
      }
      return m;
    };

    const d = tally(deals, "value");
    const w = tally(wo, "value");
    brief.sector_pipeline_vs_delivery = [...new Set([...d.keys(), ...w.keys()])]
      .map((s) => ({
        sector: s,
        deals: d.get(s)?.count ?? 0,
        deal_value: Math.round(d.get(s)?.value ?? 0),
        work_orders: w.get(s)?.count ?? 0,
        work_order_value: Math.round(w.get(s)?.value ?? 0),
      }))
      .sort((a, b) => b.deal_value + b.work_order_value - (a.deal_value + a.work_order_value))
      .slice(0, 12);
  } catch {
    /* the failing board already reported its own error above */
  }

  brief.data_caveats = [...caveats].slice(0, 12);
  brief.instruction_to_agent =
    "Write this as a short leadership update: 3-5 headline numbers, then what stands out and why it matters, then risks (slipping deals, overdue delivery, receivables), then one recommended action. Put data caveats in a single short footnote. Round large numbers. Do not invent any figure that is not in this payload.";

  return brief;
}
