import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  defaultFilters,
  detectFilterConflicts,
  formatOfficialRegionalName,
  normalizeRegionalKey,
  type Filters,
  type Report,
} from "../shared/domain";
import { filterLabel } from "../src/export-model";
import { canonicalFiltersKey, optionsCacheKey } from "../src/lib/cache";
import {
  activeFilterChips,
  buildCompactFilterSummary,
  buildFilterSearch,
  parseFiltersFromSearch,
  removeIncompatibleSelections,
} from "../src/lib/filter-state";
import {
  readDimensionSelection,
  writeDimensionSelection,
} from "../src/components/DimensionMultiFilter";
import worker from "../worker/index";
import { now } from "../worker/core";
import { routeCommercialIntent } from "../worker/intent-router";
import { makeStore } from "./fixtures";
import { fakeR2 } from "./manual-fixtures";

function seedUser(
  sql: ReturnType<typeof makeStore>["sql"],
  opts: {
    role: "admin" | "diretoria" | "gerente" | "comercial";
    national: boolean;
    regions?: string[];
    clients?: string[];
  },
) {
  const id = randomUUID();
  const secret = createHash("sha256").update(id).digest("hex").slice(0, 64).padEnd(64, "b");
  sql
    .prepare(
      "INSERT INTO users(id,email,name,password,role,regions,clients,national,active,created,update_only) VALUES(?,?,?,?,?,?,?,?,1,?,0)",
    )
    .run(
      id,
      `${opts.role}-${id.slice(0, 6)}@synthetic.test`,
      opts.role.toUpperCase(),
      "hash",
      opts.role,
      JSON.stringify(opts.regions ?? []),
      JSON.stringify(opts.clients ?? []),
      opts.national ? 1 : 0,
      now(),
    );
  sql
    .prepare("INSERT INTO sessions(hash,user_id,version,expires,seen) VALUES(?,?,1,?,?)")
    .run(createHash("sha256").update(secret).digest("hex"), id, now() + 3600, now());
  return { id, secret };
}

async function setupSyntheticCsvStore() {
  const s = makeStore();
  s.sql.exec(readFileSync(new URL("../migrations/0011_structured_csv_layer.sql", import.meta.url), "utf8"));
  s.env.BUCKET = fakeR2().bucket;
  const admin = seedUser(s.sql, { role: "admin", national: true });
  const repSpUser = seedUser(s.sql, { role: "comercial", national: false, regions: ["Rep SP"] });
  const clientScopedUser = seedUser(s.sql, { role: "comercial", national: false, clients: ["C_CO_AC"] });
  const jobs: Promise<unknown>[] = [];

  const call = async (
    path: string,
    method: string,
    body: unknown,
    actorSecret: string,
    headers: Record<string, string> = {},
  ) => {
    const isRaw = typeof body === "string";
    const res = await worker.fetch(
      new Request(s.env.APP_ORIGIN + "/api/" + path, {
        method,
        headers: {
          Origin: s.env.APP_ORIGIN,
          Cookie: "__Host-ci=" + actorSecret,
          ...(!isRaw && body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : isRaw ? body : JSON.stringify(body),
      }),
      s.env,
      { waitUntil: (p: Promise<unknown>) => jobs.push(p) } as unknown as ExecutionContext,
    );
    await Promise.all(jobs.splice(0));
    return res;
  };

  const batchRes = await call(
    "admin/csv/batches",
    "POST",
    { sourceLabel: "Lote PowerBI Sintético", referenceDate: "2026-02-28" },
    admin.secret,
  );
  assert.equal(batchRes.status, 201);
  const { id: batchId } = (await batchRes.json()) as { id: string };

  const regionsCsv = [
    "Unidade federativa,Sigla,Regional,Gerente,Região ",
    "São Paulo,SP,SP,Renata,Sudeste",
    "Acre,AC,Centro Oeste 1,Alessandro,Centro-Oeste",
    "Mato Grosso do Sul,MS,Centro Oeste 1,Alessandro,Centro-Oeste",
    "Mato Grosso,MT,Centro Oeste 1,Alessandro,Centro-Oeste",
    "Rondônia,RO,Centro Oeste 1,Alessandro,Centro-Oeste",
    "Rio de Janeiro,RJ,Sudeste 1,Fabio,Sudeste",
    "Espírito Santo,ES,Sudeste 1,Fabio,Sudeste",
    "Exterior,EX,EX,Exportação,Exportação",
  ].join("\n");

  const calendarCsv = [
    "Date,Dia,MÊS,Ano,Nome do Mes,Trimestre",
    "2025-01-10,10,1,2025,jan,1",
    "2025-02-10,10,2,2025,fev,1",
    "2026-01-10,10,1,2026,jan,1",
    "2026-01-15,15,1,2026,jan,1",
    "2026-02-10,10,2,2026,fev,1",
  ].join("\n");

  const productsCsv = [
    "Codigo Item,Descrição do item,Marca,Macro Categoria",
    "P01,Suco Uva Integral,Panizzon,SUCO",
    "P01B,Suco Maçã Bag,Pérgola,SUCO",
    "P02,Suco Concentrado Uva,Pérgola,SUCO CONCENTRADO DE UVA",
    "P03,Suco Concentrado Laranja,Panizzon,SUCO CONCENTRADO DE LARANJA",
    "P04,Suco Concentrado Maçã,Panizzon,SUCO CONCENTRADO DE MAÇÃ",
    "P05,Suco Concentrado Tangerina,Panizzon,SUCO CONCENTRADO DE TANGERINA",
    "P06,Vinho Tinto Seco,Pérgola,VINHO",
    "P07,Vinho Tinto Granel,Granel House,VINHO GRANEL",
    "P08,Vinagre Granel 20L,Granel House,VINAGRE GRANEL",
    "P09,Vinho Chileno Reservado,Import House,VINHO IMPORTADO",
    "P10,Espumante Brut,Panizzon,ESPUMANTE",
    "P11,Destilado Sereno,Panizzon,BEBIDA QUENTE",
    "P12,Vinagre Tinto 750ml,Panizzon,VINAGRE",
    "P13,Kit Degustação Varejo,Panizzon,VENDA VAREJO",
    "P_REG_ZERO,Produto Cadastrado Sem Movimento,Panizzon,SUCO",
  ].join("\n");

  const customersCsv = [
    'Código Cliente,Cliente,Representantes,Estado,"Região ","Segmento "',
    "C_SP1,Mercado Paulista SINTÉTICO,Rep SP,SP,Sudeste,Varejo",
    "C_SP2,Atacadão Campinas SINTÉTICO,Rep SP,SP,Sudeste,Atacado",
    "C_CO_AC,Distribuidora Acreana SINTÉTICO,Rep CO,AC,Centro-Oeste,Distribuidor",
    "C_CO_MT,Rede Pantanal SINTÉTICO,Rep CO,MT,Centro-Oeste,Atacado",
    "C_SE_RJ,Empório Carioca SINTÉTICO,Rep RJ,RJ,Sudeste,B2B",
    "C_EX1,Importadora Sul SINTÉTICO,Rep EX,EX,Exportação,Distribuidor",
    "C_REG_ZERO,Cliente Cadastrado Sem Compra SINTÉTICO,Rep SP,SP,Sudeste,Varejo",
  ].join("\n");

  const salesCsv = [
    "Serial,Data do lanc.,Codigo Cliente,Cliente,Canal,UF,Municipio,Código do item,Grupo Item,Valor mercadorias",
    "NF-01,2026-01-10,C_SP1,Mercado Paulista SINTÉTICO,Clientes Canal Direto,SP,São Paulo,P01,PA - SUCO,1000.00",
    "NF-02,2026-01-10,C_SP2,Atacadão Campinas SINTÉTICO,E-Commerce,SP,Campinas,P01B,PA - GRANEL,400.00",
    "NF-03,2026-01-15,C_SP1,Mercado Paulista SINTÉTICO,Clientes Canal Direto,SP,São Paulo,P06,PA - VINHO TINTO,600.00",
    "NF-04,2026-01-15,C_SP2,Atacadão Campinas SINTÉTICO,Industria,SP,Ribeirão Preto,P07,PA - GRANEL,500.00",
    "NF-05,2026-01-10,C_CO_AC,Distribuidora Acreana SINTÉTICO,Clientes Canal Indireto,AC,Rio Branco,P02,SUCO CONCENTRADO,700.00",
    "NF-06,2026-01-15,C_CO_MT,Rede Pantanal SINTÉTICO,Clientes Canal Indireto,MT,Cuiabá,P03,SUCO CONCENTRADO,200.00",
    "NF-07,2026-01-15,C_CO_MT,Rede Pantanal SINTÉTICO,Clientes Canal Indireto,MT,Cuiabá,P04,SUCO CONCENTRADO,150.00",
    "NF-08,2026-01-15,C_CO_MT,Rede Pantanal SINTÉTICO,Clientes Canal Indireto,MT,Cuiabá,P05,SUCO CONCENTRADO,100.00",
    "NF-09,2026-02-10,C_CO_MT,Rede Pantanal SINTÉTICO,Clientes Canal Direto,MT,Cuiabá,P10,PA - ESPUMANTE,300.00",
    "NF-10,2026-02-10,C_CO_MT,Rede Pantanal SINTÉTICO,Clientes Canal Direto,MT,Cuiabá,P11,PA - BEBIDA QUENTE,250.00",
    "NF-11,2026-01-15,C_SE_RJ,Empório Carioca SINTÉTICO,Clientes Canal Direto,RJ,Niterói,P08,PA - VINAGRE GRANEL,350.00",
    "NF-12,2026-01-15,C_SE_RJ,Empório Carioca SINTÉTICO,Clientes Canal Direto,RJ,Niterói,P09,PA - VINHO IMPORTADO,450.00",
    "NF-13,2026-02-10,C_SE_RJ,Empório Carioca SINTÉTICO,Clientes Canal Direto,RJ,Niterói,P12,PA - VINAGRE,150.00",
    "NF-14,2026-02-10,C_EX1,Importadora Sul SINTÉTICO,Clientes Exportação,EX,Montevideo,P13,PA - VENDA VAREJO,850.00",
    "NF-P1,2025-01-10,C_SP1,Mercado Paulista SINTÉTICO,Clientes Canal Direto,SP,São Paulo,P01,PA - SUCO,500.00",
    "NF-P2,2025-01-10,C_CO_AC,Distribuidora Acreana SINTÉTICO,Clientes Canal Indireto,AC,Rio Branco,P02,SUCO CONCENTRADO,900.00",
  ].join("\n");

  const returnsCsv = [
    "Nº Documento,Data do lanc.,Cód. PN,UF,Código do item,Grupo Item,Valor mercadorias,ObservacaoComplementar",
    "DEV-01,2026-01-15,C_SP1,SP,P01,PA - SUCO,100.00,Avaria SP",
    "DEV-02,2026-02-10,C_EX1,EX,P13,PA - VENDA VAREJO,50.00,Avaria EX",
  ].join("\n");

  for (const [role, csv] of [
    ["regions", regionsCsv],
    ["calendar", calendarCsv],
    ["products", productsCsv],
    ["customers", customersCsv],
    ["sales", salesCsv],
    ["returns", returnsCsv],
  ] as const) {
    const res = await call(`admin/csv/batches/${batchId}/files/${role}`, "PUT", csv, admin.secret, {
      "Content-Type": "text/csv",
      "X-Filename": `${role}.csv`,
    });
    assert.equal(res.status, 200);
  }

  assert.equal((await call(`admin/csv/batches/${batchId}/process`, "POST", {}, admin.secret)).status, 200);
  const valRes = await call(`admin/csv/batches/${batchId}/validate`, "POST", {}, admin.secret);
  assert.equal(valRes.status, 200);
  const valJson = (await valRes.json()) as { passed: boolean };
  assert.equal(valJson.passed, true);
  assert.equal((await call(`admin/csv/batches/${batchId}/activate`, "POST", {}, admin.secret)).status, 200);
  assert.equal(
    (await call("admin/data/settings", "PUT", { source: "manual", staleDays: 7, allowAI: false }, admin.secret))
      .status,
    200,
  );

  return { s, admin, repSpUser, clientScopedUser, batchId, call };
}

test("Regional usa apenas nomes oficiais (nunca gerentes) e distingue Gerente Regional", async (t) => {
  const { s, admin, call } = await setupSyntheticCsvStore();
  t.after(() => s.sql.close());

  assert.equal(formatOfficialRegionalName("CENTRO OESTE 1"), "Centro-Oeste 1");
  assert.equal(formatOfficialRegionalName("SP"), "São Paulo");
  assert.equal(formatOfficialRegionalName("EX"), "Exportação (EX)");
  assert.equal(normalizeRegionalKey("Centro-Oeste 1"), "CENTRO OESTE 1");
  assert.equal(normalizeRegionalKey("São Paulo"), "SP");

  const optRes = await call(
    "data/options",
    "POST",
    { from: "2026-01", to: "2026-02", region: "", client: "", product: "" },
    admin.secret,
  );
  assert.equal(optRes.status, 200);
  const opt = (await optRes.json()) as {
    values: Record<string, string[]>;
    labels: Record<string, Record<string, string>>;
  };

  assert.deepEqual(opt.values.regional, ["CENTRO OESTE 1", "EX", "SP", "SUDESTE 1"]);
  assert.equal(opt.labels.regional["CENTRO OESTE 1"], "Centro-Oeste 1");
  assert.equal(opt.labels.regional.SP, "São Paulo");
  assert.equal(opt.labels.regional.EX, "Exportação (EX)");
  assert.equal(opt.labels.regional["SUDESTE 1"], "Sudeste 1");

  for (const label of Object.values(opt.labels.regional)) {
    assert.doesNotMatch(label, /^(Renata|Alessandro|Fabio)$/i);
  }
  assert.deepEqual(opt.values.manager, ["Alessandro", "Exportação", "Fabio", "Renata"]);

  const repRes = await call(
    "report",
    "POST",
    {
      group: "regional",
      metric: "revenue",
      order: "current",
      filters: { from: "2026-01", to: "2026-02", region: "", client: "", product: "" },
    },
    admin.secret,
  );
  assert.equal(repRes.status, 200);
  const rep = (await repRes.json()) as Report;
  const rowNames = rep.rows.map((r) => r.name);
  assert.ok(rowNames.includes("Centro-Oeste 1"));
  assert.ok(rowNames.includes("São Paulo"));
  assert.ok(rowNames.includes("Sudeste 1"));
  assert.ok(rowNames.includes("Exportação (EX)"));
  for (const name of rowNames) {
    assert.doesNotMatch(name, /^(Renata|Alessandro|Fabio)$/i);
  }
});

test("Cascata Power BI, união de múltiplas regionais, acentos PT-BR e detecção de incompatibilidades", async (t) => {
  const { s, admin, call } = await setupSyntheticCsvStore();
  t.after(() => s.sql.close());

  // 1. Centro-Oeste 1 restringe UFs a AC/MT, Gerente a Alessandro, e retorna municípios/clientes/produtos mesmo com ci_agg_monthly ativa
  const coRes = await call(
    "data/options",
    "POST",
    { from: "2026-01", to: "2026-02", region: "", client: "", product: "", regionals: ["Centro-Oeste 1"] },
    admin.secret,
  );
  assert.equal(coRes.status, 200);
  const co = (await coRes.json()) as {
    values: Record<string, string[]>;
    registeredProducts: string[];
    incompatible: { dimension: string; values: string[]; message: string }[];
  };
  assert.deepEqual(co.values.state, ["AC", "MT"]);
  assert.deepEqual(co.values.manager, ["Alessandro"]);
  assert.deepEqual(co.values.region, ["Rep CO"]);
  assert.deepEqual(co.values.municipality, ["Cuiabá", "Rio Branco"]);
  assert.ok(co.values.client.includes("C_CO_AC"));
  assert.ok(co.values.client.includes("C_CO_MT"));
  assert.ok(co.values.product.includes("P02"));
  assert.equal(co.values.product.includes("P_REG_ZERO"), false);
  assert.ok(co.registeredProducts.includes("P_REG_ZERO"));
  assert.equal(co.incompatible.length, 0);

  // 2. Combinação Centro-Oeste 1 + São Paulo gera união correta de UFs e faturamento bruto exato
  const unionOptRes = await call(
    "data/options",
    "POST",
    {
      from: "2026-01",
      to: "2026-02",
      region: "",
      client: "",
      product: "",
      regionals: ["Centro-Oeste 1", "SP"],
    },
    admin.secret,
  );
  const unionOpt = (await unionOptRes.json()) as { values: Record<string, string[]> };
  assert.deepEqual(unionOpt.values.state, ["AC", "MT", "SP"]);

  const unionRep = (await (
    await call(
      "report",
      "POST",
      {
        group: "month",
        metric: "gross",
        order: "current",
        filters: {
          from: "2026-01",
          to: "2026-02",
          region: "",
          client: "",
          product: "",
          regionals: ["Centro-Oeste 1", "SP"],
        },
      },
      admin.secret,
    )
  ).json()) as Report;
  // SP (2500) + CO1 (700 + 200 + 150 + 100 + 300 + 250 = 1700) = 4200 gross; return = 100 -> revenue = 4100
  assert.equal(unionRep.total.values.gross.current, 4200);
  assert.equal(unionRep.total.values.returns.current, 100);
  assert.equal(unionRep.total.values.revenue.current, 4100);

  // 3. Busca em município e filtragem com acentos portugueses (São Paulo, Cuiabá, Clientes Exportação, Pérgola)
  const searchSpRes = await call(
    "data/search",
    "POST",
    {
      dimension: "municipality",
      query: "sao",
      filters: { from: "2026-01", to: "2026-02", region: "", client: "", product: "" },
    },
    admin.secret,
  );
  assert.equal(searchSpRes.status, 200);
  const searchSp = (await searchSpRes.json()) as { items: { key: string; name: string }[] };
  assert.ok(searchSp.items.some((i) => i.name === "São Paulo"));

  // Produto cadastrado sem venda aparece marcado em search("product")
  const searchProdRes = await call(
    "data/search",
    "POST",
    {
      dimension: "product",
      query: "P_REG_ZERO",
      filters: { from: "2026-01", to: "2026-02", region: "", client: "", product: "" },
    },
    admin.secret,
  );
  const searchProd = (await searchProdRes.json()) as {
    items: { key: string; name: string; hasSalesInPeriod?: boolean }[];
  };
  assert.equal(searchProd.items[0]?.key, "P_REG_ZERO");
  assert.equal(searchProd.items[0]?.hasSalesInPeriod, false);

  // Filtro por município acentuado ("São Paulo") e canal acentuado ("Clientes Exportação")
  const spMuniRep = (await (
    await call(
      "report",
      "POST",
      {
        group: "month",
        metric: "revenue",
        order: "current",
        filters: {
          from: "2026-01",
          to: "2026-02",
          region: "",
          client: "",
          product: "",
          municipalities: ["São Paulo"],
        },
      },
      admin.secret,
    )
  ).json()) as Report;
  // C_SP1 em São Paulo comprou P01 (1000) + P06 (600) = 1600 bruto, devolução DEV-01 (100) => 1500 líquido
  assert.equal(spMuniRep.total.values.gross.current, 1600);
  assert.equal(spMuniRep.total.values.returns.current, 100);
  assert.equal(spMuniRep.total.values.revenue.current, 1500);

  const exChanRep = (await (
    await call(
      "report",
      "POST",
      {
        group: "month",
        metric: "revenue",
        order: "current",
        filters: {
          from: "2026-01",
          to: "2026-02",
          region: "",
          client: "",
          product: "",
          channelsExclude: ["Clientes Exportação"],
        },
      },
      admin.secret,
    )
  ).json()) as Report;
  // Total geral bruto = 6000, devoluções = 150. Sem EX (850 bruto, 50 dev) => 5150 bruto, 100 dev, 5050 líq.
  assert.equal(exChanRep.total.values.gross.current, 5150);
  assert.equal(exChanRep.total.values.returns.current, 100);
  assert.equal(exChanRep.total.values.revenue.current, 5050);

  // Marca acentuada Pérgola (P01B=400 + P02=700 + P06=600 = 1700)
  const pergRep = (await (
    await call(
      "report",
      "POST",
      {
        group: "product",
        metric: "gross",
        order: "current",
        filters: {
          from: "2026-01",
          to: "2026-02",
          region: "",
          client: "",
          product: "",
          brands: ["Pérgola"],
        },
      },
      admin.secret,
    )
  ).json()) as Report;
  assert.equal(pergRep.total.values.gross.current, 1700);

  // 4. Seleção incompatível (Regional = Centro-Oeste 1 com UF = SP) sinaliza APENAS UF (sem culpar Regional!)
  const incompFilters: Filters = {
    from: "2026-01",
    to: "2026-02",
    region: "",
    client: "",
    product: "",
    regional: "Centro-Oeste 1",
    state: "SP",
  };
  const incompOpt = (await (await call("data/options", "POST", incompFilters, admin.secret)).json()) as {
    incompatible: { dimension: string; values: string[] }[];
  };
  assert.equal(incompOpt.incompatible.length, 1);
  assert.equal(incompOpt.incompatible[0].dimension, "state");
  assert.deepEqual(incompOpt.incompatible[0].values, ["SP"]);

  const fixed = removeIncompatibleSelections(incompFilters, incompOpt.incompatible);
  assert.equal(fixed.state, "");
  assert.equal(fixed.regional, "Centro-Oeste 1");
});

test("Categorias oficiais Power BI independentes, interseção AND e exclusão prevalente", async (t) => {
  const { s, admin, call } = await setupSyntheticCsvStore();
  t.after(() => s.sql.close());

  const opt = (await (
    await call(
      "data/options",
      "POST",
      { from: "2026-01", to: "2026-02", region: "", client: "", product: "" },
      admin.secret,
    )
  ).json()) as { values: Record<string, string[]>; labels: Record<string, Record<string, string>> };

  // Todas as 13 Macro Categorias com vendas no período permanecem separadas
  assert.equal(opt.values.macroCategory.length, 13);
  for (const mc of [
    "Macro Categoria: SUCO",
    "Macro Categoria: SUCO CONCENTRADO DE UVA",
    "Macro Categoria: SUCO CONCENTRADO DE LARANJA",
    "Macro Categoria: SUCO CONCENTRADO DE MAÇÃ",
    "Macro Categoria: SUCO CONCENTRADO DE TANGERINA",
    "Macro Categoria: VINHO",
    "Macro Categoria: VINHO GRANEL",
    "Macro Categoria: VINAGRE GRANEL",
    "Macro Categoria: VINHO IMPORTADO",
    "Macro Categoria: ESPUMANTE",
    "Macro Categoria: BEBIDA QUENTE",
    "Macro Categoria: VINAGRE",
    "Macro Categoria: VENDA VAREJO",
  ]) {
    assert.ok(opt.values.macroCategory.includes(mc), `Missing ${mc}`);
  }

  // Filtrar apenas Macro Categoria: SUCO NÃO agrupa os 4 Sucos Concentrados (P01=1000 + P01B=400 = 1400)
  const sucoOnly = (await (
    await call(
      "report",
      "POST",
      {
        group: "product",
        metric: "gross",
        order: "current",
        filters: {
          from: "2026-01",
          to: "2026-02",
          region: "",
          client: "",
          product: "",
          categoriesInclude: ["Macro Categoria: SUCO"],
        },
      },
      admin.secret,
    )
  ).json()) as Report;
  assert.equal(sucoOnly.total.values.gross.current, 1400);

  // Interseção AND entre Macro Categoria (SUCO) e Grupo do Item (PA - SUCO) resulta APENAS P01 (1000), exclui P01B (PA - GRANEL)
  const sucoAndGrupo = (await (
    await call(
      "report",
      "POST",
      {
        group: "product",
        metric: "gross",
        order: "current",
        filters: {
          from: "2026-01",
          to: "2026-02",
          region: "",
          client: "",
          product: "",
          categoriesInclude: ["Macro Categoria: SUCO", "PA - SUCO"],
        },
      },
      admin.secret,
    )
  ).json()) as Report;
  assert.equal(sucoAndGrupo.total.values.gross.current, 1000);
  assert.equal(sucoAndGrupo.rows.length, 1);

  // Overlap Incluir + Excluir: exclusão prevalece e alerta de conflito é retornado
  const overlapFilters: Filters = {
    from: "2026-01",
    to: "2026-02",
    region: "",
    client: "",
    product: "",
    categoriesInclude: ["Macro Categoria: SUCO", "Macro Categoria: VINHO"],
    categoriesExclude: ["Macro Categoria: VINHO"],
    regionals: ["São Paulo", "Sudeste 1"],
    regionalsExclude: ["Sudeste 1"],
  };
  const conflicts = detectFilterConflicts(overlapFilters);
  assert.equal(conflicts.length, 2);

  const overlapRep = (await (
    await call(
      "report",
      "POST",
      { group: "month", metric: "gross", order: "current", filters: overlapFilters },
      admin.secret,
    )
  ).json()) as Report;
  // SUCO em SP (P01 + P01B = 1400); VINHO excluído; Sudeste 1 excluído
  assert.equal(overlapRep.total.values.gross.current, 1400);
  assert.equal(overlapRep.filterConflicts?.length, 2);
});

test("Consistência numérica entre abas e isolamento ACL rigoroso no backend", async (t) => {
  const { s, admin, repSpUser, clientScopedUser, call } = await setupSyntheticCsvStore();
  t.after(() => s.sql.close());

  const complexFilters: Filters = {
    from: "2026-01",
    to: "2026-02",
    region: "",
    client: "",
    product: "",
    regionals: ["SP", "Centro-Oeste 1"],
    statesExclude: ["AC"],
    segmentsExclude: ["Industria"],
  };

  const totals = new Set<string>();
  for (const group of ["month", "regional", "state", "region", "client", "product", "category"] as const) {
    const r = (await (
      await call("report", "POST", { group, metric: "revenue", order: "current", filters: complexFilters }, admin.secret)
    ).json()) as Report;
    totals.add(
      JSON.stringify([
        r.total.values.gross.current,
        r.total.values.returns.current,
        r.total.values.revenue.current,
        r.total.values.buyers.current,
      ]),
    );
  }
  assert.equal(totals.size, 1, "Todos os agrupamentos devem retornar o mesmo total oficial");

  // Usuário restrito a Rep SP recebe apenas SP em options/search e toma 403 se pedir Rep CO
  const spOptRes = await call(
    "data/options",
    "POST",
    { from: "2026-01", to: "2026-02", region: "", client: "", product: "" },
    repSpUser.secret,
  );
  assert.equal(spOptRes.status, 200);
  const spOpt = (await spOptRes.json()) as { values: Record<string, string[]> };
  assert.deepEqual(spOpt.values.region, ["Rep SP"]);
  assert.deepEqual(spOpt.values.state, ["SP"]);

  const forbiddenOpt = await call(
    "data/options",
    "POST",
    { from: "2026-01", to: "2026-02", region: "Rep CO", client: "", product: "" },
    repSpUser.secret,
  );
  assert.equal(forbiddenOpt.status, 403);

  const forbiddenSearch = await call(
    "data/search",
    "POST",
    {
      dimension: "category",
      query: "SUCO",
      filters: { from: "2026-01", to: "2026-02", region: "Rep CO", client: "", product: "" },
    },
    repSpUser.secret,
  );
  assert.equal(forbiddenSearch.status, 403);

  // Cliente restrito C_CO_AC vê exclusivamente seus dados e toma 403 ao pedir C_SP1
  const cliOpt = (await (
    await call(
      "data/options",
      "POST",
      { from: "2026-01", to: "2026-02", region: "", client: "", product: "" },
      clientScopedUser.secret,
    )
  ).json()) as { values: Record<string, string[]> };
  assert.deepEqual(cliOpt.values.client, ["C_CO_AC"]);

  const forbiddenCliRep = await call(
    "report",
    "POST",
    {
      group: "month",
      metric: "revenue",
      order: "current",
      filters: { from: "2026-01", to: "2026-02", region: "", client: "C_SP1", product: "" },
    },
    clientScopedUser.secret,
  );
  assert.equal(forbiddenCliRep.status, 403);
});

test("Utilitários de UI (filter-state, cache, DimensionMultiFilter, export-model, intent-router)", () => {
  const base = defaultFilters();
  let f = writeDimensionSelection(base, "regional", ["CENTRO OESTE 1", "SP"], ["EX"]);
  assert.deepEqual(f.regionals, ["CENTRO OESTE 1", "SP"]);
  assert.deepEqual(f.regionalsExclude, ["EX"]);
  assert.equal(f.regional, undefined);

  f = writeDimensionSelection(f, "macroCategory", ["Macro Categoria: SUCO"], []);
  f = writeDimensionSelection(f, "itemGroup", ["PA - SUCO"], ["PA - GRANEL"]);
  assert.deepEqual(f.categoriesInclude, ["Macro Categoria: SUCO", "PA - SUCO"]);
  assert.deepEqual(f.categoriesExclude, ["PA - GRANEL"]);

  f = writeDimensionSelection(f, "channel", ["Clientes Canal Direto"], ["Clientes Exportação"]);
  f = writeDimensionSelection(f, "brand", ["Pérgola"], []);
  f = writeDimensionSelection(f, "segment", ["Varejo"], []);

  // Roundtrip URL params
  const search = buildFilterSearch(f);
  const parsed = parseFiltersFromSearch(
    search,
    ["region", "client", "product", "category", "state", "regional", "manager"],
    ["municipality", "channel", "brand", "segment", "macroCategory", "itemGroup"],
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.regionals, ["CENTRO OESTE 1", "SP"]);
  assert.deepEqual(parsed.channelsExclude, ["Clientes Exportação"]);

  // Read preserves separated Macrocategoria vs Grupo do item
  assert.deepEqual(readDimensionSelection(parsed, "macroCategory").include, ["Macro Categoria: SUCO"]);
  assert.deepEqual(readDimensionSelection(parsed, "itemGroup"), {
    include: ["PA - SUCO"],
    exclude: ["PA - GRANEL"],
  });

  // Compact summary & export label
  const caps = {
    metrics: ["revenue"] as Report["plan"]["metric"][],
    groups: ["month"] as Report["plan"]["group"][],
    filters: ["region", "client", "product", "category", "state", "regional", "manager"] as Report["plan"]["filters"] extends infer _ ? ("region" | "client" | "product" | "category" | "state" | "regional" | "manager")[] : never,
    extraFilters: ["municipality", "channel", "brand", "segment", "macroCategory", "itemGroup"] as const,
  };
  const chips = activeFilterChips(parsed, { ...caps, extraFilters: [...caps.extraFilters] });
  assert.ok(chips.some((c) => c.label === "Macrocategoria" && c.value === "SUCO"));
  assert.ok(chips.some((c) => c.mode === "exclude" && c.value === "Clientes Exportação"));

  const summary = buildCompactFilterSummary(parsed, { ...caps, extraFilters: [...caps.extraFilters] });
  assert.ok(summary.totalCount >= 5);
  assert.ok(summary.summaryText.includes("exclus"));

  // Cache key reacts to exclude & macro categories
  const alt = writeDimensionSelection(parsed, "brand", [], ["Granel House"]);
  assert.notEqual(canonicalFiltersKey(parsed), canonicalFiltersKey(alt));
  assert.notEqual(optionsCacheKey(parsed), optionsCacheKey(alt));

  const label = filterLabel({
    plan: { filters: parsed, metric: "revenue", group: "month", order: "current" },
  } as Report);
  assert.match(label, /Centro-Oeste 1/);
  assert.match(label, /Excluir canais: Clientes Exportação/);
  assert.match(label, /Macrocategoria SUCO/);

  // Intent router detecta regional única e respeita restrição de múltiplas regionais
  const routed = routeCommercialIntent(
    "Quanto faturamos no Centro-Oeste 1 em 2026?",
    base,
    { ...caps, extraFilters: [...caps.extraFilters] },
    [],
  );
  assert.ok(routed);
  expectArrayMatch(routed.plan.filters);
});

function expectArrayMatch(f: Filters) {
  const vals = [...(f.regional ? [f.regional] : []), ...(f.regionals ?? [])].map((v) =>
    normalizeRegionalKey(v),
  );
  assert.ok(vals.includes("SP") || vals.includes("CENTRO OESTE 1"));
}
