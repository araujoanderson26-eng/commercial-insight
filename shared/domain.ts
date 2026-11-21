import { z } from "zod";
export const roles = {
  admin: "Administrador",
  diretoria: "Diretoria",
  gerente: "Gerente Regional",
  comercial: "Usuário Comercial",
  operador: "Operador de atualização",
} as const;
export type Role = keyof typeof roles;
export const metrics = {
  revenue: { label: "Faturamento", unit: "money", up: true },
  gross: { label: "Faturamento bruto", unit: "money", up: true },
  margin: { label: "Margem comercial", unit: "percent", up: true },
  buyers: { label: "Clientes compradores", unit: "count", up: true },
  returns: { label: "Devoluções", unit: "money", up: false },
} as const;
export type Metric = keyof typeof metrics;
export const groups = {
  month: "Evolução mensal",
  client: "Clientes",
  region: "Regionais",
  product: "Produtos",
  category: "Categorias",
  regional: "Regionais comerciais",
  state: "UF",
  manager: "Gerentes",
} as const;
export type Group = keyof typeof groups;
export const filterDimensions = ["region", "client", "product", "category", "regional", "state", "manager"] as const;
export type FilterDimension = typeof filterDimensions[number];
export const extendedFilterDimensions = [
  "regional",
  "manager",
  "region",
  "state",
  "municipality",
  "client",
  "product",
  "macroCategory",
  "itemGroup",
  "channel",
  "brand",
  "segment",
] as const;
export type ExtendedFilterDimension = typeof extendedFilterDimensions[number];
export type ExtraFilterCapability = "municipality" | "channel" | "brand" | "segment" | "macroCategory" | "itemGroup";
export type DataCapabilities = {
  metrics: Metric[];
  groups: Group[];
  filters: FilterDimension[];
  extraFilters?: ExtraFilterCapability[];
  labels?: Partial<Record<FilterDimension | ExtendedFilterDimension | Group | Metric, string>>;
  unavailable?: Partial<Record<FilterDimension | Group, string>>;
};
export const OFFICIAL_REGIONAL_LABELS: Record<string, string> = {
  SP: "São Paulo",
  "SUDESTE 1": "Sudeste 1",
  "SUDESTE 2": "Sudeste 2",
  "SUL 1": "Sul 1",
  "SUL 2": "Sul 2",
  "CENTRO OESTE 1": "Centro-Oeste 1",
  "CENTRO OESTE 2": "Centro-Oeste 2",
  NORTE: "Norte",
  NORDESTE: "Nordeste",
  EX: "Exportação (EX)",
};
export function normalizeRegionalKey(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.normalize("NFC").trim();
  if (!trimmed) return null;
  const ascii = trimmed
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  if (ascii === "SP" || ascii === "SAO PAULO") return "SP";
  if (ascii === "CENTRO OESTE 1") return "CENTRO OESTE 1";
  if (ascii === "CENTRO OESTE 2") return "CENTRO OESTE 2";
  if (ascii === "EX" || ascii === "EXPORTACAO" || ascii === "EXPORTACAO (EX)") return "EX";
  if (ascii === "SUDESTE 1" || ascii === "SUDESTE 2" || ascii === "SUL 1" || ascii === "SUL 2" || ascii === "NORTE" || ascii === "NORDESTE") {
    return ascii;
  }
  return trimmed.toLocaleUpperCase("pt-BR");
}
export function formatOfficialRegionalName(keyOrRaw: string | null | undefined): string {
  if (keyOrRaw == null) return "";
  const trimmed = keyOrRaw.normalize("NFC").trim();
  if (!trimmed) return "";
  const key = normalizeRegionalKey(trimmed);
  if (key && OFFICIAL_REGIONAL_LABELS[key]) return OFFICIAL_REGIONAL_LABELS[key];
  return trimmed;
}
export const metricKeys = Object.keys(metrics) as Metric[];
export const dateRE = /^\d{4}-(0[1-9]|1[0-2])$/;
const month = z
  .string()
  .regex(dateRE)
  .refine((s) => +s.slice(0, 4) >= 2001 && +s.slice(0, 4) <= 2100);
const val = z.string().trim().max(140).default("");
const multiVal = z.array(z.string().trim().min(1).max(140)).max(100).optional();
export const filtersSchema = z
  .object({
    from: month,
    to: month,
    region: val,
    client: val,
    product: val,
    regional: z.string().trim().max(140).optional(),
    state: z.string().trim().max(140).optional(),
    manager: z.string().trim().max(140).optional(),
    municipality: z.string().trim().max(140).optional(),
    category: z.string().trim().max(140).optional(),
    categoriesInclude: multiVal,
    categoriesExclude: multiVal,
    regions: multiVal,
    regionsExclude: multiVal,
    regionals: multiVal,
    regionalsExclude: multiVal,
    states: multiVal,
    statesExclude: multiVal,
    managers: multiVal,
    managersExclude: multiVal,
    municipalities: multiVal,
    municipalitiesExclude: multiVal,
    clients: multiVal,
    clientsExclude: multiVal,
    products: multiVal,
    productsExclude: multiVal,
    channels: multiVal,
    channelsExclude: multiVal,
    segments: multiVal,
    segmentsExclude: multiVal,
    brands: multiVal,
    brandsExclude: multiVal,
    revenueMin: z.number().finite().optional(),
    revenueMax: z.number().finite().optional(),
    ticketMin: z.number().finite().optional(),
    ticketMax: z.number().finite().optional(),
    variationDirection: z.enum(["all", "growth", "decline"]).optional(),
  })
  .strict()
  .refine((v) => {
    const n = monthsBetween(v.from, v.to);
    return n >= 0 && n < 24;
  }, "Selecione de 1 a 24 meses.")
  .refine(
    (v) => v.revenueMin === undefined || v.revenueMax === undefined || v.revenueMin <= v.revenueMax,
    "O faturamento mínimo não pode ser maior que o máximo.",
  )
  .refine(
    (v) => v.ticketMin === undefined || v.ticketMax === undefined || v.ticketMin <= v.ticketMax,
    "O ticket mínimo não pode ser maior que o máximo.",
  );
export type Filters = z.infer<typeof filtersSchema>;
export function detectFilterConflicts(filters: Filters): string[] {
  const conflicts: string[] = [];
  const fold = (s: string) => s.normalize("NFC").trim().toLocaleUpperCase("pt-BR");
  const inc = new Set((filters.categoriesInclude ?? []).map(fold));
  const exc = new Set((filters.categoriesExclude ?? []).map(fold));
  const overlap = [...inc].filter((v) => exc.has(v));
  if (overlap.length) {
    const prettyOverlap = overlap.map((v) =>
      v.startsWith("MACRO CATEGORIA: ") ? `Macrocategoria: ${v.slice(17)}` : v,
    );
    conflicts.push(
      `Categoria selecionada para incluir e excluir simultaneamente (${prettyOverlap.join(", ")}): a exclusão prevalece no resultado.`,
    );
  }
  if (filters.category && exc.has(fold(filters.category))) {
    conflicts.push(
      `A categoria selecionada (${filters.category}) está também marcada para exclusão: a exclusão prevalece.`,
    );
  }
  const checkOverlap = (
    label: string,
    singleVal: string | undefined,
    incList: string[] | undefined,
    excList: string[] | undefined,
    norm: (v: string) => string = fold,
    fmt: (v: string) => string = (v) => v,
  ) => {
    const excSet = new Set((excList ?? []).map(norm).filter(Boolean));
    if (!excSet.size) return;
    const matched: string[] = [];
    const seen = new Set<string>();
    for (const raw of [...(singleVal ? [singleVal] : []), ...(incList ?? [])]) {
      const k = norm(raw);
      if (k && excSet.has(k) && !seen.has(k)) {
        seen.add(k);
        matched.push(fmt(raw));
      }
    }
    if (matched.length) {
      conflicts.push(
        `${label} com item selecionado para incluir e excluir simultaneamente (${matched.join(", ")}): a exclusão prevalece no resultado.`,
      );
    }
  };
  checkOverlap(
    "Regional",
    filters.regional,
    filters.regionals,
    filters.regionalsExclude,
    (v) => normalizeRegionalKey(v) ?? fold(v),
    (v) => formatOfficialRegionalName(v),
  );
  checkOverlap("Gerente Regional", filters.manager, filters.managers, filters.managersExclude);
  checkOverlap("Representante", filters.region, filters.regions, filters.regionsExclude);
  checkOverlap("UF", filters.state, filters.states, filters.statesExclude);
  checkOverlap("Município", filters.municipality, filters.municipalities, filters.municipalitiesExclude);
  checkOverlap("Cliente", filters.client, filters.clients, filters.clientsExclude);
  checkOverlap("Produto", filters.product, filters.products, filters.productsExclude);
  checkOverlap("Canal comercial", undefined, filters.channels, filters.channelsExclude);
  checkOverlap("Marca", undefined, filters.brands, filters.brandsExclude);
  checkOverlap("Segmento", undefined, filters.segments, filters.segmentsExclude);
  if (filters.revenueMin !== undefined && filters.revenueMax !== undefined && filters.revenueMin > filters.revenueMax) {
    conflicts.push("Faixa de faturamento conflitante: valor mínimo maior que o máximo.");
  }
  if (filters.ticketMin !== undefined && filters.ticketMax !== undefined && filters.ticketMin > filters.ticketMax) {
    conflicts.push("Faixa de ticket médio conflitante: valor mínimo maior que o máximo.");
  }
  return conflicts;
}
export function monthsBetween(a: string, b: string) {
  return (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5) - +a.slice(5));
}
export function defaultFilters(): Filters {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const y = +today.slice(0, 4),
    m = +today.slice(5, 7);
  const fmt = (offset: number) =>
    new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 7);
  return { from: fmt(-6), to: fmt(-1), region: "", client: "", product: "" };
}
export const planSchema = z
  .object({
    group: z.enum(["month", "client", "region", "product", "category", "regional", "state", "manager"]),
    metric: z.enum(["revenue", "gross", "margin", "buyers", "returns"]),
    filters: filtersSchema,
    order: z.enum(["current", "decline", "growth"]),
  })
  .strict();
export type Plan = z.infer<typeof planSchema>;
export type Pair = { current: number | null; previous: number | null };
export type Row = { name: string; key?: string; description?: string; descriptionConflict?: boolean; values: Record<Metric, Pair>; canDrill?: boolean };
export type Report = {
  total: Row;
  rows: Row[];
  plan: Plan;
  asOf: string;
  truncated: boolean;
  source: "Power BI" | "Arquivo manual (D1)";
  comparison?: {
    current: { from: string; to: string };
    previous: { from: string; to: string };
    status: "comparable" | "partial" | "outside-coverage";
    reason?: string;
  };
  warnings?: string[];
  filterConflicts?: string[];
  summaryStats?: {
    activeReps?: number | null;
    registeredClients?: number | null;
    registeredReps?: number | null;
    invoiceCount?: number | null;
    ticketPerBuyer?: number | null;
    ticketPerInvoice?: number | null;
  };
  sourceInfo?: {
    versionId: string;
    extractedAt: string;
    sourceUpdatedAt: string | null;
    referenceDate: string;
    coverage: { from: string; to: string };
    publishedAt?: string;
    model?: string;
    metrics?: Partial<Record<Metric, { status: "validated" | "pending" | "unavailable"; reason?: string }>>;
    capabilities?: DataCapabilities;
  };
};
export type Commentary = { summary: string; actions: string[] };
export type User = {
  id: string;
  name: string;
  email: string;
  role: Role;
  national: boolean;
  regions: string[];
  clients: string[];
  active: boolean;
  entraOid: string | null;
};
export type Session = {
  user: User;
  policyVersion: string;
  integrations: {
    configured: boolean;
    mode: "application" | "delegated";
    linked: boolean;
    ai: boolean;
  };
  expires: number;
  data?: {
    source: "manual" | "powerbi";
    ready: boolean;
    activeVersionId: string | null;
    extractedAt: string | null;
    stale: boolean;
    referenceDate?: string | null;
    model?: string | null;
    storageEngine?: "csv" | "ndjson" | null;
    capabilities?: DataCapabilities;
  };
};
export const identifier = z
  .string()
  .trim()
  .min(1)
  .max(110)
  .regex(/^[\p{L}\p{N} _%.$()/ºª+-]+$/u, "Use apenas o nome simples da tabela, medida ou coluna.");
const column = z.object({ table: identifier, column: identifier }).strict();
export const configSchema = z
  .object({
    tenant: z.uuid(),
    application: z.uuid(),
    workspace: z.uuid().or(z.literal("me")),
    dataset: z.uuid(),
    mode: z.enum(["delegated", "application"]),
    factTable: identifier,
    columns: z
      .object({ date: column, region: column, client: column, product: column, category: column })
      .strict(),
    measures: z
      .object({
        revenue: identifier,
        margin: identifier.nullable(),
        buyers: identifier.nullable(),
        returns: identifier.nullable(),
        gross: identifier.nullable().optional(),
      })
      .strict(),
    marginScale: z.enum(["fraction", "points"]),
    scopedMeasuresReviewed: z.boolean(),
    allowAI: z.boolean(),
  })
  .strict()
  .refine((m) => m.workspace !== "me" || m.mode === "delegated", {
    path: ["workspace"], message: "Meu workspace requer uma conta Microsoft vinculada no modo delegado.",
  });
export type ModelConfig = z.infer<typeof configSchema>;
export function change(p: Pair, m: Metric) {
  if (p.current === null || p.previous === null || !Number.isFinite(p.current) || !Number.isFinite(p.previous)) return null;
  if (m === "margin") return p.current - p.previous;
  return p.previous <= 0 ? null : (100 * (p.current - p.previous)) / p.previous;
}
/** Growth percentages require a positive denominator. Absolute movement remains observable. */
export function comparison(p: Pair, m: Metric) {
  const present = p.current !== null && p.previous !== null && Number.isFinite(p.current) && Number.isFinite(p.previous);
  const absolute = present ? p.current! - p.previous! : null;
  const status: "comparable" | "missing" | "zero-base" | "negative-base" = !present ? "missing" : m === "margin" || p.previous! > 0 ? "comparable" : p.previous === 0 ? "zero-base" : "negative-base";
  return { status, absolute, percent: change(p, m), favorable: absolute === null || absolute === 0 ? null : metrics[m].up ? absolute > 0 : absolute < 0 };
}
export function pretty(n: number | null, m: Metric, compact = false) {
  if (n === null) return "—";
  const unit = metrics[m].unit;
  return (
    new Intl.NumberFormat("pt-BR", {
      ...(unit === "money" ? { style: "currency", currency: "BRL" as const } : {}),
      notation: compact && Math.abs(n) >= 10000 ? "compact" : "standard",
      maximumFractionDigits: unit === "count" ? 0 : compact ? 1 : 2,
    }).format(n) + (unit === "percent" ? "%" : "")
  );
}
export function deltaTitle(n: number | null, m: Metric) {
  return n === null
    ? "Sem base comparável"
    : (n > 0 ? "+" : "") +
        n.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) +
        (m === "margin" ? " p.p." : "%");
}
