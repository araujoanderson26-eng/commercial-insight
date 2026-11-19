import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertRealOracle, realHmlOrigin, realPrivatePath, runRealAcceptance, validateRealAcceptanceConfig, type RealAcceptanceConfig, type RealChatResponse, type RealScenarioOracle } from "../scripts/hml-real-verify";
import { assertExpectedUiChat, findRealFilterControl, normalizedRealFilters } from "../scripts/hml-real-chat-transport";
import { chromium } from "@playwright/test";

function config(): RealAcceptanceConfig {
  const base = { from: "2026-01", to: "2026-10", region: "", client: "", product: "" };
  return { version: 1, origin: realHmlOrigin, scopeHash: "a".repeat(64), activeSampleUuid: randomUUID(), model: "gpt-4.1-mini", credentialFile: ".wrangler/hml-real/accounts.json", oracleFile: ".wrangler/hml-real/oracle.json", policyActor: "admin",
    authorizations: { realData: true, openAI: true, scopeApproved: true, budgetUsd: 0.1 },
    budget: { previousReservedUsd: 0.0413548, previousProviderAttempts: 10, maximumCumulativeProviderAttempts: 18, newMaximumProviderAttempts: 8, resetRequested: false },
    scenarios: [
      { id: "s1", question: "Pergunta de teste 1", actor: "admin", filters: base, expectedMetric: "revenue", expectedGroup: "month" },
      { id: "s2", question: "Pergunta de teste 2", actor: "scoped", filters: { ...base, state: "SP", region: "TEST-REP" }, expectedMetric: "revenue", expectedGroup: "client" },
      { id: "s3", question: "Pergunta de teste 3", actor: "scoped", filters: { ...base, state: "SP", region: "TEST-REP", client: "TEST-CLIENT" }, expectedMetric: "revenue", expectedGroup: "month" },
      { id: "s4", question: "Pergunta de teste 4", actor: "scoped", filters: { ...base, state: "SP", region: "TEST-REP", client: "TEST-CLIENT" }, expectedMetric: "revenue", expectedGroup: "product", conversationFromScenario: "s3" },
    ] };
}
test("real-data acceptance preserves authorization, cumulative budget and intersection scope", () => {
  assert.equal(validateRealAcceptanceConfig(config()).origin, realHmlOrigin);
  const changes = [
    (value: RealAcceptanceConfig) => { value.origin = "https://production.example.test"; },
    (value: RealAcceptanceConfig) => { value.authorizations.openAI = false as true; },
    (value: RealAcceptanceConfig) => { value.authorizations.budgetUsd = 0.2; },
    (value: RealAcceptanceConfig) => { value.budget.resetRequested = true as false; },
    (value: RealAcceptanceConfig) => { value.budget.previousReservedUsd = 0; },
    (value: RealAcceptanceConfig) => { value.scenarios[1].filters.state = "RJ"; },
    (value: RealAcceptanceConfig) => { value.scenarios[2].actor = "admin"; },
    (value: RealAcceptanceConfig) => { value.scenarios[3].filters.client = "ANOTHER-CLIENT"; },
    (value: RealAcceptanceConfig) => { value.scenarios[3].conversationFromScenario = "s1"; },
    (value: RealAcceptanceConfig) => { value.credentialFile = ".wrangler/hml/access.json"; },
  ];
  for (const change of changes) { const candidate = config(); change(candidate); assert.throws(() => validateRealAcceptanceConfig(candidate)); }
});
test("real-data oracle refuses changed values or a different sample and private paths stay confined", () => {
  const candidate = config(), plan = { metric: "revenue", group: "month", order: "current", filters: candidate.scenarios[0].filters } as const;
  const values = { gross: { current: 2, previous: 3 }, returns: { current: 0.5, previous: 1 }, revenue: { current: 1.5, previous: 2 }, buyers: { current: 1, previous: 1 }, margin: { current: null, previous: null } };
  const expected: RealScenarioOracle = { plan, totalValues: values };
  const response = { id: randomUUID(), turn: randomUUID(), report: { plan, total: { name: "Total", values }, rows: [], sourceInfo: { versionId: candidate.activeSampleUuid } }, commentary: { summary: "Descrição de teste", actions: [] } } as unknown as RealChatResponse;
  assert.doesNotThrow(() => assertRealOracle(response, expected, candidate.activeSampleUuid));
  const changed = structuredClone(response); changed.report.total.values.revenue.current = 2;
  assert.throws(() => assertRealOracle(changed, expected, candidate.activeSampleUuid));
  assert.throws(() => assertRealOracle(response, expected, randomUUID()));
  assert.throws(() => realPrivatePath("docs/commercial-evidence.json"));
});
test("real-data execution requires explicit authorization flag before loading any private source", async () => {
  assert.ok(!process.argv.includes("--execute-authorized-real"));
  await assert.rejects(runRealAcceptance(), /Explicit real-data execution flag is required/);
});

test("live UI transport admits exactly the expected question, scoped filters, conversation and two submission slots", () => {
  const scenario = config().scenarios[2], body = { question: scenario.question, filters: scenario.filters, conversation: null };
  assert.doesNotThrow(() => assertExpectedUiChat(body, scenario, null, 0));
  assert.deepEqual(normalizedRealFilters(scenario.filters), normalizedRealFilters({ ...scenario.filters, category: "", regional: "", manager: "" }));
  assert.throws(() => assertExpectedUiChat({ ...body, question: "Outra pergunta" }, scenario, null, 0));
  assert.throws(() => assertExpectedUiChat({ ...body, filters: { ...body.filters, state: "RJ" } }, scenario, null, 0));
  assert.throws(() => assertExpectedUiChat({ ...body, conversation: randomUUID() }, scenario, null, 0));
  assert.throws(() => assertExpectedUiChat(body, scenario, null, 2));
});

test("UI filter selection ignores concatenated option/help names and disambiguates similar titles", async () => {
  const browser = await chromium.launch({ executablePath: process.env.UI_SMOKE_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  try {
    const page = await browser.newPage(); let remoteRequests = 0;
    await page.route("**/*", route => { remoteRequests++; return route.abort(); });
    await page.setContent('<dialog open><label>Representante<select><option value="">Todos no meu escopo</option><option value="TEST-REP">Representante de teste</option></select><small>As permissões cadastradas continuam aplicadas.</small></label><label>Cliente<input value=""><datalist><option value="TEST-CLIENT" label="Cliente de teste"></option></datalist></label><label>Regional<input value=""></label><label>Regional comercial<input value=""></label><label>UF<input value=""></label></dialog>');
    const dialog = page.getByRole("dialog");
    assert.equal(await dialog.getByLabel(/^Representante(?:\s|$)/).count(), 0, "The original selector must reproduce the observed failure.");
    const representative = await findRealFilterControl(dialog, "Representante"); assert.ok(representative); await representative.selectOption("TEST-REP");
    const customer = await findRealFilterControl(dialog, "Cliente"); assert.ok(customer); await customer.fill("TEST-CLIENT");
    const regional = await findRealFilterControl(dialog, "Regional"); assert.ok(regional); await regional.fill("TEST-REGION");
    const commercial = await findRealFilterControl(dialog, "Regional comercial"); assert.ok(commercial); await commercial.fill("TEST-COMMERCIAL");
    assert.equal(await representative.inputValue(), "TEST-REP"); assert.equal(await customer.inputValue(), "TEST-CLIENT");
    assert.equal(await regional.inputValue(), "TEST-REGION"); assert.equal(await commercial.inputValue(), "TEST-COMMERCIAL");
    assert.equal(await findRealFilterControl(dialog, "Missing"), null); assert.equal(remoteRequests, 0);
  } finally { await browser.close(); }
});
