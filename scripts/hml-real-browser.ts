/** Real-data UI acceptance reopens existing answers. It blocks every new /api/chat call.
 * node --import tsx scripts/hml-real-browser.ts --execute-authorized-real-ui
 * Screenshots, exports and all commercial evidence remain private.
 */
import assert from "node:assert/strict";
import { copyFile, readFile, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect as defaultExpect, type APIResponse, type Browser, type BrowserContext, type Page, type Response as PlaywrightResponse } from "@playwright/test";
import { pretty, type Filters, type Session } from "../shared/domain";
import { assertRealOracle, loadRealAcceptanceFiles, realHmlOrigin, realPrivatePath, type RealChatResponse } from "./hml-real-verify";
import { findRealFilterControl } from "./hml-real-chat-transport";

const expect = defaultExpect.configure({ timeout: 45000 });

export async function runRealBrowserAcceptance() {
  assert.ok(process.argv.includes("--execute-authorized-real-ui"), "Explicit private real-data UI execution flag is required.");
  const { config, oracle } = loadRealAcceptanceFiles();
  const credentials = JSON.parse(await readFile(realPrivatePath(config.credentialFile), "utf8")) as { origin: string; actors: Record<string, { email: string; password: string }> };
  assert.equal(credentials.origin, realHmlOrigin);
  const latest = JSON.parse(await readFile(realPrivatePath(".wrangler/hml-real/latest-run.json"), "utf8")) as { runId: string; scopeHash: string; apiArtifact: string };
  assert.equal(latest.scopeHash, config.scopeHash); assert.match(latest.runId, /^[a-f0-9-]{36}$/);
  const apiEvidence = JSON.parse(await readFile(realPrivatePath(latest.apiArtifact), "utf8")) as { apiChecksPassed: boolean; scopeHash: string; sampleId: string; responses: { scenarioId: string; actor: string; value: RealChatResponse }[] };
  assert.equal(apiEvidence.apiChecksPassed, true); assert.equal(apiEvidence.scopeHash, config.scopeHash); assert.equal(apiEvidence.sampleId, config.activeSampleUuid);
  const root = realPrivatePath(`.wrangler/hml-real/evidence/${latest.runId}/browser`); await mkdir(root, { recursive: true });
  const priorAttemptArchive = resolve(root, "archive", new Date().toISOString().replace(/[:.]/gu, "-"));
  await mkdir(priorAttemptArchive, { recursive: true });
  for (const name of ["report.json", "failure.json", "failure.png"]) {
    try { await copyFile(resolve(root, name), resolve(priorAttemptArchive, name), constants.COPYFILE_EXCL); }
    catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
  }
  const checks: { id: string; passed: boolean }[] = [], pageErrors: string[] = [];
  const httpFailures: { method: string; path: string; status: number; diagnostic: string | null; detail: string | null }[] = [];
  let browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined, step = "launch", sourceConfirmed = false, blockedChatRequests = 0, sessionsClosed = true;
  const startedAt = new Date().toISOString();
  const check = (id: string) => checks.push({ id, passed: true });
  async function fitViewport() {
    expect(await page!.evaluate(() => {
      const viewport = globalThis as unknown as { document: { documentElement: { scrollWidth: number } }; innerWidth: number };
      return viewport.document.documentElement.scrollWidth <= viewport.innerWidth;
    })).toBe(true);
  }
  async function setFilters(value: Filters, me: Session) {
    await page!.getByRole("button", { name: /^Filtros/ }).click(); const dialog = page!.getByRole("dialog");
    await dialog.getByLabel("Primeiro mês", { exact: true }).fill(value.from); await dialog.getByLabel("Último mês", { exact: true }).fill(value.to);
    const labels = { region: "Regional", client: "Cliente", product: "Produto", regional: "Regional comercial", state: "UF", manager: "Gerente", category: "Categoria", ...me.data?.capabilities?.labels };
    for (const dimension of ["region", "client", "product", "regional", "state", "manager", "category"] as const) {
      if (value[dimension] === undefined) continue;
      const field = await findRealFilterControl(dialog, labels[dimension]);
      if (!field) { assert.ok(!value[dimension]); continue; }
      const tag = await field.evaluate(element => element.tagName.toLowerCase());
      if (tag === "select") await field.selectOption(value[dimension] ?? ""); else await field.fill(value[dimension] ?? "");
    }
    await dialog.getByRole("button", { name: "Aplicar filtros", exact: true }).click(); await expect(dialog).not.toBeVisible();
  }
  async function closeSession() {
    if (!context) return;
    try {
      const response = await context.request.post(realHmlOrigin + "/api/auth/logout", { headers: { Origin: realHmlOrigin }, data: {}, maxRedirects: 0 });
      assert.equal(response.status(), 200);
      assert.equal((await context.request.get(realHmlOrigin + "/api/me", { maxRedirects: 0 })).status(), 401);
    } catch { sessionsClosed = false; }
    await context.close(); context = undefined; page = undefined;
  }
  try {
    browser = await chromium.launch({ executablePath: process.env.UI_SMOKE_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
    for (const [index, scenario] of config.scenarios.entries()) {
      step = `scenario-${index + 1}`; sourceConfirmed = false;
      const actor = credentials.actors[scenario.actor], evidence = apiEvidence.responses.find(item => item.scenarioId === scenario.id); assert.ok(actor && evidence);
      assert.equal(evidence.actor, scenario.actor);
      context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "pt-BR", acceptDownloads: true });
      await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== realHmlOrigin) return route.abort();
        if (url.pathname === "/api/chat" && route.request().method() === "POST") { blockedChatRequests++; return route.abort(); }
        return route.continue();
      });
      page = await context.newPage(); page.setDefaultTimeout(45000); page.on("pageerror", error => pageErrors.push(error.name));
      page.on("response", response => {
        const url = new URL(response.url());
        if (url.origin === realHmlOrigin && url.pathname.startsWith("/api/") && response.status() >= 400 && !(url.pathname === "/api/me" && response.status() === 401)) {
          const headers = response.headers(), safeEnum = (value?: string) => value && /^[a-z0-9_-]{1,64}$/i.test(value) ? value : null;
          httpFailures.push({ method: response.request().method(), path: url.pathname, status: response.status(), diagnostic: safeEnum(headers["x-hml-diagnostic"]), detail: safeEnum(headers["x-hml-diagnostic-detail"]) });
        }
      });
      await page.goto(realHmlOrigin + "/");
      await page.getByLabel("E-mail corporativo", { exact: true }).fill(actor.email); await page.getByLabel("Senha", { exact: true }).fill(actor.password);
      await page.getByRole("button", { name: "Entrar no Comercial Insight", exact: true }).click(); await expect(page.locator(".sidebar")).toBeVisible();
      const meResponse: APIResponse = await context.request.get(realHmlOrigin + "/api/me", { maxRedirects: 0 }); assert.equal(meResponse.status(), 200); const me = await meResponse.json() as Session;
      const source: APIResponse = await context.request.get(realHmlOrigin + "/api/data/status", { maxRedirects: 0 }); assert.equal(source.status(), 200);
      assert.equal((await source.json() as { active: { id: string } | null }).active?.id, config.activeSampleUuid); sourceConfirmed = true;
      const threadsEvent: Promise<PlaywrightResponse> = page.waitForResponse(response => response.url() === realHmlOrigin + "/api/conversations");
      await page.goto(realHmlOrigin + "/conversas"); const threadsResponse: PlaywrightResponse = await threadsEvent; assert.equal(threadsResponse.status(), 200); const threads = await threadsResponse.json() as { id: string }[];
      await setFilters(scenario.filters, me); check(`${scenario.id}-filters`);
      const threadIndex = threads.findIndex(item => item.id === evidence.value.id); assert.ok(threadIndex >= 0);
      const turnsEvent: Promise<PlaywrightResponse> = page.waitForResponse(response => response.url() === realHmlOrigin + "/api/conversations/" + evidence.value.id);
      await page.locator(".thread").nth(threadIndex).locator("button").first().click();
      const turnsResponse: PlaywrightResponse = await turnsEvent; assert.equal(turnsResponse.status(), 200); const turns = await turnsResponse.json() as { id: string }[]; const turnIndex = turns.findIndex(item => item.id === evidence.value.turn); assert.ok(turnIndex >= 0);
      const article = page.locator(".turn").nth(turnIndex); await expect(article.locator(".bubble")).toHaveText(scenario.question);
      const reopenEvent: Promise<PlaywrightResponse> = page.waitForResponse(response => response.url() === realHmlOrigin + "/api/turns/" + evidence.value.turn + "/reopen");
      await article.getByRole("button", { name: "Reabrir valores da versão original", exact: true }).click();
      const reopenResponse: PlaywrightResponse = await reopenEvent; assert.equal(reopenResponse.status(), 200); const reopened = await reopenResponse.json() as Omit<RealChatResponse, "id" | "turn">;
      assertRealOracle({ ...reopened, id: evidence.value.id, turn: evidence.value.turn }, oracle.scenarios[scenario.id], config.activeSampleUuid);
      const revenue = reopened.report.total.values.revenue.current, revenueCard = article.locator(".kpi-revenue strong").first();
      await expect(revenueCard).toHaveText(pretty(revenue, "revenue", Math.abs(revenue ?? 0) >= 10000));
      await expect(revenueCard).toHaveAttribute("title", pretty(revenue, "revenue"));
      await expect(article.locator(".graph .recharts-surface").first()).toBeVisible();
      const monthLabel = (month: string) => new Intl.DateTimeFormat("pt-BR", { month: "short", year: "2-digit", timeZone: "UTC" }).format(new Date(month + "-15T12:00:00Z")).replace(". de ", "/").replace(" de ", "/");
      await expect(article.locator(".graph .chartsub").first()).toContainText(monthLabel(scenario.filters.from) + " – " + monthLabel(scenario.filters.to));
      if (scenario.filters.client) await expect(article).toContainText(scenario.filters.client);
      await fitViewport(); check(`${scenario.id}-history-and-charts`);
      const graph = article.locator(".graph").first(); await graph.getByRole("button", { name: "Tabela", exact: true }).click(); await expect(graph.locator("tbody tr").first()).toBeVisible();
      if (oracle.scenarios[scenario.id].plan.group !== "month") for (const row of (oracle.scenarios[scenario.id].rows ?? []).slice(0, 3)) if (row.name) await expect(article).toContainText(row.name);
      await graph.getByRole("button", { name: "Gráfico", exact: true }).click(); check(`${scenario.id}-labels-and-table`);
      const downloadEvent = page.waitForEvent("download"); await article.getByRole("button", { name: "Excel", exact: true }).first().click();
      const download = await downloadEvent, workbook = resolve(root, `scenario-${index + 1}.xlsx`); await download.saveAs(workbook); assert.equal((await readFile(workbook)).subarray(0, 2).toString(), "PK");
      await page.screenshot({ path: resolve(root, `scenario-${index + 1}-desktop.png`), fullPage: true });
      await page.emulateMedia({ media: "print" }); await expect(page.locator(".sidebar")).not.toBeVisible();
      await page.evaluate(async () => {
        const layout = globalThis as unknown as { requestAnimationFrame(callback: () => void): number };
        await new Promise<void>(done => layout.requestAnimationFrame(() => layout.requestAnimationFrame(done)));
      });
      await expect.poll(() => article.locator(".chart").first().evaluate(element => {
        const container = element as unknown as { clientWidth: number; querySelector(selector: string): { getBoundingClientRect(): { width: number } } | null };
        const svg = container.querySelector("svg"), width = svg?.getBoundingClientRect().width ?? 0; return width > 0 && width <= container.clientWidth + 1;
      })).toBe(true);
      const pdf = resolve(root, `scenario-${index + 1}.pdf`); await page.pdf({ path: pdf, format: "A4", printBackground: true }); assert.equal((await readFile(pdf)).subarray(0, 4).toString(), "%PDF"); await page.emulateMedia({ media: "screen" });
      await page.setViewportSize({ width: 390, height: 844 }); await fitViewport(); await page.screenshot({ path: resolve(root, `scenario-${index + 1}-mobile.png`), fullPage: true });
      check(`${scenario.id}-exports-and-mobile`); await closeSession();
    }
    assert.equal(pageErrors.length, 0); assert.equal(blockedChatRequests, 0); assert.equal(sessionsClosed, true);
  } catch (error) {
    checks.push({ id: step, passed: false }); process.exitCode = 1;
    if (page && sourceConfirmed) await page.screenshot({ path: resolve(root, "failure.png"), fullPage: true }).catch(() => {});
    await writeFile(resolve(root, "failure.json"), JSON.stringify({ step, errorType: error instanceof Error ? error.name : "verification_failed", httpFailures }) + "\n", { mode: 0o600 });
  } finally {
    await closeSession(); await browser?.close();
    const report = { runId: latest.runId, scopeHash: config.scopeHash, priorAttemptArchive, ok: !process.exitCode && sessionsClosed, startedAt, completedAt: new Date().toISOString(), checks, pageErrors, httpFailures, blockedChatRequests, sessionsClosed };
    await writeFile(resolve(root, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    process.stdout.write(JSON.stringify({ runId: latest.runId, scopeHash: config.scopeHash, ok: report.ok, checksPassed: checks.filter(item => item.passed).length, checksFailed: checks.filter(item => !item.passed).length, blockedChatRequests, pageErrors: pageErrors.length, sessionsClosed }) + "\n");
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runRealBrowserAcceptance().catch(error => { process.exitCode = 1; process.stdout.write(JSON.stringify({ ok: false, phase: "local-preflight", errorType: error instanceof Error ? error.name : "verification_failed" }) + "\n"); });
}
