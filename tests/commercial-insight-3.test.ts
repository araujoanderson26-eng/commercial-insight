import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultFilters, type DataCapabilities, type Filters, type Report } from "../shared/domain";
import {
  buildFilterContext,
  describeFilterScope,
  enforceActiveFilterContext,
} from "../shared/filter-context";
import {
  calcNetRevenue,
  calcParticipationPct,
  calcTicketPerBuyer,
  calcYoYDiff,
  calcYoYPercent,
  OFFICIAL_INDICATORS,
  summarizeReportIndicators,
} from "../shared/metrics";
import { BI_MODULES, DATA_SOURCE_ADAPTERS } from "../shared/bi-modules";
import { compareReconciliationSnapshots } from "../shared/reconciliation";
import { buildCommentOpenAIRequest, interpret, reviewCommentary } from "../worker/assistant";
import { routeCommercialIntent } from "../worker/intent-router";
import { productionAIModel, productionAIStatus } from "../worker/production-ai-budget";
import { Problem, now } from "../worker/core";
import { makeStore, model } from "./fixtures";

const fullCaps: DataCapabilities = {
  metrics: ["revenue", "gross", "returns", "buyers"],
  groups: ["month", "client", "region", "product", "category", "regional", "state", "manager"],
  filters: ["region", "client", "product", "category", "regional", "state", "manager"],
  extraFilters: ["municipality", "channel", "brand", "segment", "macroCategory", "itemGroup"],
};

test("Modo A (determinístico) roteia perguntas objetivas sem OpenAI e Modo B (analítico) delega à IA", () => {
  const active: Filters = { from: "2026-01", to: "2026-10", region: "", client: "", product: "" };

  // Modo A — Determinísticas
  const nov = routeCommercialIntent("Quanto faturei em novembro?", active, fullCaps, []);
  assert.equal(nov?.kind, "metric_summary");
  assert.equal(nov?.plan.metric, "revenue");
  assert.equal(nov?.plan.filters.from, "2026-11");
  assert.equal(nov?.plan.filters.to, "2026-11");

  const byReg = routeCommercialIntent("Qual o faturamento líquido por regional?", active, fullCaps, []);
  assert.equal(byReg?.kind, "metric_summary");
  assert.equal(byReg?.plan.group, "regional");
  assert.equal(byReg?.plan.metric, "revenue");

  const yoy = routeCommercialIntent("Quanto cresci em relação ao ano anterior?", active, fullCaps, []);
  assert.equal(yoy?.kind, "yoy_growth");

  const top10 = routeCommercialIntent("Quais os 10 maiores clientes?", active, fullCaps, []);
  assert.equal(top10?.kind, "ranking");
  assert.equal(top10?.plan.group, "client");
  assert.equal(top10?.plan.order, "current");

  const sucos = routeCommercialIntent("Quanto vendi de sucos?", active, fullCaps, []);
  assert.equal(sucos?.kind, "category_filtered");
  assert.deepEqual(sucos?.plan.filters.categoriesInclude, ["SUCO"]);

  const devs = routeCommercialIntent("Qual foi o valor das devoluções?", active, fullCaps, []);
  assert.equal(devs?.kind, "metric_summary");
  assert.equal(devs?.plan.metric, "returns");

  // Modo B — Analíticas abertas devem retornar null (delegadas à OpenAI)
  const analyticalPrompts = [
    "Por que a regional Sudeste 1 está perdendo faturamento?",
    "Quais clientes apresentam maior risco de abandono?",
    "Quais produtos oferecem oportunidades de crescimento?",
    "Quais fatores explicam a queda nas vendas?",
    "Quais ações comerciais devo priorizar?",
    "Quais redes apresentam maior potencial de recuperação?",
    "Quais tendências merecem atenção da diretoria?",
  ];
  for (const q of analyticalPrompts) {
    assert.equal(routeCommercialIntent(q, active, fullCaps, []), null, `Esperado Modo B para: ${q}`);
  }
});

test("Contrato único de contexto de filtros impede a IA de ampliar o recorte do usuário", async (t) => {
  const s = makeStore();
  t.after(() => s.sql.close());
  s.sql.exec(readFileSync(new URL("../migrations/0010_production_ai_budget.sql", import.meta.url), "utf8"));
  Object.assign(s.env, {
    APP_ORIGIN: "https://commercial-insight.araujoempresarial.com.br",
    PRODUCTION_AI_BUDGET: "true",
    OPENAI_MODEL: productionAIModel,
  });
  s.sql.prepare("INSERT INTO users(id,email,name,password,role,created) VALUES('admin1','a@s.test','A','x','admin',?)").run(now());
  s.sql.prepare("INSERT INTO users(id,email,name,password,role,created) VALUES('dir1','d@s.test','D','x','diretoria',?)").run(now());
  s.sql
    .prepare(
      `UPDATE ai_production_policy SET enabled=1,administrator_id='admin1',organization_id='org-test',project_id='proj_test',
       credit_ceiling_nano_usd=20000000000,credit_verified_at=?,credit_valid_until=?,verification_reference='ref',pricing_valid_until=? WHERE id=1`,
    )
    .run(now() - 86400 * 3, now() + 86400 * 30, now() + 86400 * 30);

  const activeFilters: Filters = {
    from: "2026-01",
    to: "2026-10",
    region: "",
    client: "",
    product: "",
    regional: "SP",
    clients: ["C001", "C002", "C003"],
    categoriesInclude: ["Macro Categoria: SUCO"],
  };
  const ctx = buildFilterContext(activeFilters);
  assert.equal(ctx.version, "3.0");
  assert.equal(ctx.activeSelectionCount, 5);
  assert.ok(describeFilterScope(activeFilters).some((line) => line.includes("São Paulo")));

  // Mock OpenAI returning an attempt to widen filters (clearing clients/categories)
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      status: "completed",
      model: productionAIModel,
      usage: { input_tokens: 120, output_tokens: 60 },
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                supported: true,
                reason: "",
                inheritContext: false,
                group: "client",
                metric: "revenue",
                order: "decline",
                filters: {
                  from: "2026-01",
                  to: "2026-10",
                  region: "",
                  client: "",
                  product: "",
                  regional: "",
                  state: "",
                  manager: "",
                  category: "",
                  categoriesInclude: [],
                  categoriesExclude: [],
                },
              }),
            },
          ],
        },
      ],
    }),
  );

  const plan = await interpret(
    s.env,
    { ...model, capabilities: fullCaps },
    "Por que minhas vendas caíram?",
    activeFilters,
    [],
    "dir1",
  );
  assert.equal(plan.filters.regional, "SP");
  assert.deepEqual(plan.filters.clients, ["C001", "C002", "C003"]);
  assert.deepEqual(plan.filters.categoriesInclude, ["Macro Categoria: SUCO"]);
  assert.equal(plan.filters.from, "2026-01");
  assert.equal(plan.filters.to, "2026-10");

  // Direct helper check
  const enforced = enforceActiveFilterContext(activeFilters, defaultFilters());
  assert.deepEqual(enforced.clients, ["C001", "C002", "C003"]);
});

test("Modo B estrutura fatos, indicadores, hipóteses, recomendações e trata indisponibilidade/cota OpenAI", async (t) => {
  const sampleReport: Report = {
    plan: {
      group: "client",
      metric: "revenue",
      order: "decline",
      filters: { from: "2026-01", to: "2026-10", region: "", client: "", product: "", regional: "SP" },
    },
    total: {
      name: "Total",
      values: {
        gross: { current: 1000, previous: 1200 },
        returns: { current: 100, previous: 50 },
        revenue: { current: 900, previous: 1150 },
        buyers: { current: 10, previous: 12 },
        margin: { current: null, previous: null },
      },
    },
    rows: [
      {
        key: "C001",
        name: "C001 — Cliente Sintético",
        values: {
          gross: { current: 400, previous: 600 },
          returns: { current: 50, previous: 20 },
          revenue: { current: 350, previous: 580 },
          buyers: { current: 1, previous: 1 },
          margin: { current: null, previous: null },
        },
      },
    ],
    asOf: "2026-11-17T12:00:00Z",
    truncated: false,
    source: "Arquivo manual (D1)",
  };

  const reviewed = reviewCommentary(
    {
      summary: "O faturamento líquido foi de R$ 900,00 frente a R$ 1.150,00 no período anterior.",
      facts: ["O cliente C001 apresentou faturamento líquido de R$ 350,00 ante R$ 580,00."],
      indicators: ["Faturamento bruto de R$ 1.000,00 e devoluções de R$ 100,00."],
      hypotheses: ["Verificar se houve alteração de mix ou disponibilidade no cliente C001."],
      actions: ["Revisar o histórico de pedidos do cliente C001 com o representante."],
      limitations: ["Dados de estoque e margem não estão disponíveis neste recorte."],
    },
    sampleReport,
  );
  assert.equal(reviewed.validation.status, "accepted");
  assert.equal(reviewed.facts?.length, 1);
  assert.equal(reviewed.indicators?.length, 1);
  assert.equal(reviewed.hypotheses?.length, 1);
  assert.equal(reviewed.limitations?.length, 1);

  // Request payload includes central indicators summary and strict schema fields
  const s = makeStore();
  t.after(() => s.sql.close());
  s.sql.exec(readFileSync(new URL("../migrations/0010_production_ai_budget.sql", import.meta.url), "utf8"));
  Object.assign(s.env, {
    APP_ORIGIN: "https://commercial-insight.araujoempresarial.com.br",
    PRODUCTION_AI_BUDGET: "true",
    OPENAI_MODEL: productionAIModel,
  });
  s.sql.prepare("INSERT INTO users(id,email,name,password,role,created) VALUES('admin1','a@s.test','A','x','admin',?)").run(now());
  s.sql
    .prepare(
      `UPDATE ai_production_policy SET enabled=1,administrator_id='admin1',organization_id='org-test',project_id='proj_test',
       credit_ceiling_nano_usd=20000000000,credit_verified_at=?,credit_valid_until=?,verification_reference='ref',pricing_valid_until=? WHERE id=1`,
    )
    .run(now() - 86400 * 5, now() + 86400 * 30, now() + 86400 * 30);

  const reqJson = JSON.parse(buildCommentOpenAIRequest(s.env, "Por que caiu?", sampleReport, "admin1"));
  assert.ok(reqJson.text.format.schema.properties.facts);
  assert.ok(reqJson.text.format.schema.properties.hypotheses);
  assert.ok(reqJson.input.includes("indicatorsSummary"));

  // OpenAI insufficient_quota disables policy and returns clear unmasked error
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } }, { status: 429 }),
  );
  await assert.rejects(
    interpret(s.env, { ...model, capabilities: fullCaps }, "Por que caiu?", sampleReport.plan.filters, [], "admin1"),
    (err: unknown) => err instanceof Problem && err.status === 429 && /saldo ou cota insuficiente/i.test(err.message),
  );
  assert.equal((await productionAIStatus(s.env, "admin1")).reason, "policy_disabled");
});

test("Camada central de indicadores, contratos BI 3.0 e conciliação reutilizável Power BI", () => {
  assert.ok(OFFICIAL_INDICATORS.revenue);
  assert.equal(calcNetRevenue(266288149.1, 9525848.54), 256762300.56);
  assert.equal(calcYoYDiff(256762300.56, 291854722.41), -35092421.85);
  assert.equal(Number(calcYoYPercent({ current: 256762300.56, previous: 291854722.41 })!.toFixed(2)), -12.02);
  assert.equal(calcYoYPercent({ current: 100, previous: 0 }), null);
  assert.equal(calcTicketPerBuyer(256762300.56, 3538), 72572.72);
  assert.equal(calcParticipationPct(137914999.19, 266288149.1), 51.79);

  // BI 3.0 expansion contracts
  assert.equal(BI_MODULES.comercial.status, "active");
  assert.equal(BI_MODULES.metas.status, "planned");
  assert.equal(DATA_SOURCE_ADAPTERS.csv_dax_studio.status, "active");
  assert.equal(DATA_SOURCE_ADAPTERS.erp_sap_b1.status, "planned");

  // Conciliação exata aprovada
  const ok = compareReconciliationSnapshots(
    {
      sourceName: "D1",
      referenceDate: "2026-11-17",
      periodFrom: "2026-01-01",
      periodTo: "2026-11-17",
      gross: 266288149.1,
      returns: 9525848.54,
      revenue: 256762300.56,
      breakdowns: { regional: { SP: 50000000 }, macroCategory: { SUCO: 80000000 } },
    },
    {
      sourceName: "Power BI CSV",
      referenceDate: "2026-11-17",
      periodFrom: "2026-01-01",
      periodTo: "2026-11-17",
      gross: 266288149.1,
      returns: 9525848.54,
      revenue: 256762300.56,
      breakdowns: { regional: { SP: 50000000 }, macroCategory: { SUCO: 80000000 } },
    },
  );
  assert.equal(ok.approved, true);
  assert.equal(ok.divergences.length, 0);

  // Rejeita comparação entre datas diferentes
  const wrongDate = compareReconciliationSnapshots(
    { sourceName: "D1", referenceDate: "2026-11-17", periodFrom: "2026-01-01", periodTo: "2026-11-17", gross: 100, returns: 10, revenue: 90 },
    { sourceName: "PBI", referenceDate: "2026-11-10", periodFrom: "2026-01-01", periodTo: "2026-11-17", gross: 100, returns: 10, revenue: 90 },
  );
  assert.equal(wrongDate.approved, false);
  assert.equal(wrongDate.divergences[0]?.scope, "metadata");

  // Quantifica divergência financeira
  const diff = compareReconciliationSnapshots(
    { sourceName: "D1", referenceDate: "2026-11-17", periodFrom: "2026-01-01", periodTo: "2026-11-17", gross: 100.5, returns: 10, revenue: 90.5 },
    { sourceName: "PBI", referenceDate: "2026-11-17", periodFrom: "2026-01-01", periodTo: "2026-11-17", gross: 100, returns: 10, revenue: 90 },
  );
  assert.equal(diff.approved, false);
  assert.equal(diff.divergences.length, 2);
  assert.equal(diff.divergences[0]?.delta, 0.5);

  // summarizeReportIndicators smoke
  const summary = summarizeReportIndicators({
    plan: { group: "category", metric: "revenue", order: "current", filters: defaultFilters() },
    total: {
      name: "Total",
      values: {
        gross: { current: 200, previous: 100 },
        returns: { current: 20, previous: 10 },
        revenue: { current: 180, previous: 90 },
        buyers: { current: 9, previous: 5 },
        margin: { current: null, previous: null },
      },
    },
    rows: [
      {
        key: "SUCO",
        name: "SUCO",
        values: {
          gross: { current: 100, previous: 50 },
          returns: { current: 10, previous: 5 },
          revenue: { current: 90, previous: 45 },
          buyers: { current: 5, previous: 3 },
          margin: { current: null, previous: null },
        },
      },
    ],
    asOf: "2026-11-17T00:00:00Z",
    truncated: false,
    source: "Arquivo manual (D1)",
  });
  assert.equal(summary.ticketPerBuyer, 20);
  assert.equal(summary.yoyGrowthPct, 100);
  assert.equal(summary.rowShares[0]?.sharePct, 50);
});
