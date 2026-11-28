export const PERIOD = "ordered_at >= '2025-11-01' and ordered_at < '2026-11-01'";

export const KPI_SQL = {
  revenue: "sum(amount) filter (where status = 'paid')",
  orders: "count(*) filter (where status = 'paid')",
  aov: "sum(amount) filter (where status = 'paid') / count(*) filter (where status = 'paid')",
  refund_rate: "count(*) filter (where status = 'refunded')::numeric / count(*)",
} as const;
