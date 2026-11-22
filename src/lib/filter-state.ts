import {
  defaultFilters,
  filtersSchema,
  formatOfficialRegionalName,
  normalizeRegionalKey,
  type DataCapabilities,
  type ExtendedFilterDimension,
  type ExtraFilterCapability,
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

const EXCLUDE_FIELD_BY_DIM: Partial<
  Record<
    FilterDimension,
    keyof Pick<
      Filters,
      | "regionsExclude"
      | "clientsExclude"
      | "productsExclude"
      | "regionalsExclude"
      | "statesExclude"
      | "managersExclude"
    >
  >
> = {
  region: "regionsExclude",
  client: "clientsExclude",
  product: "productsExclude",
  regional: "regionalsExclude",
  state: "statesExclude",
  manager: "managersExclude",
};

const DEFAULT_DIMENSION_LABELS: Record<FilterDimension | ExtendedFilterDimension, string> = {
  region: "Representante",
  client: "Cliente",
  product: "Produto",
  category: "Categoria",
  regional: "Regional",
  state: "UF",
  manager: "Gerente Regional",
  municipality: "Município",
  macroCategory: "Macrocategoria",
  itemGroup: "Grupo do item",
  channel: "Canal comercial",
  brand: "Marca",
  segment: "Segmento",
};

export type ActiveFilterChip = {
  id: string;
  label: string;
  value: string;
  mode: "include" | "exclude";
  dimension?: ExtendedFilterDimension | "category" | "range";
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
  supportedExtra?: readonly ExtraFilterCapability[],
): Filters {
  const next: Filters = { ...filters };
  for (const dim of ALL_OPTIONAL_DIMENSIONS) {
    if (!supported.includes(dim)) {
      delete next[dim];
      const multiKey = MULTI_FIELD_BY_DIM[dim];
      const excKey = EXCLUDE_FIELD_BY_DIM[dim];
      if (multiKey) delete next[multiKey];
      if (excKey) delete next[excKey];
    }
  }
  if (!supported.includes("category")) {
    delete next.categoriesInclude;
    delete next.categoriesExclude;
  }
  if (supportedExtra) {
    if (!supportedExtra.includes("municipality")) {
      delete next.municipality;
      delete next.municipalities;
      delete next.municipalitiesExclude;
    }
    if (!supportedExtra.includes("channel")) {
      delete next.channels;
      delete next.channelsExclude;
    }
    if (!supportedExtra.includes("segment")) {
      delete next.segments;
      delete next.segmentsExclude;
    }
    if (!supportedExtra.includes("brand")) {
      delete next.brands;
      delete next.brandsExclude;
    }
  }
  return next;
}

export function parseFiltersFromSearch(
  search: string,
  supported: readonly FilterDimension[],
  supportedExtra?: readonly ExtraFilterCapability[],
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
    "municipality",
    "mun",
    "category",
    "catIn",
    "catEx",
    "regions",
    "repEx",
    "clients",
    "cliEx",
    "products",
    "prodEx",
    "regionals",
    "regEx",
    "states",
    "stEx",
    "managers",
    "mgrEx",
    "muns",
    "munEx",
    "ch",
    "chEx",
    "seg",
    "segEx",
    "br",
    "brEx",
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
  const munSingle = params.get("mun") ?? params.get("municipality");
  if (munSingle) candidate.municipality = munSingle;
  const catIn = splitValues("catIn");
  const catEx = splitValues("catEx");
  if (catIn) candidate.categoriesInclude = catIn;
  if (catEx) candidate.categoriesExclude = catEx;
  const arrayParamMap: [string, keyof Filters][] = [
    ["regions", "regions"],
    ["repEx", "regionsExclude"],
    ["clients", "clients"],
    ["cliEx", "clientsExclude"],
    ["products", "products"],
    ["prodEx", "productsExclude"],
    ["regionals", "regionals"],
    ["regEx", "regionalsExclude"],
    ["states", "states"],
    ["stEx", "statesExclude"],
    ["managers", "managers"],
    ["mgrEx", "managersExclude"],
    ["muns", "municipalities"],
    ["munEx", "municipalitiesExclude"],
    ["ch", "channels"],
    ["chEx", "channelsExclude"],
    ["seg", "segments"],
    ["segEx", "segmentsExclude"],
    ["br", "brands"],
    ["brEx", "brandsExclude"],
  ];
  for (const [paramName, field] of arrayParamMap) {
    const vals = splitValues(paramName);
    if (vals) candidate[field] = vals;
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
  return sanitizeFiltersForCapabilities(parsed.data, supported, supportedExtra);
}

export function loadInitialFilters(
  userId: string,
  supported: readonly FilterDimension[],
  supportedExtra?: readonly ExtraFilterCapability[],
): Filters {
  if (typeof location !== "undefined") {
    const fromUrl = parseFiltersFromSearch(location.search, supported, supportedExtra);
    if (fromUrl) return fromUrl;
  }
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(STORAGE_PREFIX + userId);
      if (raw) {
        const parsed = filtersSchema.safeParse(JSON.parse(raw));
        if (parsed.success) return sanitizeFiltersForCapabilities(parsed.data, supported, supportedExtra);
      }
    }
  } catch {
    // Ignore malformed or restricted localStorage.
  }
  return sanitizeFiltersForCapabilities(defaultFilters(), supported, supportedExtra);
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
  if (filters.municipality?.trim()) params.set("mun", filters.municipality.trim());
  if (filters.categoriesInclude?.length) params.set("catIn", filters.categoriesInclude.join("|"));
  if (filters.categoriesExclude?.length) params.set("catEx", filters.categoriesExclude.join("|"));
  const outArrayMap: [keyof Filters, string][] = [
    ["regions", "regions"],
    ["regionsExclude", "repEx"],
    ["clients", "clients"],
    ["clientsExclude", "cliEx"],
    ["products", "products"],
    ["productsExclude", "prodEx"],
    ["regionals", "regionals"],
    ["regionalsExclude", "regEx"],
    ["states", "states"],
    ["statesExclude", "stEx"],
    ["managers", "managers"],
    ["managersExclude", "mgrEx"],
    ["municipalities", "muns"],
    ["municipalitiesExclude", "munEx"],
    ["channels", "ch"],
    ["channelsExclude", "chEx"],
    ["segments", "seg"],
    ["segmentsExclude", "segEx"],
    ["brands", "br"],
    ["brandsExclude", "brEx"],
  ];
  for (const [field, paramName] of outArrayMap) {
    const vals = filters[field] as string[] | undefined;
    if (vals?.length) params.set(paramName, vals.join("|"));
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
  supportedExtra?: readonly ExtraFilterCapability[],
): void {
  const clean = sanitizeFiltersForCapabilities(filters, supported, supportedExtra);
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

function formatChipValue(
  dim: ExtendedFilterDimension | "category",
  raw: string,
  optionLabels?: Partial<Record<FilterDimension | ExtendedFilterDimension, Record<string, string>>>,
): string {
  if (dim === "regional") {
    return optionLabels?.regional?.[raw] ?? formatOfficialRegionalName(raw);
  }
  if (dim === "macroCategory") {
    const lbl = optionLabels?.macroCategory?.[raw] ?? optionLabels?.category?.[raw];
    if (lbl) return lbl;
    return raw.toLocaleLowerCase("pt-BR").startsWith("macro categoria:")
      ? raw.slice("macro categoria:".length).trim()
      : raw;
  }
  if (dim === "itemGroup") {
    return optionLabels?.itemGroup?.[raw] ?? optionLabels?.category?.[raw] ?? raw;
  }
  return optionLabels?.[dim]?.[raw] ?? raw;
}

export function activeFilterChips(
  filters: Filters,
  capabilities: DataCapabilities,
  optionLabels?: Partial<Record<FilterDimension | ExtendedFilterDimension, Record<string, string>>>,
): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];
  for (const dim of capabilities.filters) {
    const label = capabilities.labels?.[dim] ?? DEFAULT_DIMENSION_LABELS[dim];
    const raw = filters[dim]?.trim();
    if (raw) {
      const display = formatChipValue(dim, raw, optionLabels);
      chips.push({
        id: `dim:${dim}`,
        label,
        value: display,
        mode: "include",
        dimension: dim,
        remove: (current) => ({ ...current, [dim]: "" }),
      });
    }
    const multiKey = MULTI_FIELD_BY_DIM[dim];
    if (multiKey) {
      for (const item of filters[multiKey] ?? []) {
        if (item === raw) continue;
        const display = formatChipValue(dim, item, optionLabels);
        chips.push({
          id: `multi:${multiKey}:${item}`,
          label,
          value: display,
          mode: "include",
          dimension: dim,
          remove: (current) => {
            const next = (current[multiKey] ?? []).filter((v) => v !== item);
            return { ...current, [multiKey]: next.length ? next : undefined };
          },
        });
      }
    }
    const excKey = EXCLUDE_FIELD_BY_DIM[dim];
    if (excKey) {
      for (const item of filters[excKey] ?? []) {
        const display = formatChipValue(dim, item, optionLabels);
        chips.push({
          id: `exc:${excKey}:${item}`,
          label: `Excluir ${label}`,
          value: display,
          mode: "exclude",
          dimension: dim,
          remove: (current) => {
            const next = (current[excKey] ?? []).filter((v) => v !== item);
            return { ...current, [excKey]: next.length ? next : undefined };
          },
        });
      }
    }
  }

  const extra = capabilities.extraFilters ?? [];
  if (extra.includes("municipality") || filters.municipality?.trim() || filters.municipalities?.length || filters.municipalitiesExclude?.length) {
    const raw = filters.municipality?.trim();
    if (raw) {
      chips.push({
        id: "dim:municipality",
        label: "Município",
        value: raw,
        mode: "include",
        dimension: "municipality",
        remove: (current) => ({ ...current, municipality: "" }),
      });
    }
    for (const item of filters.municipalities ?? []) {
      if (item === raw) continue;
      chips.push({
        id: `multi:municipalities:${item}`,
        label: "Município",
        value: item,
        mode: "include",
        dimension: "municipality",
        remove: (current) => {
          const next = (current.municipalities ?? []).filter((v) => v !== item);
          return { ...current, municipalities: next.length ? next : undefined };
        },
      });
    }
    for (const item of filters.municipalitiesExclude ?? []) {
      chips.push({
        id: `exc:municipalities:${item}`,
        label: "Excluir Município",
        value: item,
        mode: "exclude",
        dimension: "municipality",
        remove: (current) => {
          const next = (current.municipalitiesExclude ?? []).filter((v) => v !== item);
          return { ...current, municipalitiesExclude: next.length ? next : undefined };
        },
      });
    }
  }

  const pushExtraArray = (
    dim: "channel" | "segment" | "brand",
    label: string,
    incField: "channels" | "segments" | "brands",
    excField: "channelsExclude" | "segmentsExclude" | "brandsExclude",
  ) => {
    for (const item of filters[incField] ?? []) {
      chips.push({
        id: `multi:${incField}:${item}`,
        label,
        value: item,
        mode: "include",
        dimension: dim,
        remove: (current) => {
          const next = (current[incField] ?? []).filter((v) => v !== item);
          return { ...current, [incField]: next.length ? next : undefined };
        },
      });
    }
    for (const item of filters[excField] ?? []) {
      chips.push({
        id: `exc:${excField}:${item}`,
        label: `Excluir ${label}`,
        value: item,
        mode: "exclude",
        dimension: dim,
        remove: (current) => {
          const next = (current[excField] ?? []).filter((v) => v !== item);
          return { ...current, [excField]: next.length ? next : undefined };
        },
      });
    }
  };

  if (extra.includes("channel") || filters.channels?.length || filters.channelsExclude?.length) {
    pushExtraArray("channel", "Canal", "channels", "channelsExclude");
  }
  if (extra.includes("segment") || filters.segments?.length || filters.segmentsExclude?.length) {
    pushExtraArray("segment", "Segmento", "segments", "segmentsExclude");
  }
  if (extra.includes("brand") || filters.brands?.length || filters.brandsExclude?.length) {
    pushExtraArray("brand", "Marca", "brands", "brandsExclude");
  }

  for (const cat of filters.categoriesInclude ?? []) {
    const isMacro = cat.toLocaleLowerCase("pt-BR").startsWith("macro categoria:");
    const dimKey: ExtendedFilterDimension = isMacro ? "macroCategory" : "itemGroup";
    chips.push({
      id: `catIn:${cat}`,
      label: isMacro ? "Macrocategoria" : "Incluir",
      value: isMacro ? formatChipValue("macroCategory", cat, optionLabels) : formatChipValue("itemGroup", cat, optionLabels),
      mode: "include",
      dimension: dimKey,
      remove: (current) => {
        const next = (current.categoriesInclude ?? []).filter((item) => item !== cat);
        return { ...current, categoriesInclude: next.length ? next : undefined };
      },
    });
  }
  for (const cat of filters.categoriesExclude ?? []) {
    const isMacro = cat.toLocaleLowerCase("pt-BR").startsWith("macro categoria:");
    const dimKey: ExtendedFilterDimension = isMacro ? "macroCategory" : "itemGroup";
    chips.push({
      id: `catEx:${cat}`,
      label: isMacro ? "Excluir Macro" : "Excluir",
      value: isMacro ? formatChipValue("macroCategory", cat, optionLabels) : formatChipValue("itemGroup", cat, optionLabels),
      mode: "exclude",
      dimension: dimKey,
      remove: (current) => {
        const next = (current.categoriesExclude ?? []).filter((item) => item !== cat);
        return { ...current, categoriesExclude: next.length ? next : undefined };
      },
    });
  }
  if (filters.variationDirection && filters.variationDirection !== "all") {
    chips.push({
      id: "varDir",
      label: "Variação",
      value: filters.variationDirection === "growth" ? "Somente crescimento" : "Somente queda",
      mode: "include",
      dimension: "range",
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
      mode: "include",
      dimension: "range",
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
      mode: "include",
      dimension: "range",
      remove: (current) => ({ ...current, ticketMin: undefined, ticketMax: undefined }),
    });
  }
  return chips;
}

const PLURAL_LABELS: Partial<Record<ExtendedFilterDimension | "category" | "range", [string, string]>> = {
  regional: ["regional", "regionais"],
  manager: ["gerente", "gerentes"],
  region: ["representante", "representantes"],
  state: ["UF", "UFs"],
  municipality: ["município", "municípios"],
  client: ["cliente", "clientes"],
  product: ["produto", "produtos"],
  macroCategory: ["macrocategoria", "macrocategorias"],
  itemGroup: ["grupo", "grupos"],
  channel: ["canal", "canais"],
  brand: ["marca", "marcas"],
  segment: ["segmento", "segmentos"],
  category: ["categoria", "categorias"],
  range: ["faixa", "faixas"],
};

export function buildCompactFilterSummary(
  filters: Filters,
  capabilities: DataCapabilities,
  optionLabels?: Partial<Record<FilterDimension | ExtendedFilterDimension, Record<string, string>>>,
): { summaryText: string; totalCount: number; includeCount: number; excludeCount: number } {
  const chips = activeFilterChips(filters, capabilities, optionLabels);
  const counts = new Map<string, number>();
  let includeCount = 0;
  let excludeCount = 0;

  for (const chip of chips) {
    if (chip.mode === "exclude") {
      excludeCount++;
    } else {
      includeCount++;
      const key = chip.dimension ?? "category";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const parts: string[] = [];
  for (const [dim, n] of counts.entries()) {
    const pair = PLURAL_LABELS[dim as keyof typeof PLURAL_LABELS] ?? [dim, dim];
    parts.push(`${n} ${n === 1 ? pair[0] : pair[1]}`);
  }
  if (excludeCount > 0) {
    parts.push(`${excludeCount} ${excludeCount === 1 ? "exclusão" : "exclusões"}`);
  }

  return {
    summaryText: parts.join(" · "),
    totalCount: chips.length,
    includeCount,
    excludeCount,
  };
}

export function removeIncompatibleSelections(
  filters: Filters,
  incompatible: { dimension: ExtendedFilterDimension; values: string[] }[],
): Filters {
  let next: Filters = { ...filters };
  const normCsv = (v: string) => v.normalize("NFC").trim().toLocaleUpperCase("pt-BR");

  for (const item of incompatible) {
    if (!item.values.length) continue;
    const normSet = new Set(
      item.values.map((v) =>
        item.dimension === "regional"
          ? normalizeRegionalKey(v) ?? normCsv(v)
          : item.dimension === "macroCategory"
            ? normCsv(v.replace(/^macro categoria:\s*/iu, ""))
            : normCsv(v),
      ),
    );
    const keep = (raw: string, isRegional = false, isMacro = false) => {
      const k = isRegional
        ? normalizeRegionalKey(raw) ?? normCsv(raw)
        : isMacro
          ? normCsv(raw.replace(/^macro categoria:\s*/iu, ""))
          : normCsv(raw);
      return !normSet.has(k);
    };

    switch (item.dimension) {
      case "regional":
        if (next.regional && !keep(next.regional, true)) next.regional = "";
        if (next.regionals?.length) {
          const filtered = next.regionals.filter((v) => keep(v, true));
          next.regionals = filtered.length ? filtered : undefined;
        }
        break;
      case "manager":
        if (next.manager && !keep(next.manager)) next.manager = "";
        if (next.managers?.length) {
          const filtered = next.managers.filter((v) => keep(v));
          next.managers = filtered.length ? filtered : undefined;
        }
        break;
      case "region":
        if (next.region && !keep(next.region)) next.region = "";
        if (next.regions?.length) {
          const filtered = next.regions.filter((v) => keep(v));
          next.regions = filtered.length ? filtered : undefined;
        }
        break;
      case "state":
        if (next.state && !keep(next.state)) next.state = "";
        if (next.states?.length) {
          const filtered = next.states.filter((v) => keep(v));
          next.states = filtered.length ? filtered : undefined;
        }
        break;
      case "municipality":
        if (next.municipality && !keep(next.municipality)) next.municipality = "";
        if (next.municipalities?.length) {
          const filtered = next.municipalities.filter((v) => keep(v));
          next.municipalities = filtered.length ? filtered : undefined;
        }
        break;
      case "client":
        if (next.client && !keep(next.client)) next.client = "";
        if (next.clients?.length) {
          const filtered = next.clients.filter((v) => keep(v));
          next.clients = filtered.length ? filtered : undefined;
        }
        break;
      case "product":
        if (next.product && !keep(next.product)) next.product = "";
        if (next.products?.length) {
          const filtered = next.products.filter((v) => keep(v));
          next.products = filtered.length ? filtered : undefined;
        }
        break;
      case "channel":
        if (next.channels?.length) {
          const filtered = next.channels.filter((v) => keep(v));
          next.channels = filtered.length ? filtered : undefined;
        }
        break;
      case "segment":
        if (next.segments?.length) {
          const filtered = next.segments.filter((v) => keep(v));
          next.segments = filtered.length ? filtered : undefined;
        }
        break;
      case "brand":
        if (next.brands?.length) {
          const filtered = next.brands.filter((v) => keep(v));
          next.brands = filtered.length ? filtered : undefined;
        }
        break;
      case "macroCategory":
        if (next.categoriesInclude?.length) {
          const filtered = next.categoriesInclude.filter((v) => {
            const isM = v.toLocaleLowerCase("pt-BR").startsWith("macro categoria:");
            return !isM || keep(v, false, true);
          });
          next.categoriesInclude = filtered.length ? filtered : undefined;
        }
        break;
      case "itemGroup":
        if (next.category && !keep(next.category)) next.category = "";
        if (next.categoriesInclude?.length) {
          const filtered = next.categoriesInclude.filter((v) => {
            const isM = v.toLocaleLowerCase("pt-BR").startsWith("macro categoria:");
            return isM || keep(v);
          });
          next.categoriesInclude = filtered.length ? filtered : undefined;
        }
        break;
    }
  }
  return next;
}

export function hasAnyActiveFilter(filters: Filters, capabilities: DataCapabilities): boolean {
  return isNonDefaultPeriod(filters) || activeFilterChips(filters, capabilities).length > 0;
}
