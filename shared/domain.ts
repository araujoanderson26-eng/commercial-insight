import { z } from "zod";
export const roles = {
  admin: "Administrador",
  diretoria: "Diretoria",
  gerente: "Gerente Regional",
  comercial: "Usuário Comercial",
} as const;
export type Role = keyof typeof roles;
export const metrics = {
  revenue: { label: "Faturamento", unit: "money", up: true },
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
} as const;
export type Group = keyof typeof groups;
export const metricKeys = Object.keys(metrics) as Metric[];
export const dateRE = /^\d{4}-(0[1-9]|1[0-2])$/;
const month = z
  .string()
  .regex(dateRE)
  .refine((s) => +s.slice(0, 4) >= 2001 && +s.slice(0, 4) <= 2100);
const val = z.string().trim().max(140).default("");
export const filtersSchema = z
  .object({ from: month, to: month, region: val, client: val, product: val })
  .strict()
  .refine((v) => {
    const n = monthsBetween(v.from, v.to);
    return n >= 0 && n < 24;
  }, "Selecione de 1 a 24 meses.");
export type Filters = z.infer<typeof filtersSchema>;
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
    group: z.enum(["month", "client", "region", "product", "category"]),
    metric: z.enum(["revenue", "margin", "buyers", "returns"]),
    filters: filtersSchema,
    order: z.enum(["current", "decline", "growth"]),
  })
  .strict();
export type Plan = z.infer<typeof planSchema>;
export type Pair = { current: number | null; previous: number | null };
export type Row = { name: string; values: Record<Metric, Pair> };
export type Report = {
  total: Row;
  rows: Row[];
  plan: Plan;
  asOf: string;
  truncated: boolean;
  source: "Power BI" | "Arquivo manual (D1)";
  sourceInfo?: {
    versionId: string;
    extractedAt: string;
    sourceUpdatedAt: string | null;
    referenceDate: string;
    coverage: { from: string; to: string };
    publishedAt?: string;
    model?: string;
    metrics?: Partial<Record<Metric, { status: "validated" | "pending" | "unavailable"; reason?: string }>>;
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
  if (p.current === null || p.previous === null) return null;
  if (m === "margin") return p.current - p.previous;
  return p.previous === 0 ? null : (100 * (p.current - p.previous)) / Math.abs(p.previous);
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
