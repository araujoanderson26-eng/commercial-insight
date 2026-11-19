import test from "node:test";
import assert from "node:assert/strict";
import { hmlOrigin, privateEvidencePath, runLiveAcceptance, validateLiveConfiguration } from "../scripts/hml-openai-verify";

const config = () => ({ name: "commercial-insight-hml", vars: { APP_ORIGIN: hmlOrigin, HML_SYNTHETIC_ONLY: "true", HML_OPENAI_BUDGET_USD: "0.10", OPENAI_MODEL: "gpt-4.1-mini" }, d1_databases: [{ database_id: "9717c220-a4b4-4fad-8183-f2b733787b61" }] });
const approval = () => ({ approvedBudgetUsd: 0.1, scope: { origin: hmlOrigin, data: "synthetic only" }, plannedTest: { maximumProviderAttempts: 8 } });

test("live OpenAI acceptance refuses production, missing budget protection, unknown prices and plaintext keys", () => {
  assert.equal(validateLiveConfiguration(config(), approval()), "gpt-4.1-mini");
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

test("live OpenAI acceptance evidence cannot escape the ignored homologation folder", () => {
  assert.match(privateEvidencePath(".wrangler/hml/live-test.json"), /hml[/\\]live-test\.json$/);
  for (const path of [".wrangler/hml", "../outside.json", "docs/live-test.json", ".wrangler/hml/../../outside.json"]) assert.throws(() => privateEvidencePath(path));
});

test("live OpenAI acceptance requires explicit execution before reading credentials or making a request", async () => {
  assert.ok(!process.argv.includes("--execute-authorized-live"));
  await assert.rejects(runLiveAcceptance(), /Explicit live acceptance flag is required/);
});
