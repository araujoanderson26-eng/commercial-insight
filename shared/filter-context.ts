/**
 * Contrato único de contexto de filtros compartilhado entre Dashboard, Gráficos,
 * Relatórios, Assistente de IA, Excel e PDF.
 * Garante que a IA jamais amplie ou contradiga os filtros ativos selecionados pelo usuário.
 */
import {
  filterDimensions,
  formatOfficialRegionalName,
  normalizeRegionalKey,
  type Filters,
} from "./domain";

export const MULTI_FILTER_ARRAY_FIELDS = [
  "regions",
  "regionsExclude",
  "regionals",
  "regionalsExclude",
  "states",
  "statesExclude",
  "managers",
  "managersExclude",
  "municipalities",
  "municipalitiesExclude",
  "clients",
  "clientsExclude",
  "products",
  "productsExclude",
  "channels",
  "channelsExclude",
  "segments",
  "segmentsExclude",
  "brands",
  "brandsExclude",
] as const;

export type MultiFilterArrayField = (typeof MULTI_FILTER_ARRAY_FIELDS)[number];

export type FilterContextContract = {
  version: "3.0";
  period: { from: string; to: string };
  filters: Filters;
  activeSelectionCount: number;
  hasEntityRestrictions: boolean;
  canonicalKey: string;
};

function sortedUnique(list?: string[]): string[] {
  if (!list?.length) return [];
  return [...new Set(list.map((v) => v.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "pt-BR"),
  );
}

export function countActiveFilterSelections(filters: Filters): number {
  let count = 0;
  for (const dim of filterDimensions) {
    if (filters[dim]?.trim()) count++;
  }
  if (filters.municipality?.trim()) count++;
  for (const field of MULTI_FILTER_ARRAY_FIELDS) {
    count += filters[field]?.length ?? 0;
  }
  count += filters.categoriesInclude?.length ?? 0;
  count += filters.categoriesExclude?.length ?? 0;
  if (filters.variationDirection && filters.variationDirection !== "all") count++;
  if (filters.revenueMin !== undefined || filters.revenueMax !== undefined) count++;
  if (filters.ticketMin !== undefined || filters.ticketMax !== undefined) count++;
  return count;
}

export function canonicalFilterContextKey(filters: Filters): string {
  const normalized: Record<string, unknown> = {
    from: filters.from,
    to: filters.to,
  };
  for (const dim of filterDimensions) {
    const val = filters[dim]?.trim();
    if (val) {
      normalized[dim] = dim === "regional" ? normalizeRegionalKey(val) ?? val : val;
    }
  }
  if (filters.municipality?.trim()) normalized.municipality = filters.municipality.trim();
  for (const field of MULTI_FILTER_ARRAY_FIELDS) {
    const items = sortedUnique(filters[field]);
    if (items.length) {
      normalized[field] =
        field === "regionals" || field === "regionalsExclude"
          ? items.map((v) => normalizeRegionalKey(v) ?? v).sort()
          : items;
    }
  }
  const catIn = sortedUnique(filters.categoriesInclude);
  const catEx = sortedUnique(filters.categoriesExclude);
  if (catIn.length) normalized.categoriesInclude = catIn;
  if (catEx.length) normalized.categoriesExclude = catEx;
  if (filters.revenueMin !== undefined) normalized.revenueMin = filters.revenueMin;
  if (filters.revenueMax !== undefined) normalized.revenueMax = filters.revenueMax;
  if (filters.ticketMin !== undefined) normalized.ticketMin = filters.ticketMin;
  if (filters.ticketMax !== undefined) normalized.ticketMax = filters.ticketMax;
  if (filters.variationDirection && filters.variationDirection !== "all") {
    normalized.variationDirection = filters.variationDirection;
  }
  return JSON.stringify(normalized);
}

export function buildFilterContext(filters: Filters): FilterContextContract {
  const activeSelectionCount = countActiveFilterSelections(filters);
  return {
    version: "3.0",
    period: { from: filters.from, to: filters.to },
    filters,
    activeSelectionCount,
    hasEntityRestrictions: activeSelectionCount > 0,
    canonicalKey: canonicalFilterContextKey(filters),
  };
}

/**
 * Mescla o recorte interpretado pela IA com os filtros ativos do usuário,
 * garantindo que nenhum filtro ativo (simples, múltiplo, exclusão ou faixa) seja removido ou ampliado.
 */
export function enforceActiveFilterContext(
  activeFilters: Filters,
  candidate: Filters,
  inherited?: Filters,
): Filters {
  const next: Filters = { ...candidate };

  if (activeFilters.municipality?.trim()) {
    next.municipality = activeFilters.municipality.trim();
  } else if (!next.municipality?.trim() && inherited?.municipality?.trim()) {
    next.municipality = inherited.municipality.trim();
  }

  for (const field of MULTI_FILTER_ARRAY_FIELDS) {
    if (activeFilters[field]?.length) {
      next[field] = [...activeFilters[field]!];
    } else if (!next[field]?.length && inherited?.[field]?.length) {
      next[field] = [...inherited[field]!];
    }
  }

  if (activeFilters.revenueMin !== undefined) next.revenueMin = activeFilters.revenueMin;
  if (activeFilters.revenueMax !== undefined) next.revenueMax = activeFilters.revenueMax;
  if (activeFilters.ticketMin !== undefined) next.ticketMin = activeFilters.ticketMin;
  if (activeFilters.ticketMax !== undefined) next.ticketMax = activeFilters.ticketMax;
  if (activeFilters.variationDirection && activeFilters.variationDirection !== "all") {
    next.variationDirection = activeFilters.variationDirection;
  }

  return next;
}

/** Resumo neutro de escopo de filtros para auditoria e cabeçalhos (sem dados pessoais). */
export function describeFilterScope(filters: Filters): string[] {
  const parts: string[] = [`Período: ${filters.from} a ${filters.to}`];
  const pushList = (label: string, single?: string, multi?: string[], fmt = (v: string) => v) => {
    const vals = sortedUnique([...(single ? [single] : []), ...(multi ?? [])]).map(fmt);
    if (vals.length) parts.push(`${label}: ${vals.join(", ")}`);
  };
  pushList("Regional", filters.regional, filters.regionals, formatOfficialRegionalName);
  pushList("Excluir Regional", undefined, filters.regionalsExclude, formatOfficialRegionalName);
  pushList("UF", filters.state, filters.states);
  pushList("Representante", filters.region, filters.regions);
  pushList("Cliente", filters.client, filters.clients);
  pushList("Produto", filters.product, filters.products);
  pushList("Incluir categorias", filters.category, filters.categoriesInclude);
  pushList("Excluir categorias", undefined, filters.categoriesExclude);
  pushList("Marca", undefined, filters.brands);
  pushList("Canal", undefined, filters.channels);
  pushList("Segmento", undefined, filters.segments);
  return parts;
}
