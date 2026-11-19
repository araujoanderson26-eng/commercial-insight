import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { makeWorkbook, reportSheet } from "../src/exports";
import { Delta, Kpis, ReportContext, ticketPerBuyer } from "../src/ui";
import type { Report } from "../shared/domain";
import { plan } from "./fixtures";

// All labels and values in this public test are synthetic.
const values = { revenue: { current: 515, previous: -60 }, gross: { current: 600, previous: 80 }, returns: { current: 85, previous: 140 }, buyers: { current: 10, previous: 15 }, margin: { current: null, previous: null } };
const report: Report = { total: { name: "Total", values }, rows: [{ key: "000123", name: "000123 — Cliente & Filhos", values }], plan, asOf: "2026-11-19T12:00:00Z", truncated: false, source: "Arquivo manual (D1)", comparison: { current: { from: "2026-01-01", to: "2026-11-17" }, previous: { from: "2025-01-01", to: "2025-11-17" }, status: "partial", reason: "Mês em andamento com corte equivalente." }, warnings: ["A atribuição por representante exige conferir mudanças de carteira."], sourceInfo: { versionId: "synthetic-test", extractedAt: "2026-11-19T12:00:00Z", sourceUpdatedAt: null, referenceDate: "2026-11-17", coverage: { from: "2025-01-01", to: "2026-11-17" }, capabilities: { metrics: ["revenue", "gross", "returns", "buyers"], groups: ["month", "client"], filters: ["client"], labels: { revenue: "Faturamento líquido" } } } };

test("ranking com base anterior negativa apresenta condição neutra e valor absoluto", () => {
  const delta = renderToStaticMarkup(createElement(Delta, { r: report.total, m: "revenue" }));
  assert.match(delta, /Base anterior negativa/);
  assert.doesNotMatch(delta, /class="delta positive"|%/);
  const cards = renderToStaticMarkup(createElement(Kpis, { r: report }));
  assert.match(cards, /Diferença: \+R\$/);
  assert.match(cards, /Faturamento líquido/);
  assert.doesNotMatch(cards, /Margem comercial/);
});

test("contexto exibe datas efetivas equivalentes e limites de atribuição", () => {
  const html = renderToStaticMarkup(createElement(ReportContext, { r: report }));
  assert.match(html, /17\/11\/2026/); assert.match(html, /17\/11\/2025/);
  assert.match(html, /Mês em andamento/); assert.match(html, /mudanças de carteira/);
});

test("ticket por comprador exige denominador positivo e preserva indisponibilidade", () => {
  assert.deepEqual(ticketPerBuyer({ current: 150, previous: -30 }, { current: 3, previous: 2 }), { current: 50, previous: -15 });
  assert.deepEqual(ticketPerBuyer({ current: 150, previous: null }, { current: 0, previous: 2 }), { current: null, previous: null });
  assert.deepEqual(ticketPerBuyer({ current: 0, previous: 30 }, { current: 1, previous: -2 }), { current: 0, previous: null });
  const html = renderToStaticMarkup(createElement(Kpis, { r: report }));
  assert.match(html, /Ticket por comprador/); assert.match(html, /Não é média por pedido/);
});

test("Excel mantém códigos com zeros e omite percentual inválido para base negativa", () => {
  const sheet = reportSheet(report);
  assert.equal(sheet.rows[2][0], "000123");
  assert.equal(sheet.rows[2][1], "000123 — Cliente & Filhos");
  assert.equal(sheet.rows[2][5], null);
  assert.equal(sheet.rows[2][4], 575);
  assert.match(String(sheet.rows[0][2]), /Faturamento líquido/);
});

test("arquivo XLSX contém pacote Office e trata fórmulas, markup e caracteres de controle como texto", () => {
  const bytes = makeWorkbook([{ name: "Resultados", rows: [["=HYPERLINK(\"https://invalid.test\")", "000123", "<script>&\u0001", -42.7, null]] }]);
  assert.equal(new DataView(bytes.buffer).getUint32(0, true), 0x04034b50);
  assert.equal(new DataView(bytes.buffer).getUint32(bytes.length - 22, true), 0x06054b50);
  const archive = new TextDecoder().decode(bytes);
  assert.match(archive, /application\/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main\+xml/);
  assert.match(archive, /t="inlineStr"><is><t xml:space="preserve">=HYPERLINK/);
  assert.match(archive, /<t xml:space="preserve">000123<\/t>/);
  assert.match(archive, /&lt;script&gt;&amp;/);
  assert.match(archive, /<v>-42.7<\/v>/);
  assert.doesNotMatch(archive, /<f>|<script>/);
  assert.equal(archive.includes(String.fromCharCode(1) + "</t>"), false);
});
