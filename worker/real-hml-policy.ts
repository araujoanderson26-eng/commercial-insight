import { createHash } from "node:crypto";
import { z } from "zod";
import { type Filters, type Plan } from "../shared/domain";
import { manifestSchema, type ManualManifest } from "../shared/manual";
import { fail, stmt, type DbUser, type Env } from "./core";

export const controlledHmlOrigin = "https://commercial-insight-hml.araujo-anderson26.workers.dev";
export const controlledHmlAdminId = "e95a9a9c-0ed2-47fc-9ced-f76615f260ab";
const scopeAlias = "CARTEIRA_AUTORIZADA";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const code = z.string().regex(/^[\p{L}\p{N}._/-]{1,100}$/u);
const schema = z.object({
  runId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), expiresAt: z.iso.datetime({ offset: true }),
  packageSha256: hash, manifestSha256: hash, sourceModelId: z.string().min(1).max(200),
  extractedAt: z.iso.datetime({ offset: true }), referenceDate: z.iso.date(),
  allowedQuestionHashes: z.array(hash).length(4), allowedClientCodes: z.array(code).min(1).max(100),
  allowedUserIds: z.array(z.uuid()).length(2),
  period: z.object({ from: z.literal("2026-01"), to: z.literal("2026-10") }).strict(),
  scopedFilters: z.object({ state: z.literal("SP"), region: z.string().min(1).max(200) }).strict(),
}).strict();
export type ControlledHmlPolicy = z.infer<typeof schema>;
export const hmlQuestionHash = (question: string) => createHash("sha256").update(question.trim()).digest("hex");
/** Hash the schema-validated, serialized manifest; independent of upload whitespace/key order. */
export const hmlManifestHash = (manifest: ManualManifest) => createHash("sha256").update(JSON.stringify(manifestSchema.parse(manifest))).digest("hex");

export function controlledHmlPolicy(e: Env, active = false): ControlledHmlPolicy | null {
  if (e.HML_REAL_DATA_AUTHORIZATION === undefined) {
    if (e.APP_ORIGIN === controlledHmlOrigin && e.HML_SYNTHETIC_ONLY !== "true")
      fail(503, "A homologação exige uma autorização específica para dados reais.");
    return null;
  }
  let policy: ControlledHmlPolicy;
  try { policy = schema.parse(JSON.parse(e.HML_REAL_DATA_AUTHORIZATION)); }
  catch { fail(503, "A autorização de dados reais da homologação está inválida."); }
  if (e.APP_ORIGIN !== controlledHmlOrigin || e.HML_SYNTHETIC_ONLY !== "false"
    || !policy.allowedUserIds.includes(controlledHmlAdminId) || new Set(policy.allowedUserIds).size !== 2
    || new Set(policy.allowedQuestionHashes).size !== 4 || new Date(policy.expiresAt).valueOf() > Date.now() + 86400000)
    fail(503, "A autorização de dados reais não corresponde à homologação controlada.");
  if (active && new Date(policy.expiresAt).valueOf() <= Date.now())
    fail(403, "A autorização temporária de dados reais expirou. Nenhuma chamada OpenAI foi iniciada.");
  return policy;
}

export function assertControlledHmlUser(e: Env, userId: string) {
  const policy = controlledHmlPolicy(e);
  if (policy && !policy.allowedUserIds.includes(userId))
    fail(403, "Este usuário não participa da validação temporária com dados reais.");
}

/** A temporary data authorization refines existing ACLs; it never modifies user records. */
export function controlledHmlFilters(e: Env, user: Pick<DbUser, "id">, filters: Filters): Filters {
  const policy = controlledHmlPolicy(e);
  if (!policy) return filters;
  assertControlledHmlUser(e, user.id);
  if (filters.from < policy.period.from || filters.to > policy.period.to)
    fail(403, "O período está fora do recorte autorizado para esta validação.");
  if (filters.client && !policy.allowedClientCodes.includes(filters.client))
    fail(403, "Selecione o código de cliente autorizado para a visita.");
  if (user.id === controlledHmlAdminId) return filters;
  if ((filters.state && filters.state !== policy.scopedFilters.state)
    || (filters.region && filters.region !== policy.scopedFilters.region))
    fail(403, "O recorte autorizado está restrito a São Paulo e ao representante selecionado.");
  return { ...filters, ...policy.scopedFilters };
}

export function assertControlledHmlPackage(e: Env, sha256: string) {
  const policy = controlledHmlPolicy(e, true);
  if (policy && sha256 !== policy.packageSha256) fail(403, "O pacote não corresponde à amostra real autorizada.");
}

export function assertControlledHmlManifest(e: Env, manifest: ManualManifest, packageSha256?: string, active = false) {
  const policy = controlledHmlPolicy(e, !manifest.synthetic && active);
  if (manifest.synthetic) return; // Synthetic rollback remains available after the real trial expires.
  if (e.HML_SYNTHETIC_ONLY === "true")
    fail(403, "Esta homologação aceita exclusivamente pacotes sintéticos.");
  if (!policy) return;
  if (packageSha256 !== policy.packageSha256 || hmlManifestHash(manifest) !== policy.manifestSha256
    || manifest.model.id !== policy.sourceModelId || manifest.extractedAt !== policy.extractedAt
    || manifest.referenceDate !== policy.referenceDate)
    fail(403, "O manifesto não corresponde ao snapshot real autorizado.");
}

export function controlledHmlQuestion(e: Env, question: string, actorId?: string) {
  const policy = controlledHmlPolicy(e, true);
  if (!policy) return null;
  if (!actorId) fail(403, "A chamada real exige um participante autorizado.");
  assertControlledHmlUser(e, actorId);
  const questionHash = hmlQuestionHash(question), index = policy.allowedQuestionHashes.indexOf(questionHash);
  if (index < 0 || (index === 0 && actorId !== controlledHmlAdminId))
    fail(403, "Esta pergunta não faz parte do roteiro real autorizado.");
  return { policy, questionHash, index };
}

export function controlledHmlPlan(e: Env, question: string, actorId: string | undefined, filters: Filters): Filters {
  const allowed = controlledHmlQuestion(e, question, actorId);
  if (!allowed) return filters;
  const narrowed = { ...restoreControlledHmlAliases(e, filters), ...allowed.policy.period };
  checkedQuestionFilters(allowed.policy, allowed.index, narrowed);
  return narrowed;
}

export function restoreControlledHmlAliases(e: Env, filters: Filters): Filters {
  const policy = controlledHmlPolicy(e);
  return policy && filters.region === scopeAlias ? { ...filters, region: policy.scopedFilters.region } : filters;
}

function checkedQuestionFilters(policy: ControlledHmlPolicy, index: number, filters: Filters) {
  const restored = { ...filters, region: filters.region === scopeAlias ? policy.scopedFilters.region : filters.region };
  if (restored.from !== policy.period.from || restored.to !== policy.period.to
    || [restored.product, restored.category, restored.regional, restored.manager].some(Boolean)
    || (index === 0 && [restored.client, restored.state, restored.region].some(Boolean))
    || (index > 0 && (restored.state !== policy.scopedFilters.state || restored.region !== policy.scopedFilters.region))
    || (index === 1 && !!restored.client)
    || (index >= 2 && !policy.allowedClientCodes.includes(restored.client)))
    fail(403, "Os filtros da pergunta estão fora do roteiro real autorizado.");
}

/** Only the outbound model payload is minimized; report labels and UI remain unchanged. */
export function minimizeControlledHmlInput(e: Env, purpose: string, input: unknown, actorId?: string): unknown {
  if (!controlledHmlPolicy(e)) return input;
  const value = input as { question: string; filters?: Filters; period?: Filters; prior?: { question: string; plan: Plan }[];
    ranking?: Plan; sourceInfo?: { extractedAt: string; referenceDate: string; coverage: { from: string; to: string } };
    totals?: unknown; rows?: { name: string; key?: string; current: number | null; previous: number | null }[];
    comparison?: unknown; limited?: boolean; metricLabels?: unknown; warnings?: string[]; measures?: unknown; dimensions?: unknown; today?: string };
  const allowed = controlledHmlQuestion(e, value.question, actorId)!;
  const originalFilters = purpose === "plano_comercial" ? value.filters! : value.period!;
  checkedQuestionFilters(allowed.policy, allowed.index, originalFilters);
  const maskFilters = (filters: Filters) => ({ ...filters, region: filters.region ? scopeAlias : "" });
  if (purpose === "plano_comercial") {
    const prior = (value.prior ?? []).map(turn => {
      const index = allowed.policy.allowedQuestionHashes.indexOf(hmlQuestionHash(turn.question));
      if (index < 0 || index >= allowed.index) fail(403, "O histórico está fora do roteiro real autorizado.");
      checkedQuestionFilters(allowed.policy, index, turn.plan.filters);
      return { question: turn.question, plan: { ...turn.plan, filters: maskFilters(turn.plan.filters) } };
    });
    return { question: value.question, filters: maskFilters(originalFilters), prior, today: value.today,
      measures: value.measures, dimensions: value.dimensions };
  }
  return { question: value.question, source: "Snapshot comercial de homologação", sourceInfo: value.sourceInfo ? {
    extractedAt: value.sourceInfo.extractedAt, referenceDate: value.sourceInfo.referenceDate, coverage: value.sourceInfo.coverage,
  } : undefined, period: maskFilters(originalFilters), ranking: { ...value.ranking!, filters: maskFilters(originalFilters) },
  metricLabels: value.metricLabels, totals: value.totals,
  rows: (value.rows ?? []).map((row, index) => {
    const key = row.key ?? row.name.split(/\s+—\s+/u)[0];
    const codeGroup=["client","product","month","state"].includes(value.ranking!.group);
    return { name: codeGroup&&/^[\p{L}\p{N}._/-]{1,100}$/u.test(key) ? key : "item-" + (index + 1), current: row.current, previous: row.previous };
  }), comparison: value.comparison, limited: value.limited,
  warnings: value.warnings?.some(warning=>/muitos.para.muitos|não some/iu.test(warning)) ? ["Os agrupamentos podem ser não aditivos; não inferir entidades ou causas a partir do total."] : [] };
}

export async function assertControlledHmlAISource(e: Env) {
  const policy = controlledHmlPolicy(e, true);
  if (!policy) return;
  const row = await stmt(e, `SELECT i.sha256,i.manifest FROM ci_sources s JOIN ci_imports i ON i.id=s.active_version_id
    WHERE s.id='commercial-main' AND s.source='manual' AND s.allow_ai=1 AND i.status='published'`).first<{ sha256: string; manifest: string }>();
  if (!row) fail(403, "A fonte real autorizada não está ativa para esta validação.");
  const manifest = manifestSchema.parse(JSON.parse(row.manifest));
  if (manifest.synthetic) fail(403, "O roteiro real exige o snapshot real autorizado.");
  assertControlledHmlManifest(e, manifest, row.sha256, true);
}

export async function controlledHmlAIRequest(e: Env, body: string, actorId?: string) {
  if (!controlledHmlPolicy(e)) return null;
  let value: { question: string; filters?: Filters; period?: Filters };
  try { value = JSON.parse(JSON.parse(body).input); }
  catch { fail(403,"O pedido não corresponde ao roteiro real autorizado."); }
  if (typeof value.question !== "string" || !(value.filters ?? value.period)) fail(403,"O pedido real está incompleto.");
  const allowed = controlledHmlQuestion(e,value.question,actorId)!;
  checkedQuestionFilters(allowed.policy,allowed.index,(value.filters ?? value.period)!);
  await assertControlledHmlAISource(e);
  return { runId:allowed.policy.runId, questionHash:allowed.questionHash, index:allowed.index };
}
