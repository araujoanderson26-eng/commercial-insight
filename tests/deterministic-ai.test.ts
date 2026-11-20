import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import worker from "../worker/index";
import { now } from "../worker/core";
import { routeCommercialIntent } from "../worker/intent-router";
import { nativePartStatements } from "../worker/native-model";
import { productionAIModel } from "../worker/production-ai-budget";
import { resolvePlanEntities, type DataProvider } from "../worker/providers";
import { makeStore } from "./fixtures";
import { nativeFixture, type NativeRows } from "./native-fixtures";

async function setupDeterministicStore() {
  const s = makeStore();
  s.sql.exec(readFileSync(new URL("../migrations/0010_production_ai_budget.sql", import.meta.url), "utf8"));
  s.sql.exec(readFileSync(new URL("../migrations/0011_structured_csv_layer.sql", import.meta.url), "utf8"));

  const rows: NativeRows = {
    s: [
      ["2025-01-10", "C001", "P_SUCO", "PA - SUCO", "SP", "São Paulo", "500.00"],
      ["2025-01-11", "C002", "P_VINHO", "PA - VINHO", "SP", "São Paulo", "900.00"], // C002 stops buying in 2026 -> churned!
      ["2026-01-10", "C001", "P_SUCO", "PA - SUCO", "SP", "São Paulo", "1200.00"],
      ["2026-01-11", "C001", "P_GRANEL", "PA - GRANEL", "SP", "São Paulo", "400.00"],
      ["2026-01-12", "C003", "P_VINHO", "PA - VINHO", "RJ", "Rio de Janeiro", "300.00"],
    ],
    r: [
      ["2025-01-10", "C001", "P_SUCO", "PA - SUCO", "SP", "50.00"],
      ["2026-01-12", "C001", "P_SUCO", "PA - SUCO", "SP", "100.00"],
    ],
    c: [
      ["C001", "Rep Alfa", "SP"],
      ["C001", "Rep Alfa", "SP"], // Exact duplicate row!
      ["C002", "Rep Alfa", "SP"],
      ["C003", "Rep Beta", "RJ"],
      ["C004", "Rep Sem Venda", "PR"], // 3 distinct reps, 2 selling; 4 distinct registered clients!
    ],
    d: [
      ["2025-01-10"],
      ["2025-01-11"],
      ["2026-01-10"],
      ["2026-01-11"],
      ["2026-01-12"],
    ],
    g: [
      ["SP", "Sudeste", "Gerente Sul/SE"],
      ["RJ", "Sudeste", "Gerente Sul/SE"],
      ["PR", "Sul", "Gerente Sul/SE"],
    ],
    m: [["São Paulo"], ["Rio de Janeiro"]],
    l: [["SP"], ["RJ"], ["PR"]],
    a: [["SP"], ["RJ"], ["PR"]],
    z: [],
  };

  const pkg = nativeFixture(rows, (m) => {
    m.projection.from = "2025-01-10";
    m.projection.to = "2026-01-12";
    m.referenceDate = "2026-01-12";
    m.controls = m.controls.slice(0, 6);
  });
  pkg.manifest.inventory.tables.push({
    ...pkg.manifest.inventory.tables[0],
    id: "products",
    name: "Base Produtos",
    columns: ["Codigo Item", "Descrição do item", "Macro Categoria"].map((name) => ({
      ...pkg.manifest.inventory.tables[0].columns[0],
      name,
    })),
    rowCount: 3,
    sourceRowCount: 3,
    parts: [],
  });
  for (const fact of [pkg.manifest.nativeModel!.sales, pkg.manifest.nativeModel!.returns]) {
    pkg.manifest.inventory.relationships.push({
      ...pkg.manifest.inventory.relationships[0],
      fromTable: fact.table,
      fromColumn: fact.product,
      toTable: "products",
      toColumn: "Codigo Item",
      isActive: true,
      crossFilteringBehavior: "OneDirection",
    });
  }
  const custLabels = ["Supermercado Alfa", "Supermercado Alfa", "Empório Beta", "Adega Gama", "Casa Delta"];
  const version = randomUUID();
  s.sql
    .prepare(
      "INSERT INTO ci_imports(id,owner,actor,filename,bytes,sha256,object_key,status,base_generation,created,updated,published,manifest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(version, "admin", "Admin", "det.ci.ndjson", pkg.data.length, pkg.sha256, "local", "published", 0, 1, 1, 1, JSON.stringify(pkg.manifest));
  s.sql
    .prepare("UPDATE ci_sources SET source='manual',active_version_id=?,allow_ai=1,active_at=1 WHERE id='commercial-main'")
    .run(version);

  for (const t of pkg.manifest.inventory.tables) {
    if (rows[t.id]) {
      await s.env.DB.batch(nativePartStatements(s.env, pkg.manifest, version, t.id, rows[t.id].map((values, i) => ({ row: i + 1, values }))));
    }
  }
  const prodMacros: [string, string, string][] = [
    ["P_SUCO", "Suco Integral Uva", "SUCO"],
    ["P_VINHO", "Vinho Tinto Seco", "VINHO"],
    ["P_GRANEL", "Vinho Tinto Granel", "VINHO"],
  ];
  for (const [i, pRow] of prodMacros.entries()) {
    s.sql.prepare("INSERT INTO ci_raw_rows(version_id,table_id,row_no,value) VALUES(?,?,?,?)").run(version, "products", i + 1, JSON.stringify(pRow));
  }
  const custTable = pkg.manifest.inventory.tables.find((t) => t.id === "c")!;
  custTable.columns.push({ name: "Cliente", type: "String" });
  s.sql.exec("DELETE FROM ci_raw_rows WHERE table_id='c'");
  for (const [i, row] of rows.c.entries()) {
    s.sql
      .prepare("INSERT INTO ci_raw_rows(version_id,table_id,row_no,value) VALUES(?,?,?,?)")
      .run(version, "c", i + 1, JSON.stringify([...row, custLabels[i]]));
  }
  s.sql.prepare("UPDATE ci_imports SET manifest=? WHERE id=?").run(JSON.stringify(pkg.manifest), version);

  const adminId = "admin-det";
  const secretAdmin = "a".repeat(64);
  s.sql
    .prepare("INSERT INTO users(id,email,name,password,role,national,active,created) VALUES(?,?,?,?,?,1,1,?)")
    .run(adminId, "admin@det.test", "Admin", "hash", "admin", now());
  s.sql
    .prepare("INSERT INTO sessions(hash,user_id,version,expires,seen) VALUES(?,?,1,?,?)")
    .run(createHash("sha256").update(secretAdmin).digest("hex"), adminId, now() + 3600, now());

  const spUserId = "rep-sp";
  const secretSp = "b".repeat(64);
  s.sql
    .prepare("INSERT INTO users(id,email,name,password,role,national,regions,clients,active,created) VALUES(?,?,?,?,?,0,?,?,1,?)")
    .run(spUserId, "alfa@det.test", "Rep Alfa", "hash", "comercial", '["Rep Alfa"]', "[]", now());
  s.sql
    .prepare("INSERT INTO sessions(hash,user_id,version,expires,seen) VALUES(?,?,1,?,?)")
    .run(createHash("sha256").update(secretSp).digest("hex"), spUserId, now() + 3600, now());

  return { ...s, secretAdmin, secretSp, adminId };
}

test("all 15 mandatory AI questions answer deterministically in milliseconds with ZERO OpenAI calls and ACL enforcement", async (t) => {
  const s = await setupDeterministicStore();
  t.after(() => s.sql.close());

  let openAiCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    openAiCalls++;
    return Response.json({
      status: "completed",
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
                group: "month",
                metric: "revenue",
                order: "current",
                filters: { from: "2026-01", to: "2026-01", region: "", client: "", product: "", categoriesInclude: [], categoriesExclude: [] },
              }),
            },
          ],
        },
      ],
    });
  });

  const ask = async (question: string, secret = s.secretAdmin, extraFilters = {}) => {
    const res = await worker.fetch(
      new Request(s.env.APP_ORIGIN + "/api/chat", {
        method: "POST",
        headers: {
          Origin: s.env.APP_ORIGIN,
          Cookie: "__Host-ci=" + secret,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question,
          filters: { from: "2026-01", to: "2026-01", region: "", client: "", product: "", ...extraFilters },
          conversation: null,
        }),
      }),
      s.env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };

  // All 15 questions must resolve with engine="deterministic" and openAiCalls === 0!
  const q1 = await ask("Quantos clientes distintos existem na base?");
  assert.equal(q1.status, 200);
  assert.equal(q1.json.meta.engine, "deterministic");
  assert.match(q1.json.commentary.summary, /4 clientes distintos cadastrados/);

  const q2 = await ask("Quantos clientes compraram em 2026?");
  assert.equal(q2.status, 200);
  assert.equal(q2.json.meta.engine, "deterministic");
  assert.match(q2.json.commentary.summary, /2 clientes distintos realizaram compras/);

  const q3 = await ask("Quantos representantes existem cadastrados?");
  assert.equal(q3.status, 200);
  assert.match(q3.json.commentary.summary, /3 representantes distintos cadastrados/);

  const q4 = await ask("Quantos representantes tiveram vendas?");
  assert.equal(q4.status, 200);
  assert.match(q4.json.commentary.summary, /2 representantes distintos tiveram vendas/);

  const q5 = await ask("Qual foi o faturamento bruto em 2026?");
  assert.equal(q5.status, 200);
  assert.equal(q5.json.report.total.values.gross.current, 1900);

  const q6 = await ask("Qual foi o faturamento líquido?");
  assert.equal(q6.status, 200);
  assert.equal(q6.json.report.total.values.revenue.current, 1800);

  const q7 = await ask("Quais foram as devoluções?");
  assert.equal(q7.status, 200);
  assert.equal(q7.json.report.total.values.returns.current, 100);

  const q8 = await ask("Qual foi o crescimento em relação a 2025?");
  assert.equal(q8.status, 200);
  assert.match(q8.json.commentary.summary, /1\.800,00/);

  const q9 = await ask("Quais clientes tiveram maior queda de faturamento?");
  assert.equal(q9.status, 200);
  assert.equal(q9.json.report.plan.group, "client");
  assert.equal(q9.json.report.plan.order, "decline");
  assert.equal(q9.json.report.rows[0].key, "C002");

  const q10 = await ask("Quais produtos tiveram maior crescimento?");
  assert.equal(q10.status, 200);
  assert.equal(q10.json.report.plan.group, "product");
  assert.equal(q10.json.report.plan.order, "growth");
  assert.equal(q10.json.report.rows[0].key, "P_SUCO");

  const q11 = await ask("Quanto faturamos em Suco e Vinho excluindo Granel?");
  assert.equal(q11.status, 200);
  // SUCO (1200 gross) + VINHO (300 gross) minus GRANEL (400 excluded!) = 1500 gross, 100 returns, 1400 net
  assert.equal(q11.json.report.total.values.gross.current, 1500);
  assert.equal(q11.json.report.total.values.revenue.current, 1400);

  const q12 = await ask("Qual a participação de cada categoria?");
  assert.equal(q12.status, 200);
  assert.equal(q12.json.report.plan.group, "category");
  assert.match(q12.json.commentary.summary, /%/);

  const q13 = await ask("Quais representantes mais cresceram?");
  assert.equal(q13.status, 200);
  assert.equal(q13.json.report.plan.group, "region");
  assert.equal(q13.json.report.plan.order, "growth");

  const q14 = await ask("Quais clientes deixaram de comprar?");
  assert.equal(q14.status, 200);
  assert.match(q14.json.commentary.summary, /1 clientes compraram no período homólogo anterior/);
  assert.match(q14.json.commentary.summary, /C002/);

  const q15 = await ask("Prepare um resumo comercial para visita ao cliente C001 amanhã");
  assert.equal(q15.status, 200, JSON.stringify(q15.json));
  assert.ok(q15.json.visit);
  assert.equal(q15.json.visit.client.code, "C001");

  assert.equal(openAiCalls, 0, "Zero OpenAI calls allowed for all 15 deterministic questions!");

  // Restricted ACL user only sees their own authorized scope counts (never out-of-scope C003/C004)
  const aclQ1 = await ask("Quantos clientes distintos existem na base?", s.secretSp);
  assert.equal(aclQ1.status, 200);
  assert.match(aclQ1.json.commentary.summary, /2 clientes distintos cadastrados/);

  // Mode 1 (deterministic D1) keeps working even when OpenAI is restricted; Mode 2 (open OpenAI) stays strictly guarded
  s.env.PRODUCTION_AI_BUDGET = "true";
  const detSp = await ask("Qual foi o faturamento líquido?", s.secretSp);
  assert.equal(detSp.status, 200);
  assert.equal(detSp.json.meta.engine, "deterministic");
  const deniedOpenSp = await ask("Analise meu faturamento e sugira hipóteses estratégicas", s.secretSp);
  assert.equal(deniedOpenSp.status, 403);
  delete s.env.PRODUCTION_AI_BUDGET;

  s.sql.exec("UPDATE ci_sources SET allow_ai=0");
  const detDisabledAI = await ask("Qual foi o faturamento líquido?");
  assert.equal(detDisabledAI.status, 200);
  assert.equal(detDisabledAI.json.meta.engine, "deterministic");
  assert.equal((await ask("Analise meu faturamento e sugira hipóteses estratégicas")).status, 409);
  s.sql.exec("UPDATE ci_sources SET allow_ai=1");

  // Open analytical questions still fall back cleanly to OpenAI
  const openRes = await ask("Analise meu faturamento e sugira hipóteses estratégicas");
  assert.equal(openRes.status, 200);
  assert.equal(openRes.json.meta.engine, "openai");
  assert.ok(openAiCalls >= 1);
});

test("deterministic router and entity resolver keep Sucos Concentrados, Granel, Vinho Importado and Sucos Importados strictly independent", async () => {
  const filters = { from: "2026-01", to: "2026-01", region: "", client: "", product: "" };
  const capabilities = {
    metrics: ["revenue" as const, "gross" as const, "returns" as const, "buyers" as const],
    groups: ["month" as const, "client" as const, "product" as const, "category" as const, "region" as const, "state" as const, "regional" as const],
    filters: ["region" as const, "client" as const, "product" as const, "category" as const, "state" as const, "regional" as const],
  };

  const catalogKeys = [
    "Macro Categoria: SUCO",
    "Macro Categoria: SUCO CONCENTRADO DE UVA",
    "Macro Categoria: SUCO CONCENTRADO DE MAÇÃ",
    "Macro Categoria: SUCO CONCENTRADO DE LARANJA",
    "Macro Categoria: SUCO CONCENTRADO DE TANGERINA",
    "Macro Categoria: VINHO",
    "Macro Categoria: VINHO IMPORTADO",
    "Macro Categoria: VINHO GRANEL",
    "Macro Categoria: VINAGRE",
    "Macro Categoria: VINAGRE GRANEL",
    "PA - GRANEL",
    "PA - SUCO CONCENTRADO GRANEL",
  ];
  const mockProvider: DataProvider = {
    sourceType: "manual",
    versionId: "v",
    semantics: { allowAI: false, measures: { revenue: "Líq", gross: "Bruto", returns: "Dev", buyers: "Comp", margin: null }, capabilities },
    query: async () => {
      throw new Error("not used");
    },
    search: async (_f, _dim, q) => ({
      items: catalogKeys
        .filter((k) => k.toLocaleLowerCase("pt-BR").includes(q.toLocaleLowerCase("pt-BR")))
        .map((key) => ({ key, name: key })),
      truncated: false,
    }),
  };

  const uvaIntent = routeCommercialIntent("Quanto faturamos em Suco Concentrado de Uva em 2026?", filters, capabilities, []);
  assert.ok(uvaIntent);
  assert.deepEqual(uvaIntent.plan.filters.categoriesInclude, ["Macro Categoria: SUCO CONCENTRADO DE UVA"]);
  const uvaResolved = await resolvePlanEntities(mockProvider, uvaIntent.plan, filters);
  assert.deepEqual(uvaResolved.filters.categoriesInclude, ["Macro Categoria: SUCO CONCENTRADO DE UVA"]);

  const impVinhoIntent = routeCommercialIntent("Quanto faturamos em Vinho Importado em 2026?", filters, capabilities, []);
  assert.ok(impVinhoIntent);
  assert.deepEqual(impVinhoIntent.plan.filters.categoriesInclude, ["Macro Categoria: VINHO IMPORTADO"]);
  const impVinhoResolved = await resolvePlanEntities(mockProvider, impVinhoIntent.plan, filters);
  assert.deepEqual(impVinhoResolved.filters.categoriesInclude, ["Macro Categoria: VINHO IMPORTADO"]);

  const vinhoGranelIntent = routeCommercialIntent("Quanto faturamos em Vinho Granel em 2026?", filters, capabilities, []);
  assert.ok(vinhoGranelIntent);
  assert.deepEqual(vinhoGranelIntent.plan.filters.categoriesInclude, ["Macro Categoria: VINHO GRANEL"]);

  const excConcIntent = routeCommercialIntent(
    "Quanto faturamos em Suco e Vinho excluindo Suco Concentrado de Uva e Granel?",
    filters,
    capabilities,
    [],
  );
  assert.ok(excConcIntent);
  assert.deepEqual(excConcIntent.plan.filters.categoriesInclude, ["SUCO", "VINHO"]);
  assert.deepEqual(excConcIntent.plan.filters.categoriesExclude, ["Macro Categoria: SUCO CONCENTRADO DE UVA", "GRANEL"]);

  // Generic Sucos Importados / Sucos Concentrados never auto-map to SUCO
  const sucoImpIntent = routeCommercialIntent("Quanto faturamos em Sucos Importados?", filters, capabilities, []);
  assert.ok(sucoImpIntent);
  assert.deepEqual(sucoImpIntent.plan.filters.categoriesInclude, ["SUCO IMPORTADO"]);
  await assert.rejects(() => resolvePlanEntities(mockProvider, sucoImpIntent.plan, filters), /não é agrupada automaticamente em SUCO/);

  const sucoConcIntent = routeCommercialIntent("Quanto faturamos em Sucos Concentrados?", filters, capabilities, []);
  assert.ok(sucoConcIntent);
  assert.deepEqual(sucoConcIntent.plan.filters.categoriesInclude, ["SUCOS CONCENTRADOS"]);
  await assert.rejects(() => resolvePlanEntities(mockProvider, sucoConcIntent.plan, filters), /não são agrupados em SUCO/);
});

test("deterministic commercial queries stay available when OpenAI credits are unverified or expired, while OpenAI queries stay blocked with zero fetch calls", async (t) => {
  const s = await setupDeterministicStore();
  t.after(() => s.sql.close());

  Object.assign(s.env, {
    APP_ORIGIN: "https://commercial-insight.araujoempresarial.com.br",
    PRODUCTION_AI_BUDGET: "true",
    OPENAI_MODEL: productionAIModel,
  });

  const ts = now();
  s.sql
    .prepare(
      `UPDATE ai_production_policy
       SET enabled=1, administrator_id=?, organization_id='org-synthetic', project_id='proj_synthetic',
           credit_ceiling_nano_usd=30000000000, credit_verified_at=?, credit_valid_until=?,
           verification_reference='synthetic-proof-only', pricing_valid_until=?
       WHERE id=1`,
    )
    .run(s.adminId, ts - 86401, ts + 3600, ts + 3600);

  const opId = "op-det";
  const secretOp = "c".repeat(64);
  s.sql
    .prepare("INSERT INTO users(id,email,name,password,role,national,regions,clients,update_only,active,created) VALUES(?,?,?,?,?,0,'[]','[]',1,1,?)")
    .run(opId, "op@det.test", "Operador", "hash", "comercial", ts);
  s.sql
    .prepare("INSERT INTO sessions(hash,user_id,version,expires,seen) VALUES(?,?,1,?,?)")
    .run(createHash("sha256").update(secretOp).digest("hex"), opId, ts + 3600, ts);

  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls++;
    throw new Error("OpenAI network fetch must NOT be called!");
  });

  const callApi = async (path: string, method: "GET" | "POST", payload?: unknown, secret = s.secretAdmin) => {
    const res = await worker.fetch(
      new Request(s.env.APP_ORIGIN + "/api/" + path, {
        method,
        headers: {
          Origin: s.env.APP_ORIGIN,
          Cookie: "__Host-ci=" + secret,
          ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      }),
      s.env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };

  // Assistant status explicitly exposes both independent modes
  const st = await callApi("assistant/status", "GET");
  assert.equal(st.status, 200);
  assert.equal(st.json.deterministic?.ready, true);
  assert.equal(st.json.advancedAI?.ready, false);
  assert.equal(st.json.advancedAI?.reason, "credits_unverified");
  assert.equal(st.json.ready, false);
  assert.equal(st.json.reason, "credits_unverified");

  // Mode 1: all 5 core deterministic commercial questions succeed cleanly
  const baseFilters = { from: "2026-01", to: "2026-01", region: "", client: "", product: "" };
  for (const question of [
    "Quantos clientes existem?",
    "Quantos representantes venderam em 2026?",
    "Quanto faturamos?",
    "Quanto vendemos de Suco e Vinho, excluindo Granel?",
    "Quais clientes apresentaram maior queda?",
  ]) {
    const res = await callApi("chat", "POST", { question, filters: baseFilters, conversation: null });
    assert.equal(res.status, 200, `${question}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.meta?.engine, "deterministic", question);
    assert.equal(res.json.meta?.openaiCalls, 0, question);
    assert.ok(typeof res.json.commentary?.summary === "string" && res.json.commentary.summary.length > 10);
  }

  // Non-admin commercial user still executes Mode 1 with ACL strictly applied, while Mode 2 stays 403
  const spDet = await callApi(
    "chat",
    "POST",
    { question: "Quantos clientes existem?", filters: baseFilters, conversation: null },
    s.secretSp,
  );
  assert.equal(spDet.status, 200);
  assert.match(spDet.json.commentary.summary, /2 clientes distintos cadastrados/);
  const spOpen = await callApi(
    "chat",
    "POST",
    {
      question: "Analise a estratégia comercial e explique por que houve variação no trimestre",
      filters: baseFilters,
      conversation: null,
    },
    s.secretSp,
  );
  assert.equal(spOpen.status, 403);

  // Update operator remains blocked (403) even on Mode 1 deterministic questions
  const opDenied = await callApi(
    "chat",
    "POST",
    { question: "Quanto faturamos?", filters: baseFilters, conversation: null },
    secretOp,
  );
  assert.equal(opDenied.status, 403);

  // Mode 2: open/advanced question for admin is blocked by expired/unverified credits (503) and does NOT auto-route
  const openExpiredVerified = await callApi("chat", "POST", {
    question: "Analise a estratégia comercial e explique por que houve variação no trimestre",
    filters: baseFilters,
    conversation: null,
  });
  assert.equal(openExpiredVerified.status, 503);
  assert.match(String(openExpiredVerified.json.error), /Análise avançada com OpenAI temporariamente indisponível/);

  // Also test expired credit_valid_until
  s.sql
    .prepare("UPDATE ai_production_policy SET credit_verified_at=?, credit_valid_until=? WHERE id=1")
    .run(ts, ts - 10);
  const detValidUntil = await callApi("chat", "POST", {
    question: "Quanto faturamos?",
    filters: baseFilters,
    conversation: null,
  });
  assert.equal(detValidUntil.status, 200);
  assert.equal(detValidUntil.json.meta?.engine, "deterministic");

  const openValidUntil = await callApi("chat", "POST", {
    question: "Analise a estratégia comercial e explique as causas da variação",
    filters: baseFilters,
    conversation: null,
  });
  assert.equal(openValidUntil.status, 503);

  assert.equal(fetchCalls, 0);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ai_production_attempts").get()!.n, 0);
});

test("active CSV batch metadata replaces legacy manual date in /api/me, /api/data/status and /api/assistant/status", async (t) => {
  const s = await setupDeterministicStore();
  t.after(() => s.sql.close());

  const batchId = randomUUID();
  const activatedAt = 1795197805; // 2026-11-20T18:03:25Z (NOT the legacy 1970-01-01 / 2026-11-18 fixture!)
  s.sql
    .prepare(
      `INSERT INTO ci_csv_batches(id,actor,owner,status,source_label,reference_date,coverage_from,coverage_to,file_count,sales_rows,return_rows,customer_rows,product_rows,created,updated,activated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      batchId,
      "Admin",
      s.adminId,
      "active",
      "Produção Commercial Insight 2.0 (20 CSVs)",
      "2026-11-17",
      "2025-01-01",
      "2026-11-17",
      20,
      404728,
      19430,
      11097,
      660,
      activatedAt - 100,
      activatedAt,
      activatedAt,
    );
  s.sql
    .prepare(
      "INSERT INTO ci_csv_active(id,active_batch_id,previous_batch_id,mode,updated,actor) VALUES(1,?,NULL,'active',?,'Admin') ON CONFLICT(id) DO UPDATE SET active_batch_id=excluded.active_batch_id,mode='active',updated=excluded.updated,actor=excluded.actor",
    )
    .run(batchId, activatedAt);

  const get = async (path: string) => {
    const res = await worker.fetch(
      new Request(s.env.APP_ORIGIN + "/api/" + path, {
        headers: { Origin: s.env.APP_ORIGIN, Cookie: "__Host-ci=" + s.secretAdmin },
      }),
      s.env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };

  const me = await get("me");
  assert.equal(me.status, 200);
  assert.equal(me.json.data.activeVersionId, batchId);
  assert.equal(me.json.data.storageEngine, "csv");
  assert.equal(me.json.data.referenceDate, "2026-11-17");
  assert.equal(me.json.data.model, "Produção Commercial Insight 2.0 (20 CSVs)");
  assert.equal(me.json.data.extractedAt, new Date(activatedAt * 1000).toISOString());

  const ds = await get("data/status");
  assert.equal(ds.status, 200);
  assert.equal(ds.json.active.id, batchId);
  assert.equal(ds.json.active.storageEngine, "csv");
  assert.equal(ds.json.active.tables, 20);
  assert.equal(ds.json.active.rows, 404728 + 19430 + 11097 + 660);
  assert.equal(ds.json.active.referenceDate, "2026-11-17");

  const st = await get("assistant/status");
  assert.equal(st.status, 200);
  assert.equal(st.json.deterministic?.ready, true);
  assert.equal(st.json.deterministic?.source, "csv");
});
