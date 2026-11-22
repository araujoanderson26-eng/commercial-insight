/**
 * Camada central de indicadores comerciais do Commercial Insight 3.0.
 * Fonte única de definição e cálculo para Dashboard, Gráficos, Relatórios, Exportações e IA.
 * Nunca altera fórmulas já conciliadas com o Power BI.
 */
import type { Metric, Pair, Report } from "./domain";

export type OfficialIndicatorId =
  | "gross"
  | "returns"
  | "revenue"
  | "yoy_growth_pct"
  | "yoy_diff_abs"
  | "monthly_evolution"
  | "buyers"
  | "active_products"
  | "ticket_per_buyer"
  | "category_share_pct"
  | "regional_share_pct";

export type IndicatorDefinition = {
  id: OfficialIndicatorId;
  label: string;
  formula: string;
  unit: "money" | "percent" | "count" | "series";
  favorableDirection: "up" | "down" | "neutral";
  sourceMetric?: Metric;
};

export const OFFICIAL_INDICATORS: Record<OfficialIndicatorId, IndicatorDefinition> = {
  gross: {
    id: "gross",
    label: "Faturamento bruto",
    formula: "SUM(ci_fact_sales.gross_amount)",
    unit: "money",
    favorableDirection: "up",
    sourceMetric: "gross",
  },
  returns: {
    id: "returns",
    label: "Devoluções",
    formula: "SUM(ci_fact_returns.return_amount)",
    unit: "money",
    favorableDirection: "down",
    sourceMetric: "returns",
  },
  revenue: {
    id: "revenue",
    label: "Faturamento líquido",
    formula: "Faturamento bruto - Devoluções",
    unit: "money",
    favorableDirection: "up",
    sourceMetric: "revenue",
  },
  yoy_growth_pct: {
    id: "yoy_growth_pct",
    label: "Crescimento YoY (%)",
    formula: "(Atual - Anterior) / Anterior * 100 (somente quando Anterior > 0)",
    unit: "percent",
    favorableDirection: "up",
  },
  yoy_diff_abs: {
    id: "yoy_diff_abs",
    label: "Diferença absoluta YoY",
    formula: "Atual - Anterior",
    unit: "money",
    favorableDirection: "up",
  },
  monthly_evolution: {
    id: "monthly_evolution",
    label: "Evolução mensal",
    formula: "Série mensal comparativa (período atual vs. meses equivalentes do ano anterior)",
    unit: "series",
    favorableDirection: "neutral",
  },
  buyers: {
    id: "buyers",
    label: "Clientes compradores",
    formula: "COUNT(DISTINCT client_key) com vendas no período",
    unit: "count",
    favorableDirection: "up",
    sourceMetric: "buyers",
  },
  active_products: {
    id: "active_products",
    label: "Produtos ativos",
    formula: "COUNT(DISTINCT product_key) com vendas no período",
    unit: "count",
    favorableDirection: "up",
  },
  ticket_per_buyer: {
    id: "ticket_per_buyer",
    label: "Ticket médio por comprador",
    formula: "Faturamento líquido / Clientes compradores (quando compradores > 0)",
    unit: "money",
    favorableDirection: "up",
  },
  category_share_pct: {
    id: "category_share_pct",
    label: "Participação por categoria (%)",
    formula: "Faturamento da categoria / Faturamento total * 100",
    unit: "percent",
    favorableDirection: "neutral",
  },
  regional_share_pct: {
    id: "regional_share_pct",
    label: "Participação por regional (%)",
    formula: "Faturamento da regional / Faturamento total * 100",
    unit: "percent",
    favorableDirection: "neutral",
  },
};

export function calcNetRevenue(gross: number | null, returns: number | null): number | null {
  if (gross === null || returns === null || !Number.isFinite(gross) || !Number.isFinite(returns)) {
    return null;
  }
  return Number((gross - returns).toFixed(2));
}

export function calcYoYDiff(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || !Number.isFinite(current) || !Number.isFinite(previous)) {
    return null;
  }
  return Number((current - previous).toFixed(2));
}

export function calcYoYPercent(pair: Pair, metric: Metric = "revenue"): number | null {
  if (
    pair.current === null ||
    pair.previous === null ||
    !Number.isFinite(pair.current) ||
    !Number.isFinite(pair.previous)
  ) {
    return null;
  }
  if (metric === "margin") return pair.current - pair.previous;
  return pair.previous <= 0 ? null : (100 * (pair.current - pair.previous)) / pair.previous;
}

export function calcTicketPerBuyer(revenue: number | null, buyers: number | null): number | null {
  if (
    revenue === null ||
    buyers === null ||
    !Number.isFinite(revenue) ||
    !Number.isFinite(buyers) ||
    buyers <= 0
  ) {
    return null;
  }
  return Number((revenue / buyers).toFixed(2));
}

export function calcParticipationPct(part: number | null, total: number | null): number | null {
  if (
    part === null ||
    total === null ||
    !Number.isFinite(part) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return null;
  }
  return Number(((part / total) * 100).toFixed(2));
}

export type ReportIndicatorSummary = {
  gross: number | null;
  returns: number | null;
  revenue: number | null;
  previousRevenue: number | null;
  yoyDiffAbs: number | null;
  yoyGrowthPct: number | null;
  buyers: number | null;
  ticketPerBuyer: number | null;
  rowShares: { key: string; name: string; current: number | null; sharePct: number | null }[];
};

export function summarizeReportIndicators(report: Report): ReportIndicatorSummary {
  const gross = report.total.values.gross.current;
  const returns = report.total.values.returns.current;
  const revenue = report.total.values.revenue.current;
  const previousRevenue = report.total.values.revenue.previous;
  const buyers = report.total.values.buyers.current;
  const metric = report.plan.metric;
  const totalForShare = report.total.values[metric].current;

  return {
    gross,
    returns,
    revenue,
    previousRevenue,
    yoyDiffAbs: calcYoYDiff(revenue, previousRevenue),
    yoyGrowthPct: calcYoYPercent(report.total.values.revenue, "revenue"),
    buyers,
    ticketPerBuyer: calcTicketPerBuyer(revenue, buyers),
    rowShares: report.rows.slice(0, 12).map((row) => ({
      key: row.key ?? row.name,
      name: row.name,
      current: row.values[metric].current,
      sharePct: calcParticipationPct(row.values[metric].current, totalForShare),
    })),
  };
}
