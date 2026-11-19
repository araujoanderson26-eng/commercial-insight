import { fail, now, stmt, type Env } from "./core";
import { controlledHmlAIRequest, controlledHmlAdminId, controlledHmlPolicy } from "./real-hml-policy";
import { productionAIControlled, reserveProductionAI, finishProductionAI } from './production-ai-budget';

// This allowance is deliberately cumulative across deployments and users. No automatic reset.
// Preserve the credential diagnostic and six calls from the first run; allow four focused rechecks.
const maximumCumulativeAttempts = 11;
const hmlOrigin = "https://commercial-insight-hml.araujo-anderson26.workers.dev";
const models = new Set(["gpt-4.1-mini", "gpt-4.1-mini-2025-04-14"]);
const inputNanoUsd = 400, cachedInputNanoUsd = 100, outputNanoUsd = 1600;
export const hmlOpenAIOutputLimit = 1200;
export type OpenAIBudgetReservation = { id: string; inputTokens: number; nanoUsd: number; controlledReal?: true;
  production?: true; organizationId?: string; projectId?: string };
export type Outcome = {
  status: "completed" | "http_error" | "transport_error" | "response_error";
  httpStatus?: number;
  requestId?: string | null;
  providerCode?: string | null;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens?: number } };
};
const providerCodes = new Set(["insufficient_quota", "model_not_found", "invalid_json_schema", "invalid_api_key",
  "rate_limit_exceeded", "access_terminated", "billing_hard_limit_reached", "unsupported_parameter", "invalid_parameter",
  "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded"]);

/** Only retain known diagnostic codes; never a provider message, key, request body or arbitrary string. */
export async function hmlOpenAIErrorCode(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8192) { await reader.cancel(); return null; }
      chunks.push(part.value);
    }
    const value: unknown = JSON.parse(await new Blob(chunks).text());
    const code = value && typeof value === "object" && "error" in value && value.error
      && typeof value.error === "object" && "code" in value.error ? value.error.code : null;
    return typeof code === "string" && providerCodes.has(code) ? code : null;
  } catch {
    return null;
  }
}

/** Byte-based upper estimate includes instructions/schema and extra protocol overhead, without tokenizing secrets. */
export function estimateHmlOpenAIRequest(body: string) {
  const inputTokens = new TextEncoder().encode(body).byteLength + 2048;
  return { inputTokens, nanoUsd: inputTokens * inputNanoUsd + hmlOpenAIOutputLimit * outputNanoUsd };
}

export async function reserveHmlOpenAI(e: Env, body: string, purpose: string, actorId?: string): Promise<OpenAIBudgetReservation | null> {
  if (productionAIControlled(e)) return reserveProductionAI(e,body,purpose,actorId);
  const policy = controlledHmlPolicy(e);
  if (e.HML_OPENAI_BUDGET_USD === undefined) {
    if (e.HML_SYNTHETIC_ONLY === "true" || e.APP_ORIGIN === hmlOrigin)
      fail(503, "Configure o orçamento OpenAI antes de iniciar chamadas na homologação.");
    return null;
  }
  if ((e.HML_SYNTHETIC_ONLY !== "true" && !policy) || e.APP_ORIGIN !== hmlOrigin || !models.has(e.OPENAI_MODEL)
    || !/^(?:0\.0[1-9]|0\.10)$/.test(e.HML_OPENAI_BUDGET_USD)
    || !["plano_comercial", "leitura_comercial"].includes(purpose))
    fail(503, "A configuração do orçamento OpenAI da homologação precisa ser revisada.");
  const cap = Math.round(Number(e.HML_OPENAI_BUDGET_USD) * 1_000_000_000);
  const real = await controlledHmlAIRequest(e,body,actorId);
  const estimate = estimateHmlOpenAIRequest(body), id = crypto.randomUUID();
  // A single statement makes reservation/limit checking atomic even for concurrent requests.
  let inserted: { id: string } | null;
  try {
    inserted = await stmt(e, `INSERT INTO hml_openai_attempts
      (id,model,purpose,reserved_nano_usd,reserved_input_tokens,output_limit,status,created${real ? ",authorization_run_id,question_hash" : ""})
      SELECT ?,?,?,?,?,?,'reserved',?${real ? ",?,?" : ""}
      WHERE (SELECT COUNT(*) FROM hml_openai_attempts)<?
        AND (SELECT COALESCE(SUM(reserved_nano_usd),0) FROM hml_openai_attempts)+?<=?
        AND NOT EXISTS(SELECT 1 FROM hml_openai_attempts WHERE status IN ('usage_exceeded_reservation','model_mismatch'))
        ${real ? `AND (SELECT COUNT(*) FROM hml_openai_attempts WHERE authorization_run_id=? AND purpose='plano_comercial')=?
          AND NOT EXISTS(SELECT 1 FROM hml_openai_attempts WHERE authorization_run_id=? AND question_hash=? AND purpose=?)
          AND NOT EXISTS(SELECT 1 FROM hml_openai_attempts WHERE authorization_run_id=? AND status<>'completed')` : ""}
      RETURNING id`, id, e.OPENAI_MODEL, purpose, estimate.nanoUsd, estimate.inputTokens,
    hmlOpenAIOutputLimit, now(), ...(real ? [real.runId,real.questionHash] : []), real ? 18 : maximumCumulativeAttempts, estimate.nanoUsd, cap,
    ...(real ? [real.runId,real.index+(purpose==="leitura_comercial"?1:0),real.runId,real.questionHash,purpose,real.runId] : [])).first<{ id: string }>();
  } catch {
    fail(503, "Não foi possível reservar o orçamento OpenAI da homologação. Nenhuma nova chamada foi iniciada.");
  }
  if (!inserted) fail(429, "O limite de tentativas ou o orçamento OpenAI desta homologação foi atingido.");
  return { id, ...estimate, ...(real ? {controlledReal:true as const} : {}) };
}

/** Model metadata only: GET /models, never a Responses request or inference retry. */
export async function controlledHmlModelPreflight(e:Env,actorId:string) {
  const policy=controlledHmlPolicy(e,true);
  if(!policy||actorId!==controlledHmlAdminId||!models.has(e.OPENAI_MODEL)||!e.OPENAI_API_KEY)
    fail(403,"A pré-checagem exige o administrador e o modelo de homologação autorizados.");
  const totals=await stmt(e,"SELECT COUNT(*) AS attempts,COALESCE(SUM(reserved_nano_usd),0) AS reserved FROM hml_openai_attempts").first<{attempts:number;reserved:number}>();
  let response:Response;
  try{response=await fetch("https://api.openai.com/v1/models/"+encodeURIComponent(e.OPENAI_MODEL),{
    headers:{Authorization:"Bearer "+e.OPENAI_API_KEY},signal:AbortSignal.timeout(20000)});}
  catch{fail(502,"Não foi possível conferir a disponibilidade do modelo.");}
  const budget={capUsd:Number(e.HML_OPENAI_BUDGET_USD),reservedNanoUsd:totals?.reserved??0,attempts:totals?.attempts??0,maximumAttempts:18};
  if(!response.ok)return {available:false,status:response.status,modelId:null,providerCode:await hmlOpenAIErrorCode(response),budget};
  const reader=response.body?.getReader();const chunks:Uint8Array[]=[];let bytes=0;
  if(!reader)fail(502,"A pré-checagem do modelo retornou uma resposta vazia.");
  for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>8192){await reader.cancel();fail(502,"A resposta de metadados do modelo excedeu o limite.");}chunks.push(part.value);}
  let id:unknown;try{id=(JSON.parse(await new Blob(chunks).text()) as {id:unknown}).id;}catch{fail(502,"A pré-checagem do modelo retornou formato inválido.");}
  if(typeof id!=="string"||!models.has(id))fail(502,"O modelo retornado não corresponde ao modelo autorizado.");
  return {available:true,status:response.status,modelId:id,budget};
}

/** Keep the entire reservation after every outcome, including timeout or unknown usage. */
export async function finishHmlOpenAI(e: Env, reservation: OpenAIBudgetReservation | null, outcome: Outcome) {
  if (!reservation) return;
  if (reservation.production) return finishProductionAI(e,reservation,outcome);
  const usage = outcome.usage;
  const validUsage = usage && Number.isSafeInteger(usage.input_tokens) && usage.input_tokens >= 0
    && Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0;
  const cached = usage?.input_tokens_details?.cached_tokens;
  const knownCache = reservation.controlledReal && validUsage && cached !== undefined
    && Number.isSafeInteger(cached) && cached >= 0 && cached <= usage.input_tokens;
  const discountedTokens = knownCache ? cached : 0;
  const actual = validUsage ? (usage.input_tokens - discountedTokens) * inputNanoUsd
    + discountedTokens * cachedInputNanoUsd + usage.output_tokens * outputNanoUsd : null;
  const responseModel = outcome.model && models.has(outcome.model) ? outcome.model : null;
  const status = outcome.model && !responseModel ? "model_mismatch"
    : validUsage && (usage.input_tokens > reservation.inputTokens || usage.output_tokens > hmlOpenAIOutputLimit)
      ? "usage_exceeded_reservation" : outcome.status;
  const requestId = outcome.requestId && /^[A-Za-z0-9_-]{1,200}$/.test(outcome.requestId) ? outcome.requestId : null;
  const providerCode = outcome.providerCode && providerCodes.has(outcome.providerCode) ? outcome.providerCode : null;
  try {
    await stmt(e, `UPDATE hml_openai_attempts SET status=?,http_status=?,response_model=?,request_id=?,provider_code=?,
      input_tokens=?,output_tokens=?,actual_nano_usd=?${reservation.controlledReal ? ",cached_input_tokens=?" : ""} WHERE id=?`, status,
    outcome.httpStatus ?? null, responseModel, requestId, providerCode, validUsage ? usage.input_tokens : null,
    validUsage ? usage.output_tokens : null, actual, ...(reservation.controlledReal ? [knownCache ? cached : null] : []), reservation.id).run();
  } catch {
    // The reserved row remains charged conservatively. Never return SQL/provider diagnostics.
    fail(503, "Não foi possível registrar o consumo OpenAI da homologação; a reserva foi mantida.");
  }
}
