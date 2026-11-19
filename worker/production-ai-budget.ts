import { fail, now, stmt, type Env } from './core';
import type { OpenAIBudgetReservation, Outcome } from './openai-budget';
import type { AssistantBudget } from '../shared/commercial';

const productionOrigin = 'https://commercial-insight.araujoempresarial.com.br';
const nano = 1_000_000_000, cap = 20 * nano;
// Standard text pricing verified 2026-11-19. No tools, retries, background or paid extras.
export const productionAIModel = 'gpt-4.1-mini-2025-04-14';
const inputRate = 400, outputRate = 1600, outputLimit = 1200;
const blockedStatuses = "'reserved','transport_error','response_error','usage_missing','model_mismatch','usage_exceeded_reservation'";
type Policy = { enabled: number; administrator_id: string | null; revision: number; monthly_cap_nano_usd: number;
  organization_id: string | null; project_id: string | null; credit_ceiling_nano_usd: number;
  credit_verified_at: number; credit_valid_until: number; verification_reference: string | null;
  model: string; pricing_valid_until: number };
export type ProductionAIBlock = 'policy_disabled' | 'account_not_authorized' | 'credits_unverified' | 'budget_exhausted' | 'request_in_progress' | 'budget_unavailable';
export type ProductionAIBudget = AssistantBudget;
const messages: Record<ProductionAIBlock, string> = {
  policy_disabled: 'A IA de produção aguarda a liberação financeira verificada do administrador.',
  account_not_authorized: 'A IA está liberada exclusivamente para a conta administrativa autorizada.',
  credits_unverified: 'Créditos disponíveis, projeto e validade ainda não foram verificados, ou a verificação expirou. Nenhuma chamada será iniciada.',
  budget_exhausted: 'O orçamento mensal ou a parcela de créditos verificados não comporta novas chamadas.',
  request_in_progress: 'Há uma chamada em andamento ou com consumo pendente de conciliação. Novas chamadas estão bloqueadas.',
  budget_unavailable: 'O controle financeiro da IA está indisponível ou precisa de revisão. Nenhuma chamada será iniciada.',
};
export const productionAIControlled = (e: Env) => e.APP_ORIGIN === productionOrigin || e.PRODUCTION_AI_BUDGET === 'true';
const monthAt = (timestamp: number) => new Date(timestamp * 1000).toISOString().slice(0, 7);
async function policy(e: Env) {
  return stmt(e, 'SELECT * FROM ai_production_policy WHERE id=1').first<Policy>();
}
async function authorized(e: Env, p: Policy, actorId?: string) {
  return Boolean(actorId && p.administrator_id === actorId && await stmt(e,
    "SELECT id FROM users WHERE id=? AND active=1 AND role='admin' AND update_only=0", actorId).first());
}
function policyBlock(e: Env, p: Policy, timestamp: number): ProductionAIBlock | null {
  if (!p.enabled) return 'policy_disabled';
  if (e.PRODUCTION_AI_BUDGET !== 'true' || e.APP_ORIGIN !== productionOrigin || p.model !== productionAIModel
    || e.OPENAI_MODEL !== productionAIModel || p.pricing_valid_until <= timestamp
    || !Number.isSafeInteger(p.monthly_cap_nano_usd) || p.monthly_cap_nano_usd <= 0 || p.monthly_cap_nano_usd > cap)
    return 'budget_unavailable';
  if (!p.organization_id || !/^org-[A-Za-z0-9_-]+$/.test(p.organization_id)
    || !p.project_id || !/^proj_[A-Za-z0-9_-]+$/.test(p.project_id) || !p.verification_reference
    || p.credit_ceiling_nano_usd <= 0 || !Number.isSafeInteger(p.credit_ceiling_nano_usd)
    || p.credit_verified_at <= 0 || p.credit_verified_at > timestamp || timestamp - p.credit_verified_at > 86400
    || p.credit_valid_until <= timestamp + 60) return 'credits_unverified';
  return null;
}
export async function productionAIStatus(e: Env, actorId?: string): Promise<{
  ready: boolean; reason?: ProductionAIBlock; message?: string; budget?: ProductionAIBudget;
}> {
  if (!productionAIControlled(e)) return { ready: true };
  try {
    const p = await policy(e);
    if (!p) return { ready: false, reason: 'budget_unavailable', message: messages.budget_unavailable };
    if (!await authorized(e, p, actorId)) return { ready: false, reason: 'account_not_authorized', message: messages.account_not_authorized };
    const timestamp = now(), month = monthAt(timestamp);
    const totals = await stmt(e, `SELECT COALESCE(SUM(reserved_nano_usd),0) lifetime,
      COALESCE(SUM(CASE WHEN month=? THEN reserved_nano_usd ELSE 0 END),0) committed,
      COALESCE(SUM(CASE WHEN month=? THEN usage_upper_nano_usd ELSE 0 END),0) usage,
      COALESCE(SUM(CASE WHEN month=? AND usage_upper_nano_usd IS NULL THEN 1 ELSE 0 END),0) unknown_count,
      COALESCE(SUM(CASE WHEN status IN (${blockedStatuses}) THEN 1 ELSE 0 END),0) pending
      FROM ai_production_attempts`, month, month, month).first<{ lifetime: number; committed: number; usage: number; unknown_count: number; pending: number }>();
    if (!totals) throw new Error('Missing ledger aggregate');
    const alerts = (await stmt(e, 'SELECT threshold_nano_usd,event,created FROM ai_production_alerts WHERE month=? ORDER BY threshold_nano_usd,event', month)
      .all<{ threshold_nano_usd: number; event: string; created: number }>()).results;
    const budget: ProductionAIBudget = { month, capUsd: p.monthly_cap_nano_usd / nano, reservedUsd: totals.committed / nano,
      usageUpperUsd: totals.usage / nano, unknownUsageCount: totals.unknown_count,
      remainingUsd: Math.max(0, p.monthly_cap_nano_usd - totals.committed) / nano,
      verifiedCreditRemainingUsd: Math.max(0, p.credit_ceiling_nano_usd - totals.lifetime) / nano,
      creditValidUntil: p.credit_valid_until, alerts: alerts.map(a => ({ thresholdUsd: a.threshold_nano_usd / nano, event: a.event, created: a.created })) };
    const reason = policyBlock(e, p, timestamp)
      ?? (totals.committed >= p.monthly_cap_nano_usd || totals.lifetime >= p.credit_ceiling_nano_usd ? 'budget_exhausted'
        : totals.pending ? 'request_in_progress' : undefined);
    return { ready: !reason, ...(reason ? { reason, message: messages[reason] } : {}), budget };
  } catch { return { ready: false, reason: 'budget_unavailable', message: messages.budget_unavailable }; }
}
export async function assertProductionAI(e: Env, actorId?: string) {
  const status = await productionAIStatus(e, actorId);
  // Returning an already paid answer must remain possible when its last reservation filled the cap.
  if (!status.ready && status.reason !== 'budget_exhausted' && status.reason !== 'request_in_progress')
    fail(status.reason === 'account_not_authorized' ? 403 : 503, status.message!);
}
export function estimateProductionAI(body: string) {
  const inputTokens = new TextEncoder().encode(body).byteLength + 8192;
  if (inputTokens > 140000) fail(413, 'O contexto da pergunta excede o limite seguro da IA. Reduza o recorte.');
  return { inputTokens, nanoUsd: 2 * (inputTokens * inputRate + outputLimit * outputRate) };
}
export async function reserveProductionAI(e: Env, body: string, purpose: string, actorId?: string): Promise<OpenAIBudgetReservation> {
  await assertProductionAI(e, actorId);
  const parsed = JSON.parse(body) as Record<string, unknown>;
  if (parsed.model !== productionAIModel || parsed.max_output_tokens !== outputLimit || parsed.store !== false
    || Object.keys(parsed).some(k => !['model','store','max_output_tokens','instructions','input','text'].includes(k))
    || !['plano_comercial','leitura_comercial'].includes(purpose)) fail(503, 'A chamada não corresponde à política de IA precificada.');
  const p = (await policy(e))!, timestamp = now(), month = monthAt(timestamp), estimate = estimateProductionAI(body), id = crypto.randomUUID();
  let row: { id: string } | null;
  try {
    // All guards AND the single-flight lock are evaluated by ONE SQLite statement.
    row = await stmt(e, `INSERT INTO ai_production_attempts
      (id,owner,policy_revision,month,model,purpose,reserved_nano_usd,reserved_input_tokens,output_limit,status,created)
      SELECT ?,?,revision,?,?,?,?,?,1200,'reserved',? FROM ai_production_policy
      WHERE id=1 AND enabled=1 AND revision=? AND administrator_id=? AND model=?
      AND monthly_cap_nano_usd>0 AND monthly_cap_nano_usd<=20000000000
      AND credit_verified_at BETWEEN ? AND ? AND credit_valid_until>? AND pricing_valid_until>?
      AND organization_id=? AND project_id=? AND verification_reference IS NOT NULL
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role='admin' AND update_only=0)
      AND COALESCE((SELECT SUM(reserved_nano_usd) FROM ai_production_attempts WHERE month=?),0)+?<=monthly_cap_nano_usd
      AND COALESCE((SELECT SUM(reserved_nano_usd) FROM ai_production_attempts),0)+?<=credit_ceiling_nano_usd
      AND NOT EXISTS(SELECT 1 FROM ai_production_attempts WHERE status IN (${blockedStatuses})) RETURNING id`,
    id, actorId!, month, productionAIModel, purpose, estimate.nanoUsd, estimate.inputTokens, timestamp, p.revision,
    actorId!, productionAIModel, timestamp - 86400, timestamp, timestamp + 60, timestamp, p.organization_id, p.project_id,
    actorId!, month, estimate.nanoUsd, estimate.nanoUsd).first<{ id: string }>();
  } catch { fail(503, messages.budget_unavailable); }
  if (!row) {
    const s = await productionAIStatus(e, actorId);
    if (s.ready && s.budget && (s.budget.remainingUsd * nano < estimate.nanoUsd || s.budget.verifiedCreditRemainingUsd * nano < estimate.nanoUsd)) {
      await stmt(e, `INSERT OR IGNORE INTO ai_production_alerts(month,threshold_nano_usd,event,committed_nano_usd,created)
        SELECT ?,20000000000,'budget_blocked',COALESCE(SUM(reserved_nano_usd),0),? FROM ai_production_attempts WHERE month=?`, month, timestamp, month).run();
      fail(429, messages.budget_exhausted);
    }
    fail(s.reason === 'account_not_authorized' ? 403 : 429, s.message ?? messages.request_in_progress);
  }
  return { id, ...estimate, production: true, organizationId: p.organization_id!, projectId: p.project_id! };
}
export async function finishProductionAI(e: Env, reservation: OpenAIBudgetReservation, outcome: Outcome) {
  const usage = outcome.usage;
  const valid = usage && Number.isSafeInteger(usage.input_tokens) && usage.input_tokens >= 0
    && Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0;
  const modelMatches = outcome.model === productionAIModel;
  const upper = valid ? usage.input_tokens * inputRate + usage.output_tokens * outputRate : null;
  const status = outcome.model && !modelMatches ? 'model_mismatch'
    : valid && (usage.input_tokens > reservation.inputTokens || usage.output_tokens > outputLimit || upper! > reservation.nanoUsd) ? 'usage_exceeded_reservation'
    : outcome.status === 'completed' && (!valid || !modelMatches) ? 'usage_missing'
    : outcome.status === 'http_error' && (outcome.httpStatus ?? 0) >= 500 ? 'response_error' : outcome.status;
  const requestId = outcome.requestId && /^[A-Za-z0-9_-]{1,200}$/.test(outcome.requestId) ? outcome.requestId : null;
  try {
    // Never free the reservation, even after provider errors or known cached-token discounts.
    await stmt(e, `UPDATE ai_production_attempts SET status=?,finished=?,http_status=?,response_model=?,request_id=?,provider_code=?,
      input_tokens=?,output_tokens=?,usage_upper_nano_usd=? WHERE id=? AND status='reserved'`, status, now(),
    outcome.httpStatus ?? null, modelMatches ? outcome.model! : null, requestId,
    ['credit_balance_exhausted','insufficient_quota','billing_hard_limit_reached','organization_spend_limit_exceeded','project_spend_limit_exceeded','organization_usage_limit_exceeded','invalid_api_key','model_not_found','invalid_json_schema','rate_limit_exceeded','access_terminated','unsupported_parameter','invalid_parameter'].includes(outcome.providerCode ?? '') ? outcome.providerCode! : null,
    valid ? usage.input_tokens : null, valid ? usage.output_tokens : null, upper, reservation.id).run();
    if (['credit_balance_exhausted','insufficient_quota','billing_hard_limit_reached','organization_spend_limit_exceeded','project_spend_limit_exceeded','organization_usage_limit_exceeded'].includes(outcome.providerCode ?? ''))
      await stmt(e, 'UPDATE ai_production_policy SET enabled=0,revision=revision+1 WHERE id=1').run();
  } catch { fail(503, 'Não foi possível registrar o consumo. A reserva e o bloqueio financeiro foram mantidos.'); }
  if (['usage_missing','model_mismatch','usage_exceeded_reservation'].includes(status)) fail(503, messages.request_in_progress);
}
