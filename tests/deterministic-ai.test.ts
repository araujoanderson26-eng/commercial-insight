import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import worker from "../worker/index";
import { now } from "../worker/core";
import { nativePartStatements } from "../worker/native-model";
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

  // Budget/policy guard stays 100% enforced
  s.env.PRODUCTION_AI_BUDGET = "true";
  const denied = await ask("Qual foi o faturamento líquido?", s.secretSp);
  assert.equal(denied.status, 403);
  delete s.env.PRODUCTION_AI_BUDGET;

  s.sql.exec("UPDATE ci_sources SET allow_ai=0");
  assert.equal((await ask("Qual foi o faturamento líquido?")).status, 409);
  s.sql.exec("UPDATE ci_sources SET allow_ai=1");

  // Open analytical questions still fall back cleanly to OpenAI
  const openRes = await ask("Analise meu faturamento e sugira hipóteses estratégicas");
  assert.equal(openRes.status, 200);
  assert.equal(openRes.json.meta.engine, "openai");
  assert.ok(openAiCalls >= 1);
});
