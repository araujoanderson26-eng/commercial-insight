import {
  defaultFilters,
  filtersSchema,
  type DataCapabilities,
  type FilterDimension,
  type Filters,
} from "../../shared/domain";
import { sameFilters } from "./analytics";

const STORAGE_PREFIX = "ci:filters:v1:";
const ALL_OPTIONAL_DIMENSIONS: FilterDimension[] = ["regional", "state", "manager", "category"];

const DEFAULT_DIMENSION_LABELS: Record<FilterDimension, string> = {
  region: "Regional",
  client: "Cliente",
  product: "Produto",
  category: "Categoria",
  regional: "Regional comercial",
  state: "UF",
  manager: "Gerente",
};

export type ActiveFilterChip = {
  id: string;
  label: string;
  value: string;
  remove: (current: Filters) => Filters;
};

export type PeriodPreset = {
  id: string;
  label: string;
  from: string;
  to: string;
};

export function sanitizeFiltersForCapabilities(
  filters: Filters,
  supported: readonly FilterDimension[],
): Filters {
  const next: Filters = { ...filters };
  for (const dim of ALL_OPTIONAL_DIMENSIONS) {
    if (!supported.includes(dim)) delete next[dim];
  }
  if (!supported.includes("category")) {
    delete next.categoriesInclude;
    delete next.categoriesExclude;
  }
  return next;
}

export function parseFiltersFromSearch(
  search: string,
  supported: readonly FilterDimension[],
): Filters | null {
  if (!search || search === "?") return null;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const keys = [
    "from",
    "to",
    "region",
    "client",
    "product",
    "regional",
    "state",
    "manager",
    "category",
    "catIn",
    "catEx",
  ];
  if (!keys.some((key) => params.has(key))) return null;
  const base = defaultFilters();
  const splitValues = (paramName: string) => {
    const rawList = params
      .getAll(paramName)
      .flatMap((v) => v.split("|"))
      .map((v) => v.trim())
      .filter(Boolean);
    return rawList.length ? [...new Set(rawList)] : undefined;
  };
  const candidate: Record<string, unknown> = {
    from: params.get("from") || base.from,
    to: params.get("to") || base.to,
    region: params.get("region") ?? "",
    client: params.get("client") ?? "",
    product: params.get("product") ?? "",
  };
  for (const dim of ["regional", "state", "manager", "category"] as const) {
    const value = params.get(dim);
    if (value) candidate[dim] = value;
  }
  const catIn = splitValues("catIn");
  const catEx = splitValues("catEx");
  if (catIn) candidate.categoriesInclude = catIn;
  if (catEx) candidate.categoriesExclude = catEx;
  const parsed = filtersSchema.safeParse(candidate);
  if (!parsed.success) return null;
  return sanitizeFiltersForCapabilities(parsed.data, supported);
}

export function loadInitialFilters(
  userId: string,
  supported: readonly FilterDimension[],
): Filters {
  if (typeof location !== "undefined") {
    const fromUrl = parseFiltersFromSearch(location.search, supported);
    if (fromUrl) return fromUrl;
  }
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(STORAGE_PREFIX + userId);
      if (raw) {
        const parsed = filtersSchema.safeParse(JSON.parse(raw));
        if (parsed.success) return sanitizeFiltersForCapabilities(parsed.data, supported);
      }
    }
  } catch {
    // Ignore malformed or restricted localStorage.
  }
  return sanitizeFiltersForCapabilities(defaultFilters(), supported);
}

export function buildFilterSearch(filters: Filters): string {
  const base = defaultFilters();
  if (sameFilters(filters, base)) return "";
  const params = new URLSearchParams();
  if (filters.from !== base.from || filters.to !== base.to) {
    params.set("from", filters.from);
    params.set("to", filters.to);
  }
  for (const dim of ["region", "client", "product", "regional", "state", "manager", "category"] as const) {
    const val = filters[dim]?.trim();
    if (val) params.set(dim, val);
  }
  if (filters.categoriesInclude?.length) params.set("catIn", filters.categoriesInclude.join("|"));
  if (filters.categoriesExclude?.length) params.set("catEx", filters.categoriesExclude.join("|"));
  const qs = params.toString();
  return qs ? "?" + qs : "";
}

export function persistFilters(
  userId: string,
  filters: Filters,
  supported: readonly FilterDimension[],
): void {
  const clean = sanitizeFiltersForCapabilities(filters, supported);
  try {
    if (typeof localStorage !== "undefined") {
      if (sameFilters(clean, defaultFilters())) localStorage.removeItem(STORAGE_PREFIX + userId);
      else localStorage.setItem(STORAGE_PREFIX + userId, JSON.stringify(clean));
    }
  } catch {
    // Ignore storage unavailability.
  }
  if (typeof history !== "undefined" && typeof location !== "undefined") {
    const nextSearch = buildFilterSearch(clean);
    if (location.search !== nextSearch) {
      history.replaceState(null, "", location.pathname + nextSearch);
    }
  }
}

export function periodPresets(): PeriodPreset[] {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const fmt = (offset: number) =>
    new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 7);
  const to = fmt(-1);
  const ytdYear = m === 1 ? y - 1 : y;
  return [
    { id: "3m", label: "3M", from: fmt(-3), to },
    { id: "6m", label: "6M", from: fmt(-6), to },
    { id: "12m", label: "12M", from: fmt(-12), to },
    { id: "ytd", label: "Ano", from: `${ytdYear}-01`, to },
  ];
}

export function isNonDefaultPeriod(filters: Filters): boolean {
  const base = defaultFilters();
  return filters.from !== base.from || filters.to !== base.to;
}

export function activeFilterChips(
  filters: Filters,
  capabilities: DataCapabilities,
  optionLabels?: Partial<Record<FilterDimension, Record<string, string>>>,
): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];
  for (const dim of capabilities.filters) {
    const raw = filters[dim]?.trim();
    if (!raw) continue;
    const label = capabilities.labels?.[dim] ?? DEFAULT_DIMENSION_LABELS[dim];
    const display = optionLabels?.[dim]?.[raw] ?? raw;
    chips.push({
      id: `dim:${dim}`,
      label,
      value: display,
      remove: (current) => ({ ...current, [dim]: "" }),
    });
  }
  for (const cat of filters.categoriesInclude ?? []) {
    chips.push({
      id: `catIn:${cat}`,
      label: "Incluir",
      value: cat,
      remove: (current) => ({
        ...current,
        categoriesInclude: (current.categoriesInclude ?? []).filter((item) => item !== cat),
      }),
    });
  }
  for (const cat of filters.categoriesExclude ?? []) {
    chips.push({
      id: `catEx:${cat}`,
      label: "Excluir",
      value: cat,
      remove: (current) => ({
        ...current,
        categoriesExclude: (current.categoriesExclude ?? []).filter((item) => item !== cat),
      }),
    });
  }
  return chips;
}

export function hasAnyActiveFilter(filters: Filters, capabilities: DataCapabilities): boolean {
  return isNonDefaultPeriod(filters) || activeFilterChips(filters, capabilities).length > 0;
}
