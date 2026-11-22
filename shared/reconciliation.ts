/**
 * Mecanismo reutilizável de conciliação financeira e dimensional entre D1 e Power BI / CSVs oficiais.
 * Nunca compara bases de datas diferentes e rejeita aprovações com divergências não explicadas.
 */

export type ReconciliationDimension =
  | "regional"
  | "uf"
  | "client"
  | "product"
  | "macroCategory"
  | "itemGroup";

export type ReconciliationSnapshot = {
  sourceName: string;
  referenceDate: string;
  periodFrom: string;
  periodTo: string;
  gross: number;
  returns: number;
  revenue: number;
  breakdowns?: Partial<Record<ReconciliationDimension, Record<string, number>>>;
};

export type ReconciliationDivergence = {
  scope: "metadata" | "total" | ReconciliationDimension;
  key: string;
  d1Value: number | string | null;
  referenceValue: number | string | null;
  delta: number | null;
  reason: string;
};

export type ReconciliationReport = {
  approved: boolean;
  referenceDate: string;
  period: { from: string; to: string };
  tolerance: number;
  divergences: ReconciliationDivergence[];
  summary: string;
};

const round2 = (n: number) => Number(n.toFixed(2));

export function compareReconciliationSnapshots(
  d1: ReconciliationSnapshot,
  reference: ReconciliationSnapshot,
  tolerance = 0.005,
): ReconciliationReport {
  const divergences: ReconciliationDivergence[] = [];

  if (d1.referenceDate !== reference.referenceDate) {
    divergences.push({
      scope: "metadata",
      key: "referenceDate",
      d1Value: d1.referenceDate,
      referenceValue: reference.referenceDate,
      delta: null,
      reason: "Datas de atualização distintas: não é permitido conciliar bases com referenceDate diferente.",
    });
  }
  if (d1.periodFrom !== reference.periodFrom || d1.periodTo !== reference.periodTo) {
    divergences.push({
      scope: "metadata",
      key: "period",
      d1Value: `${d1.periodFrom}..${d1.periodTo}`,
      referenceValue: `${reference.periodFrom}..${reference.periodTo}`,
      delta: null,
      reason: "Períodos distintos: conciliação exige exatamente o mesmo intervalo de datas.",
    });
  }

  // Stop before comparing numbers if metadata/dates do not match.
  if (divergences.length) {
    return {
      approved: false,
      referenceDate: d1.referenceDate,
      period: { from: d1.periodFrom, to: d1.periodTo },
      tolerance,
      divergences,
      summary: `Conciliação recusada por divergência de data/período (${divergences.length} inconsistência(s)).`,
    };
  }

  const checkScalar = (key: "gross" | "returns" | "revenue", label: string) => {
    const delta = round2(d1[key] - reference[key]);
    if (Math.abs(delta) > tolerance) {
      divergences.push({
        scope: "total",
        key,
        d1Value: round2(d1[key]),
        referenceValue: round2(reference[key]),
        delta,
        reason: `Divergência em ${label}: D1=${round2(d1[key])} vs Referência=${round2(reference[key])} (delta=${delta}).`,
      });
    }
  };

  checkScalar("gross", "Faturamento bruto");
  checkScalar("returns", "Devoluções");
  checkScalar("revenue", "Faturamento líquido");

  const dims: ReconciliationDimension[] = [
    "regional",
    "uf",
    "client",
    "product",
    "macroCategory",
    "itemGroup",
  ];
  for (const dim of dims) {
    const left = d1.breakdowns?.[dim];
    const right = reference.breakdowns?.[dim];
    if (!left && !right) continue;
    const keys = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})]);
    for (const k of keys) {
      const lv = left?.[k] ?? 0;
      const rv = right?.[k] ?? 0;
      const delta = round2(lv - rv);
      if (Math.abs(delta) > tolerance) {
        divergences.push({
          scope: dim,
          key: k,
          d1Value: round2(lv),
          referenceValue: round2(rv),
          delta,
          reason: `Divergência em ${dim} (${k}): D1=${round2(lv)} vs Referência=${round2(rv)} (delta=${delta}).`,
        });
      }
    }
  }

  const approved = divergences.length === 0;
  return {
    approved,
    referenceDate: d1.referenceDate,
    period: { from: d1.periodFrom, to: d1.periodTo },
    tolerance,
    divergences,
    summary: approved
      ? `Conciliação aprovada ao centavo (${d1.periodFrom} a ${d1.periodTo}, base ${d1.referenceDate}).`
      : `Conciliação reprovada com ${divergences.length} divergência(s) acima da tolerância de R$ ${tolerance.toFixed(3)}.`,
  };
}
