/** Live-provider acceptance. Never run against production; never receives an OpenAI key.
 * node --import tsx scripts/hml-openai-verify.ts --execute-authorized-live
 * Add --resume-visit-followup to reuse verified national/client financial evidence without new calls.
 * Only the isolated Worker uses its own secret. All evidence remains under .wrangler/hml.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse } from "jsonc-parser";
import type { Commentary, Filters, Plan, Report, Session } from "../shared/domain";
import type { AssistantStatus, VisitBriefing } from "../shared/commercial";
import { commentaryGrounded, factualCommentary } from "../worker/assistant";

export const hmlOrigin = "https://commercial-insight-hml.araujo-anderson26.workers.dev";
const privateRoot = resolve(".wrangler/hml");
const syntheticModel = "SINTÉTICO HML — SEM DADOS REAIS";
const budgetUsd = 0.10;
export function privateEvidencePath(value: string) {
  const path = resolve(value), rel = relative(privateRoot, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw Error("Evidence must remain inside .wrangler/hml.");
  return path;
}
export function archivePreviousEvidence(path: string, runId: string) {
  const source = privateEvidencePath(path);
  assert.match(runId, /^[a-f0-9-]{36}$/);
  if (!existsSync(source)) return null;
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const archive = privateEvidencePath(`.wrangler/hml/archive/openai-api-verification-${timestamp}-${runId}.json`);
  mkdirSync(dirname(archive), { recursive: true });
  copyFileSync(source, archive, constants.COPYFILE_EXCL);
  return relative(resolve(), archive);
}
export function validateLiveConfiguration(config: unknown, approved: unknown) {
  const value = config as { name?: string; vars?: Record<string, unknown>; d1_databases?: { database_id?: string }[] };
  const authorization = approved as { approvedBudgetUsd?: number; scope?: { origin?: string; data?: string }; plannedTest?: { maximumProviderAttempts?: number } };
  assert.equal(value.name, "commercial-insight-hml");
  assert.equal(value.vars?.APP_ORIGIN, hmlOrigin);
  assert.equal(value.vars?.HML_SYNTHETIC_ONLY, "true");
  assert.equal(Number(value.vars?.HML_OPENAI_BUDGET_USD), budgetUsd);
  assert.ok(["gpt-4.1-mini", "gpt-4.1-mini-2025-04-14"].includes(String(value.vars?.OPENAI_MODEL)), "Validate pricing before changing the acceptance model.");
  assert.ok(!Object.hasOwn(value.vars ?? {}, "OPENAI_API_KEY"), "The key must remain a Worker secret.");
  assert.equal(value.d1_databases?.[0]?.database_id, "9717c220-a4b4-4fad-8183-f2b733787b61");
  assert.equal(authorization.approvedBudgetUsd, budgetUsd);
  assert.equal(authorization.scope?.origin, hmlOrigin);
  assert.equal(authorization.scope?.data, "synthetic only");
  assert.equal(authorization.plannedTest?.maximumProviderAttempts, 8);
  return String(value.vars!.OPENAI_MODEL);
}

type Actor = { email: string; password: string; cookie?: string };
type DataStatus = { source: string; staleDays: number; allowAI: boolean; active: { id: string; model: string } | null };
type ChatResponse = { id: string; turn: string; report: Report; commentary: Commentary; visit?: VisitBriefing };
type Check = { name: string; passed: boolean };
const nationalCheck = "live commercial question matches the national synthetic financial evidence";
const clientCheck = "live client-loss question resolves a typed ranking with descriptions";
const filters: Filters = { from: "2026-01", to: "2026-01", region: "", client: "", product: "" };
const baselinePlan: Plan = { metric: "revenue", group: "month", order: "current", filters };

export function liveAcceptanceMode(argv: readonly string[]) {
  const resume = argv.includes("--resume-visit-followup");
  return { mode: resume ? "visit-followup" : "full", chatAllowance: resume ? 2 : 4, providerAttemptAllowance: resume ? 4 : 8 } as const;
}
export function validateResumeEvidence(previous: unknown, expectedVersion: string, configuredModel: string) {
  const prior = previous as { runId: string; origin: string; synthetic: boolean; model: string; budgetUsd: number; policyRestored: boolean; sessionsClosed: boolean;
    checks: Check[]; responses: { name: string; value: ChatResponse }[] };
  assert.match(prior.runId, /^[a-f0-9-]{36}$/);
  assert.equal(prior.origin, hmlOrigin); assert.equal(prior.synthetic, true); assert.equal(prior.model, configuredModel); assert.equal(prior.budgetUsd, budgetUsd);
  assert.equal(prior.policyRestored, true); assert.equal(prior.sessionsClosed, true);
  const checks = [nationalCheck, clientCheck].map(name => {
    assert.equal(prior.checks.filter(item => item.name === name && item.passed).length, 1);
    return { name, passed: true };
  });
  for (const name of ["national", "declining-clients"]) {
    const matches = prior.responses.filter(item => item.name === name); assert.equal(matches.length, 1);
    assert.match(matches[0].value.turn, /^[a-f0-9-]{36}$/);
    const value = matches[0].value.report;
    assert.equal(value.sourceInfo?.versionId, expectedVersion); assert.equal(value.sourceInfo?.model, syntheticModel);
    assert.equal(value.plan.metric, "revenue");
    assert.equal(value.plan.filters.from, filters.from); assert.equal(value.plan.filters.to, filters.to);
    for (const dimension of ["client", "product", "region"] as const) assert.equal(value.plan.filters[dimension], "");
    assert.deepEqual([value.total.values.gross.current, value.total.values.returns.current, value.total.values.revenue.current, value.total.values.revenue.previous, value.total.values.buyers.current], [350, 1034, -684, 90, 2]);
    if (name === "declining-clients") {
      assert.equal(value.plan.group, "client"); assert.equal(value.plan.order, "decline"); assert.ok(value.rows.length > 0);
      assert.ok(value.rows.every(row => row.name.includes("Cliente SINTÉTICO")));
    }
  }
  return { runId: prior.runId, acceptedFinancialChecks: checks, responseNames: ["national", "declining-clients"], priorNarrativeRevalidationRequired: true };
}

export async function runLiveAcceptance() {
  assert.ok(process.argv.includes("--execute-authorized-live"), "Explicit live acceptance flag is required.");
  const mode = liveAcceptanceMode(process.argv);
  const configuredModel = validateLiveConfiguration(
    parse(readFileSync(resolve("wrangler.hml.jsonc"), "utf8")),
    JSON.parse(readFileSync(privateEvidencePath(".wrangler/hml/openai-test-budget.json"), "utf8")),
  );
  const access = JSON.parse(readFileSync(privateEvidencePath(".wrangler/hml/access.json"), "utf8")) as { origin: string; admin: Actor; users: Record<string, Actor> };
  assert.equal(access.origin, hmlOrigin);
  const priorAcceptance = JSON.parse(readFileSync(privateEvidencePath(".wrangler/hml/api-verification.json"), "utf8")) as { ok: boolean; imports: { id: string; status: string; synthetic: boolean }[] };
  assert.equal(priorAcceptance.ok, true);
  const expectedVersion = priorAcceptance.imports.find(item => item.status === "published" && item.synthetic)?.id;
  assert.ok(expectedVersion, "A previously verified synthetic snapshot is required.");
  const actors = new Map<string, Actor>([["admin", { ...access.admin }], ...["sales", "other", "operator", "no-scope"].map(name => [name, { ...access.users[name] }] as [string, Actor])]);
  for (const actor of actors.values()) {
    assert.ok(actor.email?.endsWith("@hml.example.test"));
    assert.ok(typeof actor.password === "string" && actor.password.length >= 16);
  }
  const artifact = privateEvidencePath(".wrangler/hml/openai-api-verification.json");
  const previousRunEvidence = mode.mode === "visit-followup"
    ? JSON.parse(readFileSync(artifact, "utf8")) as { responses: { name: string; value: ChatResponse }[] }
    : null;
  const inheritedEvidence = previousRunEvidence ? validateResumeEvidence(previousRunEvidence, expectedVersion, configuredModel) : null;
  const runId = randomUUID(), previousEvidenceArchive = archivePreviousEvidence(artifact, runId);
  const report = { runId, previousEvidenceArchive, cumulativeBudgetPreserved: true, budgetLedgerResetRequested: false,
    runMode: mode.mode, inheritedEvidence: inheritedEvidence ? { ...inheritedEvidence, archivePath: previousEvidenceArchive } : null,
    newRunChatAllowance: mode.chatAllowance, newRunProviderAttemptAllowance: mode.providerAttemptAllowance,
    origin: hmlOrigin, synthetic: true, model: configuredModel, budgetUsd, startedAt: new Date().toISOString(), completedAt: "", apiChecksPassed: false,
    externalProviderLedgerVerificationRequired: true, requests: 0, chatRequests: 0, checks: [] as Check[], failures: [] as string[],
    httpFailures: [] as { method: string; path: string; status: number }[],
    storedNarrativeReplays: [] as { name: string; turn: string; reportReconciled: boolean; guardAccepted: boolean; factualFallback: boolean; previousNarrativeAccepted: boolean; previousNarrativeChanged: boolean }[],
    responses: [] as { name: string; value: ChatResponse }[], policyRestored: false, sessionsClosed: false };
  const admin = actors.get("admin")!, sales = actors.get("sales")!, other = actors.get("other")!;
  let original: Pick<DataStatus, "source" | "staleDays" | "allowAI"> | undefined;
  let policyTouched = false, operation = "preflight";
  const flush = () => { mkdirSync(dirname(artifact), { recursive: true }); writeFileSync(artifact, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); };
  const checked = (name: string) => { report.checks.push({ name, passed: true }); flush(); process.stdout.write(JSON.stringify({ check: name, passed: true }) + "\n"); };
  async function api<T>(path: string, method = "GET", value?: unknown, actor: Actor = admin, expected = [200]) {
    assert.match(path, /^[a-z0-9/_-]+$/i); assert.ok(!path.includes("//"));
    operation = `${method} ${path}`;
    const headers: Record<string, string> = { Origin: hmlOrigin, "Content-Type": "application/json" };
    if (actor.cookie) headers.Cookie = actor.cookie;
    report.requests++;
    const response = await fetch(hmlOrigin + "/api/" + path, { method, headers, body: value === undefined ? undefined : JSON.stringify(value), redirect: "error", signal: AbortSignal.timeout(100000) });
    if (!expected.includes(response.status)) {
      report.httpFailures.push({ method, path, status: response.status }); flush();
      await response.body?.cancel().catch(() => {});
      throw Error("Unexpected HTTP status.");
    }
    const text = await response.text();
    if (response.status === 200 && path !== "auth/login") assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    return { data: (text ? JSON.parse(text) : null) as T, response };
  }
  async function login(actor: Actor) {
    const { response } = await api("auth/login", "POST", { email: actor.email, password: actor.password }, actor);
    const cookie = response.headers.get("set-cookie"); assert.ok(cookie); assert.ok(cookie.includes("Secure") && cookie.includes("HttpOnly"));
    actor.cookie = cookie.split(";")[0];
    return (await api<Session>("me", "GET", undefined, actor)).data;
  }
  async function chat(name: string, question: string, actor: Actor, conversation: string | null = null) {
    assert.ok(report.chatRequests < mode.chatAllowance, "The new-run question allowance is exhausted.");
    report.chatRequests++; flush(); // Count uncertain/failed requests too; there is no automatic retry.
    const { data } = await api<ChatResponse>("chat", "POST", { question, filters, conversation }, actor);
    assert.equal(data.report.sourceInfo?.versionId, expectedVersion);
    assert.equal(data.report.sourceInfo?.model, syntheticModel);
    report.responses.push({ name, value: data }); flush();
    assert.equal(data.report.plan.filters.from, filters.from); assert.equal(data.report.plan.filters.to, filters.to);
    assert.ok(data.commentary.summary.length > 0 && Array.isArray(data.commentary.actions));
    assert.ok(!/interpretação da OpenAI está temporariamente indisponível/i.test(data.commentary.summary), "HTTP 200 fallback is not proof of working AI.");
    const { data: deterministic } = await api<Report>("report", "POST", data.report.plan, actor);
    assert.deepEqual(data.report.total, deterministic.total); assert.deepEqual(data.report.rows, deterministic.rows);
    assert.deepEqual(data.report.comparison, deterministic.comparison);
    return data;
  }
  try {
    for (const actor of actors.values()) await login(actor);
    const { data: initial } = await api<DataStatus>("data/status");
    assert.equal(initial.source, "manual"); assert.ok(initial.active); assert.equal(initial.active.id, expectedVersion); assert.equal(initial.active.model, syntheticModel);
    assert.equal(initial.allowAI, false, "The test expects AI disabled and will restore that policy.");
    original = { source: initial.source, staleDays: initial.staleDays, allowAI: initial.allowAI };
    const { data: status } = await api<AssistantStatus>("assistant/status");
    assert.equal(status.model, configuredModel); assert.equal(status.credentialConfigured, true);
    const { data: baseline } = await api<Report>("report", "POST", baselinePlan);
    assert.equal(baseline.sourceInfo?.model, syntheticModel);
    assert.deepEqual([baseline.total.values.gross.current, baseline.total.values.returns.current, baseline.total.values.revenue.current, baseline.total.values.buyers.current], [350, 1034, -684, 2]);
    await api("report", "POST", baselinePlan, actors.get("no-scope")!, [403]);
    await api("chat", "POST", { question: "Como está meu resultado comercial?", filters, conversation: null }, actors.get("operator")!, [403]);
    await api("report", "POST", { ...baselinePlan, filters: { ...filters, client: "0002" } }, sales, [403]);
    checked("synthetic version, live credential presence, deterministic baseline and ACL preflight");
    if (previousRunEvidence && report.inheritedEvidence) {
      for (const name of ["national", "declining-clients"]) {
        const previous: ChatResponse = previousRunEvidence.responses.find(item => item.name === name)!.value;
        const replayResponse: { data: Omit<ChatResponse, "id" | "turn">; response: Response } = await api<Omit<ChatResponse, "id" | "turn">>(`turns/${previous.turn}/reopen`, "POST", {}, admin);
        const reopened: Omit<ChatResponse, "id" | "turn"> = replayResponse.data;
        assert.equal(reopened.report.sourceInfo?.versionId, expectedVersion); assert.equal(reopened.report.sourceInfo?.model, syntheticModel);
        assert.deepEqual(reopened.report.plan, previous.report.plan); assert.deepEqual(reopened.report.total, previous.report.total);
        const { data: deterministic } = await api<Report>("report", "POST", reopened.report.plan, admin);
        assert.deepEqual(reopened.report.total, deterministic.total); assert.deepEqual(reopened.report.rows, deterministic.rows);
        const guardAccepted = commentaryGrounded(reopened.commentary, reopened.report);
        const factualFallback = isDeepStrictEqual(reopened.commentary, factualCommentary(reopened.report));
        assert.ok(guardAccepted || factualFallback, "Reopened narrative must pass the current guard or equal computed factual commentary.");
        const previousNarrativeAccepted = commentaryGrounded(previous.commentary, previous.report);
        assert.equal(previousNarrativeAccepted, false, "The previously observed unsupported narrative must be rejected by the corrected guard.");
        const previousNarrativeChanged = !isDeepStrictEqual(previous.commentary, reopened.commentary);
        assert.equal(previousNarrativeAccepted, false, "The known-invalid original narrative must be rejected by the current guard.");
        assert.ok(previousNarrativeChanged, "Rejected stored narrative must be replaced when reopened.");
        report.storedNarrativeReplays.push({ name, turn: previous.turn, reportReconciled: true, guardAccepted, factualFallback, previousNarrativeAccepted, previousNarrativeChanged }); flush();
      }
      report.inheritedEvidence.priorNarrativeRevalidationRequired = false;
      checked("stored national and client-loss narratives are revalidated against current guards without OpenAI calls");
    }
    policyTouched = true;
    await api("admin/data/settings", "PUT", { ...original, allowAI: true });
    const { data: ready } = await api<AssistantStatus>("assistant/status"); assert.equal(ready.ready, true);
    checked("AI enabled only for the synthetic homologation source during this acceptance");
    if (mode.mode === "full") {
      const national = await chat("national", "Como está meu resultado comercial?", admin);
      assert.equal(national.report.plan.metric, "revenue"); assert.equal(national.report.total.values.revenue.current, -684); assert.equal(national.report.total.values.revenue.previous, 90);
      checked(nationalCheck);
      const declining = await chat("declining-clients", "Quais clientes mais perderam faturamento?", admin);
      assert.equal(declining.report.plan.metric, "revenue"); assert.equal(declining.report.plan.group, "client"); assert.equal(declining.report.plan.order, "decline");
      assert.ok(declining.report.rows.every(row => row.name.includes("Cliente SINTÉTICO")));
      checked(clientCheck);
    }
    const visit = await chat("visit", "Vou visitar o cliente 0001. Prepare minha reunião.", sales);
    assert.equal(visit.report.plan.filters.client, "0001"); assert.ok(visit.visit); assert.equal(visit.visit.client.code, "0001");
    assert.equal(visit.visit.timeline.total.values.revenue.current, 135); assert.equal(visit.visit.timeline.total.values.revenue.previous, 90);
    assert.equal(visit.visit.activity.lastPurchase, "2026-01-02"); assert.equal(visit.visit.activity.purchaseDays, 2);
    checked("live visit question preserves customer ACL, financial values and daily activity");
    const products = await chat("product-followup", "E quais produtos explicam a queda?", sales, visit.id);
    assert.equal(products.id, visit.id); assert.equal(products.report.plan.filters.client, "0001");
    assert.equal(products.report.plan.group, "product"); assert.equal(products.report.plan.metric, "revenue");
    assert.ok(products.report.rows.every(row => row.name.includes("Produto SINTÉTICO")));
    checked("live follow-up retains the authorized customer and homologous months");
    const { data: history } = await api<{ id: string }[]>(`conversations/${visit.id}`, "GET", undefined, sales);
    assert.equal(history.length, 2); assert.ok(history.some(turn => turn.id === visit.turn));
    await api(`conversations/${visit.id}`, "GET", undefined, other, [404]);
    await api(`turns/${visit.turn}/reopen`, "POST", {}, other, [404]);
    const { data: reopened } = await api<Omit<ChatResponse, "id" | "turn">>(`turns/${visit.turn}/reopen`, "POST", {}, sales);
    assert.deepEqual(reopened.report.total, visit.report.total); assert.equal(reopened.visit?.client.code, "0001");
    assert.equal(reopened.visit?.activity.purchaseDays, 2);
    checked("history reopens the pinned evidence and refuses another synthetic user's access");
    report.apiChecksPassed = true;
  } catch (error) {
    // Assertion values, headers and provider errors must never leak credentials.
    report.failures.push(`${operation}: ${error instanceof Error ? error.name : "verification_failed"}`); process.exitCode = 1;
  } finally {
    if (policyTouched && original && admin.cookie) {
      try { await api("admin/data/settings", "PUT", original); report.policyRestored = true; }
      catch { report.failures.push("AI_policy_restore_failed"); process.exitCode = 1; }
    } else report.policyRestored = !policyTouched;
    for (const actor of actors.values()) if (actor.cookie) {
      try { await api("auth/logout", "POST", {}, actor); actor.cookie = undefined; }
      catch { report.failures.push("session_cleanup_failed"); process.exitCode = 1; }
    }
    report.sessionsClosed = [...actors.values()].every(actor => !actor.cookie);
    report.apiChecksPassed &&= report.failures.length === 0 && report.policyRestored && report.sessionsClosed;
    report.completedAt = new Date().toISOString(); flush();
    process.stdout.write(JSON.stringify({ runId, runMode: mode.mode, previousEvidenceArchive, inheritedFinancialCases: inheritedEvidence?.responseNames ?? [], apiChecksPassed: report.apiChecksPassed, externalProviderLedgerVerificationRequired: true, checks: report.checks.length, chatRequests: report.chatRequests, requests: report.requests, policyRestored: report.policyRestored, sessionsClosed: report.sessionsClosed, privateReport: relative(resolve(), artifact), failures: report.failures, httpFailures: report.httpFailures }) + "\n");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runLiveAcceptance().catch(error => {
    process.exitCode = 1;
    process.stdout.write(JSON.stringify({ apiChecksPassed: false, phase: "local_preflight", errorType: error instanceof Error ? error.name : "verification_failed" }) + "\n");
  });
}
