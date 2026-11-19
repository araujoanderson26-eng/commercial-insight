import type { Filters, Plan, Report, Row } from "../../shared/domain";

function sortedSet(values?: string[]): string[] {
  return values?.length ? [...new Set(values)].sort((a, b) => a.localeCompare(b)) : [];
}

function sameList(a?: string[], b?: string[]): boolean {
  const left = sortedSet(a);
  const right = sortedSet(b);
  return left.length === right.length && left.every((value, idx) => value === right[idx]);
}

export function sameFilters(a: Filters, b: Filters): boolean {
  return (
    a.from === b.from &&
    a.to === b.to &&
    (a.region ?? "") === (b.region ?? "") &&
    (a.client ?? "") === (b.client ?? "") &&
    (a.product ?? "") === (b.product ?? "") &&
    (a.category ?? "") === (b.category ?? "") &&
    (a.regional ?? "") === (b.regional ?? "") &&
    (a.state ?? "") === (b.state ?? "") &&
    (a.manager ?? "") === (b.manager ?? "") &&
    sameList(a.categoriesInclude, b.categoriesInclude) &&
    sameList(a.categoriesExclude, b.categoriesExclude)
  );
}

/**
 * Reuses an already-loaded report in memory for instant 0ms metric/sort transitions
 * whenever all rows are guaranteed to be present (monthly series or non-truncated rankings).
 */
export function projectCompatibleReport(plan: Plan, candidates: Report[]): Report | null {
  for (const candidate of candidates) {
    if (candidate.plan.group !== plan.group) continue;
    if (!sameFilters(candidate.plan.filters, plan.filters)) continue;
    if (candidate.plan.metric === plan.metric && candidate.plan.order === plan.order) {
      return candidate;
    }
    if (plan.group === "month") {
      return { ...candidate, plan };
    }
    if (!candidate.truncated) {
      const score = (row: Row) => {
        const pair = row.values[plan.metric];
        if (plan.order === "current") return pair.current ?? -Infinity;
        return (pair.current ?? 0) - (pair.previous ?? 0);
      };
      const sortedRows = [...candidate.rows].sort(
        (a, b) =>
          (plan.order === "decline" ? 1 : -1) * (score(a) - score(b)) ||
          a.name.localeCompare(b.name, "pt-BR"),
      );
      return { ...candidate, plan, rows: sortedRows };
    }
  }
  return null;
}

function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR");
}

export function filterRowsLocally(rows: Row[], query: string): Row[] {
  const needle = normalizeSearch(query.trim());
  if (!needle) return rows;
  return rows.filter((row) => {
    if (normalizeSearch(row.name).includes(needle)) return true;
    if (row.key && normalizeSearch(row.key).includes(needle)) return true;
    if (row.description && normalizeSearch(row.description).includes(needle)) return true;
    return false;
  });
}
