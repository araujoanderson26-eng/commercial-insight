import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { archivePreviousEvidence, hmlOrigin, liveAcceptanceMode, privateEvidencePath, runLiveAcceptance, validateLiveConfiguration, validateResumeEvidence } from "../scripts/hml-openai-verify";

const config = () => ({ name: "commercial-insight-hml", vars: { APP_ORIGIN: hmlOrigin, HML_SYNTHETIC_ONLY: "true", HML_OPENAI_BUDGET_USD: "0.10", OPENAI_MODEL: "gpt-4.1-mini" }, d1_databases: [{ database_id: "9717c220-a4b4-4fad-8183-f2b733787b61" }] });
const approval = () => ({ approvedBudgetUsd: 0.1, scope: { origin: hmlOrigin, data: "synthetic only" }, plannedTest: { maximumProviderAttempts: 8 } });

test("live OpenAI acceptance refuses production, missing budget protection, unknown prices and plaintext keys", () => {
  assert.equal(validateLiveConfiguration(config(), approval()), "gpt-4.1-mini");
  assert.throws(() => validateLiveConfiguration(config(), { ...approval(), plannedTest: { maximumProviderAttempts: 9 } }));
  const mutations = [
    (value: ReturnType<typeof config>) => { value.name = "commercial-insight"; },
    (value: ReturnType<typeof config>) => { value.vars.APP_ORIGIN = "https://commercial-insight.example.test"; },
    (value: ReturnType<typeof config>) => { value.vars.HML_SYNTHETIC_ONLY = "false"; },
    (value: ReturnType<typeof config>) => { value.vars.HML_OPENAI_BUDGET_USD = "0.20"; },
    (value: ReturnType<typeof config>) => { value.vars.OPENAI_MODEL = "unpriced-model"; },
    (value: ReturnType<typeof config>) => { Object.assign(value.vars, { OPENAI_API_KEY: "never-a-key" }); },
    (value: ReturnType<typeof config>) => { value.d1_databases[0].database_id = "production"; },
  ];
  for (const mutate of mutations) { const candidate = config(); mutate(candidate); assert.throws(() => validateLiveConfiguration(candidate, approval())); }
  for (const field of ["approvedBudgetUsd", "scope", "plannedTest"] as const) {
    const candidate: Partial<ReturnType<typeof approval>> = approval(); delete candidate[field];
    assert.throws(() => validateLiveConfiguration(config(), candidate));
  }
});

test("live OpenAI acceptance evidence cannot escape the ignored folder and prior evidence survives a new run", t => {
  assert.match(privateEvidencePath(".wrangler/hml/live-test.json"), /hml[/\\]live-test\.json$/);
  for (const path of [".wrangler/hml", "../outside.json", "docs/live-test.json", ".wrangler/hml/../../outside.json"]) assert.throws(() => privateEvidencePath(path));
  const source = privateEvidencePath(`.wrangler/hml/acceptance-archive-test-${randomUUID()}.json`);
  mkdirSync(dirname(source), { recursive: true });
  const initial = '{"apiChecksPassed":false,"requests":19}\n';
  writeFileSync(source, initial, { mode: 0o600 });
  const archive = archivePreviousEvidence(source, randomUUID()); assert.ok(archive);
  const archivedPath = privateEvidencePath(archive);
  t.after(() => { unlinkSync(source); unlinkSync(archivedPath); });
  assert.equal(readFileSync(source, "utf8"), initial); assert.equal(readFileSync(archivedPath, "utf8"), initial);
  writeFileSync(source, '{"apiChecksPassed":true}\n');
  assert.equal(readFileSync(archivedPath, "utf8"), initial);
});

test("live OpenAI acceptance requires explicit execution before reading credentials or making a request", async () => {
  assert.ok(!process.argv.includes("--execute-authorized-live"));
  await assert.rejects(runLiveAcceptance(), /Explicit live acceptance flag is required/);
});

test("targeted visit resumption uses only two new chats and requires verified January financial cases", () => {
  assert.deepEqual(liveAcceptanceMode([]), { mode: "full", chatAllowance: 4, providerAttemptAllowance: 8 });
  assert.deepEqual(liveAcceptanceMode(["--resume-visit-followup"]), { mode: "visit-followup", chatAllowance: 2, providerAttemptAllowance: 4 });
  const source = { versionId: "synthetic-version", model: "SINTÉTICO HML — SEM DADOS REAIS" };
  const plan = { metric: "revenue", group: "month", order: "current", filters: { from: "2026-01", to: "2026-01", client: "", product: "", region: "" } };
  const total = { values: { gross: { current: 350 }, returns: { current: 1034 }, revenue: { current: -684, previous: 90 }, buyers: { current: 2 } } };
  const prior = { runId: randomUUID(), origin: hmlOrigin, synthetic: true, model: "gpt-4.1-mini", budgetUsd: 0.1, apiChecksPassed: false, policyRestored: true, sessionsClosed: true,
    checks: ["live commercial question matches the national synthetic financial evidence", "live client-loss question resolves a typed ranking with descriptions"].map(name => ({ name, passed: true })),
    responses: [
      { name: "national", value: { turn: randomUUID(), report: { sourceInfo: source, plan, total, rows: [] } } },
      { name: "declining-clients", value: { turn: randomUUID(), report: { sourceInfo: source, plan: { ...plan, group: "client", order: "decline" }, total, rows: [{ name: "0001 — Cliente SINTÉTICO 0001" }] } } },
    ] };
  const result = validateResumeEvidence(prior, "synthetic-version", "gpt-4.1-mini");
  assert.deepEqual(result.responseNames, ["national", "declining-clients"]); assert.equal(result.priorNarrativeRevalidationRequired, true);
  assert.throws(() => validateResumeEvidence(prior, "another-version", "gpt-4.1-mini"));
  const wrongPeriod = structuredClone(prior); wrongPeriod.responses[0].value.report.plan.filters.from = "2025-01";
  assert.throws(() => validateResumeEvidence(wrongPeriod, "synthetic-version", "gpt-4.1-mini"));
  const unchecked = structuredClone(prior); unchecked.checks[1].passed = false;
  assert.throws(() => validateResumeEvidence(unchecked, "synthetic-version", "gpt-4.1-mini"));
});
