import test from "node:test";
import assert from "node:assert/strict";
import { change, configSchema, filtersSchema } from "../shared/domain";
import { compile, readResult } from "../worker/analysis";
import { biRows, filters, model, plan, user } from "./fixtures";
test("filtros de carteira e regional são cumulativos, inclusive no total e no comparativo", () => {
  const dax = compile(model, user, plan);
  assert.match(dax, /EVALUATE CALCULATETABLE\(UNION/);
  assert.match(dax, /KEEPFILTERS\(TREATAS\(\{"Sul"\}/);
  assert.match(dax, /KEEPFILTERS\(TREATAS\(\{"Loja A"\}/);
  assert.match(dax, /COUNTROWS\('Vendas'\)/);
  assert.match(dax, /DATE\(2025,1,1\)/);
});
test("nega gerente sem regional, pedido fora do escopo e medidas não homologadas", () => {
  assert.throws(() => compile(model, { ...user, regions: [] }, plan));
  assert.throws(() => compile(model, user, { ...plan, filters: { ...filters, region: "Norte" } }));
  assert.throws(() => compile({ ...model, scopedMeasuresReviewed: false }, user, plan));
  assert.throws(() =>
    compile(model, { ...user, role: "comercial", regions: [], clients: [] }, plan),
  );
});
test("diretoria nacional exige habilitação explícita", () => {
  const director = { ...user, role: "diretoria" as const, regions: [], clients: [] };
  assert.throws(() => compile(model, director, plan));
  assert.doesNotThrow(() => compile(model, { ...director, national: true }, plan));
});
test("nomes comerciais são literais e metadados aceitam apenas identificadores simples", () => {
  const name = 'Loja "Sol"';
  assert.match(compile(model, { ...user, clients: [name] }, plan), /"Loja ""Sol"""/);
  assert.equal(configSchema.safeParse({ ...model, factTable: "Vendas' extra" }).success, false);
});
test("períodos e escala de margem, valores ausentes e denominador zero", () => {
  assert.equal(filtersSchema.safeParse({ ...filters, to: "2025-01" }).success, false);
  assert.equal(filtersSchema.safeParse({ ...filters, to: "2028-01" }).success, false);
  const data = readResult(biRows(), model, plan);
  assert.equal(data.total.values.margin.current, 20);
  assert.equal(change(data.total.values.margin, "margin"), 5);
  assert.equal(change({ current: 4, previous: 0 }, "revenue"), null);
  assert.equal(data.total.values.buyers.current, null);
});
test("rejeita resposta parcial HTTP 200 do Power BI e medida não mapeada", () => {
  assert.throws(() =>
    readResult({ results: [{ error: { code: "partial" }, tables: [] }] }, model, plan),
  );
  assert.throws(() =>
    compile({ ...model, measures: { ...model.measures, buyers: null } }, user, {
      ...plan,
      metric: "buyers",
    }),
  );
});
test("ranking com top 30 sinaliza truncamento e inclui desempate e comparativo", () => {
  const data = biRows();
  const rows = data.results[0].tables[0].rows;
  for (let i = 0; i < 30; i++) rows.push({ ...rows[1], "[label]": "Loja " + i, "[revenue_c]": i });
  const p = { ...plan, group: "client" as const, order: "decline" as const };
  assert.match(compile(model, user, p), /TOPN\(31/);
  const r = readResult(data, model, p);
  assert.equal(r.truncated, true);
  assert.equal(r.rows.length, 30);
  assert.equal(r.rows[0].values.revenue.current, 0);
});
