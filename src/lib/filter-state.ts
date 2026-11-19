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
const MULTI_FIELD_BY_DIM: Partial<
  Record<
    FilterDimension,
    keyof Pick<Filters, "regions" | "clients" | "products" | "regionals" | "states" | "managers">
  >
> = {
  region: "regions",
  client: "clients",
  product: "products",
  regional: "regionals",
  state: "states",
  manager: "managers",
};

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
    if (!supported.includes(dim)) {
      delete next[dim];
      const multiKey = MULTI_FIELD_BY_DIM[dim];
      if (multiKey) delete next[multiKey];
    }
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
    "regions",
    "clients",
    "products",
    "regionals",
    "states",
    "managers",
    "revMin",
    "revMax",
    "tktMin",
    "tktMax",
    "dir",
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
  const numParam = (name: string) => {
    const raw = params.get(name);
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
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
  for (const multi of ["regions", "clients", "products", "regionals", "states", "managers"] as const) {
    const vals = splitValues(multi);
    if (vals) candidate[multi] = vals;
  }
  const revMin = numParam("revMin");
  const revMax = numParam("revMax");
  const tktMin = numParam("tktMin");
  const tktMax = numParam("tktMax");
  if (revMin !== undefined) candidate.revenueMin = revMin;
  if (revMax !== undefined) candidate.revenueMax = revMax;
  if (tktMin !== undefined) candidate.ticketMin = tktMin;
  if (tktMax !== undefined) candidate.ticketMax = tktMax;
  const dir = params.get("dir");
  if (dir === "growth" || dir === "decline" || dir === "all") candidate.variationDirection = dir;

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
  for (const multi of ["regions", "clients", "products", "regionals", "states", "managers"] as const) {
    if (filters[multi]?.length) params.set(multi, filters[multi]!.join("|"));
  }
  if (filters.revenueMin !== undefined) params.set("revMin", String(filters.revenueMin));
  if (filters.revenueMax !== undefined) params.set("revMax", String(filters.revenueMax));
  if (filters.ticketMin !== undefined) params.set("tktMin", String(filters.ticketMin));
  if (filters.ticketMax !== undefined) params.set("tktMax", String(filters.ticketMax));
  if (filters.variationDirection && filters.variationDirection !== "all") {
    params.set("dir", filters.variationDirection);
  }
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
    { id: "2026", label: "2026", from: "2026-01", to: "2026-12" },
    { id: "2025", label: "2025", from: "2025-01", to: "2025-12" },
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
    const label = capabilities.labels?.[dim] ?? DEFAULT_DIMENSION_LABELS[dim];
    const raw = filters[dim]?.trim();
    if (raw) {
      const display = optionLabels?.[dim]?.[raw] ?? raw;
      chips.push({
        id: `dim:${dim}`,
        label,
        value: display,
        remove: (current) => ({ ...current, [dim]: "" }),
      });
    }
    const multiKey = MULTI_FIELD_BY_DIM[dim];
    if (multiKey) {
      for (const item of filters[multiKey] ?? []) {
        if (item === raw) continue;
        const display = optionLabels?.[dim]?.[item] ?? item;
        chips.push({
          id: `multi:${multiKey}:${item}`,
          label,
          value: display,
          remove: (current) => ({
            ...current,
            [multiKey]: (current[multiKey] ?? []).filter((v) => v !== item),
          }),
        });
      }
    }
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
  if (filters.variationDirection && filters.variationDirection !== "all") {
    chips.push({
      id: "varDir",
      label: "Variação",
      value: filters.variationDirection === "growth" ? "Somente crescimento" : "Somente queda",
      remove: (current) => ({ ...current, variationDirection: undefined }),
    });
  }
  if (filters.revenueMin !== undefined || filters.revenueMax !== undefined) {
    const text = [
      filters.revenueMin !== undefined ? `≥ ${filters.revenueMin}` : "",
      filters.revenueMax !== undefined ? `≤ ${filters.revenueMax}` : "",
    ]
      .filter(Boolean)
      .join(" e ");
    chips.push({
      id: "revRange",
      label: "Faturamento",
      value: text,
      remove: (current) => ({ ...current, revenueMin: undefined, revenueMax: undefined }),
    });
  }
  if (filters.ticketMin !== undefined || filters.ticketMax !== undefined) {
    const text = [
      filters.ticketMin !== undefined ? `≥ ${filters.ticketMin}` : "",
      filters.ticketMax !== undefined ? `≤ ${filters.ticketMax}` : "",
    ]
      .filter(Boolean)
      .join(" e ");
    chips.push({
      id: "tktRange",
      label: "Ticket",
      value: text,
      remove: (current) => ({ ...current, ticketMin: undefined, ticketMax: undefined }),
    });
  }
  return chips;
}

export function hasAnyActiveFilter(filters: Filters, capabilities: DataCapabilities): boolean {
  return isNonDefaultPeriod(filters) || activeFilterChips(filters, capabilities).length > 0;
}
