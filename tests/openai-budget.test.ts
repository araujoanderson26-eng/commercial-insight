import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { estimateHmlOpenAIRequest, finishHmlOpenAI, reserveHmlOpenAI } from "../worker/openai-budget";
import { interpret } from "../worker/assistant";
import { Problem } from "../worker/core";
import { filters, makeStore, plan } from "./fixtures";

function store() {
  const value = makeStore();
  value.sql.exec(readFileSync(new URL("../migrations/0007_hml_openai_budget.sql", import.meta.url), "utf8"));
  value.sql.exec(readFileSync(new URL("../migrations/0009_hml_openai_cache_usage.sql", import.meta.url), "utf8"));
  Object.assign(value.env, { HML_OPENAI_BUDGET_USD: "0.10", HML_SYNTHETIC_ONLY: "true",
    APP_ORIGIN: "https://commercial-insight-hml.araujo-anderson26.workers.dev", OPENAI_MODEL: "gpt-4.1-mini" });
  return value;
}
const semantics = { allowAI: true, measures: { revenue: "Líquido", margin: null, returns: null, buyers: null } };

test("orçamento HML reserva atomicamente com concorrência e recusa antes de exceder US$0,01", async t => {
  const { env, sql } = store(); t.after(() => sql.close());
  env.HML_OPENAI_BUDGET_USD = "0.01";
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => reserveHmlOpenAI(env, "{}", "plano_comercial")));
  assert.equal(attempts.filter(x => x.status === "fulfilled").length, 3);
  const total = sql.prepare("SELECT COUNT(*) AS n,SUM(reserved_nano_usd) AS cost FROM hml_openai_attempts").get()!;
  assert.equal(total.n, 3); assert.ok(Number(total.cost) <= 10_000_000);
  for (const result of attempts) if (result.status === "rejected") assert.equal(result.reason.status, 429);
});

test("retomada HML permite onze tentativas cumulativas incluindo diagnóstico e conserva reservas após falhas", async t => {
  const { env, sql } = store(); t.after(() => sql.close());
  const reservations = await Promise.all(Array.from({ length: 11 }, () => reserveHmlOpenAI(env, "{}", "plano_comercial")));
  for (const reserved of reservations) await finishHmlOpenAI(env, reserved, { status: "transport_error" });
  await assert.rejects(reserveHmlOpenAI(env, "{}", "plano_comercial"), error => error instanceof Problem && error.status === 429);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM hml_openai_attempts WHERE status='transport_error'").get()!.n, 11);
  assert.equal(sql.prepare("SELECT SUM(reserved_nano_usd) AS n FROM hml_openai_attempts").get()!.n, estimateHmlOpenAIRequest("{}").nanoUsd * 11);
});

test("sem flag de orçamento o fluxo de produção não consulta ledger nem exige migração HML", async t => {
  const { env, sql } = makeStore(); t.after(() => sql.close());
  assert.equal(await reserveHmlOpenAI(env, "{}", "plano_comercial"), null);
  await finishHmlOpenAI(env, null, { status: "transport_error" });
  assert.equal(sql.prepare("SELECT name FROM sqlite_master WHERE name='hml_openai_attempts'").get(), undefined);
});

test("configuração inválida, modelo não precificado, origem errada e fonte não sintética falham fechados", async t => {
  const { env, sql } = store(); t.after(() => sql.close());
  for (const patch of [{ HML_OPENAI_BUDGET_USD: "1.00" }, { HML_OPENAI_BUDGET_USD: "0" },
    { HML_OPENAI_BUDGET_USD: undefined },
    { HML_OPENAI_BUDGET_USD: undefined, HML_SYNTHETIC_ONLY: undefined },
    { HML_OPENAI_BUDGET_USD: undefined, APP_ORIGIN: "https://production.example.test" },
    { HML_OPENAI_BUDGET_USD: "" }, { OPENAI_MODEL: "expensive-unknown-model" },
    { APP_ORIGIN: "https://production.example.test" }, { HML_SYNTHETIC_ONLY: "false" }]) {
    await assert.rejects(reserveHmlOpenAI({ ...env, ...patch }, "{}", "plano_comercial"), error => error instanceof Problem && error.status === 503);
  }
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM hml_openai_attempts").get()!.n, 0);
});

test("reserva inclui bytes UTF8 e bloqueia corpo grande antes do fetch", async t => {
  const { env, sql } = store(); t.after(() => sql.close());
  assert.ok(estimateHmlOpenAIRequest("ã").inputTokens > estimateHmlOpenAIRequest("a").inputTokens);
  env.HML_OPENAI_BUDGET_USD = "0.01";
  const mock = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  await assert.rejects(interpret(env, semantics, "x".repeat(30000), filters, []), error => error instanceof Problem && error.status === 429);
  assert.equal(mock.mock.callCount(), 0);
});

test("chamada realista conserva somente usage, modelo e identificador seguros no ledger", async t => {
  const { env, sql } = store(); t.after(() => sql.close());
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.max_output_tokens, 1200); assert.equal(body.store, false);
    return Response.json({ status: "completed", model: "gpt-4.1-mini-2025-04-14",
      usage: { input_tokens: 1100, output_tokens: 200 },
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ supported: true, reason: "", inheritContext: false, ...plan }) }] }] },
    { headers: { "x-request-id": "req_test_123" } });
  });
  await interpret(env, semantics, "Pergunta privada de teste", filters, []);
  const record = sql.prepare("SELECT * FROM hml_openai_attempts").get()!;
  assert.equal(record.status, "completed"); assert.equal(record.response_model, "gpt-4.1-mini-2025-04-14");
  assert.equal(record.request_id, "req_test_123"); assert.equal(record.actual_nano_usd, 1100 * 400 + 200 * 1600);
  assert.ok(Number(record.reserved_nano_usd) > Number(record.actual_nano_usd));
  assert.doesNotMatch(JSON.stringify(record), /Pergunta privada|test-only|Bearer|plano_comercial.*schema/);
});

test("HTTP, rede e falha de leitura preservam reserva e apenas código conhecido do provedor", async t => {
  const { env, sql } = store(); t.after(() => sql.close());
  let response = () => Response.json({ error: { code: "insufficient_quota", message: "DO_NOT_STORE_CREDENTIAL" } },
    { status: 429, headers: { "x-request-id": "unsafe request id" } });
  t.mock.method(globalThis, "fetch", async () => response());
  await assert.rejects(interpret(env, semantics, "Analise", filters, []), error => error instanceof Problem && error.status === 429);
  let record = sql.prepare("SELECT * FROM hml_openai_attempts ORDER BY rowid DESC LIMIT 1").get()!;
  assert.equal(record.status, "http_error"); assert.equal(record.provider_code, "insufficient_quota"); assert.equal(record.request_id, null);
  assert.ok(Number(record.reserved_nano_usd) > 0); assert.doesNotMatch(JSON.stringify(record), /DO_NOT_STORE_CREDENTIAL/);
  response = () => new Response("broken json");
  await assert.rejects(interpret(env, semantics, "Analise", filters, []), error => error instanceof Problem && error.status === 502);
  record = sql.prepare("SELECT * FROM hml_openai_attempts ORDER BY rowid DESC LIMIT 1").get()!;
  assert.equal(record.status, "response_error"); assert.ok(Number(record.reserved_nano_usd) > 0);
  response = () => { throw new TypeError("DO_NOT_STORE_TRANSPORT_DETAILS"); };
  await assert.rejects(interpret(env, semantics, "Analise", filters, []), error => error instanceof Problem && error.status === 502 && !error.message.includes("DO_NOT_STORE"));
  record = sql.prepare("SELECT * FROM hml_openai_attempts ORDER BY rowid DESC LIMIT 1").get()!;
  assert.equal(record.status, "transport_error"); assert.ok(Number(record.reserved_nano_usd) > 0);
});

test("usage acima da reserva ou modelo inesperado impedem chamadas seguintes", async t => {
  const { env, sql } = store(); t.after(() => sql.close());
  const reservation = await reserveHmlOpenAI(env, "{}", "plano_comercial");
  await finishHmlOpenAI(env, reservation, { status: "completed", model: env.OPENAI_MODEL,
    usage: { input_tokens: 1, output_tokens: 1201 } });
  assert.equal(sql.prepare("SELECT status FROM hml_openai_attempts").get()!.status, "usage_exceeded_reservation");
  await assert.rejects(reserveHmlOpenAI(env, "{}", "plano_comercial"), error => error instanceof Problem && error.status === 429);
  await finishHmlOpenAI(env, reservation, { status: "completed", model: "unexpected-model", usage: { input_tokens: 1, output_tokens: 1 } });
  assert.equal(sql.prepare("SELECT status FROM hml_openai_attempts").get()!.status, "model_mismatch");
  await assert.rejects(reserveHmlOpenAI(env, "{}", "plano_comercial"), error => error instanceof Problem && error.status === 429);
});

test("cache observado desconta somente o custo real estimado e mantém reserva integral sem reescrever histórico", async t => {
  const { env, sql } = store(); t.after(() => sql.close());
  const reservation = (await reserveHmlOpenAI(env,"{}","plano_comercial"))!;
  const realReservation = {...reservation,controlledReal:true as const};
  for (const cached of [0,1000,undefined,2001]) {
    await finishHmlOpenAI(env,realReservation,{status:"completed",model:env.OPENAI_MODEL,
      usage:{input_tokens:2000,output_tokens:100,...(cached===undefined?{}:{input_tokens_details:{cached_tokens:cached}})}});
    const row=sql.prepare("SELECT reserved_nano_usd,actual_nano_usd,cached_input_tokens FROM hml_openai_attempts WHERE id=?").get(reservation.id)!;
    const known=cached!==undefined&&cached<=2000;
    assert.equal(row.cached_input_tokens,known?cached:null);
    assert.equal(row.actual_nano_usd,known?(2000-cached)*400+cached*100+100*1600:2000*400+100*1600);
    assert.equal(row.reserved_nano_usd,reservation.nanoUsd);
  }
  const historical=(await reserveHmlOpenAI(env,"{}","leitura_comercial"))!;
  await finishHmlOpenAI(env,historical,{status:"completed",model:env.OPENAI_MODEL,usage:{input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:500}}});
  const old=sql.prepare("SELECT actual_nano_usd,cached_input_tokens FROM hml_openai_attempts WHERE id=?").get(historical.id)!;
  assert.equal(old.cached_input_tokens,null);assert.equal(old.actual_nano_usd,1000*400+100*1600);
});
