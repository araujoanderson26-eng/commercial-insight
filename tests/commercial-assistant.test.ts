import test from "node:test";
import assert from "node:assert/strict";
import { assistantStatus, prepareVisit, reportInsights } from "../worker/commercial";
import { canonicalState, comment, commentaryGrounded, conversationContext, factualCommentary, interpret } from "../worker/assistant";
import { resolvePlanEntities } from "../worker/providers";
import type { DataProvider } from "../worker/providers";
import { Problem } from "../worker/core";
import { metricKeys, type Plan, type Report, type Row } from "../shared/domain";
import { filters, makeStore, plan } from "./fixtures";

function row(name: string, current: number | null, previous: number | null): Row {
  const values = Object.fromEntries(metricKeys.map(metric => [metric, { current: null, previous: null }])) as Row["values"];
  values.revenue = { current, previous };
  values.gross = { current: current === null ? null : current + 10, previous: previous === null ? null : previous + 5 };
  values.returns = { current: current === null ? null : 10, previous: previous === null ? null : 5 };
  return { name, values };
}
function report(p: Plan): Report {
  const rows: Row[] = p.group === "month" ? [row("2026-01", 50, 100), row("2026-02", 0, 30), row("2026-03", 20, 0)]
    : p.group === "client" ? [row("0001 — Cliente real do teste", 70, 130)]
    : p.group === "region" ? [row("Representante A", 70, 130)]
    : p.group === "regional" ? [row("Sudeste", 70, 130)]
    : p.group === "state" ? [row("SP", 70, 130)]
    : [row("P — Produto real do teste", 70, 130)];
  return { total: row("Total", 70, 130), rows, plan: p, source: "Arquivo manual (D1)",
    asOf: "2026-11-19T12:00:00Z", truncated: false,
    sourceInfo: { versionId: "pinned-snapshot", extractedAt: "2026-11-18T12:00:00Z", sourceUpdatedAt: null,
      referenceDate: "2026-11-18", coverage: { from: "2025-01-01", to: "2026-03-31" } } };
}
function provider() {
  const plans: Plan[] = [];
  const value: DataProvider = { sourceType: "manual", versionId: "pinned-snapshot",
    semantics: { allowAI: false, measures: { revenue: "Fat. Liq.", gross: "Fat. Bruto", returns: "Dev. Fat", buyers: null, margin: null },
      capabilities: { metrics: ["revenue", "gross", "returns"], groups: ["month", "client", "product", "category", "region", "state", "regional"], filters: ["client", "region", "product", "state", "regional"] } },
    async query(p) { plans.push(p); return report(p); } };
  return { value, plans };
}

test("visita usa consultas tipadas no mesmo snapshot, preserva código/escopo e explicita limitações", async () => {
  const { value, plans } = provider();
  const input = { ...filters, client: "0001", region: "Representante A", state: "SP" };
  const briefing = await prepareVisit(value, input);
  assert.equal(plans.length, 8);
  for (const p of plans) assert.deepEqual(p.filters, input);
  assert.equal(briefing.client.code, "0001");
  assert.equal(briefing.client.name, "0001 — Cliente real do teste");
  assert.deepEqual(briefing.client.states, ["SP"]);
  assert.deepEqual(briefing.client.representatives, ["Representante A"]);
  assert.equal(briefing.timeline.sourceInfo?.versionId, "pinned-snapshot");
  assert.equal(briefing.activity.lastPurchase, null, "mensal não comprova última data de documento");
  assert.equal(briefing.activity.lastPurchaseMonth, "2026-03");
  assert.equal(briefing.activity.monthsWithPurchases, 3, "atividade é baseada no bruto positivo, não saldo líquido");
  assert.equal(briefing.client.municipality, null);
  assert.match(briefing.limitations.join(" "), /Município cadastral não disponível/);
  assert.match(briefing.objectives.join(" "), /P — Produto real/);
  assert.ok(briefing.insights.some(insight => insight.title === "Aumento de devoluções"));
  assert.equal(briefing.insights.every(insight => insight.kind === "fact"), true);
});

test("visita recusa ausência/ambiguidade de cliente e propaga recusa de autorização", async () => {
  const { value, plans } = provider();
  await assert.rejects(prepareVisit(value, filters), (error: unknown) => error instanceof Problem && error.status === 422);
  assert.equal(plans.length, 0);
  const duplicate: DataProvider = { ...value, query: async p => ({ ...report(p), rows: p.group === "client" ? [row("0001", 1, 1), row("0002", 1, 1)] : report(p).rows }) };
  await assert.rejects(prepareVisit(duplicate, { ...filters, client: "ambíguo" }), /mais de um cadastro/);
  const forbidden: DataProvider = { ...value, query: async () => { throw new Problem(403, "fora do escopo"); } };
  await assert.rejects(prepareVisit(forbidden, { ...filters, client: "proibido" }), (error: unknown) => error instanceof Problem && error.status === 403);
});

test("insights não transformam dados ausentes em zero nem base negativa em crescimento percentual", () => {
  const r = report(plan);
  r.total.values.revenue = { current: 200, previous: -50 };
  r.rows = [row("Sem dado", null, 500)];
  const insights = reportInsights(r);
  assert.equal(insights.length, 1);
  assert.match(insights[0].detail, /Sem base comparável/);
  assert.doesNotMatch(insights[0].detail, /949|%/);
  assert.equal(insights[0].impact, 250);
});

test("diagnóstico da IA informa as duas pendências sem expor secret", () => {
  const { env, sql } = makeStore();
  try {
    const { value } = provider();
    delete env.OPENAI_API_KEY;
    const status = assistantStatus(env, value);
    assert.equal(status.ready, false);
    assert.deepEqual(status.pending, ["source_disabled", "credential_missing"]);
    assert.match(status.message, /duas pendências/);
    env.OPENAI_API_KEY = "SECRET_PRIVATE_VALUE";
    value.semantics.allowAI = true;
    assert.equal(assistantStatus(env, value).ready, true);
    assert.doesNotMatch(JSON.stringify(assistantStatus(env, value)), /SECRET_PRIVATE_VALUE/);
  } finally { sql.close(); }
});

test("contexto recupera só planos válidos e a continuação herda entidade sem ampliar filtro ativo", async t => {
  const { env, sql } = makeStore();
  t.after(() => sql.close());
  const last = { ...plan, filters: { ...filters, state: "SP" } };
  const history = [{ question: "Como está São Paulo?", plan: JSON.stringify(last) }, { question: "Inválida", plan: "{bad" }];
  assert.equal(conversationContext(history).length, 1);
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    const payload = JSON.parse(request.input);
    assert.equal(payload.prior[0].plan.filters.state, "SP");
    assert.equal(payload.prior.length, 1);
    assert.equal(request.store, false);
    const answer = { supported: true, reason: "", inheritContext: true, ...plan, group: "product", filters: { ...filters, state: "" } };
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }] });
  });
  const semantic = { allowAI: true, measures: { revenue: "Líquido", margin: null, returns: null, buyers: null } };
  const resolved = await interpret(env, semantic, "E quais produtos provocaram a maior queda?", filters, history);
  assert.equal(resolved.filters.state, "SP");
  const active = await interpret(env, semantic, "E os produtos?", { ...filters, state: "RJ" }, history);
  assert.equal(active.filters.state, "RJ");
});

test("OpenAI trata rede, recusa, respostas inválidas e limite de corpo com erros sem segredos", async t => {
  const { env, sql } = makeStore();
  t.after(() => sql.close());
  const r = report(plan);
  let answer: () => Promise<Response> = async () => { throw new TypeError("secret transport detail"); };
  t.mock.method(globalThis, "fetch", () => answer());
  await assert.rejects(comment(env, "Analise", r), error => error instanceof Problem && error.status === 502 && !error.message.includes("secret"));
  answer = async () => new Response("private credential error", { status: 401 });
  await assert.rejects(comment(env, "Analise", r), error => error instanceof Problem && error.status === 409);
  answer = async () => Response.json({ status: "completed", output: [] });
  await assert.rejects(comment(env, "Analise", r), error => error instanceof Problem && error.status === 422);
  answer = async () => new Response("x".repeat(512 * 1024 + 1));
  await assert.rejects(comment(env, "Analise", r), error => error instanceof Problem && error.status === 502 && /limite/.test(error.message));
});

test("pergunta independente sem data preserva o mês ativo mesmo se o modelo ampliar a janela de visita", async t => {
  const { env, sql } = makeStore(); t.after(() => sql.close());
  t.mock.method(globalThis, "fetch", async () => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ supported: true, reason: "", inheritContext: false,
    ...plan, filters: { ...filters, from: "2025-01", to: "2026-01", client: "0001" } }) }] }] }));
  const semantic = { allowAI: true, measures: { revenue: "Líquido", margin: null, returns: null, buyers: null } };
  const active = { ...filters, from: "2026-01", to: "2026-01" };
  const resolved = await interpret(env, semantic, "Vou visitar o cliente 0001. Prepare minha reunião.", active, []);
  assert.deepEqual([resolved.filters.from, resolved.filters.to], ["2026-01", "2026-01"]);
  assert.equal(resolved.filters.client, "0001");
  const explicit = await interpret(env, semantic, "Compare janeiro de 2025 a janeiro de 2026 para o cliente 0001", active, []);
  assert.deepEqual([explicit.filters.from, explicit.filters.to], ["2025-01", "2026-01"]);
});

test("guardas comerciais recusam margem inventada, atribuição de total M:M e extremos de linha parcial", () => {
  const r = report(plan);
  assert.equal(commentaryGrounded({ summary: "A margem bruta avançou de 80 para 135.", actions: [] }, r), false);
  assert.equal(commentaryGrounded({ summary: "Não há dados disponíveis de margem.", actions: [] }, r), true);
  assert.equal(commentaryGrounded({ summary: "Faturamento de R$ 70,00 ante R$ 130,00; queda de 46,15%.", actions: [] }, r), true);
  const grouped = report({ ...plan, group: "client" });
  grouped.total = row("Total", -50, 100); grouped.rows = [row("0001", 70, 100), row("0002", 20, 0)];
  grouped.warnings = ["Relacionamentos muitos-para-muitos: não some as linhas para reconstruir o total."];
  assert.equal(commentaryGrounded({ summary: "O total caiu para -50; outros clientes não listados explicam a queda.", actions: [] }, grouped), false);
  assert.equal(commentaryGrounded(factualCommentary(grouped), grouped), true);
  assert.equal(commentaryGrounded({ ...factualCommentary(grouped), actions: ["Outros clientes explicam a queda."] }, grouped), false);
  const timeline = report(plan);
  timeline.rows = [row("2026-01", 50, 100), row("2026-02", 70, 130)];
  assert.equal(commentaryGrounded({ summary: "O pico foi de 50.", actions: [] }, timeline), false);
  assert.equal(commentaryGrounded({ summary: "O pico foi de 70.", actions: [] }, timeline), true);
  timeline.truncated = true;
  assert.equal(commentaryGrounded({ summary: "O pico foi de 70.", actions: [] }, timeline), false);
  assert.equal(commentaryGrounded(factualCommentary(timeline), timeline), true);
  assert.equal(commentaryGrounded({ summary: "Houve uma única compra registrada.", actions: [] }, r), false);
});

test("divergência de agrupamento M:M usa fatos calculados sem pagar chamada de narrativa", async t => {
  const { env, sql } = makeStore(); t.after(() => sql.close());
  const grouped = report({ ...plan, group: "client" });
  grouped.total = row("Total", -50, 100); grouped.rows = [row("0001", 70, 100), row("0002", 20, 0)];
  grouped.warnings = ["Relacionamentos muitos-para-muitos: não some as linhas para reconstruir o total."];
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Não deve enviar narrativa"); });
  const result = await comment(env, "Quais clientes mais perderam faturamento?", grouped);
  assert.deepEqual(result, factualCommentary(grouped));
  assert.equal(commentaryGrounded(result, grouped), true);
  assert.equal(fetch.mock.callCount(), 0);
});

test("resumo factual de líquido decompõe bruto/devoluções e informa comparação absoluta e percentual válida",()=>{
  const r=report({...plan,filters:{...plan.filters}});r.comparison={current:{from:"2026-01-01",to:"2026-03-31"},previous:{from:"2025-01-01",to:"2025-03-31"},status:"comparable"};
  r.plan.filters.client="0001";
  const result=factualCommentary(r);
  assert.match(result.summary,/^Fato verificado:/);
  assert.match(result.summary,/Faturamento líquido[^.]*70,00/);
  assert.match(result.summary,/Faturamento bruto[^.]*80,00[^.]*135,00/);
  assert.match(result.summary,/Devoluções[^.]*10,00[^.]*5,00/);
  assert.match(result.summary,/Diferença absoluta[^.]*60,00/);assert.match(result.summary,/-46,15%/);
  assert.match(result.summary,/2025-01-01 a 2025-03-31/);assert.match(result.summary,/2026-11-18T12:00:00Z/);
  assert.match(result.summary,/client: 0001/);assert.match(result.summary,/Resumo factual automático calculado pela aplicação/);
  assert.equal(commentaryGrounded(result,r),true);
  for(const previous of [0,-50,null]){
    r.total.values.revenue.previous=previous;
    const summary=factualCommentary(r).summary;
    assert.doesNotMatch(summary,/%/);
    assert.match(summary,previous===0?/base anterior é zero/:previous===null?/falta valor/:/base anterior é negativa/);
  }
});

test("resumo de quedas cita até três itens efetivamente menores sem inferir causas ou somar atribuições M:M",()=>{
  for(const group of ["client","product"] as const){
    const r=report({...plan,group,order:"decline"});
    r.rows=[row("Menor",90,100),{...row("Descrição autorizada",10,100),key:"0002"},row("Terceiro",40,100),
      row("Quarto",50,100),row("Cresceu",200,100),row("Sem comparação",null,300)];
    r.warnings=["Os relacionamentos muitos-para-muitos podem atribuir valores a mais de um grupo. Não some as linhas."];r.truncated=true;
    const result=factualCommentary(r);
    assert.match(result.summary,/0002 — Descrição autorizada: atual[^.]*10,00[^.]*100,00[^.]*90,00/);
    assert.match(result.summary,/Terceiro: atual/);assert.match(result.summary,/Quarto: atual/);
    assert.doesNotMatch(result.summary,/Menor: atual|Cresceu: atual|Sem comparação: atual/);
    assert.ok(result.summary.indexOf("0002 —")<result.summary.indexOf("Terceiro: atual"));
    assert.match(result.summary,/não some as quedas para explicar o total/);assert.match(result.summary,/somente as linhas exibidas/);
    assert.match(result.summary,/causas comerciais precisam ser confirmadas/);assert.equal(commentaryGrounded(result,r),true);
  }
});

test("comentário aceita formatos monetários válidos e rejeita números ou percentuais inventados", async t => {
  const r = report(plan);
  assert.equal(commentaryGrounded({ summary: "Faturamento de R$ 70,00 ante R$ 130,00; queda de 46,15%.", actions: [] }, r), true);
  assert.equal(commentaryGrounded({ summary: "Faturamento de R$ 999.999,00.", actions: [] }, r), false);
  assert.equal(commentaryGrounded({ summary: "Crescimento de 987,65%.", actions: [] }, r), false);
  assert.equal(commentaryGrounded({ summary: "Crescimento de 46,15%.", actions: [] }, r), false, "mesmo número válido não autoriza sentido contrário");
  assert.equal(commentaryGrounded({ summary: "Faturamento +46,15%.", actions: [] }, r), false);
  assert.equal(commentaryGrounded({ summary: "Faturamento de R$ 2026,00.", actions: [] }, r), false, "ano da evidência não vira quantia monetária");
  const { env, sql } = makeStore();
  t.after(() => sql.close());
  t.mock.method(globalThis, "fetch", async () => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ summary: "Você faturou R$ 999.999,00 e cresceu 987,12%.", actions: ["Comprar 500 unidades."] }) }] }] }));
  const answer = await comment(env, "Como está o resultado?", r);
  assert.match(answer.summary, /Fato verificado/);
  assert.match(answer.summary, /70,00/);
  assert.doesNotMatch(JSON.stringify(answer), /999|987|500/);
});

test("resolução por nome usa só candidatos autorizados e não escolhe cadastro ambíguo", async () => {
  const { value } = provider();
  value.search = async (_filters, dimension, query) => ({ items: dimension === "client" && query === "Cliente Único" ? [{ key: "0001", name: "0001 — Cliente Único" }] : [{ key: "0002", name: "0002 — Loja A" }, { key: "0003", name: "0003 — Loja B" }], truncated: false });
  const resolved = await resolvePlanEntities(value, { ...plan, filters: { ...filters, client: "Cliente Único" } });
  assert.equal(resolved.filters.client, "0001");
  assert.equal(plan.filters.client, "", "plano de entrada não sofre mutação");
  await assert.rejects(resolvePlanEntities(value, { ...plan, filters: { ...filters, client: "Loja" } }), /mais de um cadastro/);
  value.search = async () => ({ items: [], truncated: false });
  await assert.rejects(resolvePlanEntities(value, { ...plan, filters: { ...filters, product: "Inexistente" } }), /Nenhum cadastro de produto/);
  value.search = async () => ({ items: [{ key: "10002", name: "10002 — Outro cadastro autorizado" }], truncated: false });
  await assert.rejects(resolvePlanEntities(value, { ...plan, filters: { ...filters, client: "0002" } }), /não foi localizado exatamente/);
  const fixed = { ...filters, client: "0002" };
  assert.equal((await resolvePlanEntities(value, { ...plan, filters: fixed }, fixed)).filters.client, "0002", "seleção exata segue para ACL da consulta sem troca aproximada");
});

test("visita de cliente inativo preserva identificação histórica e declara ausência de movimento", async () => {
  const { value } = provider();
  value.search = async () => ({ items: [{ key: "0001", name: "0001 — Cliente inativo" }], truncated: false });
  value.query = async p => ({ ...report(p), total: row("Total", null, null), rows: p.group === "month" ? [row("2026-01", null, null)] : [] });
  const visit = await prepareVisit(value, { ...filters, client: "0001" });
  assert.equal(visit.client.name, "0001 — Cliente inativo");
  assert.equal(visit.timeline.total.values.revenue.current, null);
  assert.match(visit.summary, /sem movimentos observados/);
  assert.match(visit.limitations.join(" "), /Cliente localizado no histórico autorizado/);
  assert.equal(visit.activity.lastPurchase, null);
  assert.equal(visit.activity.monthsWithPurchases, 0);
  assert.equal(visit.insights.length, 0);
});

test("alerta sem venda observada exige cobertura válida e mantém bruto nulo", () => {
  const r = report({ ...plan, group: "client" });
  r.total.values.revenue = { current: null, previous: null };
  r.rows = [row("0001", null, 50)];
  assert.equal(reportInsights(r).length, 0, "sem cobertura comprovada não declarar inatividade");
  r.comparison = { current: { from: "2026-01-01", to: "2026-03-31" }, previous: { from: "2025-01-01", to: "2025-03-31" }, status: "comparable" };
  const alerts = reportInsights(r);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /sem venda bruta observada/);
  assert.equal(alerts[0].impact, 55);
  assert.equal(r.rows[0].values.gross.current, null);
  r.comparison.status = "outside-coverage";
  assert.equal(reportInsights(r).length, 0);
});

test("UF por nome ou sigla é preservada mesmo quando o modelo omite o recorte", async t => {
  assert.equal(canonicalState("São Paulo"), "SP");
  assert.equal(canonicalState("sao paulo"), "SP");
  assert.equal(canonicalState("sp"), "SP");
  assert.throws(() => canonicalState("Sudeste"), /UF não reconhecida/);
  const { env, sql } = makeStore();
  t.after(() => sql.close());
  t.mock.method(globalThis, "fetch", async () => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ supported: true, reason: "", inheritContext: false, ...plan }) }] }] }));
  const { value } = provider();
  const semantic = { ...value.semantics, allowAI: true };
  const resolved = await interpret(env, semantic, "Como está São Paulo?", filters, []);
  assert.equal(resolved.filters.state, "SP");
  await assert.rejects(interpret(env, { ...semantic, capabilities: undefined }, "Como está São Paulo?", filters, []), /não será ampliada ao resultado nacional/);
  await assert.rejects(interpret(env, semantic, "Como estão SP e RJ?", filters, []), /mais de uma UF/);
});
