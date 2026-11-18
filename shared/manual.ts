import { z } from "zod";

export const MANUAL_FORMAT = "commercial-insight";
export const MANUAL_SOURCE = "commercial-main";
export const UPLOAD_PART_BYTES = 5 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_DATA_PART_BYTES = 1024 * 1024;
export const DEFAULT_MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const iso = z.iso.datetime({ offset: true });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(s + "T00:00:00Z");
  return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === s;
}, "Data inválida");
const name = z.string().min(1).max(200);
export const partSchema = z.object({
  index: z.number().int().positive(), rows: z.number().int().min(1).max(100),
  bytes: z.number().int().positive().max(MAX_DATA_PART_BYTES), sha256: hash,
}).strict();
const metric = z.enum(["revenue", "margin", "buyers", "returns"]);
const dimensions = z.enum(["date", "region", "client", "product", "category", "state"]);
export const manualMetricSchema = z.object({
  id: metric, originalName: name, dax: z.string().max(32000),
  unit: z.enum(["money", "count", "percent"]),
  kind: z.enum(["sum", "distinctClient", "ratio", "unavailable"]),
  component: name.optional(), numerator: name.optional(), denominator: name.optional(),
  scale: z.number().int().min(0).max(6),
  status: z.enum(["validated", "pending", "unavailable"]),
  reason: z.string().max(2000).optional(), supportedFilters: z.array(dimensions),
}).strict();
export const controlFiltersSchema = z.object({
  from: date, to: date, region: z.string().max(200).optional(),
  client: z.string().max(200).optional(), product: z.string().max(200).optional(),
  category: z.string().max(200).optional(), state: z.string().max(200).optional(),
}).strict();
export const manifestSchema = z.object({
  kind: z.literal("manifest"), format: z.literal(MANUAL_FORMAT), formatVersion: z.literal(1),
  sourceId: z.literal(MANUAL_SOURCE), model: z.object({ name, id: name }).strict(),
  extractedAt: iso, sourceUpdatedAt: iso.nullable(), referenceDate: date,
  synthetic: z.boolean(), stableExtraction: z.literal(true),
  inventory: z.object({
    tables: z.array(z.object({
      id: name, name, columns: z.array(z.object({ name, type: name }).passthrough()).min(1).max(2000),
      rowCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      sourceRowCount: z.number().int().nonnegative().optional(),
      allowEmpty: z.boolean(), storageMode: name, partitions: z.array(z.unknown()),
      parts: z.array(partSchema),
    }).passthrough()).min(1).max(1000),
    measures: z.array(z.unknown()), relationships: z.array(z.unknown()),
    dependencies: z.array(z.unknown()), excluded: z.array(z.unknown()),
  }).strict(),
  projection: z.object({
    rowCount: z.number().int().positive(), from: date, to: date,
    grain: z.string().min(1).max(2000), dimensions: z.array(dimensions), parts: z.array(partSchema).min(1),
  }).strict(),
  metrics: z.array(manualMetricSchema).min(1).max(100),
  controls: z.array(z.object({
    metric, context: z.enum(["total", "month", "region", "client", "product", "state"]),
    filters: controlFiltersSchema, expected: z.string().max(100).nullable(),
    dax: z.string().min(1).max(32000), referenceDate: date,
    tolerance: z.string().max(30),
  }).strict()).min(6).max(10000),
}).strict();
export type ManualManifest = z.infer<typeof manifestSchema>;
export type ManualMetric = z.infer<typeof manualMetricSchema>;
export type ControlFilters = z.infer<typeof controlFiltersSchema>;
export type Fact = {
  row: number; date: string; region: string; client: string; product: string; category: string;
  state: string; values: Record<string, string | null>;
};
export const factSchema = z.object({
  row: z.number().int().positive(), date, region: z.string().min(1).max(200),
  client: z.string().min(1).max(200), product: z.string().min(1).max(200),
  category: z.string().max(200), state: z.string().max(200),
  values: z.record(name, z.string().max(100).nullable()),
}).strict();

/** Decimal strings are converted to integers before D1 aggregation. No rounding is implicit. */
export function decimalInteger(value: string, scale: number): number {
  if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value)) throw new Error("Decimal inválido: use ponto e sem expoente.");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale)))
    throw new Error("Precisão excede a escala declarada; não é permitido arredondamento silencioso.");
  const n = BigInt(whole) * 10n ** BigInt(scale) + BigInt((fraction.slice(0, scale)).padEnd(scale, "0") || "0");
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Decimal excede o limite inteiro seguro.");
  return Number(negative ? -n : n);
}
