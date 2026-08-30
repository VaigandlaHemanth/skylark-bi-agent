/**
 * Cross-board comparison.
 *
 * The boards share no row-level key: client codes overlap on nothing (199
 * against 51), and deal names repeat, so joining on them multiplies rows
 * fourfold. What they do share is two categorical dimensions - sector matches
 * on all six values the work order board uses, and owner on six of seven - so
 * the honest join is at the group level, not the row level.
 *
 * That is enough for the question neither board can answer alone: where is
 * sales landing work that delivery has not caught up to, and who is selling
 * more than the delivery side is billing.
 */

import { runQuery } from "./query";
import { getDataset, type Dataset } from "./store";

export type CompareDimension = "sector" | "owner";

/** Board values whose text contains any of these concepts. */
function valuesMeaning(ds: Dataset, field: string, ...concepts: string[]): string | null {
  const pool = ds.distinct[field];
  if (!pool) return null;
  const wanted = concepts.map((c) => c.toLowerCase());
  const hits = pool.map((p) => p.value).filter((v) => wanted.some((w) => v.toLowerCase().includes(w)));
  return hits.length ? hits.join(",") : null;
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

export async function compareBoards(dimension: CompareDimension = "sector") {
  if (dimension !== "sector" && dimension !== "owner") {
    return {
      error: `Cannot compare on "${dimension}".`,
      reason:
        "The two boards share no row-level key. Client codes have zero overlap (199 on the deal board, 51 on the work order board) and deal names repeat, so only sector and owner line up across both.",
    };
  }

  const [deals, wo] = await Promise.all([getDataset("deals"), getDataset("work_orders")]);
  const caveats = new Set<string>();

  const open = valuesMeaning(deals, "status", "open") ?? "Open";
  const won = valuesMeaning(deals, "status", "won") ?? "Won";
  const done = valuesMeaning(wo, "status", "complet", "delivered") ?? "Completed";

  const grab = (r: ReturnType<typeof runQuery>) => {
    r.caveats.forEach((c) => caveats.add(c));
    return new Map((r.groups ?? []).map((g) => [String(g[dimension]), g]));
  };

  const openByGroup = grab(runQuery(deals, { filters: [{ field: "status", op: "in", value: open }], group_by: dimension, metrics: ["count", "sum:value"] }));
  const wonByGroup = grab(runQuery(deals, { filters: [{ field: "status", op: "in", value: won }], group_by: dimension, metrics: ["count", "sum:value"] }));
  const woByGroup = grab(runQuery(wo, { group_by: dimension, metrics: ["count", "sum:value", "sum:billed", "sum:receivable"] }));
  const deliveredByGroup = grab(runQuery(wo, { filters: [{ field: "status", op: "in", value: done }], group_by: dimension, metrics: ["count"] }));

  const names = [...new Set([...openByGroup.keys(), ...wonByGroup.keys(), ...woByGroup.keys()])].filter((n) => n && n !== "(blank)");

  const rows = names.map((name) => {
    const o = openByGroup.get(name);
    const w = wonByGroup.get(name);
    const x = woByGroup.get(name);
    const d = deliveredByGroup.get(name);

    const wonValue = Number(w?.sum_value ?? 0);
    const orderValue = Number(x?.sum_value ?? 0);
    const billed = Number(x?.sum_billed ?? 0);
    const woCount = Number(x?.count ?? 0);

    return {
      [dimension]: name,
      open_deals: Number(o?.count ?? 0),
      open_value: Number(o?.sum_value ?? 0),
      won_deals: Number(w?.count ?? 0),
      won_value: wonValue,
      work_orders: woCount,
      work_order_value: orderValue,
      billed,
      receivable: Number(x?.sum_receivable ?? 0),
      delivered_pct: pct(Number(d?.count ?? 0), woCount),
      billed_pct: pct(billed, orderValue),
      // Sales is on both boards, so a group that appears on one and not the
      // other is the finding, not an error.
      present_on: [o || w ? "deals" : null, x ? "work_orders" : null].filter(Boolean).join(" + "),
    };
  });

  rows.sort((a, b) => Number(b.open_value) + Number(b.work_order_value) - (Number(a.open_value) + Number(a.work_order_value)));

  const salesOnly = rows.filter((r) => r.present_on === "deals").map((r) => r[dimension]);
  const deliveryOnly = rows.filter((r) => r.present_on === "work_orders").map((r) => r[dimension]);
  if (salesOnly.length) caveats.add(`Sold but never delivered in: ${salesOnly.join(", ")} — these appear on the deal board with no work orders at all.`);
  if (deliveryOnly.length) caveats.add(`Delivered without a matching deal record in: ${deliveryOnly.join(", ")}.`);

  return {
    dimension,
    join_basis:
      dimension === "sector"
        ? "Sector, which matches on all six values the work order board uses."
        : "Owner code, which matches on six of seven values across the two boards.",
    rows,
    data_caveats: [...caveats].slice(0, 8),
    instruction_to_agent:
      "This is a group-level comparison, not a row-level join - the boards share no key that would support one. Say what it shows: where open pipeline is large against little delivery, where delivery is running with no pipeline behind it, and where billing lags the order book. Do not multiply these figures together.",
  };
}
