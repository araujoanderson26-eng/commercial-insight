/** Authorized real-data HML acceptance. No OpenAI key is read by this process.
 * node --import tsx scripts/hml-real-verify.ts --execute-authorized-real
 * All commercial values, questions, credentials and artifacts stay under .wrangler/hml-real.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Commentary, Filters, Metric, Pair, Plan, Report, Session } from "../shared/domain";
import type { AssistantStatus, VisitBriefing } from "../shared/commercial";
import { normalizedRealFilters, RealChatUiTransport } from "./hml-real-chat-transport";

export const realHmlOrigin = "https://commercial-insight-hml.araujo-anderson26.workers.dev";
const privateRoot = resolve(".wrangler/hml-real");
type Actor = { email: string; password: string; cookie?: string; id?: string };
export type RealScenario = { id: string; question: string; actor: string; filters: Filters; expectedMetric: Metric; expectedGroup: Plan["group"]; conversationFromScenario?: string };
export type RealAcceptanceConfig = {
  version: 1; origin: string; scopeHash: string; activeSampleUuid: string; model: string; credentialFile: string; oracleFile: string; policyActor: string;
  authorizations: { realData: true; openAI: true; scopeApproved: true; budgetUsd: number };
  budget: { previousReservedUsd: number; previousProviderAttempts: number; maximumCumulativeProviderAttempts: number; newMaximumProviderAttempts: number; resetRequested: false };
  scenarios: RealScenario[];
};
export type RealScenarioOracle = {
  plan: Plan; totalValues: Partial<Record<Metric, Pair>>; tolerance?: number;
  rows?: { key?: string; name?: string; values: Partial<Record<Metric, Pair>> }[];
  visit?: { clientCode: string; currentRevenue: number; previousRevenue: number; lastPurchase: string | null; purchaseDays: number | null };
};
export type RealOracle = { scopeHash: string; activeSampleUuid: string; scenarios: Record<string, RealScenarioOracle> };
export type RealChatResponse = { id: string; turn: string; report: Report; commentary: Commentary; visit?: VisitBriefing };
type DataStatus = { source: string; staleDays: number; allowAI: boolean; active: { id: string } | null };

export function realPrivatePath(value: string) {
  const path = resolve(value), rel = relative(privateRoot, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw Error("Private real-data files must remain under the authorized folder.");
  return path;
}
export function validateRealAcceptanceConfig(value: unknown): RealAcceptanceConfig {
  const config = value as RealAcceptanceConfig;
  assert.equal(config.version, 1); assert.equal(config.origin, realHmlOrigin);
  assert.match(config.scopeHash, /^[a-f0-9]{64}$/); assert.match(config.activeSampleUuid, /^[a-f0-9-]{36}$/);
  assert.ok(["gpt-4.1-mini", "gpt-4.1-mini-2025-04-14"].includes(config.model));
  assert.equal(config.authorizations.realData, true); assert.equal(config.authorizations.openAI, true); assert.equal(config.authorizations.scopeApproved, true); assert.equal(config.authorizations.budgetUsd, 0.1);
  realPrivatePath(config.credentialFile); realPrivatePath(config.oracleFile);
  assert.equal(config.budget.resetRequested, false); assert.equal(config.budget.newMaximumProviderAttempts, 8);
  assert.equal(config.budget.previousProviderAttempts, 10); assert.equal(config.budget.maximumCumulativeProviderAttempts, 18);
  assert.ok(config.budget.previousReservedUsd >= 0.0413548 && config.budget.previousReservedUsd < 0.1);
  assert.equal(config.scenarios.length, 4); assert.equal(new Set(config.scenarios.map(item => item.id)).size, 4);
  assert.notEqual(config.scenarios[0].actor, config.scenarios[1].actor);
  for (const [index, item] of config.scenarios.entries()) {
    assert.match(item.id, /^[a-z0-9-]{1,32}$/); assert.ok(item.question.length >= 2 && item.question.length <= 900); assert.match(item.actor, /^[a-z0-9-]{1,32}$/);
    assert.equal(item.filters.from, "2026-01"); assert.equal(item.filters.to, "2026-10");
    if (index === 0) for (const dimension of ["client", "product", "region", "state", "regional", "manager", "category"] as const) assert.ok(!item.filters[dimension]);
    if (index > 0) { assert.equal(item.actor, config.scenarios[1].actor); assert.equal(item.filters.state, "SP"); assert.ok(item.filters.region.length > 0); }
    if (index > 1) { assert.ok(item.filters.client.length > 0); assert.equal(item.filters.client, config.scenarios[2].filters.client); }
    if (index === 3) assert.equal(item.conversationFromScenario, config.scenarios[2].id);
  }
  assert.equal(config.scenarios[1].filters.region, config.scenarios[2].filters.region); assert.equal(config.scenarios[2].filters.region, config.scenarios[3].filters.region);
  return config;
}
function compareNumber(actual: number | null, expected: number | null, tolerance: number) {
  if (expected === null) assert.equal(actual, null);
  else { assert.ok(typeof actual === "number" && Number.isFinite(actual)); assert.ok(Math.abs(actual - expected) <= tolerance, "Financial evidence differs from the private oracle."); }
}
function compareValues(actual: Report["total"]["values"], expected: Partial<Record<Metric, Pair>>, tolerance: number) {
  for (const [key, pair] of Object.entries(expected) as [Metric, Pair][]) {
    compareNumber(actual[key].current, pair.current, key === "buyers" ? 0 : tolerance);
    compareNumber(actual[key].previous, pair.previous, key === "buyers" ? 0 : tolerance);
  }
}
export function assertRealOracle(result: RealChatResponse, expected: RealScenarioOracle, sample: string) {
  assert.equal(result.report.sourceInfo?.versionId, sample);
  assert.equal(result.report.plan.group, expected.plan.group); assert.equal(result.report.plan.metric, expected.plan.metric); assert.equal(result.report.plan.order, expected.plan.order);
  assert.deepEqual(normalizedRealFilters(result.report.plan.filters), normalizedRealFilters(expected.plan.filters));
  const tolerance = expected.tolerance ?? 0.005; assert.ok(tolerance >= 0 && tolerance <= 0.01);
  compareValues(result.report.total.values, expected.totalValues, tolerance);
  for (const row of expected.rows ?? []) {
    const actual = result.report.rows.find(item => row.key ? item.key === row.key : item.name === row.name); assert.ok(actual);
    if (row.name) assert.equal(actual.name, row.name);
    compareValues(actual.values, row.values, tolerance);
  }
  if (expected.visit) {
    assert.ok(result.visit); assert.equal(result.visit.client.code, expected.visit.clientCode);
    compareNumber(result.visit.timeline.total.values.revenue.current, expected.visit.currentRevenue, tolerance);
    compareNumber(result.visit.timeline.total.values.revenue.previous, expected.visit.previousRevenue, tolerance);
    assert.equal(result.visit.activity.lastPurchase, expected.visit.lastPurchase); assert.equal(result.visit.activity.purchaseDays, expected.visit.purchaseDays);
  }
  assert.ok(result.commentary.summary.length > 0 && Array.isArray(result.commentary.actions));
  assert.ok(!/interpretação da OpenAI está temporariamente indisponível/i.test(result.commentary.summary));
}
export function loadRealAcceptanceFiles(configFile = ".wrangler/hml-real/config.json") {
  const config = validateRealAcceptanceConfig(JSON.parse(readFileSync(realPrivatePath(configFile), "utf8")));
  const oracle = JSON.parse(readFileSync(realPrivatePath(config.oracleFile), "utf8")) as RealOracle;
  assert.equal(oracle.scopeHash, config.scopeHash); assert.equal(oracle.activeSampleUuid, config.activeSampleUuid);
  for (const scenario of config.scenarios) {
    const item = oracle.scenarios[scenario.id]; assert.ok(item); assert.equal(item.plan.metric, scenario.expectedMetric); assert.equal(item.plan.group, scenario.expectedGroup);
    assert.deepEqual(normalizedRealFilters(item.plan.filters), normalizedRealFilters(scenario.filters));
  }
  return { config, oracle };
}

export async function runRealAcceptance() {
  assert.ok(process.argv.includes("--execute-authorized-real"), "Explicit real-data execution flag is required.");
  const useLiveUiForVisit = process.argv.includes("--ui-visit-followup");
  const resumeUi = process.argv.includes("--resume-ui-visit-followup");
  assert.ok(!resumeUi || useLiveUiForVisit, "UI resumption requires the live UI transport.");
  const { config, oracle } = loadRealAcceptanceFiles();
  const credentials = JSON.parse(readFileSync(realPrivatePath(config.credentialFile), "utf8")) as { origin: string; actors: Record<string, Actor> };
  assert.equal(credentials.origin, realHmlOrigin);
  const actors = new Map<string, Actor>(Object.entries(credentials.actors).map(([key, value]) => [key, { ...value, cookie: undefined }]));
  for (const name of new Set([config.policyActor, ...config.scenarios.map(item => item.actor)])) {
    const value = actors.get(name); assert.ok(value?.email && value.password.length >= 16);
  }
  const runId = randomUUID(), root = realPrivatePath(`.wrangler/hml-real/evidence/${runId}`), artifact = resolve(root, "api.json");
  mkdirSync(root, { recursive: true });
  const report = { runId, scopeHash: config.scopeHash, sampleId: config.activeSampleUuid, startedAt: new Date().toISOString(), completedAt: "", apiChecksPassed: false,
    externalProviderLedgerVerificationRequired: true, budgetResetRequested: false, previousReservedUsd: config.budget.previousReservedUsd, newMaximumProviderAttempts: resumeUi ? 4 : 8,
    inheritedFromRunId: null as string | null, inheritedScenarioIds: [] as string[],
    requests: 0, chatRequests: 0, checks: [] as { id: string; passed: boolean }[], responses: [] as { scenarioId: string; actor: string; question: string; transport: "api" | "live-ui"; value: RealChatResponse }[],
    liveUiTransport: null as ReturnType<RealChatUiTransport["summary"]> | null,
    failures: [] as { operation: string; errorType: string }[], httpFailures: [] as { method: string; path: string; status: number }[], policyRestored: false, sessionsClosed: false };
  if (resumeUi) {
    const previousIndex = JSON.parse(readFileSync(realPrivatePath(".wrangler/hml-real/latest-run.json"), "utf8")) as { scopeHash: string; apiArtifact: string };
    assert.equal(previousIndex.scopeHash, config.scopeHash);
    const previous = JSON.parse(readFileSync(realPrivatePath(previousIndex.apiArtifact), "utf8")) as typeof report;
    assert.equal(previous.scopeHash, config.scopeHash); assert.equal(previous.sampleId, config.activeSampleUuid); assert.equal(previous.policyRestored, true); assert.equal(previous.sessionsClosed, true);
    assert.equal(previous.liveUiTransport?.sent, 0, "An uncertain or already-submitted UI request must be audited before resumption.");
    assert.equal(previous.responses.length, 2);
    for (const scenario of config.scenarios.slice(0, 2)) {
      const item = previous.responses.find(value => value.scenarioId === scenario.id); assert.ok(item);
      assert.equal(item.actor, scenario.actor); assert.equal(item.question, scenario.question); assert.equal(item.transport, "api");
      assert.ok(previous.checks.some(value => value.id === scenario.id && value.passed)); assertRealOracle(item.value, oracle.scenarios[scenario.id], config.activeSampleUuid);
      report.responses.push(item); report.inheritedScenarioIds.push(scenario.id);
    }
    report.inheritedFromRunId = previous.runId;
  }
  const admin = actors.get(config.policyActor)!;
  let original: Pick<DataStatus, "source" | "staleDays" | "allowAI"> | undefined, policyTouched = false, operation = "preflight", uiTransport: RealChatUiTransport | undefined;
  const flush = () => writeFileSync(artifact, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  const checked = (id: string) => { report.checks.push({ id, passed: true }); flush(); };
  async function api<T>(path: string, method = "GET", value?: unknown, actor = admin, expected = [200]) {
    assert.match(path, /^[a-z0-9/_-]+$/i); assert.ok(!path.includes("//")); operation = method + " " + path; report.requests++;
    const headers: Record<string, string> = { Origin: realHmlOrigin, "Content-Type": "application/json" }; if (actor.cookie) headers.Cookie = actor.cookie;
    const response = await fetch(realHmlOrigin + "/api/" + path, { method, headers, body: value === undefined ? undefined : JSON.stringify(value), redirect: "error", signal: AbortSignal.timeout(100000) });
    if (!expected.includes(response.status)) { report.httpFailures.push({ method, path, status: response.status }); flush(); await response.body?.cancel().catch(() => {}); throw Error("Unexpected HTTP status."); }
    const text = await response.text();
    if (response.status === 200 && path !== "auth/login") assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    return { data: (text ? JSON.parse(text) : null) as T, response };
  }
  try {
    for (const [name, actor] of actors) {
      const { response } = await api("auth/login", "POST", { email: actor.email, password: actor.password }, actor);
      const cookie = response.headers.get("set-cookie"); assert.ok(cookie?.includes("Secure") && cookie.includes("HttpOnly")); actor.cookie = cookie!.split(";")[0];
      const { data: me } = await api<Session>("me", "GET", undefined, actor); if (actor.id) assert.equal(me.user.id, actor.id);
      if (name === config.policyActor) assert.equal(me.user.role, "admin");
      if (name === config.scenarios[0].actor) assert.ok(me.user.role === "admin" || (me.user.role === "diretoria" && me.user.national));
      if (name === config.scenarios[1].actor) { assert.equal(me.user.role, "gerente"); assert.equal(me.user.national, false); assert.ok(me.user.regions.includes(config.scenarios[1].filters.region)); }
    }
    const { data: source } = await api<DataStatus>("data/status"); assert.equal(source.source, "manual"); assert.equal(source.active?.id, config.activeSampleUuid); assert.equal(source.allowAI, false);
    original = { source: source.source, staleDays: source.staleDays, allowAI: false };
    const { data: status } = await api<AssistantStatus>("assistant/status"); assert.equal(status.credentialConfigured, true); assert.equal(status.model, config.model);
    checked("preflight");
    // Independent oracle is checked against direct reports before any OpenAI request.
    for (const scenario of config.scenarios) {
      const expected = oracle.scenarios[scenario.id], actor = actors.get(scenario.actor)!;
      const { data: direct } = await api<Report>("report", "POST", expected.plan, actor);
      assert.equal(direct.sourceInfo?.versionId, config.activeSampleUuid); compareValues(direct.total.values, expected.totalValues, expected.tolerance ?? 0.005);
      assert.deepEqual(direct.plan, expected.plan);
      for (const row of expected.rows ?? []) {
        const actual = direct.rows.find(item => row.key ? item.key === row.key : item.name === row.name); assert.ok(actual);
        if (row.name) assert.equal(actual.name, row.name);
        compareValues(actual.values, row.values, expected.tolerance ?? 0.005);
      }
      if (expected.visit) {
        const { data: briefing } = await api<VisitBriefing>("visit", "POST", scenario.filters, actor);
        assert.equal(briefing.client.code, expected.visit.clientCode);
        compareNumber(briefing.timeline.total.values.revenue.current, expected.visit.currentRevenue, expected.tolerance ?? 0.005);
        compareNumber(briefing.timeline.total.values.revenue.previous, expected.visit.previousRevenue, expected.tolerance ?? 0.005);
        assert.equal(briefing.activity.lastPurchase, expected.visit.lastPurchase); assert.equal(briefing.activity.purchaseDays, expected.visit.purchaseDays);
      }
    }
    checked("independent-oracle-preflight");
    policyTouched = true; await api("admin/data/settings", "PUT", { ...original, allowAI: true });
    assert.equal((await api<AssistantStatus>("assistant/status")).data.ready, true);
    for (const [index, scenario] of config.scenarios.entries()) {
      if (resumeUi && index < 2) continue;
      assert.ok(report.chatRequests < (resumeUi ? 2 : 4)); const actor = actors.get(scenario.actor)!;
      const previous = scenario.conversationFromScenario ? report.responses.find(item => item.scenarioId === scenario.conversationFromScenario) : undefined;
      if (scenario.conversationFromScenario) assert.ok(previous && previous.actor === scenario.actor);
      report.chatRequests++; flush();
      let result: RealChatResponse;
      const transport = useLiveUiForVisit && index >= 2 ? "live-ui" : "api";
      if (transport === "live-ui") {
        operation = `live-ui ${scenario.id}`;
        uiTransport ??= new RealChatUiTransport(config, actor, resolve(root, "live-chat"));
        result = await uiTransport.submit(scenario, previous?.value.id ?? null); report.liveUiTransport = uiTransport.summary();
      } else result = (await api<RealChatResponse>("chat", "POST", { question: scenario.question, filters: scenario.filters, conversation: previous?.value.id ?? null }, actor)).data;
      report.responses.push({ scenarioId: scenario.id, actor: scenario.actor, question: scenario.question, transport, value: result }); flush();
      assertRealOracle(result, oracle.scenarios[scenario.id], config.activeSampleUuid);
      const { data: direct } = await api<Report>("report", "POST", result.report.plan, actor);
      assert.deepEqual(result.report.total, direct.total); assert.deepEqual(result.report.rows, direct.rows);
      if (previous) assert.equal(result.id, previous.value.id);
      checked(scenario.id);
    }
    // Stored answers stay inspectable without another provider call.
    for (const item of report.responses) {
      const { data: reopened } = await api<Omit<RealChatResponse, "id" | "turn">>(`turns/${item.value.turn}/reopen`, "POST", {}, actors.get(item.actor)!);
      assert.deepEqual(reopened.report.total, item.value.report.total); assert.equal(reopened.report.sourceInfo?.versionId, config.activeSampleUuid);
    }
    checked("history"); report.apiChecksPassed = true;
  } catch (error) {
    await uiTransport?.captureFailure(error).catch(() => {});
    report.failures.push({ operation, errorType: error instanceof Error ? error.name : "verification_failed" }); process.exitCode = 1;
  } finally {
    if (policyTouched && original && admin.cookie) {
      try { await api("admin/data/settings", "PUT", original); report.policyRestored = true; } catch { report.failures.push({ operation: "policy-restore", errorType: "cleanup_failed" }); process.exitCode = 1; }
    } else report.policyRestored = !policyTouched;
    if (uiTransport) {
      try { await uiTransport.close(); report.liveUiTransport = uiTransport.summary(); }
      catch { report.failures.push({ operation: "live-ui-close", errorType: "cleanup_failed" }); process.exitCode = 1; }
    }
    for (const actor of actors.values()) if (actor.cookie) {
      try { await api("auth/logout", "POST", {}, actor); actor.cookie = undefined; } catch { report.failures.push({ operation: "logout", errorType: "cleanup_failed" }); process.exitCode = 1; }
    }
    report.sessionsClosed = [...actors.values()].every(actor => !actor.cookie) && (!report.liveUiTransport || report.liveUiTransport.sessionsClosed); report.completedAt = new Date().toISOString();
    report.apiChecksPassed &&= report.policyRestored && report.sessionsClosed && report.failures.length === 0; flush();
    const summary = { runId, scopeHash: config.scopeHash, apiChecksPassed: report.apiChecksPassed, checksPassed: report.checks.length, failures: report.failures.length, requests: report.requests, chatRequests: report.chatRequests, externalProviderLedgerVerificationRequired: true };
    writeFileSync(resolve(root, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
    writeFileSync(realPrivatePath(".wrangler/hml-real/latest-run.json"), JSON.stringify({ runId, scopeHash: config.scopeHash, apiArtifact: relative(resolve(), artifact) }) + "\n", { mode: 0o600 });
    process.stdout.write(JSON.stringify(summary) + "\n");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runRealAcceptance().catch(error => { process.exitCode = 1; process.stdout.write(JSON.stringify({ apiChecksPassed: false, phase: "local-preflight", errorType: error instanceof Error ? error.name : "verification_failed" }) + "\n"); });
}

export const realScopeDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
