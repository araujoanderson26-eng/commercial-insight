import {
  change,
  deltaTitle,
  detectFilterConflicts,
  formatOfficialRegionalName,
  groups,
  metricKeys,
  metrics,
  normalizeRegionalKey,
  pretty,
  type Commentary,
  type DataCapabilities,
  type ExtendedFilterDimension,
  type FilterDimension,
  type Filters,
  type Group,
  type Plan,
  type Report,
  type Row,
} from "../shared/domain";
import type { CustomerDetails } from "../shared/commercial";
import { normalizeCsvKey } from "../shared/csv";
import { fail, stmt, type DbUser, type Env } from "./core";
import { routeCommercialIntent } from "./intent-router";
import { resolvePlanEntities, type DataProvider } from "./providers";

const MONETARY_SCALE = 4;
const MONEY_DIV = 10 ** MONETARY_SCALE;

type BatchMetaRow = {
  id: string;
  status: string;
  source_label: string;
  reference_date: string | null;
  coverage_from: string | null;
  coverage_to: string | null;
  file_count: number;
  sales_rows: number;
  return_rows: number;
  customer_rows: number;
  product_rows: number;
  created: number;
  updated: number;
  activated_at: number | null;
  summary_json: string | null;
  validation_json: string | null;
  has_cal: number;
  has_macro: number;
  has_agg: number;
};

export const CSV_CAPABILITIES: DataCapabilities = {
  metrics: ["gross", "revenue", "returns", "buyers"],
  groups: ["month", "client", "region", "product", "category", "state", "regional", "manager"],
  filters: ["region", "client", "product", "category", "state", "regional", "manager"],
  extraFilters: ["municipality", "channel", "brand", "segment", "macroCategory", "itemGroup"],
  labels: {
    region: "Representante",
    regional: "Regional",
    state: "UF",
    manager: "Gerente Regional",
    municipality: "Município",
    channel: "Canal comercial",
    brand: "Marca",
    segment: "Segmento",
    macroCategory: "Macrocategoria",
    itemGroup: "Grupo do item",
    revenue: "Faturamento líquido",
  },
};

function csvSourceInfo(
  batch: BatchMetaRow,
  comp: NonNullable<Report["comparison"]>,
): NonNullable<Report["sourceInfo"]> {
  const ts = batch.activated_at ?? batch.updated ?? batch.created;
  const isoTs = Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : new Date().toISOString();
  return {
    versionId: batch.id,
    extractedAt: isoTs,
    publishedAt: isoTs,
    sourceUpdatedAt: null,
    referenceDate: batch.reference_date ?? comp.current.to,
    coverage: {
      from: batch.coverage_from ?? comp.current.from,
      to: batch.coverage_to ?? comp.current.to,
    },
    model: batch.source_label,
    capabilities: CSV_CAPABILITIES,
  };
}

type PeriodMode = "periods_join" | "disjoint_dual" | "single_range";

type ReportQueryOptions = {
  preloadedMeta?: Awaited<ReturnType<typeof loadBatchMeta>>;
  includeDocs?: boolean;
  includeActiveReps?: boolean;
  skipMonthlySeries?: boolean;
};

type TotPair = { gross: number; rows_n: number; buyers: number };

type CachedSummary = {
  curTotS?: TotPair;
  prevTotS?: TotPair;
  curRetScaled: number;
  prevRetScaled: number;
  docsCount?: number;
  activeRepsCount?: number;
};

const SUMMARY_CACHE_MAX = 64;
const summaryCache = new Map<string, CachedSummary>();

function cacheGetSummary(key: string): CachedSummary | undefined {
  const hit = summaryCache.get(key);
  if (!hit) return undefined;
  summaryCache.delete(key);
  summaryCache.set(key, hit);
  return hit;
}

function cacheSetSummary(key: string, entry: CachedSummary) {
  if (summaryCache.has(key)) summaryCache.delete(key);
  else if (summaryCache.size >= SUMMARY_CACHE_MAX) {
    const oldest = summaryCache.keys().next().value;
    if (oldest !== undefined) summaryCache.delete(oldest);
  }
  summaryCache.set(key, entry);
}

type WhereSpec = {
  joins: string;
  clause: string;
  args: (string | number | null)[];
  emptyIntersection: boolean;
};

function needsCustomerFilter(filters: Filters, acl: { allowedRegions: string[] }): boolean {
  return Boolean(
    acl.allowedRegions.length ||
      mergeNormalizedKeys(filters.region, filters.regions).length ||
      mergeNormalizedKeys(undefined, filters.regionsExclude).length ||
      mergeNormalizedKeys(undefined, filters.segments).length ||
      mergeNormalizedKeys(undefined, filters.segmentsExclude).length,
  );
}

function needsProductFilter(filters: Filters, hasDenormMacro: boolean): boolean {
  if (mergeNormalizedKeys(undefined, filters.brands).length || mergeNormalizedKeys(undefined, filters.brandsExclude).length) {
    return true;
  }
  if (hasDenormMacro) return false;
  const inc = splitCategories(filters.category, filters.categoriesInclude);
  const exc = splitCategories(undefined, filters.categoriesExclude);
  return inc.macros.length > 0 || exc.macros.length > 0;
}

function needsRegionDimFilter(filters: Filters): boolean {
  return Boolean(
    mergeRegionalKeys(filters.regional, filters.regionals).length ||
      mergeRegionalKeys(undefined, filters.regionalsExclude).length ||
      mergeNormalizedKeys(filters.manager, filters.managers).length ||
      mergeNormalizedKeys(undefined, filters.managersExclude).length,
  );
}

function buildSummaryCacheKey(
  batch: BatchMetaRow,
  hasCalendar: boolean,
  hasDenormMacro: boolean,
  acl: { allowedRegions: string[]; allowedClients: string[] },
  comp: NonNullable<Report["comparison"]>,
  f: Filters,
): string {
  const sortList = (single?: string, list?: string[]) => mergeNormalizedKeys(single, list).sort();
  const sortReg = (single?: string, list?: string[]) => mergeRegionalKeys(single, list).sort();
  const inc = splitCategories(f.category, f.categoriesInclude);
  const exc = splitCategories(undefined, f.categoriesExclude);
  return JSON.stringify([
    batch.id,
    batch.sales_rows,
    batch.return_rows,
    batch.customer_rows,
    batch.product_rows,
    batch.reference_date ?? "",
    hasCalendar ? 1 : 0,
    hasDenormMacro ? 1 : 0,
    [...acl.allowedRegions].sort(),
    [...acl.allowedClients].sort(),
    comp.current.from,
    comp.current.to,
    comp.previous.from,
    comp.previous.to,
    sortList(f.region, f.regions),
    sortList(undefined, f.regionsExclude),
    sortList(f.client, f.clients),
    sortList(undefined, f.clientsExclude),
    sortList(f.product, f.products),
    sortList(undefined, f.productsExclude),
    sortList(f.state, f.states),
    sortList(undefined, f.statesExclude),
    sortReg(f.regional, f.regionals),
    sortReg(undefined, f.regionalsExclude),
    sortList(f.manager, f.managers),
    sortList(undefined, f.managersExclude),
    sortList(f.municipality, f.municipalities),
    sortList(undefined, f.municipalitiesExclude),
    sortList(undefined, f.segments),
    sortList(undefined, f.segmentsExclude),
    sortList(undefined, f.brands),
    sortList(undefined, f.brandsExclude),
    sortList(undefined, f.channels),
    sortList(undefined, f.channelsExclude),
    [...inc.macros].sort(),
    [...inc.groups].sort(),
    [...exc.macros].sort(),
    [...exc.groups].sort(),
  ]);
}

function scopeForUser(u: DbUser, filters?: Filters): {
  allowedRegions: string[];
  allowedClients: string[];
} {
  if (u.role === "operador" || u.update_only) {
    fail(403, "O operador de atualização não tem acesso às análises comerciais.");
  }
  const regions = (JSON.parse(u.regions) as string[]).map((v) => normalizeCsvKey(v)).filter((v): v is string => !!v);
  const clients = (JSON.parse(u.clients) as string[]).map((v) => normalizeCsvKey(v)).filter((v): v is string => !!v);
  const national = u.role === "admin" || (u.role === "diretoria" && !!u.national);
  if (!national && ((u.role === "gerente" && !regions.length) || (!regions.length && !clients.length))) {
    fail(403, "Nenhuma carteira ou regional autorizada.");
  }
  if (!national && filters) {
    const reqRegions = mergeNormalizedKeys(filters.region, filters.regions);
    const reqClients = mergeNormalizedKeys(filters.client, filters.clients);
    if (regions.length && reqRegions.some((r) => !regions.includes(r))) {
      fail(403, "Seleção fora do seu escopo.");
    }
    if (clients.length && reqClients.some((c) => !clients.includes(c))) {
      fail(403, "Seleção fora do seu escopo.");
    }
  }
  return {
    allowedRegions: national ? [] : regions,
    allowedClients: national ? [] : clients,
  };
}

function mergeNormalizedKeys(single?: string, list?: string[]): string[] {
  const out = new Set<string>();
  const add = (val?: string) => {
    const k = normalizeCsvKey(val);
    if (k) out.add(k);
  };
  add(single);
  for (const item of list ?? []) add(item);
  return [...out];
}

const PT_LOWER_UPPER_PAIRS: [string, string][] = [
  ["á", "Á"],
  ["à", "À"],
  ["â", "Â"],
  ["ã", "Ã"],
  ["ä", "Ä"],
  ["é", "É"],
  ["è", "È"],
  ["ê", "Ê"],
  ["í", "Í"],
  ["ó", "Ó"],
  ["ò", "Ò"],
  ["ô", "Ô"],
  ["õ", "Õ"],
  ["ö", "Ö"],
  ["ú", "Ú"],
  ["ù", "Ù"],
  ["ü", "Ü"],
  ["ç", "Ç"],
  ["ñ", "Ñ"],
];

const PT_ASCII_PAIRS: [string, string][] = [
  ["Á", "A"],
  ["À", "A"],
  ["Â", "A"],
  ["Ã", "A"],
  ["Ä", "A"],
  ["É", "E"],
  ["È", "E"],
  ["Ê", "E"],
  ["Í", "I"],
  ["Ó", "O"],
  ["Ò", "O"],
  ["Ô", "O"],
  ["Õ", "O"],
  ["Ö", "O"],
  ["Ú", "U"],
  ["Ù", "U"],
  ["Ü", "U"],
  ["Ç", "C"],
  ["Ñ", "N"],
];

function sqlUpperPt(expr: string): string {
  let out = `UPPER(TRIM(${expr}))`;
  for (const [low, up] of PT_LOWER_UPPER_PAIRS) {
    out = `REPLACE(${out},'${low}','${up}')`;
  }
  return out;
}

function sqlFoldAscii(expr: string): string {
  let out = sqlUpperPt(expr);
  for (const [acc, asc] of PT_ASCII_PAIRS) {
    out = `REPLACE(${out},'${acc}','${asc}')`;
  }
  return out;
}

function mergeRegionalKeys(single?: string, list?: string[]): string[] {
  const out = new Set<string>();
  const add = (val?: string) => {
    const k = normalizeRegionalKey(val);
    if (k) out.add(k);
  };
  add(single);
  for (const item of list ?? []) add(item);
  return [...out];
}

function allExcluded(inc: string[], exc: string[]): boolean {
  return inc.length > 0 && inc.every((v) => exc.includes(v));
}

function splitCategories(single?: string, list?: string[]): { macros: string[]; groups: string[] } {
  const macros = new Set<string>();
  const grps = new Set<string>();
  const all = [...(single ? [single] : []), ...(list ?? [])];
  for (const raw of all) {
    const trimmed = raw.normalize("NFC").trim();
    if (!trimmed) continue;
    if (trimmed.toLocaleLowerCase("pt-BR").startsWith("macro categoria:")) {
      const k = normalizeCsvKey(trimmed.slice("macro categoria:".length));
      if (k) macros.add(k);
    } else {
      const k = normalizeCsvKey(trimmed);
      if (k) grps.add(k);
    }
  }
  return { macros: [...macros], groups: [...grps] };
}

export function csvComparisonPeriod(
  filters: Pick<Filters, "from" | "to">,
  coverageFrom: string | null,
  coverageTo: string | null,
  referenceDate: string | null,
): NonNullable<Report["comparison"]> {
  const fromDay = `${filters.from}-01`;
  const requestedTo = new Date(Date.UTC(Number(filters.to.slice(0, 4)), Number(filters.to.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10);
  const bounds = [referenceDate, coverageTo].filter((v): v is string => !!v).sort();
  const limit = bounds[0] ?? requestedTo;
  const toDay = requestedTo > limit ? limit : requestedTo;

  const shiftYear = (day: string) => {
    const y = Number(day.slice(0, 4)) - 1;
    const m = Number(day.slice(5, 7));
    const d = Number(day.slice(8, 10));
    return new Date(Date.UTC(y, m - 1, Math.min(d, new Date(Date.UTC(y, m, 0)).getUTCDate())))
      .toISOString()
      .slice(0, 10);
  };

  const current = { from: fromDay, to: toDay };
  const previous = { from: shiftYear(current.from), to: shiftYear(current.to) };
  const outside =
    current.from > current.to ||
    (coverageFrom !== null && (current.from < coverageFrom || previous.from < coverageFrom));

  return {
    current,
    previous,
    status: outside ? "outside-coverage" : toDay !== requestedTo ? "partial" : "comparable",
    ...(outside
      ? { reason: "A cobertura da versão não contém integralmente um dos períodos. Valores fora da cobertura ficam indisponíveis." }
      : toDay !== requestedTo
        ? { reason: "Período incompleto: comparação encerrada no mesmo dia do ano anterior, conforme a última data coberta pela versão." }
        : {}),
  };
}

function inlineInExpr(
  col: string,
  values: string[],
  budget: { rem: number },
  args: (string | number | null)[],
  negate = false,
): string {
  if (values.length === 1) {
    args.push(values[0]);
    budget.rem--;
    return negate ? `(${col} IS NULL OR ${col} <> ?)` : `${col} = ?`;
  }
  if (values.length <= 20 && budget.rem >= values.length) {
    const ph = values.map(() => "?").join(",");
    args.push(...values);
    budget.rem -= values.length;
    return negate ? `(${col} IS NULL OR ${col} NOT IN (${ph}))` : `${col} IN (${ph})`;
  }
  args.push(JSON.stringify(values));
  budget.rem--;
  return negate
    ? `(${col} IS NULL OR ${col} NOT IN (SELECT value FROM json_each(?)))`
    : `${col} IN (SELECT value FROM json_each(?))`;
}

type RegionStateRow = {
  stateKey: string;
  regionalKey: string | null;
  managerKey: string | null;
};

type ResolvedGeo = {
  incStates: string[];
  excStates: string[];
  emptyIntersection: boolean;
};

function expandMonthRange(fromDate: string, toDate: string): string[] {
  const start = fromDate.slice(0, 7);
  const end = toDate.slice(0, 7);
  if (!start || !end || start > end) return [];
  const out: string[] = [];
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  const endY = Number(end.slice(0, 4));
  const endM = Number(end.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (out.length > 48) break;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

async function loadRegionStates(e: Env, batchId: string): Promise<RegionStateRow[]> {
  return (
    await stmt(
      e,
      "SELECT state_key AS stateKey, regional_key AS regionalKey, manager_key AS managerKey FROM ci_dim_regions WHERE batch_id = ?",
      batchId,
    ).all<RegionStateRow>()
  ).results;
}

function resolveGeoStateKeys(filters: Filters, regions: RegionStateRow[]): ResolvedGeo {
  const reqStates = mergeNormalizedKeys(filters.state, filters.states);
  const reqStatesExc = mergeNormalizedKeys(undefined, filters.statesExclude);
  const reqRegionals = mergeRegionalKeys(filters.regional, filters.regionals);
  const reqRegionalsExc = mergeRegionalKeys(undefined, filters.regionalsExclude);
  const reqManagers = mergeNormalizedKeys(filters.manager, filters.managers);
  const reqManagersExc = mergeNormalizedKeys(undefined, filters.managersExclude);

  const hasConflict =
    allExcluded(reqStates, reqStatesExc) ||
    allExcluded(reqRegionals, reqRegionalsExc) ||
    allExcluded(reqManagers, reqManagersExc);

  const positiveSets: string[][] = [];
  if (reqStates.length) positiveSets.push(reqStates);
  if (reqRegionals.length) {
    positiveSets.push(
      regions.filter((r) => r.regionalKey && reqRegionals.includes(r.regionalKey)).map((r) => r.stateKey),
    );
  }
  if (reqManagers.length) {
    positiveSets.push(
      regions.filter((r) => r.managerKey && reqManagers.includes(r.managerKey)).map((r) => r.stateKey),
    );
  }

  const excSet = new Set(reqStatesExc);
  if (reqRegionalsExc.length) {
    for (const r of regions) {
      if (r.regionalKey && reqRegionalsExc.includes(r.regionalKey)) excSet.add(r.stateKey);
    }
  }
  if (reqManagersExc.length) {
    for (const r of regions) {
      if (r.managerKey && reqManagersExc.includes(r.managerKey)) excSet.add(r.stateKey);
    }
  }

  if (hasConflict) {
    return { incStates: [], excStates: [...excSet], emptyIntersection: true };
  }
  if (!positiveSets.length) {
    return { incStates: [], excStates: [...excSet], emptyIntersection: false };
  }

  let current = [...new Set(positiveSets[0])];
  for (const setArr of positiveSets.slice(1)) {
    const allowed = new Set(setArr);
    current = current.filter((st) => allowed.has(st));
  }
  current = current.filter((st) => !excSet.has(st));

  return {
    incStates: current,
    excStates: [...excSet],
    emptyIntersection: current.length === 0,
  };
}

function buildFactWhere(
  alias: "s" | "r",
  batchId: string,
  filters: Filters,
  acl: { allowedRegions: string[]; allowedClients: string[] },
  needsCalendarSubquery: boolean,
  hasDenormMacro: boolean,
  group?: Group,
  periodMode: PeriodMode = "periods_join",
  dateFrom?: string,
  dateTo?: string,
  disjointCurFrom?: string,
  disjointPrevTo?: string,
  omitClientDimJoin = false,
  omitProductDimJoin = false,
  resolvedGeo?: ResolvedGeo,
): WhereSpec {
  const reqRegions = mergeNormalizedKeys(filters.region, filters.regions);
  const reqRegionsExc = mergeNormalizedKeys(undefined, filters.regionsExclude);
  const reqClients = mergeNormalizedKeys(filters.client, filters.clients);
  const reqClientsExc = mergeNormalizedKeys(undefined, filters.clientsExclude);
  const reqProducts = mergeNormalizedKeys(filters.product, filters.products);
  const reqProductsExc = mergeNormalizedKeys(undefined, filters.productsExclude);
  const reqStates = mergeNormalizedKeys(filters.state, filters.states);
  const reqStatesExc = mergeNormalizedKeys(undefined, filters.statesExclude);
  const reqRegionals = mergeRegionalKeys(filters.regional, filters.regionals);
  const reqRegionalsExc = mergeRegionalKeys(undefined, filters.regionalsExclude);
  const reqManagers = mergeNormalizedKeys(filters.manager, filters.managers);
  const reqManagersExc = mergeNormalizedKeys(undefined, filters.managersExclude);
  const reqMunis = mergeNormalizedKeys(filters.municipality, filters.municipalities);
  const reqMunisExc = mergeNormalizedKeys(undefined, filters.municipalitiesExclude);
  const reqSegments = mergeNormalizedKeys(undefined, filters.segments);
  const reqSegmentsExc = mergeNormalizedKeys(undefined, filters.segmentsExclude);
  const reqBrands = mergeNormalizedKeys(undefined, filters.brands);
  const reqBrandsExc = mergeNormalizedKeys(undefined, filters.brandsExclude);
  const reqChannels = mergeNormalizedKeys(undefined, filters.channels);
  const reqChannelsExc = mergeNormalizedKeys(undefined, filters.channelsExclude);
  const inc = splitCategories(filters.category, filters.categoriesInclude);
  const exc = splitCategories(undefined, filters.categoriesExclude);

  const seekStates = resolvedGeo ? resolvedGeo.incStates : reqStates;
  const canSeekMonthState =
    alias === "s" &&
    seekStates.length >= 1 &&
    seekStates.length <= 12 &&
    !reqClients.length &&
    !reqProducts.length &&
    !acl.allowedClients.length &&
    (periodMode === "single_range" || periodMode === "disjoint_dual");
  const monthKeys = canSeekMonthState
    ? periodMode === "disjoint_dual"
      ? [...new Set([...expandMonthRange(dateFrom!, disjointPrevTo!), ...expandMonthRange(disjointCurFrom!, dateTo!)])]
      : expandMonthRange(dateFrom!, dateTo!)
    : [];
  const useMonthStateSeek = canSeekMonthState && monthKeys.length >= 1 && monthKeys.length <= 36;

  const clauses: string[] = useMonthStateSeek
    ? [
        "s.batch_id = ?",
        monthKeys.length === 1 ? "s.month_key = ?" : `s.month_key IN (${monthKeys.map(() => "?").join(",")})`,
        seekStates.length === 1 ? "s.state_key = ?" : `s.state_key IN (${seekStates.map(() => "?").join(",")})`,
        "+s.date >= ?",
        "+s.date <= ?",
        ...(periodMode === "disjoint_dual" ? ["(+s.date >= ? OR +s.date <= ?)"] : []),
      ]
    : periodMode === "periods_join"
      ? [`${alias}.batch_id = ?`, `${alias}.date >= pd.pf`, `${alias}.date <= pd.pt`]
      : periodMode === "disjoint_dual"
        ? [`${alias}.batch_id = ?`, `${alias}.date >= ?`, `${alias}.date <= ?`, `(${alias}.date >= ? OR ${alias}.date <= ?)`]
        : [`${alias}.batch_id = ?`, `${alias}.date >= ?`, `${alias}.date <= ?`];
  const args: (string | number | null)[] = useMonthStateSeek
    ? [
        batchId,
        ...monthKeys,
        ...seekStates,
        ...(periodMode === "disjoint_dual" ? [dateFrom!, dateTo!, disjointCurFrom!, disjointPrevTo!] : [dateFrom!, dateTo!]),
      ]
    : periodMode === "periods_join"
      ? [batchId]
      : periodMode === "disjoint_dual"
        ? [batchId, dateFrom!, dateTo!, disjointCurFrom!, disjointPrevTo!]
        : [batchId, dateFrom!, dateTo!];

  if (needsCalendarSubquery) {
    clauses.push(
      `EXISTS(SELECT 1 FROM ci_dim_calendar cal WHERE cal.batch_id = ${alias}.batch_id AND cal.date = ${alias}.date)`,
    );
  }

  const emptyIntersection =
    Boolean(resolvedGeo?.emptyIntersection) ||
    allExcluded(inc.macros, exc.macros) ||
    allExcluded(inc.groups, exc.groups) ||
    allExcluded(reqRegions, reqRegionsExc) ||
    allExcluded(reqClients, reqClientsExc) ||
    allExcluded(reqProducts, reqProductsExc) ||
    allExcluded(reqStates, reqStatesExc) ||
    allExcluded(reqRegionals, reqRegionalsExc) ||
    allExcluded(reqManagers, reqManagersExc) ||
    allExcluded(reqMunis, reqMunisExc) ||
    allExcluded(reqSegments, reqSegmentsExc) ||
    allExcluded(reqBrands, reqBrandsExc) ||
    allExcluded(reqChannels, reqChannelsExc);

  const needCustomers = Boolean(
    needsCustomerFilter(filters, acl) ||
      (!omitClientDimJoin && (group === "client" || group === "region")),
  );
  const needProducts = Boolean(
    needsProductFilter(filters, hasDenormMacro) ||
      (!omitProductDimJoin && (group === "product" || group === "category")),
  );
  const needRegions = Boolean(
    (!resolvedGeo && needsRegionDimFilter(filters)) || group === "regional" || group === "manager",
  );

  const joins = [
    needCustomers ? `LEFT JOIN ci_dim_customers c ON c.batch_id = ${alias}.batch_id AND c.client_key = ${alias}.client_key` : "",
    needProducts ? `LEFT JOIN ci_dim_products p ON p.batch_id = ${alias}.batch_id AND p.product_key = ${alias}.product_key` : "",
    needRegions ? `LEFT JOIN ci_dim_regions rg ON rg.batch_id = ${alias}.batch_id AND rg.state_key = ${alias}.state_key` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const budget = { rem: 60 };
  if (acl.allowedRegions.length) {
    clauses.push(inlineInExpr("c.representative_key", acl.allowedRegions, budget, args));
  }
  if (acl.allowedClients.length) {
    clauses.push(inlineInExpr(`${alias}.client_key`, acl.allowedClients, budget, args));
  }
  if (reqRegions.length) {
    clauses.push(inlineInExpr("c.representative_key", reqRegions, budget, args));
  }
  if (reqRegionsExc.length) {
    clauses.push(inlineInExpr("c.representative_key", reqRegionsExc, budget, args, true));
  }
  if (reqClients.length) {
    clauses.push(inlineInExpr(`${alias}.client_key`, reqClients, budget, args));
  }
  if (reqClientsExc.length) {
    clauses.push(inlineInExpr(`${alias}.client_key`, reqClientsExc, budget, args, true));
  }
  if (reqProducts.length) {
    clauses.push(inlineInExpr(`${alias}.product_key`, reqProducts, budget, args));
  }
  if (reqProductsExc.length) {
    clauses.push(inlineInExpr(`${alias}.product_key`, reqProductsExc, budget, args, true));
  }
  if (resolvedGeo) {
    if (resolvedGeo.incStates.length && !useMonthStateSeek) {
      clauses.push(inlineInExpr(`${alias}.state_key`, resolvedGeo.incStates, budget, args));
    }
    if (!resolvedGeo.incStates.length && resolvedGeo.excStates.length) {
      clauses.push(inlineInExpr(`${alias}.state_key`, resolvedGeo.excStates, budget, args, true));
    }
  } else {
    if (reqStates.length && !useMonthStateSeek) {
      clauses.push(inlineInExpr(`${alias}.state_key`, reqStates, budget, args));
    }
    if (reqStatesExc.length) {
      clauses.push(inlineInExpr(`${alias}.state_key`, reqStatesExc, budget, args, true));
    }
    if (reqRegionals.length) {
      clauses.push(inlineInExpr("rg.regional_key", reqRegionals, budget, args));
    }
    if (reqRegionalsExc.length) {
      clauses.push(inlineInExpr("rg.regional_key", reqRegionalsExc, budget, args, true));
    }
    if (reqManagers.length) {
      clauses.push(inlineInExpr("rg.manager_key", reqManagers, budget, args));
    }
    if (reqManagersExc.length) {
      clauses.push(inlineInExpr("rg.manager_key", reqManagersExc, budget, args, true));
    }
  }
  if (reqMunis.length) {
    if (alias === "s") {
      clauses.push(inlineInExpr(sqlUpperPt("s.municipality"), reqMunis, budget, args));
    } else {
      const mDate =
        periodMode === "periods_join"
          ? "fs.date BETWEEN pd.pf AND pd.pt"
          : periodMode === "disjoint_dual"
            ? "fs.date BETWEEN ? AND ? AND (fs.date >= ? OR fs.date <= ?)"
            : "fs.date BETWEEN ? AND ?";
      if (periodMode === "disjoint_dual") args.push(dateFrom!, dateTo!, disjointCurFrom!, disjointPrevTo!);
      else if (periodMode === "single_range") args.push(dateFrom!, dateTo!);
      const mCond = inlineInExpr(sqlUpperPt("fs.municipality"), reqMunis, budget, args);
      clauses.push(
        `EXISTS(SELECT 1 FROM ci_fact_sales fs WHERE fs.batch_id = r.batch_id AND ${mDate} AND fs.client_key = r.client_key AND ${mCond})`,
      );
    }
  }
  if (reqMunisExc.length) {
    if (alias === "s") {
      clauses.push(inlineInExpr(sqlUpperPt("s.municipality"), reqMunisExc, budget, args, true));
    } else {
      const mDate =
        periodMode === "periods_join"
          ? "fs.date BETWEEN pd.pf AND pd.pt"
          : periodMode === "disjoint_dual"
            ? "fs.date BETWEEN ? AND ? AND (fs.date >= ? OR fs.date <= ?)"
            : "fs.date BETWEEN ? AND ?";
      if (periodMode === "disjoint_dual") args.push(dateFrom!, dateTo!, disjointCurFrom!, disjointPrevTo!);
      else if (periodMode === "single_range") args.push(dateFrom!, dateTo!);
      const mCond = inlineInExpr(sqlUpperPt("fs.municipality"), reqMunisExc, budget, args);
      clauses.push(
        `NOT EXISTS(SELECT 1 FROM ci_fact_sales fs WHERE fs.batch_id = r.batch_id AND ${mDate} AND fs.client_key = r.client_key AND ${mCond})`,
      );
    }
  }
  if (reqSegments.length) {
    clauses.push(inlineInExpr(sqlUpperPt("c.segment"), reqSegments, budget, args));
  }
  if (reqSegmentsExc.length) {
    clauses.push(inlineInExpr(sqlUpperPt("c.segment"), reqSegmentsExc, budget, args, true));
  }
  if (reqBrands.length) {
    clauses.push(inlineInExpr(sqlUpperPt("p.brand"), reqBrands, budget, args));
  }
  if (reqBrandsExc.length) {
    clauses.push(inlineInExpr(sqlUpperPt("p.brand"), reqBrandsExc, budget, args, true));
  }
  if (reqChannels.length) {
    if (alias === "s") {
      clauses.push(inlineInExpr(sqlUpperPt("s.channel"), reqChannels, budget, args));
    } else {
      const chDate =
        periodMode === "periods_join"
          ? "fs.date BETWEEN pd.pf AND pd.pt"
          : periodMode === "disjoint_dual"
            ? "fs.date BETWEEN ? AND ? AND (fs.date >= ? OR fs.date <= ?)"
            : "fs.date BETWEEN ? AND ?";
      if (periodMode === "disjoint_dual") args.push(dateFrom!, dateTo!, disjointCurFrom!, disjointPrevTo!);
      else if (periodMode === "single_range") args.push(dateFrom!, dateTo!);
      const chCond = inlineInExpr(sqlUpperPt("fs.channel"), reqChannels, budget, args);
      clauses.push(
        `EXISTS(SELECT 1 FROM ci_fact_sales fs WHERE fs.batch_id = r.batch_id AND ${chDate} AND fs.client_key = r.client_key AND ${chCond})`,
      );
    }
  }
  if (reqChannelsExc.length) {
    if (alias === "s") {
      clauses.push(inlineInExpr(sqlUpperPt("s.channel"), reqChannelsExc, budget, args, true));
    } else {
      const chDate =
        periodMode === "periods_join"
          ? "fs.date BETWEEN pd.pf AND pd.pt"
          : periodMode === "disjoint_dual"
            ? "fs.date BETWEEN ? AND ? AND (fs.date >= ? OR fs.date <= ?)"
            : "fs.date BETWEEN ? AND ?";
      if (periodMode === "disjoint_dual") args.push(dateFrom!, dateTo!, disjointCurFrom!, disjointPrevTo!);
      else if (periodMode === "single_range") args.push(dateFrom!, dateTo!);
      const chCond = inlineInExpr(sqlUpperPt("fs.channel"), reqChannelsExc, budget, args);
      clauses.push(
        `NOT EXISTS(SELECT 1 FROM ci_fact_sales fs WHERE fs.batch_id = r.batch_id AND ${chDate} AND fs.client_key = r.client_key AND ${chCond})`,
      );
    }
  }

  // Strictly independent commercial categories + Power BI slicer intersection between Macro Categoria and Grupo Item.
  const macroExpr = hasDenormMacro ? `${alias}.macro_key` : `COALESCE(p.macro_category_key, ${alias}.macro_key)`;

  if (inc.macros.length) {
    clauses.push(inlineInExpr(macroExpr, inc.macros, budget, args));
  }
  if (inc.groups.length) {
    clauses.push(inlineInExpr(`${alias}.group_key`, inc.groups, budget, args));
  }

  if (exc.macros.length) {
    clauses.push(inlineInExpr(macroExpr, exc.macros, budget, args, true));
  }
  if (exc.groups.length) {
    clauses.push(inlineInExpr(`${alias}.group_key`, exc.groups, budget, args, true));
  }

  return { joins, clause: clauses.join(" AND "), args, emptyIntersection };
}

function groupExpressions(alias: "s" | "r", group: Exclude<Group, "month">): { keyExpr: string; labelExpr: string } {
  switch (group) {
    case "client":
      return {
        keyExpr: `${alias}.client_key`,
        labelExpr: `COALESCE(MAX(CASE WHEN c.name IS NOT NULL AND c.name <> '' THEN COALESCE(c.client_raw, ${alias}.client_key) || ' — ' || c.name END), MAX(${alias}.client_raw), ${alias}.client_key)`,
      };
    case "product":
      return {
        keyExpr: `${alias}.product_key`,
        labelExpr: `COALESCE(MAX(CASE WHEN p.description IS NOT NULL AND p.description <> '' THEN COALESCE(p.product_raw, ${alias}.product_key) || ' — ' || p.description END), MAX(${alias}.product_raw), ${alias}.product_key)`,
      };
    case "category":
      return {
        keyExpr: `COALESCE(p.macro_category_key, ${alias}.macro_key, ${alias}.group_key)`,
        labelExpr: `COALESCE(MAX(p.macro_category_raw), MAX(p.macro_category_key), MAX(${alias}.macro_key), MAX(${alias}.group_raw), ${alias}.group_key)`,
      };
    case "region":
      return {
        keyExpr: "c.representative_key",
        labelExpr: "COALESCE(MAX(c.representative_raw), c.representative_key)",
      };
    case "regional":
      return {
        keyExpr: "rg.regional_key",
        labelExpr: "COALESCE(MAX(rg.regional_raw), rg.regional_key)",
      };
    case "state":
      return {
        keyExpr: `${alias}.state_key`,
        labelExpr: `${alias}.state_key`,
      };
    case "manager":
      return {
        keyExpr: "rg.manager_key",
        labelExpr: "COALESCE(MAX(rg.manager_raw), rg.manager_key)",
      };
  }
}

async function loadBatchMeta(
  e: Env,
  batchId: string,
): Promise<{ batch: BatchMetaRow; hasCalendar: boolean; hasDenormMacro: boolean; hasAggCube: boolean }> {
  const batch = await stmt(
    e,
    `SELECT id,status,source_label,reference_date,coverage_from,coverage_to,file_count,
       sales_rows,return_rows,customer_rows,product_rows,created,updated,activated_at,summary_json,validation_json,
       EXISTS(SELECT 1 FROM ci_dim_calendar WHERE batch_id=? LIMIT 1) AS has_cal,
       EXISTS(SELECT 1 FROM ci_fact_sales WHERE batch_id=? AND macro_key IS NOT NULL LIMIT 1) AS has_macro,
       EXISTS(SELECT 1 FROM ci_agg_monthly WHERE batch_id=? LIMIT 1) AS has_agg
     FROM ci_csv_batches WHERE id=?`,
    batchId,
    batchId,
    batchId,
    batchId,
  ).first<BatchMetaRow>();
  if (!batch) fail(404, "Lote CSV não encontrado.");
  let calVerified = false;
  if (batch.validation_json) {
    try {
      const val = JSON.parse(batch.validation_json) as { checks?: { name: string; status: string }[] };
      calVerified = val.checks?.some((c) => c.name === "cobertura_calendario" && c.status === "passed") ?? false;
    } catch {
      calVerified = false;
    }
  }
  return {
    batch,
    hasCalendar: !calVerified && !!batch.has_cal,
    hasDenormMacro: !!batch.has_macro,
    hasAggCube: !!batch.has_agg,
  };
}

export async function searchCsvCategory(
  e: Env,
  batchId: string,
  query: string,
): Promise<{ items: { key: string; name: string }[]; truncated: boolean }> {
  const rows = (
    await stmt(
      e,
      "SELECT dimension, value_key, display FROM ci_dim_catalog WHERE batch_id=? AND dimension IN ('macro_category','group') ORDER BY dimension, value_key",
      batchId,
    ).all<{ dimension: string; value_key: string; display: string }>()
  ).results;

  const q = query.normalize("NFC").trim().toLocaleLowerCase("pt-BR");
  const all = rows.map((r) =>
    r.dimension === "macro_category"
      ? { key: `Macro Categoria: ${r.value_key}`, name: `Macro Categoria: ${r.display || r.value_key}` }
      : { key: r.value_key, name: r.display || r.value_key },
  );
  const filtered = all.filter(
    (item) =>
      item.key.normalize("NFC").toLocaleLowerCase("pt-BR").includes(q) ||
      item.name.normalize("NFC").toLocaleLowerCase("pt-BR").includes(q),
  );
  return { items: filtered.slice(0, 60), truncated: filtered.length > 60 };
}

export async function searchCsvDimension(
  e: Env,
  u: DbUser,
  batchId: string,
  filters: Filters,
  dimension: "client" | "product" | "category" | "municipality",
  query: string,
): Promise<{ items: { key: string; name: string; hasSalesInPeriod?: boolean }[]; truncated: boolean }> {
  if (!["client", "product", "category", "municipality"].includes(dimension) || !query.trim() || query.length > 100) {
    fail(422, "Informe de 1 a 100 caracteres para a pesquisa.");
  }
  const cleanedFilters: Filters =
    dimension === "client"
      ? { ...filters, client: "", clients: undefined, clientsExclude: undefined }
      : dimension === "product"
        ? { ...filters, product: "", products: undefined, productsExclude: undefined }
        : dimension === "municipality"
          ? { ...filters, municipality: "", municipalities: undefined, municipalitiesExclude: undefined }
          : filters;
  const acl = scopeForUser(u, cleanedFilters);
  if (dimension === "category") return searchCsvCategory(e, batchId, query);
  const { batch, hasCalendar, hasDenormMacro } = await loadBatchMeta(e, batchId);
  const comp = csvComparisonPeriod(cleanedFilters, batch.coverage_from, batch.coverage_to, batch.reference_date);
  const curFrom = comp.current.from;
  const curTo = comp.current.to;
  const pattern = "%" + query.trim().replace(/[\\%_]/g, "\\$&") + "%";
  const upperPattern = "%" + query.trim().normalize("NFC").toLocaleUpperCase("pt-BR").replace(/[\\%_]/g, "\\$&") + "%";
  const foldedUpperPattern =
    "%" +
    query
      .trim()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toUpperCase()
      .replace(/[\\%_]/g, "\\$&") +
    "%";
  const budget = { rem: 60 };

  if (dimension === "municipality") {
    if (curFrom > curTo) return { items: [], truncated: false };
    const w = buildFactWhere("s", batchId, cleanedFilters, acl, hasCalendar, hasDenormMacro, undefined, "single_range", curFrom, curTo);
    if (w.emptyIntersection) return { items: [], truncated: false };
    const muniKeyExpr = sqlUpperPt("s.municipality");
    const muniFoldExpr = sqlFoldAscii("s.municipality");
    const rows = (
      await stmt(
        e,
        `SELECT ${muniKeyExpr} AS k, MIN(TRIM(s.municipality)) AS name
         FROM ci_fact_sales s ${w.joins}
         WHERE ${w.clause} AND s.municipality IS NOT NULL AND TRIM(s.municipality) <> ''
           AND (${muniKeyExpr} LIKE ? ESCAPE '\\' OR ${muniFoldExpr} LIKE ? ESCAPE '\\' OR s.municipality LIKE ? ESCAPE '\\')
         GROUP BY ${muniKeyExpr}
         ORDER BY name LIMIT 21`,
        ...w.args,
        upperPattern,
        foldedUpperPattern,
        pattern,
      ).all<{ k: string; name: string }>()
    ).results;
    return {
      items: rows.slice(0, 20).map((r) => ({ key: r.name, name: r.name, hasSalesInPeriod: true })),
      truncated: rows.length > 20,
    };
  }

  if (dimension === "client") {
    const reqReps = mergeNormalizedKeys(cleanedFilters.region, cleanedFilters.regions);
    const reqRepsExc = mergeNormalizedKeys(undefined, cleanedFilters.regionsExclude);
    const reqStates = mergeNormalizedKeys(cleanedFilters.state, cleanedFilters.states);
    const reqStatesExc = mergeNormalizedKeys(undefined, cleanedFilters.statesExclude);
    const reqRegionals = mergeRegionalKeys(cleanedFilters.regional, cleanedFilters.regionals);
    const reqRegionalsExc = mergeRegionalKeys(undefined, cleanedFilters.regionalsExclude);
    const reqManagers = mergeNormalizedKeys(cleanedFilters.manager, cleanedFilters.managers);
    const reqManagersExc = mergeNormalizedKeys(undefined, cleanedFilters.managersExclude);
    const reqSegments = mergeNormalizedKeys(undefined, cleanedFilters.segments);
    const reqSegmentsExc = mergeNormalizedKeys(undefined, cleanedFilters.segmentsExclude);
    if (
      allExcluded(reqReps, reqRepsExc) ||
      allExcluded(reqStates, reqStatesExc) ||
      allExcluded(reqRegionals, reqRegionalsExc) ||
      allExcluded(reqManagers, reqManagersExc) ||
      allExcluded(reqSegments, reqSegmentsExc)
    ) {
      return { items: [], truncated: false };
    }

    const clientSearchDimSql = `(c.client_key LIKE ? ESCAPE '\\' OR c.client_raw LIKE ? ESCAPE '\\' OR COALESCE(c.name,'') LIKE ? ESCAPE '\\' OR ${sqlUpperPt("COALESCE(c.name,'')")} LIKE ? ESCAPE '\\' OR ${sqlFoldAscii("COALESCE(c.name,'')")} LIKE ? ESCAPE '\\')`;
    const clientSearchArgs = [upperPattern, pattern, pattern, upperPattern, foldedUpperPattern];

    const hasFactFilters = Boolean(
      cleanedFilters.municipality?.trim() ||
        cleanedFilters.municipalities?.length ||
        cleanedFilters.municipalitiesExclude?.length ||
        cleanedFilters.channels?.length ||
        cleanedFilters.channelsExclude?.length ||
        cleanedFilters.brands?.length ||
        cleanedFilters.brandsExclude?.length ||
        cleanedFilters.category?.trim() ||
        cleanedFilters.categoriesInclude?.length ||
        cleanedFilters.categoriesExclude?.length ||
        cleanedFilters.product?.trim() ||
        cleanedFilters.products?.length ||
        cleanedFilters.productsExclude?.length,
    );

    if (hasFactFilters) {
      if (curFrom > curTo) return { items: [], truncated: false };
      const resolvedGeo = needsRegionDimFilter(cleanedFilters)
        ? resolveGeoStateKeys(cleanedFilters, await loadRegionStates(e, batchId))
        : undefined;
      const w = buildFactWhere(
        "s",
        batchId,
        cleanedFilters,
        acl,
        hasCalendar,
        hasDenormMacro,
        "client",
        "single_range",
        curFrom,
        curTo,
        undefined,
        undefined,
        false,
        false,
        resolvedGeo,
      );
      if (w.emptyIntersection) return { items: [], truncated: false };
      const custJoin = w.joins.includes("ci_dim_customers")
        ? ""
        : "LEFT JOIN ci_dim_customers c ON c.batch_id = s.batch_id AND c.client_key = s.client_key";
      const clientSearchFactSql = `(COALESCE(c.client_key, s.client_key) LIKE ? ESCAPE '\\' OR COALESCE(c.client_raw, s.client_raw, s.client_key) LIKE ? ESCAPE '\\' OR COALESCE(c.name,'') LIKE ? ESCAPE '\\' OR ${sqlUpperPt("COALESCE(c.name,'')")} LIKE ? ESCAPE '\\' OR ${sqlFoldAscii("COALESCE(c.name,'')")} LIKE ? ESCAPE '\\')`;
      const rows = (
        await stmt(
          e,
          `SELECT DISTINCT COALESCE(c.client_key, s.client_key) AS client_key,
             COALESCE(c.client_raw, s.client_raw, s.client_key) AS client_raw,
             c.name
           FROM ci_fact_sales s ${w.joins} ${custJoin}
           WHERE ${w.clause} AND COALESCE(c.client_key, s.client_key) IS NOT NULL AND ${clientSearchFactSql}
           ORDER BY client_key LIMIT 41`,
          ...w.args,
          ...clientSearchArgs,
        ).all<{ client_key: string; client_raw: string; name: string | null }>()
      ).results;
      const sliced = rows.slice(0, 40);
      return {
        items: sliced.map((r) => {
          const code = r.client_raw || r.client_key;
          return {
            key: r.client_key,
            name: r.name ? `${code} — ${r.name}` : code,
            hasSalesInPeriod: true,
          };
        }),
        truncated: rows.length > 40,
      };
    }

    const clauses = ["c.batch_id=?"];
    const args: (string | number | null)[] = [batchId];
    let joinRegions = false;
    if (acl.allowedRegions.length) {
      clauses.push(inlineInExpr("c.representative_key", acl.allowedRegions, budget, args));
    }
    if (acl.allowedClients.length) {
      clauses.push(inlineInExpr("c.client_key", acl.allowedClients, budget, args));
    }
    if (reqReps.length) clauses.push(inlineInExpr("c.representative_key", reqReps, budget, args));
    if (reqRepsExc.length) clauses.push(inlineInExpr("c.representative_key", reqRepsExc, budget, args, true));
    if (reqStates.length) clauses.push(inlineInExpr("c.state_key", reqStates, budget, args));
    if (reqStatesExc.length) clauses.push(inlineInExpr("c.state_key", reqStatesExc, budget, args, true));
    if (reqSegments.length) clauses.push(inlineInExpr(sqlUpperPt("c.segment"), reqSegments, budget, args));
    if (reqSegmentsExc.length) clauses.push(inlineInExpr(sqlUpperPt("c.segment"), reqSegmentsExc, budget, args, true));
    if (reqRegionals.length || reqRegionalsExc.length || reqManagers.length || reqManagersExc.length) {
      joinRegions = true;
      if (reqRegionals.length) clauses.push(inlineInExpr("rg.regional_key", reqRegionals, budget, args));
      if (reqRegionalsExc.length) clauses.push(inlineInExpr("rg.regional_key", reqRegionalsExc, budget, args, true));
      if (reqManagers.length) clauses.push(inlineInExpr("rg.manager_key", reqManagers, budget, args));
      if (reqManagersExc.length) clauses.push(inlineInExpr("rg.manager_key", reqManagersExc, budget, args, true));
    }
    clauses.push(clientSearchDimSql);
    args.push(...clientSearchArgs);
    const regJoin = joinRegions ? "LEFT JOIN ci_dim_regions rg ON rg.batch_id=c.batch_id AND rg.state_key=c.state_key" : "";
    const rows = (
      await stmt(
        e,
        `SELECT c.client_key, c.client_raw, c.name FROM ci_dim_customers c ${regJoin} WHERE ${clauses.join(" AND ")} ORDER BY c.client_key LIMIT 41`,
        ...args,
      ).all<{ client_key: string; client_raw: string; name: string | null }>()
    ).results;
    const sliced = rows.slice(0, 40);
    const activeSet = new Set<string>();
    if (sliced.length && curFrom <= curTo) {
      const w = buildFactWhere(
        "s",
        batchId,
        { ...cleanedFilters, clients: sliced.map((r) => r.client_key) },
        acl,
        hasCalendar,
        hasDenormMacro,
        undefined,
        "single_range",
        curFrom,
        curTo,
      );
      if (!w.emptyIntersection) {
        const hits = (
          await stmt(e, `SELECT DISTINCT s.client_key AS k FROM ci_fact_sales s ${w.joins} WHERE ${w.clause}`, ...w.args).all<{ k: string }>()
        ).results;
        for (const h of hits) activeSet.add(h.k);
      }
    }
    const items = sliced
      .map((r) => {
        const code = r.client_raw || r.client_key;
        return {
          key: r.client_key,
          name: r.name ? `${code} — ${r.name}` : code,
          hasSalesInPeriod: activeSet.has(r.client_key),
        };
      })
      .sort(
        (a, b) => Number(b.hasSalesInPeriod) - Number(a.hasSalesInPeriod) || a.key.localeCompare(b.key, "pt-BR"),
      );
    return {
      items,
      truncated: rows.length > 40,
    };
  }

  // Product search preserves registered catalog products matching Macro Categoria / Marca
  // and annotates whether each item had sales in the active period & cascaded filters.
  const prodClauses = ["p.batch_id=?"];
  const prodArgs: (string | number | null)[] = [batchId];
  const inc = splitCategories(cleanedFilters.category, cleanedFilters.categoriesInclude);
  const exc = splitCategories(undefined, cleanedFilters.categoriesExclude);
  const reqBrands = mergeNormalizedKeys(undefined, cleanedFilters.brands);
  const reqBrandsExc = mergeNormalizedKeys(undefined, cleanedFilters.brandsExclude);
  if (allExcluded(inc.macros, exc.macros) || allExcluded(reqBrands, reqBrandsExc)) {
    return { items: [], truncated: false };
  }
  if (inc.macros.length) prodClauses.push(inlineInExpr("p.macro_category_key", inc.macros, budget, prodArgs));
  if (exc.macros.length) prodClauses.push(inlineInExpr("p.macro_category_key", exc.macros, budget, prodArgs, true));
  if (reqBrands.length) prodClauses.push(inlineInExpr(sqlUpperPt("p.brand"), reqBrands, budget, prodArgs));
  if (reqBrandsExc.length) prodClauses.push(inlineInExpr(sqlUpperPt("p.brand"), reqBrandsExc, budget, prodArgs, true));
  prodClauses.push(
    `(p.product_key LIKE ? ESCAPE '\\' OR p.product_raw LIKE ? ESCAPE '\\' OR COALESCE(p.description,'') LIKE ? ESCAPE '\\' OR ${sqlUpperPt("COALESCE(p.description,'')")} LIKE ? ESCAPE '\\' OR ${sqlFoldAscii("COALESCE(p.description,'')")} LIKE ? ESCAPE '\\')`,
  );
  prodArgs.push(upperPattern, pattern, pattern, upperPattern, foldedUpperPattern);

  const rows = (
    await stmt(
      e,
      `SELECT product_key, product_raw, description FROM ci_dim_products p WHERE ${prodClauses.join(" AND ")} ORDER BY p.product_key LIMIT 21`,
      ...prodArgs,
    ).all<{ product_key: string; product_raw: string; description: string | null }>()
  ).results;
  const sliced = rows.slice(0, 20);
  const activeSet = new Set<string>();
  if (sliced.length && curFrom <= curTo) {
    const w = buildFactWhere(
      "s",
      batchId,
      { ...cleanedFilters, products: sliced.map((r) => r.product_key) },
      acl,
      hasCalendar,
      hasDenormMacro,
      "product",
      "single_range",
      curFrom,
      curTo,
    );
    if (!w.emptyIntersection) {
      const hits = (
        await stmt(e, `SELECT DISTINCT s.product_key AS k FROM ci_fact_sales s ${w.joins} WHERE ${w.clause}`, ...w.args).all<{ k: string }>()
      ).results;
      for (const h of hits) activeSet.add(h.k);
    }
  }
  return {
    items: sliced.map((r) => {
      const code = r.product_raw || r.product_key;
      return {
        key: r.product_key,
        name: r.description ? `${code} — ${r.description}` : code,
        hasSalesInPeriod: activeSet.has(r.product_key),
      };
    }),
    truncated: rows.length > 20,
  };
}

export async function csvCustomerDetails(
  e: Env,
  u: DbUser,
  batchId: string,
  filters: Filters,
): Promise<CustomerDetails> {
  if (!filters.client) fail(422, "Selecione um único cliente para consultar sua atividade diária.");
  const acl = scopeForUser(u, filters);
  const { batch, hasCalendar, hasDenormMacro } = await loadBatchMeta(e, batchId);
  const comp = csvComparisonPeriod(filters, batch.coverage_from, batch.coverage_to, batch.reference_date);
  const clientKey = normalizeCsvKey(filters.client);
  if (!clientKey) fail(422, "Código de cliente inválido.");

  const w = buildFactWhere(
    "s",
    batchId,
    { ...filters, client: clientKey },
    acl,
    hasCalendar,
    hasDenormMacro,
    undefined,
    "single_range",
    comp.current.from,
    comp.current.to,
  );
  const custScopeArgs: (string | number | null)[] = [batchId, clientKey];
  const custScopeClauses = ["c.batch_id=?", "c.client_key=?"];
  if (acl.allowedRegions.length) {
    custScopeClauses.push(inlineInExpr("c.representative_key", acl.allowedRegions, { rem: 60 }, custScopeArgs));
  }

  const [activity, muniRows] = await Promise.all([
    w.emptyIntersection
      ? Promise.resolve(null)
      : stmt(
          e,
          `WITH purchase_days AS (SELECT s.date FROM ci_fact_sales s ${w.joins} WHERE ${w.clause} GROUP BY s.date HAVING SUM(s.gross_amount)>0) SELECT MAX(date) AS lastPurchase, COUNT(*) AS purchaseDays FROM purchase_days`,
          ...w.args,
        ).first<{ lastPurchase: string | null; purchaseDays: number }>(),
    stmt(
      e,
      acl.allowedRegions.length
        ? `SELECT DISTINCT s.municipality FROM ci_fact_sales s WHERE s.batch_id=? AND s.client_key=? AND s.municipality IS NOT NULL AND s.municipality<>'' AND EXISTS(SELECT 1 FROM ci_dim_customers c WHERE ${custScopeClauses.join(" AND ")}) LIMIT 3`
        : "SELECT DISTINCT s.municipality FROM ci_fact_sales s WHERE s.batch_id=? AND s.client_key=? AND s.municipality IS NOT NULL AND s.municipality<>'' LIMIT 3",
      batchId,
      clientKey,
      ...(acl.allowedRegions.length ? custScopeArgs : []),
    ).all<{ municipality: string }>(),
  ]);
  const municipality = muniRows.results.length === 1 ? muniRows.results[0].municipality : null;
  return {
    lastPurchase: activity?.lastPurchase ?? null,
    purchaseDays: activity?.purchaseDays ?? 0,
    municipality,
    limitations: [
      "A última compra observada e a frequência usam dias com soma de faturamento bruto positiva no período selecionado. Dias distintos não equivalem a pedidos, notas ou visitas.",
    ],
    period: comp.current,
  };
}

export type IncompatibleSelection = {
  dimension: ExtendedFilterDimension;
  values: string[];
  labels: string[];
  message: string;
};

export type CsvOptionsResult = {
  values: Partial<Record<FilterDimension | ExtendedFilterDimension | "channel" | "segment" | "brand", string[]>>;
  labels: Partial<Record<FilterDimension | ExtendedFilterDimension | "channel" | "segment" | "brand", Record<string, string>>>;
  registeredProducts: string[];
  meta: {
    productActiveCount: number;
    productRegisteredCount: number;
    productHasMoreRegistered: boolean;
  };
  incompatible: IncompatibleSelection[];
  truncated: Record<string, boolean>;
  batchId: string;
};

function stripMacroFromCategoryList(list: string[] | undefined, removeMacro: boolean): string[] | undefined {
  if (!list?.length) return undefined;
  const kept = list.filter((raw) => {
    const isMacro = raw.normalize("NFC").trim().toLocaleLowerCase("pt-BR").startsWith("macro categoria:");
    return removeMacro ? !isMacro : isMacro;
  });
  return kept.length ? kept : undefined;
}

function withoutDimFilters(f: Filters, dim: ExtendedFilterDimension): Filters {
  switch (dim) {
    case "regional":
      return { ...f, regional: "", regionals: undefined, regionalsExclude: undefined };
    case "manager":
      return { ...f, manager: "", managers: undefined, managersExclude: undefined };
    case "region":
      return { ...f, region: "", regions: undefined, regionsExclude: undefined };
    case "state":
      return { ...f, state: "", states: undefined, statesExclude: undefined };
    case "municipality":
      return { ...f, municipality: "", municipalities: undefined, municipalitiesExclude: undefined };
    case "client":
      return { ...f, client: "", clients: undefined, clientsExclude: undefined };
    case "product":
      return { ...f, product: "", products: undefined, productsExclude: undefined };
    case "brand":
      return { ...f, brands: undefined, brandsExclude: undefined };
    case "channel":
      return { ...f, channels: undefined, channelsExclude: undefined };
    case "segment":
      return { ...f, segments: undefined, segmentsExclude: undefined };
    case "macroCategory":
      return {
        ...f,
        categoriesInclude: stripMacroFromCategoryList(f.categoriesInclude, true),
        categoriesExclude: stripMacroFromCategoryList(f.categoriesExclude, true),
      };
    case "itemGroup":
      return {
        ...f,
        category: "",
        categoriesInclude: stripMacroFromCategoryList(f.categoriesInclude, false),
        categoriesExclude: stripMacroFromCategoryList(f.categoriesExclude, false),
      };
  }
}

function buildAggWhere(
  batchId: string,
  fromMonth: string,
  toMonth: string,
  filters: Filters,
  acl: { allowedRegions: string[]; allowedClients: string[] },
): { clause: string; args: (string | number | null)[]; emptyIntersection: boolean } {
  const reqRegions = mergeNormalizedKeys(filters.region, filters.regions);
  const reqRegionsExc = mergeNormalizedKeys(undefined, filters.regionsExclude);
  const reqStates = mergeNormalizedKeys(filters.state, filters.states);
  const reqStatesExc = mergeNormalizedKeys(undefined, filters.statesExclude);
  const reqRegionals = mergeRegionalKeys(filters.regional, filters.regionals);
  const reqRegionalsExc = mergeRegionalKeys(undefined, filters.regionalsExclude);
  const reqManagers = mergeNormalizedKeys(filters.manager, filters.managers);
  const reqManagersExc = mergeNormalizedKeys(undefined, filters.managersExclude);
  const reqSegments = mergeNormalizedKeys(undefined, filters.segments);
  const reqSegmentsExc = mergeNormalizedKeys(undefined, filters.segmentsExclude);
  const reqBrands = mergeNormalizedKeys(undefined, filters.brands);
  const reqBrandsExc = mergeNormalizedKeys(undefined, filters.brandsExclude);
  const reqChannels = mergeNormalizedKeys(undefined, filters.channels);
  const reqChannelsExc = mergeNormalizedKeys(undefined, filters.channelsExclude);
  const inc = splitCategories(filters.category, filters.categoriesInclude);
  const exc = splitCategories(undefined, filters.categoriesExclude);

  const emptyIntersection =
    allExcluded(inc.macros, exc.macros) ||
    allExcluded(inc.groups, exc.groups) ||
    allExcluded(reqRegions, reqRegionsExc) ||
    allExcluded(reqStates, reqStatesExc) ||
    allExcluded(reqRegionals, reqRegionalsExc) ||
    allExcluded(reqManagers, reqManagersExc) ||
    allExcluded(reqSegments, reqSegmentsExc) ||
    allExcluded(reqBrands, reqBrandsExc) ||
    allExcluded(reqChannels, reqChannelsExc);

  const clauses: string[] = [
    "a.batch_id = ?",
    "a.month_key BETWEEN ? AND ?",
    reqChannels.length || reqChannelsExc.length ? "a.sales_rows > 0" : "(a.sales_rows > 0 OR a.return_rows > 0)",
  ];
  const args: (string | number | null)[] = [batchId, fromMonth, toMonth];
  const budget = { rem: 60 };

  if (acl.allowedRegions.length) clauses.push(inlineInExpr("a.representative_key", acl.allowedRegions, budget, args));
  if (reqRegions.length) clauses.push(inlineInExpr("a.representative_key", reqRegions, budget, args));
  if (reqRegionsExc.length) clauses.push(inlineInExpr("a.representative_key", reqRegionsExc, budget, args, true));
  if (reqStates.length) clauses.push(inlineInExpr("a.state_key", reqStates, budget, args));
  if (reqStatesExc.length) clauses.push(inlineInExpr("a.state_key", reqStatesExc, budget, args, true));
  if (reqRegionals.length) clauses.push(inlineInExpr("a.regional_key", reqRegionals, budget, args));
  if (reqRegionalsExc.length) clauses.push(inlineInExpr("a.regional_key", reqRegionalsExc, budget, args, true));
  if (reqManagers.length) clauses.push(inlineInExpr("a.manager_key", reqManagers, budget, args));
  if (reqManagersExc.length) clauses.push(inlineInExpr("a.manager_key", reqManagersExc, budget, args, true));
  if (reqSegments.length) clauses.push(inlineInExpr(sqlUpperPt("a.segment"), reqSegments, budget, args));
  if (reqSegmentsExc.length) clauses.push(inlineInExpr(sqlUpperPt("a.segment"), reqSegmentsExc, budget, args, true));
  if (reqBrands.length) clauses.push(inlineInExpr(sqlUpperPt("a.brand"), reqBrands, budget, args));
  if (reqBrandsExc.length) clauses.push(inlineInExpr(sqlUpperPt("a.brand"), reqBrandsExc, budget, args, true));
  if (reqChannels.length) clauses.push(inlineInExpr(sqlUpperPt("a.channel"), reqChannels, budget, args));
  if (reqChannelsExc.length) clauses.push(inlineInExpr(sqlUpperPt("a.channel"), reqChannelsExc, budget, args, true));
  if (inc.macros.length) clauses.push(inlineInExpr("a.macro_key", inc.macros, budget, args));
  if (inc.groups.length) clauses.push(inlineInExpr("a.group_key", inc.groups, budget, args));
  if (exc.macros.length) clauses.push(inlineInExpr("a.macro_key", exc.macros, budget, args, true));
  if (exc.groups.length) clauses.push(inlineInExpr("a.group_key", exc.groups, budget, args, true));

  return { clause: clauses.join(" AND "), args, emptyIntersection };
}

export async function queryCsvOptions(
  e: Env,
  u: DbUser,
  batchId: string,
  filters?: Filters,
): Promise<CsvOptionsResult> {
  const acl = scopeForUser(u, filters);
  const { batch, hasCalendar, hasDenormMacro, hasAggCube } = await loadBatchMeta(e, batchId);

  const defaultFrom = (batch.coverage_from ?? "2026-01").slice(0, 7);
  const defaultTo = (batch.reference_date ?? batch.coverage_to ?? "2026-12").slice(0, 7);
  const f: Filters = filters ?? { from: defaultFrom, to: defaultTo, region: "", client: "", product: "" };
  const comp = csvComparisonPeriod(f, batch.coverage_from, batch.coverage_to, batch.reference_date);
  const curFrom = comp.current.from;
  const curTo = comp.current.to;

  if (curFrom > curTo) {
    return {
      batchId,
      values: {
        regional: [],
        manager: [],
        region: [],
        state: [],
        municipality: [],
        client: [],
        product: [],
        macroCategory: [],
        itemGroup: [],
        category: [],
        channel: [],
        segment: [],
        brand: [],
      },
      labels: {},
      registeredProducts: [],
      meta: { productActiveCount: 0, productRegisteredCount: 0, productHasMoreRegistered: false },
      incompatible: [],
      truncated: {},
    };
  }

  const catalogRows = (
    await stmt(e, "SELECT dimension, value_key, display FROM ci_dim_catalog WHERE batch_id=?", batchId).all<{
      dimension: string;
      value_key: string;
      display: string;
    }>()
  ).results;
  const catDisplay = new Map<string, string>();
  for (const r of catalogRows) {
    if (r.display) catDisplay.set(`${r.dimension}\u0000${r.value_key}`, r.display);
  }
  const getCat = (dim: string, key: string, fallback?: string | null) =>
    catDisplay.get(`${dim}\u0000${key}`) || fallback || key;

  const monthEnd = new Date(Date.UTC(Number(f.to.slice(0, 4)), Number(f.to.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10);
  const curToMonth = curTo.slice(0, 7);
  const aggPeriodExact = hasAggCube && (curTo >= monthEnd || !batch.coverage_to || curTo >= batch.coverage_to);

  const canUseAgg = (sub: Filters) =>
    aggPeriodExact &&
    !acl.allowedClients.length &&
    !mergeNormalizedKeys(sub.client, sub.clients).length &&
    !mergeNormalizedKeys(undefined, sub.clientsExclude).length &&
    !mergeNormalizedKeys(sub.product, sub.products).length &&
    !mergeNormalizedKeys(undefined, sub.productsExclude).length &&
    !mergeNormalizedKeys(sub.municipality, sub.municipalities).length &&
    !mergeNormalizedKeys(undefined, sub.municipalitiesExclude).length;

  const macroFactExpr = hasDenormMacro ? "s.macro_key" : "COALESCE(p.macro_category_key, s.macro_key)";
  type DimItem = { k: string; lbl: string };
  type DimResult = { items: DimItem[]; truncated: boolean };

  const compoundUnion = (parts: string[]): string =>
    parts.length === 1
      ? parts[0]
      : `SELECT * FROM (${compoundUnion(parts.slice(0, Math.ceil(parts.length / 2)))}) UNION ALL SELECT * FROM (${compoundUnion(parts.slice(Math.ceil(parts.length / 2)))})`;

  const ALL_OPT_DIMS: ExtendedFilterDimension[] = [
    "regional",
    "manager",
    "state",
    "region",
    "macroCategory",
    "itemGroup",
    "channel",
    "segment",
    "brand",
    "municipality",
    "client",
    "product",
  ];

  const AGG_COL_BY_DIM: Partial<Record<ExtendedFilterDimension, { expr: string; alias: string; jsDedup?: boolean }>> = {
    regional: { expr: "a.regional_key", alias: "regional_key" },
    manager: { expr: "a.manager_key", alias: "manager_key" },
    state: { expr: "a.state_key", alias: "state_key" },
    region: { expr: "a.representative_key", alias: "representative_key" },
    macroCategory: { expr: "a.macro_key", alias: "macro_key" },
    itemGroup: { expr: "a.group_key", alias: "group_key" },
    channel: { expr: "TRIM(a.channel)", alias: "channel", jsDedup: true },
    segment: { expr: "TRIM(a.segment)", alias: "segment", jsDedup: true },
    brand: { expr: "TRIM(a.brand)", alias: "brand", jsDedup: true },
  };

  const FACT_COL_BY_DIM: Record<
    ExtendedFilterDimension,
    { expr: string; alias: string; extraJoin?: "customers" | "products" | "regions"; jsDedup?: boolean }
  > = {
    regional: { expr: "rg.regional_key", alias: "regional_key", extraJoin: "regions" },
    manager: { expr: "rg.manager_key", alias: "manager_key", extraJoin: "regions" },
    state: { expr: "s.state_key", alias: "state_key" },
    region: { expr: "c.representative_key", alias: "representative_key", extraJoin: "customers" },
    macroCategory: {
      expr: macroFactExpr,
      alias: "macro_key",
      extraJoin: hasDenormMacro ? undefined : "products",
    },
    itemGroup: { expr: "s.group_key", alias: "group_key" },
    channel: { expr: "TRIM(s.channel)", alias: "channel", jsDedup: true },
    segment: { expr: "TRIM(c.segment)", alias: "segment", extraJoin: "customers", jsDedup: true },
    brand: { expr: "TRIM(p.brand)", alias: "brand", extraJoin: "products", jsDedup: true },
    municipality: { expr: "TRIM(s.municipality)", alias: "muni", jsDedup: true },
    client: { expr: "s.client_key", alias: "client_key" },
    product: { expr: "s.product_key", alias: "product_key" },
  };

  const toDimResult = (rawVals: string[], jsDedup?: boolean): DimResult => {
    const rawLimit = jsDedup ? 300 : 250;
    const rawTruncated = rawVals.length > rawLimit;
    if (!jsDedup) {
      return {
        items: rawVals.slice(0, 250).map((v) => ({ k: v, lbl: v })),
        truncated: rawTruncated,
      };
    }
    const deduped = new Map<string, string>();
    for (const v of rawVals.slice(0, rawLimit)) {
      const k = normalizeCsvKey(v) ?? v;
      if (k && !deduped.has(k)) deduped.set(k, v);
    }
    const items = [...deduped.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, lbl]) => ({ k, lbl }));
    return {
      items: items.slice(0, 250),
      truncated: rawTruncated || items.length > 250,
    };
  };

  type Bucket = { kind: "agg" | "fact"; sub: Filters; dims: ExtendedFilterDimension[] };
  const aggBuckets = new Map<string, Bucket>();
  const factBuckets = new Map<string, Bucket>();

  for (const dim of ALL_OPT_DIMS) {
    const sub = withoutDimFilters(f, dim);
    const subKey = JSON.stringify(sub);
    const isAggEligible = Boolean(AGG_COL_BY_DIM[dim]) && canUseAgg(sub);
    const targetMap = isAggEligible ? aggBuckets : factBuckets;
    const existing = targetMap.get(subKey);
    if (existing) existing.dims.push(dim);
    else targetMap.set(subKey, { kind: isAggEligible ? "agg" : "fact", sub, dims: [dim] });
  }

  const dimResults: Partial<Record<ExtendedFilterDimension, DimResult>> = {};

  const runAggBucket = async (bucket: Bucket) => {
    const aw = buildAggWhere(batchId, f.from, curToMonth, bucket.sub, acl);
    if (aw.emptyIntersection) {
      for (const dim of bucket.dims) dimResults[dim] = { items: [], truncated: false };
      return;
    }
    if (bucket.dims.length === 1) {
      const dim = bucket.dims[0];
      const spec = AGG_COL_BY_DIM[dim]!;
      const limit = spec.jsDedup ? 301 : 251;
      const rows = (
        await stmt(
          e,
          `SELECT DISTINCT ${spec.expr} AS v FROM ci_agg_monthly a WHERE ${aw.clause} AND ${spec.expr} <> '' ORDER BY v LIMIT ${limit}`,
          ...aw.args,
        ).all<{ v: string }>()
      ).results;
      dimResults[dim] = toDimResult(
        rows.map((r) => r.v),
        spec.jsDedup,
      );
      return;
    }
    const selectCols = [...new Set(bucket.dims.map((dim) => `${AGG_COL_BY_DIM[dim]!.expr} AS ${AGG_COL_BY_DIM[dim]!.alias}`))];
    const parts = bucket.dims.map((dim) => {
      const spec = AGG_COL_BY_DIM[dim]!;
      const limit = spec.jsDedup ? 301 : 251;
      return `SELECT '${dim}' AS d, v FROM (SELECT DISTINCT ${spec.alias} AS v FROM agg_base WHERE ${spec.alias} <> '' ORDER BY v LIMIT ${limit})`;
    });
    const rows = (
      await stmt(
        e,
        `WITH agg_base AS MATERIALIZED (SELECT ${selectCols.join(", ")} FROM ci_agg_monthly a WHERE ${aw.clause}) ${compoundUnion(parts)}`,
        ...aw.args,
      ).all<{ d: ExtendedFilterDimension; v: string }>()
    ).results;
    const grouped = new Map<ExtendedFilterDimension, string[]>();
    for (const r of rows) {
      const list = grouped.get(r.d) ?? [];
      list.push(r.v);
      grouped.set(r.d, list);
    }
    for (const dim of bucket.dims) {
      dimResults[dim] = toDimResult(grouped.get(dim) ?? [], AGG_COL_BY_DIM[dim]!.jsDedup);
    }
  };

  const needsAnyRegionGeo =
    needsRegionDimFilter(f) || Boolean(f.regional || f.regionals?.length || f.regionalsExclude?.length || f.manager || f.managers?.length || f.managersExclude?.length);
  const regionStatesCache = needsAnyRegionGeo ? await loadRegionStates(e, batchId) : null;

  const runFactBucket = async (bucket: Bucket) => {
    const subGeo = regionStatesCache ? resolveGeoStateKeys(bucket.sub, regionStatesCache) : undefined;
    const w = buildFactWhere(
      "s",
      batchId,
      bucket.sub,
      acl,
      hasCalendar,
      hasDenormMacro,
      undefined,
      "single_range",
      curFrom,
      curTo,
      undefined,
      undefined,
      false,
      false,
      subGeo,
    );
    if (w.emptyIntersection) {
      for (const dim of bucket.dims) dimResults[dim] = { items: [], truncated: false };
      return;
    }

    const canFastUnfilteredFact =
      !acl.allowedRegions.length &&
      !acl.allowedClients.length &&
      !hasCalendar &&
      !w.joins &&
      bucket.dims.every(
        (d) => d === "client" || (d === "product" && batch.product_rows > 0) || d === "municipality",
      ) &&
      Object.entries(bucket.sub).every(([k, v]) => {
        if (k === "from" || k === "to") return true;
        if (k === "variationDirection") return !v || v === "all";
        return Array.isArray(v) ? v.length === 0 : v === undefined || v === "";
      });

    if (canFastUnfilteredFact) {
      await Promise.all(
        bucket.dims.map(async (dim) => {
          if (dim === "client") {
            const rows = (
              await stmt(
                e,
                "SELECT DISTINCT s.client_key AS v FROM ci_fact_sales s WHERE s.batch_id=? AND s.date>=? AND s.date<=? AND s.client_key IS NOT NULL AND s.client_key<>'' ORDER BY v LIMIT 251",
                batchId,
                curFrom,
                curTo,
              ).all<{ v: string }>()
            ).results;
            dimResults.client = toDimResult(rows.map((r) => r.v));
          } else if (dim === "product") {
            const rows = (
              await stmt(
                e,
                "SELECT p.product_key AS v FROM ci_dim_products p WHERE p.batch_id=? AND EXISTS(SELECT 1 FROM ci_fact_sales s WHERE s.batch_id=p.batch_id AND s.product_key=p.product_key AND s.date>=? AND s.date<=?) ORDER BY p.product_key LIMIT 251",
                batchId,
                curFrom,
                curTo,
              ).all<{ v: string }>()
            ).results;
            dimResults.product = toDimResult(rows.map((r) => r.v));
          } else if (dim === "municipality") {
            const rows = (
              await stmt(
                e,
                "SELECT DISTINCT TRIM(s.municipality) AS v FROM ci_fact_sales s WHERE s.batch_id=? AND s.date>=? AND s.date<=? AND s.municipality IS NOT NULL AND TRIM(s.municipality)<>'' ORDER BY v LIMIT 301",
                batchId,
                curFrom,
                curTo,
              ).all<{ v: string }>()
            ).results;
            dimResults.municipality = toDimResult(rows.map((r) => r.v), true);
          }
        }),
      );
      return;
    }
    let joins = w.joins;
    const neededJoins = new Set(bucket.dims.map((dim) => FACT_COL_BY_DIM[dim].extraJoin).filter(Boolean));
    if (neededJoins.has("customers") && !joins.includes("ci_dim_customers")) {
      joins += " LEFT JOIN ci_dim_customers c ON c.batch_id = s.batch_id AND c.client_key = s.client_key";
    }
    if (neededJoins.has("products") && !joins.includes("ci_dim_products")) {
      joins += " LEFT JOIN ci_dim_products p ON p.batch_id = s.batch_id AND p.product_key = s.product_key";
    }
    if (neededJoins.has("regions") && !joins.includes("ci_dim_regions")) {
      joins += " LEFT JOIN ci_dim_regions rg ON rg.batch_id = s.batch_id AND rg.state_key = s.state_key";
    }
    if (bucket.dims.length === 1) {
      const dim = bucket.dims[0];
      const spec = FACT_COL_BY_DIM[dim];
      const limit = spec.jsDedup ? 301 : 251;
      const rows = (
        await stmt(
          e,
          `SELECT DISTINCT ${spec.expr} AS v FROM ci_fact_sales s ${joins} WHERE ${w.clause} AND ${spec.expr} IS NOT NULL AND ${spec.expr} <> '' ORDER BY v LIMIT ${limit}`,
          ...w.args,
        ).all<{ v: string }>()
      ).results;
      dimResults[dim] = toDimResult(
        rows.map((r) => r.v),
        spec.jsDedup,
      );
      return;
    }
    const selectCols = [...new Set(bucket.dims.map((dim) => `${FACT_COL_BY_DIM[dim].expr} AS ${FACT_COL_BY_DIM[dim].alias}`))];
    const parts = bucket.dims.map((dim) => {
      const spec = FACT_COL_BY_DIM[dim];
      const limit = spec.jsDedup ? 301 : 251;
      return `SELECT '${dim}' AS d, v FROM (SELECT DISTINCT ${spec.alias} AS v FROM fact_base WHERE ${spec.alias} IS NOT NULL AND ${spec.alias} <> '' ORDER BY v LIMIT ${limit})`;
    });
    const rows = (
      await stmt(
        e,
        `WITH fact_base AS MATERIALIZED (SELECT ${selectCols.join(", ")} FROM ci_fact_sales s ${joins} WHERE ${w.clause}) ${compoundUnion(parts)}`,
        ...w.args,
      ).all<{ d: ExtendedFilterDimension; v: string }>()
    ).results;
    const grouped = new Map<ExtendedFilterDimension, string[]>();
    for (const r of rows) {
      const list = grouped.get(r.d) ?? [];
      list.push(r.v);
      grouped.set(r.d, list);
    }
    for (const dim of bucket.dims) {
      dimResults[dim] = toDimResult(grouped.get(dim) ?? [], FACT_COL_BY_DIM[dim].jsDedup);
    }
  };

  const queryRegisteredProducts = async () => {
    const sub = withoutDimFilters(f, "product");
    const inc = splitCategories(sub.category, sub.categoriesInclude);
    const exc = splitCategories(undefined, sub.categoriesExclude);
    const reqBrands = mergeNormalizedKeys(undefined, sub.brands);
    const reqBrandsExc = mergeNormalizedKeys(undefined, sub.brandsExclude);
    if (allExcluded(inc.macros, exc.macros) || allExcluded(reqBrands, reqBrandsExc)) {
      return [] as { product_key: string; product_raw: string; description: string | null }[];
    }
    const clauses = ["p.batch_id = ?"];
    const args: (string | number | null)[] = [batchId];
    const budget = { rem: 60 };
    if (inc.macros.length) clauses.push(inlineInExpr("p.macro_category_key", inc.macros, budget, args));
    if (exc.macros.length) clauses.push(inlineInExpr("p.macro_category_key", exc.macros, budget, args, true));
    if (reqBrands.length) clauses.push(inlineInExpr(sqlUpperPt("p.brand"), reqBrands, budget, args));
    if (reqBrandsExc.length) clauses.push(inlineInExpr(sqlUpperPt("p.brand"), reqBrandsExc, budget, args, true));
    return (
      await stmt(
        e,
        `SELECT p.product_key, p.product_raw, p.description FROM ci_dim_products p WHERE ${clauses.join(" AND ")} ORDER BY p.product_key`,
        ...args,
      ).all<{ product_key: string; product_raw: string; description: string | null }>()
    ).results;
  };

  const [regProdsAll] = await Promise.all([
    queryRegisteredProducts(),
    ...[...aggBuckets.values()].map(runAggBucket),
    ...[...factBuckets.values()].map(runFactBucket),
  ]);

  const emptyRes: DimResult = { items: [], truncated: false };
  const regRes = dimResults.regional ?? emptyRes;
  const mgrRes = dimResults.manager ?? emptyRes;
  const stateRes = dimResults.state ?? emptyRes;
  const repRes = dimResults.region ?? emptyRes;
  const muniRes = dimResults.municipality ?? emptyRes;
  const cliRes = dimResults.client ?? emptyRes;
  const prodRes = dimResults.product ?? emptyRes;
  const macroRes = dimResults.macroCategory ?? emptyRes;
  const grpRes = dimResults.itemGroup ?? emptyRes;
  const chanRes = dimResults.channel ?? emptyRes;
  const segRes = dimResults.segment ?? emptyRes;
  const brandRes = dimResults.brand ?? emptyRes;

  // Format official regional names cleanly (never manager names)
  const regionalLabels: Record<string, string> = {};
  const regionalKeys = regRes.items
    .map((r) => normalizeRegionalKey(r.k) ?? r.k)
    .filter(Boolean);
  for (const k of regionalKeys) {
    regionalLabels[k] = formatOfficialRegionalName(k);
  }
  const regionalsSorted = [...new Set(regionalKeys)].sort((a, b) =>
    (regionalLabels[a] ?? a).localeCompare(regionalLabels[b] ?? b, "pt-BR"),
  );

  // Manager names (separate filter only)
  const managerLabels: Record<string, string> = {};
  const managersSorted = mgrRes.items
    .map((r) => {
      const disp = getCat("manager", r.k, r.lbl);
      managerLabels[disp] = disp;
      return disp;
    })
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  // States (keep 2-letter UF codes as keys; put state name in labels.state)
  const stateLabels: Record<string, string> = {};
  const statesSorted = stateRes.items
    .map((r) => {
      const fullName = getCat("state", r.k, null);
      if (fullName && fullName !== r.k) stateLabels[r.k] = `${r.k} — ${fullName}`;
      else stateLabels[r.k] = r.k;
      return r.k;
    })
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  // Representatives
  const regionLabels: Record<string, string> = {};
  const regionsSorted = repRes.items
    .filter((r) => !acl.allowedRegions.length || acl.allowedRegions.includes(r.k))
    .map((r) => {
      const disp = getCat("representative", r.k, r.lbl);
      regionLabels[disp] = disp;
      return disp;
    })
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  // Municipalities (key = clean display name)
  const muniLabels: Record<string, string> = {};
  const municipalitiesSorted = muniRes.items
    .map((r) => {
      const disp = r.lbl || r.k;
      muniLabels[disp] = disp;
      return disp;
    })
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  // Channels, Segments, Brands
  const channelsSorted = chanRes.items
    .map((r) => {
      for (const [ck, cv] of catDisplay.entries()) {
        if (ck.startsWith("channel\u0000") && cv.toLocaleUpperCase("pt-BR") === r.k) return cv;
      }
      return r.lbl || r.k;
    })
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  const segmentsSorted = segRes.items
    .map((r) => {
      for (const [ck, cv] of catDisplay.entries()) {
        if (ck.startsWith("segment\u0000") && cv.toLocaleUpperCase("pt-BR") === r.k) return cv;
      }
      return r.lbl || r.k;
    })
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  const brandsSorted = brandRes.items
    .map((r) => {
      for (const [ck, cv] of catDisplay.entries()) {
        if (ck.startsWith("brand\u0000") && cv.toLocaleUpperCase("pt-BR") === r.k) return cv;
      }
      return r.lbl || r.k;
    })
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  // Macro Categories ("Macro Categoria: <KEY>") and Item Groups (<GROUP>)
  const macroLabels: Record<string, string> = {};
  const macroCatsSorted = macroRes.items
    .map((r) => {
      const key = `Macro Categoria: ${r.k}`;
      const disp = getCat("macro_category", r.k, r.lbl);
      macroLabels[key] = disp;
      return key;
    })
    .sort((a, b) => (macroLabels[a] ?? a).localeCompare(macroLabels[b] ?? b, "pt-BR"));

  const groupLabels: Record<string, string> = {};
  const itemGroupsSorted = grpRes.items
    .map((r) => {
      const disp = getCat("group", r.k, r.lbl);
      groupLabels[disp] = disp;
      return disp;
    })
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  const categoriesSorted = [...new Set([...macroCatsSorted, ...itemGroupsSorted])].sort((a, b) =>
    a.localeCompare(b, "pt-BR"),
  );

  // Hydrate client and product labels (plus selected ones)
  const activeClientKeys = cliRes.items.map((r) => r.k);
  const selectedClientKeys = mergeNormalizedKeys(f.client, f.clients).concat(mergeNormalizedKeys(undefined, f.clientsExclude));
  const clientsToHydrate = [...new Set([...activeClientKeys, ...selectedClientKeys])].filter(
    (k) => !acl.allowedClients.length || acl.allowedClients.includes(k),
  );

  const activeProdKeys = prodRes.items.map((r) => r.k);
  const activeProdSet = new Set(activeProdKeys);
  const inactiveRegProds = regProdsAll.filter((p) => !activeProdSet.has(p.product_key));
  const registeredProductsSlice = inactiveRegProds.slice(0, 250).map((p) => p.product_key);

  const selectedProdKeys = mergeNormalizedKeys(f.product, f.products).concat(mergeNormalizedKeys(undefined, f.productsExclude));
  const prodsToHydrate = [...new Set([...activeProdKeys, ...registeredProductsSlice, ...selectedProdKeys])];

  const [clientHydrated, prodHydrated] = await Promise.all([
    hydrateDimNames(e, batchId, "client", clientsToHydrate.map((key) => ({ key, name: key, values: {} as Row["values"] }))),
    hydrateDimNames(e, batchId, "product", prodsToHydrate.map((key) => ({ key, name: key, values: {} as Row["values"] }))),
  ]);

  const clientLabels: Record<string, string> = Object.fromEntries(
    clientHydrated.filter((r) => r.key).map((r) => [r.key!, r.name]),
  );
  const productLabels: Record<string, string> = Object.fromEntries(
    prodHydrated.filter((r) => r.key).map((r) => [r.key!, r.name]),
  );

  // Incompatible selection checks across all 12 dimensions
  const incompatible: IncompatibleSelection[] = [];
  const checkCompat = (
    dim: ExtendedFilterDimension,
    dimLabel: string,
    selectedRaw: string[],
    availableKeys: Set<string>,
    norm: (v: string) => string = (v) => normalizeCsvKey(v) ?? "",
    fmt: (v: string) => string = (v) => v,
    extraReason?: string,
  ) => {
    if (!selectedRaw.length) return;
    const missing: string[] = [];
    const missingLabels: string[] = [];
    const seen = new Set<string>();
    for (const raw of selectedRaw) {
      const k = norm(raw);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      if (!availableKeys.has(k)) {
        missing.push(raw);
        missingLabels.push(fmt(raw));
      }
    }
    if (missing.length) {
      incompatible.push({
        dimension: dim,
        values: missing,
        labels: missingLabels,
        message: `${dimLabel}: ${missingLabels.join(", ")} ${missing.length > 1 ? "não pertencem" : "não pertence"} ${extraReason || "ao recorte selecionado"}.`,
      });
    }
  };

  const toKeySet = (arr: string[], norm: (v: string) => string = (v) => normalizeCsvKey(v) ?? "") =>
    new Set(arr.map(norm).filter(Boolean));

  const singleOrMulti = (single?: string, multi?: string[]) => [
    ...(single?.trim() ? [single.trim()] : []),
    ...(multi ?? []),
  ];

  const reqRegionalRaw = singleOrMulti(f.regional, f.regionals);
  const reqManagerRaw = singleOrMulti(f.manager, f.managers);
  const reqRepRaw = singleOrMulti(f.region, f.regions);
  const reqStateRaw = singleOrMulti(f.state, f.states);
  const reqMuniRaw = singleOrMulti(f.municipality, f.municipalities);
  const reqClientRaw = singleOrMulti(f.client, f.clients);
  const reqProdRaw = singleOrMulti(f.product, f.products);
  const reqIncMacros = (f.categoriesInclude ?? []).filter((v) =>
    v.normalize("NFC").trim().toLocaleLowerCase("pt-BR").startsWith("macro categoria:"),
  );
  const reqIncGroups = [
    ...(f.category?.trim() ? [f.category.trim()] : []),
    ...(f.categoriesInclude ?? []).filter(
      (v) => !v.normalize("NFC").trim().toLocaleLowerCase("pt-BR").startsWith("macro categoria:"),
    ),
  ];

  if (!mgrRes.truncated) {
    checkCompat("manager", "Gerente Regional", reqManagerRaw, toKeySet(managersSorted), undefined, (v) => managerLabels[v] ?? v);
  }
  if (!repRes.truncated) {
    checkCompat("region", "Representante", reqRepRaw, toKeySet(regionsSorted), undefined, (v) => regionLabels[v] ?? v);
  }
  if (!stateRes.truncated) {
    checkCompat("state", "UF", reqStateRaw, toKeySet(statesSorted), undefined, (v) => stateLabels[normalizeCsvKey(v) ?? v] ?? v);
  }
  if (!macroRes.truncated) {
    checkCompat(
      "macroCategory",
      "Macrocategoria",
      reqIncMacros,
      toKeySet(macroCatsSorted, (v) => normalizeCsvKey(v.replace(/^macro categoria:\s*/iu, "")) ?? ""),
      (v) => normalizeCsvKey(v.replace(/^macro categoria:\s*/iu, "")) ?? "",
      (v) => v.replace(/^macro categoria:\s*/iu, ""),
    );
  }
  if (!grpRes.truncated) {
    checkCompat("itemGroup", "Grupo do item", reqIncGroups, toKeySet(itemGroupsSorted));
  }
  if (!chanRes.truncated) checkCompat("channel", "Canal comercial", f.channels ?? [], toKeySet(channelsSorted));
  if (!segRes.truncated) checkCompat("segment", "Segmento", f.segments ?? [], toKeySet(segmentsSorted));
  if (!brandRes.truncated) checkCompat("brand", "Marca", f.brands ?? [], toKeySet(brandsSorted));

  // For Regional: avoid falsely blaming parent regional when ONLY a lower geo child (UF/manager/municipality) caused empty cascade
  if (!regRes.truncated && reqRegionalRaw.length) {
    const regSet = toKeySet(regionalsSorted, (v) => normalizeRegionalKey(v) ?? "");
    const childGeoConflict = incompatible.some((x) => ["state", "manager", "municipality", "region"].includes(x.dimension));
    if (!childGeoConflict) {
      checkCompat(
        "regional",
        "Regional",
        reqRegionalRaw,
        regSet,
        (v) => normalizeRegionalKey(v) ?? "",
        (v) => formatOfficialRegionalName(v),
      );
    }
  }

  // Targeted checks for potentially truncated high-cardinality selections (client, product, municipality)
  const checkHighCard = async (
    dim: "client" | "product" | "municipality",
    label: string,
    selectedRaw: string[],
    alreadyFound: Set<string>,
    colExpr: string,
    isTruncated: boolean,
    registeredFallbackSet?: Set<string>,
  ) => {
    if (!selectedRaw.length) return;
    const normMap = new Map<string, string>();
    for (const raw of selectedRaw) {
      const k = normalizeCsvKey(raw);
      if (!k) continue;
      if (!alreadyFound.has(k) && (!registeredFallbackSet || !registeredFallbackSet.has(k))) {
        normMap.set(k, raw);
      }
    }
    if (!normMap.size) return;
    if (isTruncated) {
      const sub = withoutDimFilters(f, dim);
      const subGeo = regionStatesCache ? resolveGeoStateKeys(sub, regionStatesCache) : undefined;
      const w = buildFactWhere(
        "s",
        batchId,
        sub,
        acl,
        hasCalendar,
        hasDenormMacro,
        dim === "client" ? "client" : dim === "product" ? "product" : undefined,
        "single_range",
        curFrom,
        curTo,
        undefined,
        undefined,
        false,
        false,
        subGeo,
      );
      if (!w.emptyIntersection) {
        const missingKeys = [...normMap.keys()];
        const argsCopy = [...w.args];
        const cond = inlineInExpr(colExpr, missingKeys, { rem: 60 }, argsCopy);
        const foundRows = (
          await stmt(e, `SELECT DISTINCT ${colExpr} AS k FROM ci_fact_sales s ${w.joins} WHERE ${w.clause} AND ${cond}`, ...argsCopy).all<{
            k: string;
          }>()
        ).results;
        for (const r of foundRows) normMap.delete(r.k);
      }
    }
    if (normMap.size) {
      const missingRaw = [...normMap.values()];
      const lblMap = dim === "client" ? clientLabels : dim === "product" ? productLabels : muniLabels;
      const missingLbls = missingRaw.map((v) => lblMap[normalizeCsvKey(v) ?? v] ?? v);
      incompatible.push({
        dimension: dim,
        values: missingRaw,
        labels: missingLbls,
        message: `${label}: ${missingLbls.join(", ")} ${missingRaw.length > 1 ? "não possuem" : "não possui"} compatibilidade com o recorte atual.`,
      });
    }
  };

  const regProdKeySet = new Set(regProdsAll.map((p) => p.product_key));
  await Promise.all([
    checkHighCard("client", "Cliente", reqClientRaw, activeClientKeys.reduce((s, k) => s.add(k), new Set<string>()), "s.client_key", cliRes.truncated),
    checkHighCard("product", "Produto", reqProdRaw, activeProdSet, "s.product_key", prodRes.truncated, regProdKeySet),
    checkHighCard(
      "municipality",
      "Município",
      reqMuniRaw,
      toKeySet(municipalitiesSorted),
      sqlUpperPt("s.municipality"),
      muniRes.truncated,
    ),
  ]);

  return {
    batchId,
    values: {
      regional: regionalsSorted,
      manager: managersSorted,
      region: regionsSorted,
      state: statesSorted,
      municipality: municipalitiesSorted,
      client: activeClientKeys,
      product: activeProdKeys,
      macroCategory: macroCatsSorted,
      itemGroup: itemGroupsSorted,
      category: categoriesSorted,
      channel: channelsSorted,
      segment: segmentsSorted,
      brand: brandsSorted,
    },
    labels: {
      regional: regionalLabels,
      manager: managerLabels,
      region: regionLabels,
      state: stateLabels,
      municipality: muniLabels,
      client: clientLabels,
      product: productLabels,
      macroCategory: macroLabels,
      itemGroup: groupLabels,
      category: { ...macroLabels, ...groupLabels },
    },
    registeredProducts: registeredProductsSlice,
    meta: {
      productActiveCount: activeProdKeys.length,
      productRegisteredCount: regProdsAll.length,
      productHasMoreRegistered: inactiveRegProds.length > 250,
    },
    incompatible,
    truncated: {
      regional: regRes.truncated,
      manager: mgrRes.truncated,
      region: repRes.truncated,
      state: stateRes.truncated,
      municipality: muniRes.truncated,
      client: cliRes.truncated,
      product: prodRes.truncated,
      macroCategory: macroRes.truncated,
      itemGroup: grpRes.truncated,
      category: macroRes.truncated || grpRes.truncated,
      channel: chanRes.truncated,
      segment: segRes.truncated,
      brand: brandRes.truncated,
    },
  };
}

async function hydrateDimNames(
  e: Env,
  batchId: string,
  kind: "client" | "product",
  candidates: Row[],
): Promise<Row[]> {
  const keys = [...new Set(candidates.map((r) => r.key).filter((k): k is string => !!k))];
  if (!keys.length) return candidates;
  const isClient = kind === "client";
  const dimSql = isClient
    ? "SELECT client_key AS k, client_raw AS raw, name AS title FROM ci_dim_customers WHERE batch_id=? AND client_key IN (SELECT value FROM json_each(?))"
    : "SELECT product_key AS k, product_raw AS raw, description AS title FROM ci_dim_products WHERE batch_id=? AND product_key IN (SELECT value FROM json_each(?))";
  const dimRows = (
    await stmt(e, dimSql, batchId, JSON.stringify(keys)).all<{ k: string; raw: string; title: string | null }>()
  ).results;

  const dimMap = new Map(dimRows.map((d) => [d.k, d]));
  const missingKeys = keys.filter((k) => !dimMap.has(k));
  const rawMap = new Map<string, string>();
  if (missingKeys.length) {
    const fbSql = isClient
      ? "SELECT client_key AS k, MAX(client_raw) AS raw FROM ci_fact_sales WHERE batch_id=? AND client_key IN (SELECT value FROM json_each(?)) AND client_raw IS NOT NULL AND client_raw<>'' GROUP BY client_key"
      : "SELECT product_key AS k, MAX(product_raw) AS raw FROM ci_fact_sales WHERE batch_id=? AND product_key IN (SELECT value FROM json_each(?)) AND product_raw IS NOT NULL AND product_raw<>'' GROUP BY product_key";
    const fallbackRows = (
      await stmt(e, fbSql, batchId, JSON.stringify(missingKeys)).all<{ k: string; raw: string }>()
    ).results;
    for (const r of fallbackRows) rawMap.set(r.k, r.raw);
  }

  return candidates.map((row) => {
    if (!row.key) return row;
    const d = dimMap.get(row.key);
    const label = d?.title ? `${d.raw || row.key} — ${d.title}` : rawMap.get(row.key) || d?.raw || row.key;
    return { ...row, name: label };
  });
}

async function hydrateCategoryNames(e: Env, batchId: string, candidates: Row[]): Promise<Row[]> {
  if (!candidates.some((r) => !!r.key)) return candidates;
  const [catRows, prodRows] = await Promise.all([
    stmt(
      e,
      "SELECT dimension, value_key, display FROM ci_dim_catalog WHERE batch_id=? AND dimension IN ('macro_category','group')",
      batchId,
    ).all<{ dimension: string; value_key: string; display: string }>(),
    stmt(
      e,
      "SELECT DISTINCT macro_category_key AS k, macro_category_raw AS raw FROM ci_dim_products WHERE batch_id=? AND macro_category_key IS NOT NULL",
      batchId,
    ).all<{ k: string; raw: string | null }>(),
  ]);
  const labelMap = new Map<string, string>();
  for (const c of catRows.results) {
    if (c.display) labelMap.set(c.value_key, c.display);
  }
  for (const p of prodRows.results) {
    if (p.raw) labelMap.set(p.k, p.raw);
  }
  return candidates.map((row) => (row.key ? { ...row, name: labelMap.get(row.key) || row.name } : row));
}

export async function queryCsvReport(
  e: Env,
  u: DbUser,
  batchId: string,
  plan: Plan,
  opts?: ReportQueryOptions,
): Promise<Report> {
  const acl = scopeForUser(u, plan.filters);
  const { batch, hasCalendar, hasDenormMacro } = opts?.preloadedMeta ?? (await loadBatchMeta(e, batchId));
  const comp = csvComparisonPeriod(plan.filters, batch.coverage_from, batch.coverage_to, batch.reference_date);
  const f = plan.filters;
  const conflicts = detectFilterConflicts(f);
  const toPair = (cVal: number | null, pVal: number | null) => ({ current: cVal, previous: pVal });

  const includeDocs = opts?.includeDocs !== false;
  const includeActiveReps = opts?.includeActiveReps !== false;
  const hasCustFilter = needsCustomerFilter(f, acl);
  const hasProdFilter = needsProductFilter(f, hasDenormMacro);
  const disjointPeriods = comp.previous.to < comp.current.from;
  const canFastClient = plan.group === "client" && !hasCustFilter;
  const canFastRegion = plan.group === "region" && !hasCustFilter && disjointPeriods;
  const canFastProduct = plan.group === "product" && !hasProdFilter;
  const canFastCategory = plan.group === "category" && hasDenormMacro && !hasProdFilter;
  const omitCustJoin = canFastClient || canFastRegion;
  const omitProdJoin = canFastProduct || canFastCategory;
  const periodMode: PeriodMode = disjointPeriods ? "disjoint_dual" : "periods_join";
  const resolvedGeo = needsRegionDimFilter(f)
    ? resolveGeoStateKeys(f, await loadRegionStates(e, batchId))
    : undefined;

  const salesW = buildFactWhere(
    "s",
    batchId,
    f,
    acl,
    hasCalendar,
    hasDenormMacro,
    plan.group,
    periodMode,
    comp.previous.from,
    comp.current.to,
    comp.current.from,
    comp.previous.to,
    omitCustJoin,
    omitProdJoin,
    resolvedGeo,
  );
  const retW = buildFactWhere(
    "r",
    batchId,
    f,
    acl,
    hasCalendar,
    hasDenormMacro,
    plan.group,
    periodMode,
    comp.previous.from,
    comp.current.to,
    comp.current.from,
    comp.previous.to,
    omitCustJoin,
    omitProdJoin,
    resolvedGeo,
  );

  if (salesW.emptyIntersection) {
    return {
      total: {
        name: "Total",
        values: {
          gross: toPair(null, null),
          returns: toPair(0, 0),
          revenue: toPair(null, null),
          buyers: toPair(null, null),
          margin: toPair(null, null),
        },
      },
      rows: [],
      plan,
      asOf: new Date().toISOString(),
      truncated: false,
      source: "Arquivo manual (D1)",
      comparison: comp,
      ...(conflicts.length ? { filterConflicts: conflicts } : {}),
      summaryStats: { activeReps: 0, ticketPerBuyer: null, invoiceCount: 0, ticketPerInvoice: null },
      sourceInfo: csvSourceInfo(batch, comp),
    };
  }

  const canUseSummaryCache = batch.status === "validated" || batch.status === "active";
  const summaryKey = canUseSummaryCache ? buildSummaryCacheKey(batch, hasCalendar, hasDenormMacro, acl, comp, f) : "";
  const cachedSummary = canUseSummaryCache ? cacheGetSummary(summaryKey) : undefined;

  const periodArgs = [comp.current.from, comp.current.to, comp.previous.from, comp.previous.to];
  const periodsCte = "WITH periods(pk, pf, pt) AS (SELECT 0, ?, ? UNION ALL SELECT 1, ?, ?)";

  let curTotS: TotPair | undefined = cachedSummary?.curTotS;
  let prevTotS: TotPair | undefined = cachedSummary?.prevTotS;
  let docsCount = cachedSummary?.docsCount ?? 0;
  let activeRepsCount = cachedSummary?.activeRepsCount ?? 0;

  const needDocsQuery = includeDocs && cachedSummary?.docsCount === undefined;
  const needRepsQuery = includeActiveReps && plan.group !== "region" && cachedSummary?.activeRepsCount === undefined;
  const needTotsQuery = !cachedSummary && !canFastClient && !canFastRegion;

  const docsPromise = needDocsQuery
    ? (() => {
        const docsW = buildFactWhere(
          "s",
          batchId,
          f,
          acl,
          hasCalendar,
          hasDenormMacro,
          undefined,
          "single_range",
          comp.current.from,
          comp.current.to,
          undefined,
          undefined,
          false,
          false,
          resolvedGeo,
        );
        return stmt(
          e,
          `SELECT COUNT(DISTINCT NULLIF(s.doc_no, '')) AS docs FROM ci_fact_sales s ${docsW.joins} WHERE ${docsW.clause}`,
          ...docsW.args,
        ).first<{ docs: number }>();
      })()
    : Promise.resolve(null);

  const repsPromise = needRepsQuery
    ? (() => {
        const repsW = buildFactWhere(
          "s",
          batchId,
          f,
          acl,
          hasCalendar,
          hasDenormMacro,
          hasCustFilter ? "region" : undefined,
          "single_range",
          comp.current.from,
          comp.current.to,
          undefined,
          undefined,
          false,
          false,
          resolvedGeo,
        );
        if (!hasCustFilter) {
          return stmt(
            e,
            `WITH ac AS (SELECT DISTINCT COALESCE(s.client_key, NULL) AS client_key FROM ci_fact_sales s ${repsW.joins} WHERE ${repsW.clause} AND s.client_key IS NOT NULL) SELECT COUNT(DISTINCT c.representative_key) AS n FROM ac JOIN ci_dim_customers c ON c.batch_id = ? AND c.client_key = ac.client_key WHERE c.representative_key IS NOT NULL`,
            ...repsW.args,
            batchId,
          ).first<{ n: number }>();
        }
        return stmt(
          e,
          `SELECT COUNT(DISTINCT c.representative_key) AS n FROM ci_fact_sales s ${repsW.joins} WHERE ${repsW.clause} AND c.representative_key IS NOT NULL`,
          ...repsW.args,
        ).first<{ n: number }>();
      })()
    : Promise.resolve(null);

  const totsPromise = needTotsQuery
    ? (() => {
        const totsW = buildFactWhere(
          "s",
          batchId,
          f,
          acl,
          hasCalendar,
          hasDenormMacro,
          undefined,
          periodMode,
          comp.previous.from,
          comp.current.to,
          comp.current.from,
          comp.previous.to,
          false,
          false,
          resolvedGeo,
        );
        if (disjointPeriods) {
          return stmt(
            e,
            `SELECT
               COALESCE(SUM(cg), 0) AS cur_gross, COALESCE(SUM(cn), 0) AS cur_rows,
               COALESCE(SUM(CASE WHEN cn > 0 AND client_key IS NOT NULL THEN 1 ELSE 0 END), 0) AS cur_buyers,
               COALESCE(SUM(pg), 0) AS prev_gross, COALESCE(SUM(pn), 0) AS prev_rows,
               COALESCE(SUM(CASE WHEN pn > 0 AND client_key IS NOT NULL THEN 1 ELSE 0 END), 0) AS prev_buyers
             FROM (
               SELECT COALESCE(s.client_key, NULL) AS client_key,
                 SUM(CASE WHEN s.date >= ? THEN s.gross_amount ELSE 0 END) AS cg,
                 SUM(CASE WHEN s.date >= ? THEN 1 ELSE 0 END) AS cn,
                 SUM(CASE WHEN s.date <= ? THEN s.gross_amount ELSE 0 END) AS pg,
                 SUM(CASE WHEN s.date <= ? THEN 1 ELSE 0 END) AS pn
               FROM ci_fact_sales s ${totsW.joins}
               WHERE ${totsW.clause}
               GROUP BY COALESCE(s.client_key, NULL)
             )`,
            comp.current.from,
            comp.current.from,
            comp.previous.to,
            comp.previous.to,
            ...totsW.args,
          ).first<{
            cur_gross: number;
            cur_rows: number;
            cur_buyers: number;
            prev_gross: number;
            prev_rows: number;
            prev_buyers: number;
          }>();
        }
        return stmt(
          e,
          `${periodsCte}
           SELECT pk, SUM(gross) AS gross, SUM(rows_n) AS rows_n,
             SUM(CASE WHEN rows_n > 0 AND client_key IS NOT NULL THEN 1 ELSE 0 END) AS buyers
           FROM (
             SELECT pd.pk AS pk, COALESCE(s.client_key, NULL) AS client_key, SUM(s.gross_amount) AS gross, COUNT(*) AS rows_n
             FROM periods pd JOIN ci_fact_sales s ${totsW.joins}
             WHERE ${totsW.clause}
             GROUP BY pd.pk, COALESCE(s.client_key, NULL)
           )
           GROUP BY pk`,
          ...periodArgs,
          ...totsW.args,
        ).all<{ pk: number; gross: number; rows_n: number; buyers: number }>();
      })()
    : Promise.resolve(null);

  type FastAggSalesRow = { g: string | null; name?: string | null; cg: number; cn: number; cb: number; pg: number; pn: number; pb: number };
  type FastAggRetRow = { g: string | null; name?: string | null; cr: number; pr: number };
  let groupedSalesRes: { pk: number; g: string | null; name?: string | null; gross: number; buyers: number }[] = [];
  let groupedRetRes: { pk: number; g: string | null; name?: string | null; returns: number }[] = [];
  let fastAggSales: FastAggSalesRow[] | null = null;
  let fastAggRet: FastAggRetRow[] | null = null;
  let overrideRetScaled: { cur: number; prev: number } | null = null;

  const applyTotRaw = (totRaw: Awaited<typeof totsPromise>) => {
    if (!totRaw) return;
    if ("results" in totRaw) {
      const c = totRaw.results.find((r) => r.pk === 0);
      const p = totRaw.results.find((r) => r.pk === 1);
      if (c) curTotS = { gross: c.gross, rows_n: c.rows_n, buyers: c.buyers };
      if (p) prevTotS = { gross: p.gross, rows_n: p.rows_n, buyers: p.buyers };
    } else {
      if (totRaw.cur_rows > 0) curTotS = { gross: totRaw.cur_gross, rows_n: totRaw.cur_rows, buyers: totRaw.cur_buyers };
      if (totRaw.prev_rows > 0) prevTotS = { gross: totRaw.prev_gross, rows_n: totRaw.prev_rows, buyers: totRaw.prev_buyers };
    }
  };

  if (plan.group === "month") {
    if (opts?.skipMonthlySeries) {
      const retTotalsPromise = cachedSummary
        ? Promise.resolve(null)
        : disjointPeriods
          ? stmt(
              e,
              `SELECT COALESCE(SUM(CASE WHEN r.date >= ? THEN r.return_amount ELSE 0 END), 0) AS cr,
                 COALESCE(SUM(CASE WHEN r.date <= ? THEN r.return_amount ELSE 0 END), 0) AS pr
               FROM ci_fact_returns r ${retW.joins} WHERE ${retW.clause}`,
              comp.current.from,
              comp.previous.to,
              ...retW.args,
            ).first<{ cr: number; pr: number }>()
          : stmt(
              e,
              `${periodsCte} SELECT pd.pk AS pk, COALESCE(SUM(r.return_amount), 0) AS returns
               FROM periods pd JOIN ci_fact_returns r ${retW.joins} WHERE ${retW.clause} GROUP BY pd.pk`,
              ...periodArgs,
              ...retW.args,
            ).all<{ pk: number; returns: number }>();

      const [totRaw, docsRow, retTotRaw, repsRow] = await Promise.all([
        totsPromise,
        docsPromise,
        retTotalsPromise,
        repsPromise,
      ]);
      applyTotRaw(totRaw);
      if (needDocsQuery) docsCount = docsRow?.docs ?? 0;
      if (needRepsQuery) activeRepsCount = repsRow?.n ?? 0;
      if (cachedSummary) {
        overrideRetScaled = { cur: cachedSummary.curRetScaled, prev: cachedSummary.prevRetScaled };
      } else if (retTotRaw && "results" in retTotRaw) {
        overrideRetScaled = {
          cur: Number(retTotRaw.results.find((r) => r.pk === 0)?.returns ?? 0),
          prev: Number(retTotRaw.results.find((r) => r.pk === 1)?.returns ?? 0),
        };
      } else if (retTotRaw) {
        overrideRetScaled = { cur: Number(retTotRaw.cr ?? 0), prev: Number(retTotRaw.pr ?? 0) };
      }
    } else {
      const salesMonthSql = disjointPeriods
        ? `SELECT CASE WHEN s.date >= ? THEN 0 ELSE 1 END AS pk,
             CASE WHEN s.date >= ? THEN SUBSTR(s.date,1,7) ELSE (CAST(SUBSTR(s.date,1,4) AS INTEGER)+1) || SUBSTR(s.date,5,3) END AS g,
             SUM(s.gross_amount) AS gross, COUNT(DISTINCT s.client_key) AS buyers
           FROM ci_fact_sales s ${salesW.joins} WHERE ${salesW.clause} GROUP BY pk, g`
        : `${periodsCte} SELECT pd.pk AS pk,
             CASE WHEN pd.pk=0 THEN SUBSTR(s.date,1,7) ELSE (CAST(SUBSTR(s.date,1,4) AS INTEGER)+1) || SUBSTR(s.date,5,3) END AS g,
             SUM(s.gross_amount) AS gross, COUNT(DISTINCT s.client_key) AS buyers
           FROM periods pd JOIN ci_fact_sales s ${salesW.joins} WHERE ${salesW.clause} GROUP BY pd.pk, g`;
      const retMonthSql = disjointPeriods
        ? `SELECT CASE WHEN r.date >= ? THEN 0 ELSE 1 END AS pk,
             CASE WHEN r.date >= ? THEN SUBSTR(r.date,1,7) ELSE (CAST(SUBSTR(r.date,1,4) AS INTEGER)+1) || SUBSTR(r.date,5,3) END AS g,
             SUM(r.return_amount) AS returns
           FROM ci_fact_returns r ${retW.joins} WHERE ${retW.clause} GROUP BY pk, g`
        : `${periodsCte} SELECT pd.pk AS pk,
             CASE WHEN pd.pk=0 THEN SUBSTR(r.date,1,7) ELSE (CAST(SUBSTR(r.date,1,4) AS INTEGER)+1) || SUBSTR(r.date,5,3) END AS g,
             SUM(r.return_amount) AS returns
           FROM periods pd JOIN ci_fact_returns r ${retW.joins} WHERE ${retW.clause} GROUP BY pd.pk, g`;

      const [totRaw, docsRow, gs, gr, repsRow] = await Promise.all([
        totsPromise,
        docsPromise,
        stmt(
          e,
          salesMonthSql,
          ...(disjointPeriods ? [comp.current.from, comp.current.from] : periodArgs),
          ...salesW.args,
        ).all<{ pk: number; g: string; gross: number; buyers: number }>(),
        stmt(
          e,
          retMonthSql,
          ...(disjointPeriods ? [comp.current.from, comp.current.from] : periodArgs),
          ...retW.args,
        ).all<{ pk: number; g: string; returns: number }>(),
        repsPromise,
      ]);
      groupedSalesRes = gs.results;
      groupedRetRes = gr.results;
      if (needDocsQuery) docsCount = docsRow?.docs ?? 0;
      if (needRepsQuery) activeRepsCount = repsRow?.n ?? 0;
      applyTotRaw(totRaw);
    }
  } else if (canFastRegion) {
    const [docsRow, fsRes, frRes] = await Promise.all([
      docsPromise,
      stmt(
        e,
        `WITH agg AS (
           SELECT COALESCE(s.client_key, NULL) AS client_key,
             SUM(CASE WHEN s.date >= ? THEN s.gross_amount ELSE 0 END) AS cg,
             SUM(CASE WHEN s.date >= ? THEN 1 ELSE 0 END) AS cn,
             SUM(CASE WHEN s.date <= ? THEN s.gross_amount ELSE 0 END) AS pg,
             SUM(CASE WHEN s.date <= ? THEN 1 ELSE 0 END) AS pn
           FROM ci_fact_sales s ${salesW.joins}
           WHERE ${salesW.clause}
           GROUP BY COALESCE(s.client_key, NULL)
         )
         SELECT c.representative_key AS g,
           COALESCE(MAX(c.representative_raw), c.representative_key) AS name,
           SUM(agg.cg) AS cg, SUM(agg.cn) AS cn,
           SUM(CASE WHEN agg.cn > 0 AND agg.client_key IS NOT NULL THEN 1 ELSE 0 END) AS cb,
           SUM(agg.pg) AS pg, SUM(agg.pn) AS pn,
           SUM(CASE WHEN agg.pn > 0 AND agg.client_key IS NOT NULL THEN 1 ELSE 0 END) AS pb
         FROM agg
         LEFT JOIN ci_dim_customers c ON c.batch_id = ? AND c.client_key = agg.client_key
         GROUP BY c.representative_key`,
        comp.current.from,
        comp.current.from,
        comp.previous.to,
        comp.previous.to,
        ...salesW.args,
        batchId,
      ).all<FastAggSalesRow>(),
      stmt(
        e,
        `WITH agg AS (
           SELECT COALESCE(r.client_key, NULL) AS client_key,
             SUM(CASE WHEN r.date >= ? THEN r.return_amount ELSE 0 END) AS cr,
             SUM(CASE WHEN r.date <= ? THEN r.return_amount ELSE 0 END) AS pr
           FROM ci_fact_returns r ${retW.joins}
           WHERE ${retW.clause}
           GROUP BY COALESCE(r.client_key, NULL)
         )
         SELECT c.representative_key AS g,
           COALESCE(MAX(c.representative_raw), c.representative_key) AS name,
           SUM(agg.cr) AS cr, SUM(agg.pr) AS pr
         FROM agg
         LEFT JOIN ci_dim_customers c ON c.batch_id = ? AND c.client_key = agg.client_key
         GROUP BY c.representative_key`,
        comp.current.from,
        comp.previous.to,
        ...retW.args,
        batchId,
      ).all<FastAggRetRow>(),
    ]);
    fastAggSales = fsRes.results;
    fastAggRet = frRes.results;
    if (needDocsQuery) docsCount = docsRow?.docs ?? 0;
    if (includeActiveReps) activeRepsCount = fastAggSales.filter((r) => r.cn > 0 && r.g !== null).length;

    if (!cachedSummary) {
      let cGross = 0, cRows = 0, cBuyers = 0, pGross = 0, pRows = 0, pBuyers = 0;
      for (const r of fastAggSales) {
        cGross += Number(r.cg ?? 0);
        cRows += Number(r.cn ?? 0);
        cBuyers += Number(r.cb ?? 0);
        pGross += Number(r.pg ?? 0);
        pRows += Number(r.pn ?? 0);
        pBuyers += Number(r.pb ?? 0);
      }
      if (cRows > 0) curTotS = { gross: cGross, rows_n: cRows, buyers: cBuyers };
      if (pRows > 0) prevTotS = { gross: pGross, rows_n: pRows, buyers: pBuyers };
    }
  } else if ((canFastClient || canFastProduct || canFastCategory) && disjointPeriods) {
    const sKeyExpr = canFastClient
      ? "COALESCE(s.client_key, NULL)"
      : canFastProduct
        ? "s.product_key"
        : "COALESCE(s.macro_key, s.group_key)";
    const rKeyExpr = canFastClient
      ? "COALESCE(r.client_key, NULL)"
      : canFastProduct
        ? "r.product_key"
        : "COALESCE(r.macro_key, r.group_key)";
    const salesSql = canFastClient
      ? `SELECT ${sKeyExpr} AS g,
           SUM(CASE WHEN s.date >= ? THEN s.gross_amount ELSE 0 END) AS cg,
           SUM(CASE WHEN s.date >= ? THEN 1 ELSE 0 END) AS cn, 0 AS cb,
           SUM(CASE WHEN s.date <= ? THEN s.gross_amount ELSE 0 END) AS pg,
           SUM(CASE WHEN s.date <= ? THEN 1 ELSE 0 END) AS pn, 0 AS pb
         FROM ci_fact_sales s ${salesW.joins} WHERE ${salesW.clause} GROUP BY ${sKeyExpr}`
      : `SELECT ${sKeyExpr} AS g,
           SUM(CASE WHEN s.date >= ? THEN s.gross_amount ELSE 0 END) AS cg,
           SUM(CASE WHEN s.date >= ? THEN 1 ELSE 0 END) AS cn,
           COUNT(DISTINCT CASE WHEN s.date >= ? THEN s.client_key END) AS cb,
           SUM(CASE WHEN s.date <= ? THEN s.gross_amount ELSE 0 END) AS pg,
           SUM(CASE WHEN s.date <= ? THEN 1 ELSE 0 END) AS pn,
           COUNT(DISTINCT CASE WHEN s.date <= ? THEN s.client_key END) AS pb
         FROM ci_fact_sales s ${salesW.joins} WHERE ${salesW.clause} GROUP BY ${sKeyExpr}`;
    const salesArgs = canFastClient
      ? [comp.current.from, comp.current.from, comp.previous.to, comp.previous.to, ...salesW.args]
      : [comp.current.from, comp.current.from, comp.current.from, comp.previous.to, comp.previous.to, comp.previous.to, ...salesW.args];

    const [totRaw, docsRow, fsRes, frRes, repsRow] = await Promise.all([
      totsPromise,
      docsPromise,
      stmt(e, salesSql, ...salesArgs).all<FastAggSalesRow>(),
      stmt(
        e,
        `SELECT ${rKeyExpr} AS g,
           SUM(CASE WHEN r.date >= ? THEN r.return_amount ELSE 0 END) AS cr,
           SUM(CASE WHEN r.date <= ? THEN r.return_amount ELSE 0 END) AS pr
         FROM ci_fact_returns r ${retW.joins} WHERE ${retW.clause} GROUP BY ${rKeyExpr}`,
        comp.current.from,
        comp.previous.to,
        ...retW.args,
      ).all<FastAggRetRow>(),
      repsPromise,
    ]);
    fastAggSales = fsRes.results;
    fastAggRet = frRes.results;
    if (needDocsQuery) docsCount = docsRow?.docs ?? 0;
    if (needRepsQuery) activeRepsCount = repsRow?.n ?? 0;
    if (canFastClient && !cachedSummary) {
      let cGross = 0, cRows = 0, cBuyers = 0, pGross = 0, pRows = 0, pBuyers = 0;
      for (const r of fastAggSales) {
        cGross += Number(r.cg ?? 0);
        cRows += Number(r.cn ?? 0);
        if (r.cn > 0 && r.g !== null) cBuyers++;
        pGross += Number(r.pg ?? 0);
        pRows += Number(r.pn ?? 0);
        if (r.pn > 0 && r.g !== null) pBuyers++;
      }
      if (cRows > 0) curTotS = { gross: cGross, rows_n: cRows, buyers: cBuyers };
      if (pRows > 0) prevTotS = { gross: pGross, rows_n: pRows, buyers: pBuyers };
    } else {
      applyTotRaw(totRaw);
    }
  } else if (canFastClient || canFastProduct || canFastCategory) {
    const sKeyExpr = canFastClient
      ? "COALESCE(s.client_key, NULL)"
      : canFastProduct
        ? "s.product_key"
        : "COALESCE(s.macro_key, s.group_key)";
    const rKeyExpr = canFastClient
      ? "COALESCE(r.client_key, NULL)"
      : canFastProduct
        ? "r.product_key"
        : "COALESCE(r.macro_key, r.group_key)";
    const buyersSql = canFastClient ? "COUNT(*) AS buyers" : "COUNT(DISTINCT s.client_key) AS buyers";

    const [totRaw, docsRow, fsRes, frRes, repsRow] = await Promise.all([
      totsPromise,
      docsPromise,
      stmt(
        e,
        `${periodsCte} SELECT pd.pk AS pk, ${sKeyExpr} AS g, SUM(s.gross_amount) AS gross, ${buyersSql}
         FROM periods pd JOIN ci_fact_sales s ${salesW.joins} WHERE ${salesW.clause} GROUP BY pd.pk, ${sKeyExpr}`,
        ...periodArgs,
        ...salesW.args,
      ).all<{ pk: number; g: string | null; gross: number; buyers: number }>(),
      stmt(
        e,
        `${periodsCte} SELECT pd.pk AS pk, ${rKeyExpr} AS g, SUM(r.return_amount) AS returns
         FROM periods pd JOIN ci_fact_returns r ${retW.joins} WHERE ${retW.clause} GROUP BY pd.pk, ${rKeyExpr}`,
        ...periodArgs,
        ...retW.args,
      ).all<{ pk: number; g: string | null; returns: number }>(),
      repsPromise,
    ]);
    groupedSalesRes = fsRes.results.map((r) => ({
      pk: r.pk,
      g: r.g,
      name: r.g,
      gross: r.gross,
      buyers: canFastClient ? (r.buyers > 0 ? (r.g !== null ? 1 : 0) : 0) : r.buyers,
    }));
    groupedRetRes = frRes.results.map((r) => ({ pk: r.pk, g: r.g, name: r.g, returns: r.returns }));
    if (needDocsQuery) docsCount = docsRow?.docs ?? 0;
    if (needRepsQuery) activeRepsCount = repsRow?.n ?? 0;
    if (canFastClient && !cachedSummary) {
      let cGross = 0, cRows = 0, cBuyers = 0, pGross = 0, pRows = 0, pBuyers = 0;
      for (const r of fsRes.results) {
        if (r.pk === 0) {
          cGross += Number(r.gross ?? 0);
          cRows += Number(r.buyers ?? 0);
          if (r.buyers > 0 && r.g !== null) cBuyers++;
        } else {
          pGross += Number(r.gross ?? 0);
          pRows += Number(r.buyers ?? 0);
          if (r.buyers > 0 && r.g !== null) pBuyers++;
        }
      }
      if (cRows > 0) curTotS = { gross: cGross, rows_n: cRows, buyers: cBuyers };
      if (pRows > 0) prevTotS = { gross: pGross, rows_n: pRows, buyers: pBuyers };
    } else {
      applyTotRaw(totRaw);
    }
  } else {
    const sg = groupExpressions("s", plan.group);
    const rg = groupExpressions("r", plan.group);
    const salesGrpSql = disjointPeriods
      ? `SELECT CASE WHEN s.date >= ? THEN 0 ELSE 1 END AS pk, ${sg.keyExpr} AS g, ${sg.labelExpr} AS name, SUM(s.gross_amount) AS gross, COUNT(DISTINCT s.client_key) AS buyers
         FROM ci_fact_sales s ${salesW.joins} WHERE ${salesW.clause} GROUP BY pk, ${sg.keyExpr}`
      : `${periodsCte} SELECT pd.pk AS pk, ${sg.keyExpr} AS g, ${sg.labelExpr} AS name, SUM(s.gross_amount) AS gross, COUNT(DISTINCT s.client_key) AS buyers
         FROM periods pd JOIN ci_fact_sales s ${salesW.joins} WHERE ${salesW.clause} GROUP BY pd.pk, ${sg.keyExpr}`;
    const retGrpSql = disjointPeriods
      ? `SELECT CASE WHEN r.date >= ? THEN 0 ELSE 1 END AS pk, ${rg.keyExpr} AS g, ${rg.labelExpr} AS name, SUM(r.return_amount) AS returns
         FROM ci_fact_returns r ${retW.joins} WHERE ${retW.clause} GROUP BY pk, ${rg.keyExpr}`
      : `${periodsCte} SELECT pd.pk AS pk, ${rg.keyExpr} AS g, ${rg.labelExpr} AS name, SUM(r.return_amount) AS returns
         FROM periods pd JOIN ci_fact_returns r ${retW.joins} WHERE ${retW.clause} GROUP BY pd.pk, ${rg.keyExpr}`;

    const [totRaw, docsRow, gs, gr, repsRow] = await Promise.all([
      totsPromise,
      docsPromise,
      stmt(
        e,
        salesGrpSql,
        ...(disjointPeriods ? [comp.current.from] : periodArgs),
        ...salesW.args,
      ).all<{ pk: number; g: string | null; name: string | null; gross: number; buyers: number }>(),
      stmt(
        e,
        retGrpSql,
        ...(disjointPeriods ? [comp.current.from] : periodArgs),
        ...retW.args,
      ).all<{ pk: number; g: string | null; name: string | null; returns: number }>(),
      repsPromise,
    ]);
    groupedSalesRes = gs.results;
    groupedRetRes = gr.results;
    if (needDocsQuery) docsCount = docsRow?.docs ?? 0;
    if (plan.group === "region") {
      if (includeActiveReps) activeRepsCount = groupedSalesRes.filter((r) => r.pk === 0 && r.g !== null).length;
    } else if (needRepsQuery) {
      activeRepsCount = repsRow?.n ?? 0;
    }
    applyTotRaw(totRaw);
  }

  const curRetScaled = overrideRetScaled
    ? overrideRetScaled.cur
    : fastAggRet
      ? fastAggRet.reduce((acc, r) => acc + Number(r.cr ?? 0), 0)
      : groupedRetRes.filter((r) => r.pk === 0).reduce((acc, r) => acc + Number(r.returns ?? 0), 0);
  const prevRetScaled = overrideRetScaled
    ? overrideRetScaled.prev
    : fastAggRet
      ? fastAggRet.reduce((acc, r) => acc + Number(r.pr ?? 0), 0)
      : groupedRetRes.filter((r) => r.pk === 1).reduce((acc, r) => acc + Number(r.returns ?? 0), 0);

  if (canUseSummaryCache) {
    const nextEntry: CachedSummary = {
      curTotS,
      prevTotS,
      curRetScaled,
      prevRetScaled,
      ...(cachedSummary?.docsCount !== undefined
        ? { docsCount: cachedSummary.docsCount }
        : includeDocs
          ? { docsCount }
          : {}),
      ...(cachedSummary?.activeRepsCount !== undefined
        ? { activeRepsCount: cachedSummary.activeRepsCount }
        : includeActiveReps
          ? { activeRepsCount }
          : {}),
    };
    cacheSetSummary(summaryKey, nextEntry);
  }

  const curGross = curTotS?.rows_n ? Number(curTotS.gross ?? 0) / MONEY_DIV : null;
  const prevGross = prevTotS?.rows_n ? Number(prevTotS.gross ?? 0) / MONEY_DIV : null;
  const curRet = curRetScaled / MONEY_DIV;
  const prevRet = prevRetScaled / MONEY_DIV;
  const curRev = curGross !== null || curRet > 0 ? (curGross ?? 0) - curRet : null;
  const prevRev = prevGross !== null || prevRet > 0 ? (prevGross ?? 0) - prevRet : null;
  const curBuyers = curTotS?.rows_n ? curTotS.buyers : null;
  const prevBuyers = prevTotS?.rows_n ? prevTotS.buyers : null;

  const totalRow: Row = {
    name: "Total",
    values: {
      gross: toPair(curGross, prevGross),
      returns: toPair(curRet, prevRet),
      revenue: toPair(curRev, prevRev),
      buyers: toPair(curBuyers, prevBuyers),
      margin: toPair(null, null),
    },
  };

  let rows: Row[] = [];
  let totalCandidateCount = 0;
  if (plan.group === "month") {
    const mMap = new Map<string, { cg: number | null; cr: number; cb: number | null; pg: number | null; pr: number; pb: number | null }>();
    const touch = (m: string) => {
      let entry = mMap.get(m);
      if (!entry) {
        entry = { cg: null, cr: 0, cb: null, pg: null, pr: 0, pb: null };
        mMap.set(m, entry);
      }
      return entry;
    };
    for (const r of groupedSalesRes) {
      if (!r.g) continue;
      const e0 = touch(r.g);
      if (r.pk === 0) {
        e0.cg = r.gross / MONEY_DIV;
        e0.cb = r.buyers;
      } else {
        e0.pg = r.gross / MONEY_DIV;
        e0.pb = r.buyers;
      }
    }
    for (const r of groupedRetRes) {
      if (!r.g) continue;
      const e0 = touch(r.g);
      if (r.pk === 0) e0.cr = r.returns / MONEY_DIV;
      else e0.pr = r.returns / MONEY_DIV;
    }

    rows = [...mMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({
        name: month,
        values: {
          gross: toPair(v.cg, v.pg),
          returns: toPair(v.cr, v.pr),
          revenue: toPair(v.cg !== null || v.cr > 0 ? (v.cg ?? 0) - v.cr : null, v.pg !== null || v.pr > 0 ? (v.pg ?? 0) - v.pr : null),
          buyers: toPair(v.cb, v.pb),
          margin: toPair(null, null),
        },
      }));
    totalCandidateCount = rows.length;
  } else {
    const gMap = new Map<
      string,
      { key: string | null; name: string; cg: number | null; cr: number; cb: number | null; pg: number | null; pr: number; pb: number | null }
    >();
    const touch = (k: string | null, name: string | null | undefined) => {
      const id = k ?? "__NULL__";
      let entry = gMap.get(id);
      if (!entry) {
        entry = { key: k, name: name || k || "(Em branco)", cg: null, cr: 0, cb: null, pg: null, pr: 0, pb: null };
        gMap.set(id, entry);
      }
      return entry;
    };
    if (fastAggSales && fastAggRet) {
      for (const r of fastAggSales) {
        const e0 = touch(r.g, r.name ?? r.g);
        if (r.cn > 0) {
          e0.cg = r.cg / MONEY_DIV;
          e0.cb = canFastClient ? (r.g !== null ? 1 : 0) : r.cb;
        }
        if (r.pn > 0) {
          e0.pg = r.pg / MONEY_DIV;
          e0.pb = canFastClient ? (r.g !== null ? 1 : 0) : r.pb;
        }
      }
      for (const r of fastAggRet) {
        const e0 = touch(r.g, r.name ?? r.g);
        e0.cr = r.cr / MONEY_DIV;
        e0.pr = r.pr / MONEY_DIV;
      }
    } else {
      for (const r of groupedSalesRes) {
        const e0 = touch(r.g, r.name);
        if (r.pk === 0) {
          e0.cg = r.gross / MONEY_DIV;
          e0.cb = r.buyers;
        } else {
          e0.pg = r.gross / MONEY_DIV;
          e0.pb = r.buyers;
        }
      }
      for (const r of groupedRetRes) {
        const e0 = touch(r.g, r.name);
        if (r.pk === 0) e0.cr = r.returns / MONEY_DIV;
        else e0.pr = r.returns / MONEY_DIV;
      }
    }

    rows = [...gMap.values()].map((v) => ({
      name:
        plan.group === "regional" && v.key !== null
          ? formatOfficialRegionalName(v.key) !== v.key || v.key === "EX"
            ? formatOfficialRegionalName(v.key)
            : v.name
          : v.name,
      ...(v.key === null ? { canDrill: false } : { key: v.key }),
      values: {
        gross: toPair(v.cg, v.pg),
        returns: toPair(v.cr, v.pr),
        revenue: toPair(v.cg !== null || v.cr > 0 ? (v.cg ?? 0) - v.cr : null, v.pg !== null || v.pr > 0 ? (v.pg ?? 0) - v.pr : null),
        buyers: toPair(v.cb, v.pb),
        margin: toPair(null, null),
      },
    }));

    const hasRowFilters = Boolean(
      (f.variationDirection && f.variationDirection !== "all") ||
        f.revenueMin !== undefined ||
        f.revenueMax !== undefined ||
        f.ticketMin !== undefined ||
        f.ticketMax !== undefined,
    );
    if (hasRowFilters) {
      rows = rows.filter((r) => {
        const cur = r.values.revenue.current;
        const prev = r.values.revenue.previous;
        if (f.variationDirection === "growth" && (cur === null || prev === null || cur <= prev)) return false;
        if (f.variationDirection === "decline" && (cur === null || prev === null || cur >= prev)) return false;
        if (f.revenueMin !== undefined && (cur === null || cur < f.revenueMin)) return false;
        if (f.revenueMax !== undefined && (cur === null || cur > f.revenueMax)) return false;
        if (f.ticketMin !== undefined || f.ticketMax !== undefined) {
          const buyers = r.values.buyers.current;
          const tkt = cur !== null && buyers !== null && buyers > 0 ? cur / buyers : null;
          if (f.ticketMin !== undefined && (tkt === null || tkt < f.ticketMin)) return false;
          if (f.ticketMax !== undefined && (tkt === null || tkt > f.ticketMax)) return false;
        }
        return true;
      });
    }

    const score = (r: Row) =>
      plan.order === "current"
        ? (r.values[plan.metric].current ?? -Infinity)
        : (r.values[plan.metric].current ?? 0) - (r.values[plan.metric].previous ?? 0);
    const dir = plan.order === "decline" ? 1 : -1;
    rows.sort((a, b) => dir * (score(a) - score(b)) || a.name.localeCompare(b.name, "pt-BR"));
    totalCandidateCount = rows.length;

    if ((canFastClient || canFastProduct || canFastCategory) && rows.length) {
      let cut = Math.min(rows.length, 60);
      if (rows.length > 30) {
        const boundaryScore = score(rows[29]);
        while (cut < rows.length && cut < 500 && score(rows[cut]) === boundaryScore) cut++;
      }
      const topSlice = rows.slice(0, cut);
      rows = canFastCategory
        ? await hydrateCategoryNames(e, batchId, topSlice)
        : await hydrateDimNames(e, batchId, canFastClient ? "client" : "product", topSlice);
      rows.sort((a, b) => dir * (score(a) - score(b)) || a.name.localeCompare(b.name, "pt-BR"));
    }
  }

  const ticketPerBuyer = curRev !== null && curBuyers && curBuyers > 0 ? curRev / curBuyers : null;
  const ticketPerInvoice = curRev !== null && docsCount > 0 ? curRev / docsCount : null;

  return {
    total: totalRow,
    rows: rows.slice(0, 30),
    plan,
    asOf: new Date().toISOString(),
    truncated: totalCandidateCount > 30,
    source: "Arquivo manual (D1)",
    comparison: comp,
    ...(conflicts.length ? { filterConflicts: conflicts } : {}),
    summaryStats: {
      activeReps: activeRepsCount,
      ticketPerBuyer,
      invoiceCount: docsCount,
      ticketPerInvoice,
    },
    sourceInfo: csvSourceInfo(batch, comp),
  };
}

export async function reconcileCsvBatch(e: Env, batchId: string) {
  const { batch } = await loadBatchMeta(e, batchId);
  const refDate = batch.reference_date || batch.coverage_to || "2026-11-17";
  const prevEnd = (() => {
    const year = Number(refDate.slice(0, 4)) - 1;
    const month = Number(refDate.slice(5, 7));
    const day = Number(refDate.slice(8, 10));
    const clamped = Math.min(day, new Date(Date.UTC(year, month, 0)).getUTCDate());
    return `${year}-${String(month).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
  })();

  const [activeRow, filesRows, salesBoth, retBoth, repsStats, ordersCount] = await Promise.all([
    stmt(e, "SELECT active_batch_id,mode FROM ci_csv_active WHERE id=1").first<{ active_batch_id: string | null; mode: string }>(),
    stmt(e, "SELECT role,filename,sha256,bytes,row_count,duplicate_count,rejected_count,status FROM ci_csv_files WHERE batch_id=? ORDER BY role,filename", batchId).all<{
      role: string;
      filename: string;
      sha256: string;
      bytes: number;
      row_count: number;
      duplicate_count: number;
      rejected_count: number;
      status: string;
    }>(),
    stmt(
      e,
      `SELECT
         COALESCE(SUM(CASE WHEN date>='2026-01-01' THEN gross_amount ELSE 0 END),0) AS gross26,
         COUNT(DISTINCT CASE WHEN date>='2026-01-01' THEN client_key END) AS buyers26,
         COUNT(DISTINCT CASE WHEN date>='2026-01-01' AND doc_no IS NOT NULL AND doc_no<>'' THEN doc_no END) AS docs26,
         COALESCE(SUM(CASE WHEN date<=? THEN gross_amount ELSE 0 END),0) AS gross25
       FROM ci_fact_sales WHERE batch_id=? AND date BETWEEN '2025-01-01' AND ?`,
      prevEnd,
      batchId,
      refDate,
    ).first<{ gross26: number; buyers26: number; docs26: number; gross25: number }>(),
    stmt(
      e,
      `SELECT
         COALESCE(SUM(CASE WHEN date>='2026-01-01' THEN return_amount ELSE 0 END),0) AS ret26,
         COALESCE(SUM(CASE WHEN date<=? THEN return_amount ELSE 0 END),0) AS ret25
       FROM ci_fact_returns WHERE batch_id=? AND date BETWEEN '2025-01-01' AND ?`,
      prevEnd,
      batchId,
      refDate,
    ).first<{ ret26: number; ret25: number }>(),
    stmt(
      e,
      `SELECT
        (SELECT COUNT(DISTINCT representative_key) FROM ci_dim_customers WHERE batch_id=? AND representative_key IS NOT NULL) AS registered,
        (WITH ac AS (SELECT DISTINCT COALESCE(client_key, NULL) AS client_key FROM ci_fact_sales WHERE batch_id=? AND date BETWEEN '2026-01-01' AND ? AND client_key IS NOT NULL)
         SELECT COUNT(DISTINCT c.representative_key) FROM ac JOIN ci_dim_customers c ON c.batch_id=? AND c.client_key=ac.client_key WHERE c.representative_key IS NOT NULL) AS active`,
      batchId,
      batchId,
      refDate,
      batchId,
    ).first<{ registered: number; active: number }>(),
    stmt(e, "SELECT COUNT(*) AS n FROM ci_fact_orders_open WHERE batch_id=?", batchId).first<{ n: number }>(),
  ]);

  const [exARow, exBRow, exCRow, macros26, churnBoth, aggCheck] = await Promise.all([
    stmt(
      e,
      "SELECT SUM(gross_amount) AS g, SUM(return_amount) AS r, SUM(net_amount) AS n FROM ci_agg_monthly WHERE batch_id=? AND month_key BETWEEN '2026-01' AND '2026-12' AND macro_key IN ('SUCO','VINHO') AND group_key NOT LIKE '%GRANEL%'",
      batchId,
    ).first<{ g: number | null; r: number | null; n: number | null }>(),
    stmt(
      e,
      "SELECT SUM(gross_amount) AS g FROM ci_agg_monthly WHERE batch_id=? AND month_key BETWEEN '2026-01' AND '2026-12' AND group_key LIKE '%GRANEL%'",
      batchId,
    ).first<{ g: number | null }>(),
    stmt(
      e,
      "SELECT SUM(gross_amount) AS g FROM ci_agg_monthly WHERE batch_id=? AND month_key BETWEEN '2026-01' AND '2026-12' AND state_key='SP' AND macro_key IN ('SUCO','ESPUMANTE')",
      batchId,
    ).first<{ g: number | null }>(),
    stmt(
      e,
      "SELECT macro_key, SUM(gross_amount) AS g, SUM(return_amount) AS r, SUM(net_amount) AS n FROM ci_agg_monthly WHERE batch_id=? AND month_key BETWEEN '2026-01' AND '2026-12' GROUP BY macro_key ORDER BY n DESC",
      batchId,
    ).all<{ macro_key: string; g: number; r: number; n: number }>(),
    stmt(
      e,
      `WITH by_c AS (
         SELECT client_key,
           SUM(CASE WHEN date BETWEEN '2025-01-01' AND '2025-12-31' THEN gross_amount ELSE 0 END) AS y25,
           SUM(CASE WHEN date BETWEEN '2026-01-01' AND '2026-12-31' THEN gross_amount ELSE 0 END) AS y26,
           SUM(CASE WHEN date BETWEEN '2025-01-01' AND ? THEN gross_amount ELSE 0 END) AS p_ytd,
           SUM(CASE WHEN date BETWEEN '2026-01-01' AND ? THEN gross_amount ELSE 0 END) AS c_ytd
         FROM ci_fact_sales WHERE batch_id=? AND date>='2025-01-01' GROUP BY client_key
       )
       SELECT
         SUM(CASE WHEN y25>0 AND y26=0 THEN 1 ELSE 0 END) AS full_churn,
         SUM(CASE WHEN p_ytd>0 AND c_ytd=0 THEN 1 ELSE 0 END) AS ytd_churn
       FROM by_c`,
      prevEnd,
      refDate,
      batchId,
    ).first<{ full_churn: number; ytd_churn: number }>(),
    stmt(
      e,
      `SELECT
         (SELECT COALESCE(SUM(gross_amount),0) FROM ci_fact_sales WHERE batch_id=?) AS fact_gross,
         (SELECT COALESCE(SUM(return_amount),0) FROM ci_fact_returns WHERE batch_id=?) AS fact_ret,
         (SELECT COALESCE(SUM(gross_amount),0) FROM ci_agg_monthly WHERE batch_id=?) AS agg_gross,
         (SELECT COALESCE(SUM(return_amount),0) FROM ci_agg_monthly WHERE batch_id=?) AS agg_ret`,
      batchId,
      batchId,
      batchId,
      batchId,
    ).first<{ fact_gross: number; fact_ret: number; agg_gross: number; agg_ret: number }>(),
  ]);

  const gross26 = (salesBoth?.gross26 ?? 0) / MONEY_DIV;
  const returns26 = (retBoth?.ret26 ?? 0) / MONEY_DIV;
  const net26 = Number((gross26 - returns26).toFixed(2));
  const net25 = Number((((salesBoth?.gross25 ?? 0) - (retBoth?.ret25 ?? 0)) / MONEY_DIV).toFixed(2));
  const yoyPct = net25 > 0 ? Number((((net26 - net25) / net25) * 100).toFixed(2)) : null;
  const buyers26 = salesBoth?.buyers26 ?? 0;
  const docs26 = salesBoth?.docs26 ?? 0;
  const summaryMeta = batch.summary_json ? (JSON.parse(batch.summary_json) as { customerDuplicates?: number; customerConflicts?: string[] }) : {};

  return {
    batchId: batch.id,
    status: batch.status,
    mode: activeRow?.mode ?? "shadow",
    activeBatchId: activeRow?.active_batch_id ?? null,
    coverage: { from: batch.coverage_from, to: batch.coverage_to, referenceDate: refDate, previousEndDate: prevEnd },
    fileCount: filesRows.results.length,
    files: filesRows.results.map((f) => ({
      role: f.role,
      filename: f.filename,
      rows: f.row_count,
      duplicates: f.duplicate_count,
      rejected: f.rejected_count,
      bytes: f.bytes,
      status: f.status,
      sha256Prefix: f.sha256.slice(0, 12),
    })),
    counts: {
      salesRows: batch.sales_rows,
      returnRows: batch.return_rows,
      distinctCustomers: batch.customer_rows,
      customerDuplicatesRemoved: summaryMeta.customerDuplicates ?? 0,
      customerConflicts: summaryMeta.customerConflicts?.length ?? 0,
      products: batch.product_rows,
      ordersOpen: ordersCount?.n ?? 0,
      registeredReps: repsStats?.registered ?? 0,
      activeReps2026: repsStats?.active ?? 0,
      buyers2026: buyers26,
      distinctInvoices2026: docs26,
      churnedClientsFullYear2025vs2026: churnBoth?.full_churn ?? 0,
      churnedClientsYtd: churnBoth?.ytd_churn ?? 0,
    },
    ytd2026: {
      gross: Number(gross26.toFixed(2)),
      returns: Number(returns26.toFixed(2)),
      net: net26,
      prevYtdNet2025: net25,
      yoyPct,
      ticketPerBuyer: buyers26 > 0 ? Number((net26 / buyers26).toFixed(2)) : null,
      ticketPerInvoiceNet: docs26 > 0 ? Number((net26 / docs26).toFixed(2)) : null,
      ticketPerInvoiceGross: docs26 > 0 ? Number((gross26 / docs26).toFixed(2)) : null,
    },
    examples: {
      exampleA_suco_vinho_excl_granel_2026: {
        gross: Number(((exARow?.g ?? 0) / MONEY_DIV).toFixed(2)),
        returns: Number(((exARow?.r ?? 0) / MONEY_DIV).toFixed(2)),
        net: Number(((exARow?.n ?? 0) / MONEY_DIV).toFixed(2)),
      },
      exampleB_granel_only_2026: {
        gross: Number(((exBRow?.g ?? 0) / MONEY_DIV).toFixed(2)),
      },
      exampleC_suco_espumante_sp_2026: {
        gross: Number(((exCRow?.g ?? 0) / MONEY_DIV).toFixed(2)),
      },
    },
    independentCategories2026: macros26.results.map((m) => ({
      macroCategory: m.macro_key || "(Sem macro)",
      gross: Number((m.g / MONEY_DIV).toFixed(2)),
      returns: Number((m.r / MONEY_DIV).toFixed(2)),
      net: Number((m.n / MONEY_DIV).toFixed(2)),
    })),
    aggConsistency: {
      grossDeltaScaled: (aggCheck?.fact_gross ?? 0) - (aggCheck?.agg_gross ?? 0),
      returnsDeltaScaled: (aggCheck?.fact_ret ?? 0) - (aggCheck?.agg_ret ?? 0),
    },
  };
}

export async function queryCsvCustomerRegistryCounts(
  e: Env,
  u: DbUser,
  batchId: string,
  filters?: Filters,
): Promise<{ registeredClients: number; registeredReps: number }> {
  const acl = scopeForUser(u, filters);
  const clauses = ["c.batch_id=?"];
  const args: (string | number | null)[] = [batchId];
  const budget = { rem: 60 };
  if (acl.allowedRegions.length) {
    clauses.push(inlineInExpr("c.representative_key", acl.allowedRegions, budget, args));
  }
  if (acl.allowedClients.length) {
    clauses.push(inlineInExpr("c.client_key", acl.allowedClients, budget, args));
  }
  const reqReps = filters ? mergeNormalizedKeys(filters.region, filters.regions) : [];
  const reqRepsExc = filters ? mergeNormalizedKeys(undefined, filters.regionsExclude) : [];
  const reqClients = filters ? mergeNormalizedKeys(filters.client, filters.clients) : [];
  const reqClientsExc = filters ? mergeNormalizedKeys(undefined, filters.clientsExclude) : [];
  const reqStates = filters ? mergeNormalizedKeys(filters.state, filters.states) : [];
  const reqStatesExc = filters ? mergeNormalizedKeys(undefined, filters.statesExclude) : [];
  const reqRegionals = filters ? mergeRegionalKeys(filters.regional, filters.regionals) : [];
  const reqRegionalsExc = filters ? mergeRegionalKeys(undefined, filters.regionalsExclude) : [];
  const reqManagers = filters ? mergeNormalizedKeys(filters.manager, filters.managers) : [];
  const reqManagersExc = filters ? mergeNormalizedKeys(undefined, filters.managersExclude) : [];
  const reqSegments = filters ? mergeNormalizedKeys(undefined, filters.segments) : [];
  const reqSegmentsExc = filters ? mergeNormalizedKeys(undefined, filters.segmentsExclude) : [];

  if (reqReps.length) clauses.push(inlineInExpr("c.representative_key", reqReps, budget, args));
  if (reqRepsExc.length) clauses.push(inlineInExpr("c.representative_key", reqRepsExc, budget, args, true));
  if (reqClients.length) clauses.push(inlineInExpr("c.client_key", reqClients, budget, args));
  if (reqClientsExc.length) clauses.push(inlineInExpr("c.client_key", reqClientsExc, budget, args, true));
  if (reqStates.length) clauses.push(inlineInExpr("c.state_key", reqStates, budget, args));
  if (reqStatesExc.length) clauses.push(inlineInExpr("c.state_key", reqStatesExc, budget, args, true));
  if (reqSegments.length) clauses.push(inlineInExpr(sqlUpperPt("c.segment"), reqSegments, budget, args));
  if (reqSegmentsExc.length) clauses.push(inlineInExpr(sqlUpperPt("c.segment"), reqSegmentsExc, budget, args, true));

  const needGeo = reqRegionals.length > 0 || reqRegionalsExc.length > 0 || reqManagers.length > 0 || reqManagersExc.length > 0;
  const geoJoin = needGeo ? "LEFT JOIN ci_dim_regions rg ON rg.batch_id=c.batch_id AND rg.state_key=c.state_key" : "";
  if (reqRegionals.length) clauses.push(inlineInExpr("rg.regional_key", reqRegionals, budget, args));
  if (reqRegionalsExc.length) clauses.push(inlineInExpr("rg.regional_key", reqRegionalsExc, budget, args, true));
  if (reqManagers.length) clauses.push(inlineInExpr("rg.manager_key", reqManagers, budget, args));
  if (reqManagersExc.length) clauses.push(inlineInExpr("rg.manager_key", reqManagersExc, budget, args, true));

  const regCounts = await stmt(
    e,
    `SELECT COUNT(DISTINCT c.client_key) AS clients, COUNT(DISTINCT c.representative_key) AS reps FROM ci_dim_customers c ${geoJoin} WHERE ${clauses.join(" AND ")}`,
    ...args,
  ).first<{ clients: number; reps: number }>();
  return {
    registeredClients: regCounts?.clients ?? 0,
    registeredReps: regCounts?.reps ?? 0,
  };
}

export async function queryCsvChurnedClients(
  e: Env,
  u: DbUser,
  batchId: string,
  filters: Filters,
  comp: NonNullable<Report["comparison"]>,
  preloadedMeta?: Awaited<ReturnType<typeof loadBatchMeta>>,
): Promise<{ totalChurned: number; top: { clientKey: string; name: string; prevGross: number }[] }> {
  const acl = scopeForUser(u, filters);
  const { hasCalendar, hasDenormMacro } = preloadedMeta ?? (await loadBatchMeta(e, batchId));
  const curW = buildFactWhere("s", batchId, filters, acl, hasCalendar, hasDenormMacro, undefined, "single_range", comp.current.from, comp.current.to);
  const prevW = buildFactWhere("s", batchId, filters, acl, hasCalendar, hasDenormMacro, undefined, "single_range", comp.previous.from, comp.previous.to);
  if (curW.emptyIntersection) return { totalChurned: 0, top: [] };

  const spanFrom = comp.previous.from < comp.current.from ? comp.previous.from : comp.current.from;
  const spanTo = comp.previous.to > comp.current.to ? comp.previous.to : comp.current.to;
  const churnRows = (
    await stmt(
      e,
      `WITH by_c AS (
         SELECT COALESCE(s.client_key, NULL) AS client_key,
           SUM(CASE WHEN ${curW.clause} AND s.gross_amount>0 THEN s.gross_amount ELSE 0 END) AS cur_g,
           SUM(CASE WHEN ${prevW.clause} THEN s.gross_amount ELSE 0 END) AS prev_g
         FROM ci_fact_sales s ${curW.joins}
         WHERE s.batch_id=? AND s.client_key IS NOT NULL AND s.date BETWEEN ? AND ? AND ((s.date BETWEEN ? AND ?) OR (s.date BETWEEN ? AND ?))
         GROUP BY COALESCE(s.client_key, NULL)
       )
       SELECT client_key, prev_g, (SELECT COUNT(*) FROM by_c WHERE prev_g>0 AND cur_g=0) AS total_churned
       FROM by_c WHERE prev_g>0 AND cur_g=0 ORDER BY prev_g DESC, client_key ASC LIMIT 10`,
      ...curW.args,
      ...prevW.args,
      batchId,
      spanFrom,
      spanTo,
      comp.current.from,
      comp.current.to,
      comp.previous.from,
      comp.previous.to,
    ).all<{ client_key: string; prev_g: number; total_churned: number }>()
  ).results;

  if (!churnRows.length) return { totalChurned: 0, top: [] };
  const keys = churnRows.map((r) => r.client_key);
  const nameArgs: (string | number | null)[] = [batchId];
  const inKeys = inlineInExpr("client_key", keys, { rem: 60 }, nameArgs);
  const nameRows = (
    await stmt(
      e,
      `SELECT client_key, client_raw, name FROM ci_dim_customers WHERE batch_id=? AND ${inKeys}`,
      ...nameArgs,
    ).all<{ client_key: string; client_raw: string; name: string | null }>()
  ).results;
  const nameMap = new Map(
    nameRows.map((d) => [d.client_key, d.name ? `${d.client_raw || d.client_key} — ${d.name}` : d.client_raw || d.client_key]),
  );

  return {
    totalChurned: churnRows[0].total_churned,
    top: churnRows.map((r) => ({
      clientKey: r.client_key,
      name: nameMap.get(r.client_key) ?? r.client_key,
      prevGross: r.prev_g / MONEY_DIV,
    })),
  };
}

export async function askCsvDeterministic(
  e: Env,
  u: DbUser,
  batchId: string,
  question: string,
  activeFilters: Filters,
): Promise<{
  plan: Plan;
  report: Report;
  commentary: Commentary;
  meta: { engine: "deterministic"; latencyMs: number; openaiCalls: 0; mode: "shadow" };
}> {
  const t0 = Date.now();
  scopeForUser(u, activeFilters);
  const meta = await loadBatchMeta(e, batchId);
  const { batch } = meta;

  const capabilities: NonNullable<Report["sourceInfo"]>["capabilities"] = {
    metrics: ["gross", "revenue", "returns", "buyers"],
    groups: ["month", "client", "region", "product", "category", "state", "regional", "manager"],
    filters: ["region", "client", "product", "category", "state", "regional", "manager"],
  };

  const intent = routeCommercialIntent(question, activeFilters, capabilities, []);
  if (!intent) {
    fail(422, "Pergunta aberta fora do roteador determinístico; o modo shadow não envia dados reais à OpenAI.");
  }

  const needActiveReps = intent.kind === "rep_registered_count" || intent.kind === "rep_active_count";
  const skipMonthlySeries =
    intent.kind === "customer_counts" ||
    intent.kind === "buyers_period" ||
    intent.kind === "rep_registered_count" ||
    intent.kind === "rep_active_count";
  const queryOpts: ReportQueryOptions = {
    preloadedMeta: meta,
    includeDocs: false,
    includeActiveReps: needActiveReps,
    skipMonthlySeries,
  };

  const shadowProvider: DataProvider = {
    sourceType: "manual",
    versionId: batchId,
    semantics: {
      allowAI: false,
      measures: { revenue: "Faturamento líquido", gross: "Faturamento bruto", returns: "Devoluções", buyers: "Clientes compradores", margin: null },
      capabilities,
    },
    query: (p) => queryCsvReport(e, u, batchId, p, queryOpts),
    search: (_f, dimension, query) =>
      dimension === "category"
        ? searchCsvCategory(e, batchId, query)
        : Promise.resolve({ items: [], truncated: false }),
  };

  const plan = await resolvePlanEntities(shadowProvider, intent.plan, activeFilters);
  const report = await queryCsvReport(e, u, batchId, plan, queryOpts);
  const comp = report.comparison!;
  const netCurrent = report.total.values.revenue.current;
  const srcNote = `Fonte: Camada CSV estruturada (shadow · base até ${batch.reference_date ?? comp.current.to}). Recorte: ${comp.current.from} a ${comp.current.to} contra ${comp.previous.from} a ${comp.previous.to}.`;

  let commentary: Commentary;
  if (
    intent.kind === "customer_counts" ||
    intent.kind === "buyers_period" ||
    intent.kind === "rep_registered_count" ||
    intent.kind === "rep_active_count"
  ) {
    const regCounts = await queryCsvCustomerRegistryCounts(e, u, batchId, plan.filters);

    const registeredClients = regCounts.registeredClients;
    const buyingClients = report.total.values.buyers.current ?? 0;
    const registeredReps = regCounts.registeredReps;
    const activeReps = report.summaryStats?.activeReps ?? 0;

    if (intent.kind === "customer_counts") {
      commentary = {
        summary: `Existem ${registeredClients.toLocaleString("pt-BR")} clientes distintos cadastrados na Base Clientes dentro do seu escopo autorizado. No período selecionado, ${buyingClients.toLocaleString("pt-BR")} compraram. ${srcNote}`,
        actions: ["Separar a carteira cadastrada da compradora ativa."],
      };
    } else if (intent.kind === "buyers_period") {
      commentary = {
        summary: `${buyingClients.toLocaleString("pt-BR")} clientes distintos realizaram compras no período selecionado, de ${registeredClients.toLocaleString("pt-BR")} cadastrados. Líquido: ${pretty(netCurrent, "revenue")}. ${srcNote}`,
        actions: ["Comparar evolução de compradores por UF ou regional."],
      };
    } else if (intent.kind === "rep_registered_count") {
      commentary = {
        summary: `Existem ${registeredReps.toLocaleString("pt-BR")} representantes distintos cadastrados no escopo autorizado; ${activeReps.toLocaleString("pt-BR")} tiveram vendas no período. ${srcNote}`,
        actions: ["Revisar representantes cadastrados sem venda no período."],
      };
    } else {
      commentary = {
        summary: `${activeReps.toLocaleString("pt-BR")} representantes distintos tiveram vendas no período selecionado, de ${registeredReps.toLocaleString("pt-BR")} cadastrados. Líquido: ${pretty(netCurrent, "revenue")}. ${srcNote}`,
        actions: ["Consultar ranking de representantes para detalhar expansão."],
      };
    }
  } else if (intent.kind === "churned_clients") {
    const churn = await queryCsvChurnedClients(e, u, batchId, plan.filters, comp, meta);
    commentary = {
      summary: `${churn.totalChurned.toLocaleString("pt-BR")} clientes compraram no período homólogo anterior (${comp.previous.from} a ${comp.previous.to}) e zeraram no período atual (${comp.current.from} a ${comp.current.to}). ${srcNote}`,
      actions: ["Priorizar contato com clientes inativados de maior volume histórico."],
    };
  } else if (intent.kind === "category_mix_share") {
    const totalNet = netCurrent ?? 0;
    const denom = totalNet > 0 ? totalNet : report.rows.reduce((a, r) => a + Math.max(0, r.values.revenue.current ?? 0), 0);
    const shares = report.rows
      .slice(0, 8)
      .map((r) => {
        const v = r.values.revenue.current ?? 0;
        const pct = denom > 0 ? (v / denom) * 100 : 0;
        return `${r.name}: ${pretty(v, "revenue")} (${pct.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%)`;
      })
      .join("; ");
    commentary = {
      summary: `Participação sobre o líquido de ${pretty(netCurrent, "revenue")}: ${shares}. ${srcNote}`,
      actions: ["Usar filtros individuais por Macro Categoria ou Grupo Item para isolar linhas independentes."],
    };
  } else if (intent.kind === "category_filtered" || intent.kind === "metric_summary" || intent.kind === "yoy_growth") {
    const m = plan.metric;
    const p = report.total.values[m];
    const diff = p.current !== null && p.previous !== null ? p.current - p.previous : null;
    const pct = change(p, m);
    const filterDesc = [
      plan.filters.state ? `UF ${plan.filters.state}` : "",
      plan.filters.categoriesInclude?.length ? `Incluindo: ${plan.filters.categoriesInclude.join(", ")}` : "",
      plan.filters.categoriesExclude?.length ? `Excluindo: ${plan.filters.categoriesExclude.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    commentary = {
      summary: `${filterDesc ? `[${filterDesc}] ` : ""}${metrics[m].label}: ${pretty(p.current, m)} ante ${pretty(p.previous, m)} (diferença ${diff !== null ? (diff > 0 ? "+" : "") + pretty(diff, m) : "—"}; ${deltaTitle(pct, m)}). Bruto: ${pretty(report.total.values.gross.current, "gross")}, devoluções: ${pretty(report.total.values.returns.current, "returns")}. ${srcNote}`,
      actions: ["Detalhar por categoria, produto, cliente ou UF nos relatórios."],
    };
  } else {
    const top = report.rows
      .slice(0, 5)
      .map((r) => `${r.name}: ${pretty(r.values[plan.metric].current, plan.metric)} vs ${pretty(r.values[plan.metric].previous, plan.metric)}`)
      .join("; ");
    commentary = {
      summary: `Ranking de ${groups[plan.group]}: ${top || "sem registros"}. Total: ${pretty(netCurrent, "revenue")}. ${srcNote}`,
      actions: ["Abrir o ranking completo nos Relatórios."],
    };
  }

  return {
    plan,
    report,
    commentary,
    meta: {
      engine: "deterministic",
      latencyMs: Date.now() - t0,
      openaiCalls: 0,
      mode: "shadow",
    },
  };
}

export { metricKeys };
