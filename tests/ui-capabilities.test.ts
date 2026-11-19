import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { groupLabel, Kpis, metricLabel, sessionCapabilities } from "../src/ui";
import { type DataCapabilities, type Report, type Session } from "../shared/domain";
import { plan, user } from "./fixtures";

const native: DataCapabilities = {
  metrics: ["gross", "returns", "revenue", "buyers"],
  groups: ["month", "client", "region", "product", "category", "regional", "state"],
  filters: ["region", "client", "product", "regional", "state"],
  labels: { revenue: "Faturamento líquido", region: "Representante", regional: "Regional", state: "UF" },
};
const session: Session = {
  user, policyVersion: "test", expires: 0,
  integrations: { configured: false, mode: "delegated", linked: false, ai: false },
  data: { source: "manual", ready: true, activeVersionId: "test", extractedAt: null, stale: false, capabilities: native },
};

test("UI só oferece dimensões e métricas comprovadas pela fonte selecionada", () => {
  const capabilities = sessionCapabilities(session);
  assert.deepEqual(capabilities.metrics, ["gross", "returns", "revenue", "buyers"]);
  assert.equal(capabilities.groups.includes("manager"), false);
  assert.equal(groupLabel("region", capabilities), "Representante");
  assert.equal(groupLabel("regional", capabilities), "Regional");
  assert.equal(metricLabel("revenue", capabilities), "Faturamento líquido");
  const online = sessionCapabilities({ ...session, data: { ...session.data!, source: "powerbi" } });
  assert.equal(online.groups.includes("regional"), false);
  assert.equal(online.metrics.includes("gross"), false);
  assert.equal(groupLabel("region", online), "Regionais");
  assert.equal(metricLabel("revenue", online), "Faturamento");
});

test("cartões nativos mostram bruto, devoluções e líquido separadamente, sem margem inventada", () => {
  const values = { gross: { current: 100, previous: 90 }, returns: { current: 10, previous: 9 }, revenue: { current: 90, previous: 81 }, buyers: { current: 4, previous: 3 }, margin: { current: null, previous: null } };
  const report: Report = {
    total: { name: "Total", values }, rows: [], plan, asOf: "2026-11-18T12:00:00Z", truncated: false, source: "Arquivo manual (D1)",
    sourceInfo: { versionId: "test", extractedAt: "2026-11-18T12:00:00Z", sourceUpdatedAt: null, referenceDate: "2026-11-18", coverage: { from: "2025-01-01", to: "2026-11-18" }, capabilities: native },
  };
  const html = renderToStaticMarkup(createElement(Kpis, { r: report }));
  assert.match(html, /Faturamento bruto/); assert.match(html, /Faturamento líquido/); assert.match(html, /Devoluções/);
  assert.doesNotMatch(html, /Margem comercial/);
  assert.match(html, /100,00/); assert.match(html, /90,00/); assert.match(html, /10,00/);
});
