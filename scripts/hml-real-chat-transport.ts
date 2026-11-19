/** Two live UI submissions, observed without response mocks or additional model requests. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { chromium, expect as defaultExpect, type APIResponse, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { filterDimensions, filtersSchema, type Filters, type Session } from "../shared/domain";
import type { RealAcceptanceConfig, RealChatResponse, RealScenario } from "./hml-real-verify";

const origin = "https://commercial-insight-hml.araujo-anderson26.workers.dev";
const expect = defaultExpect.configure({ timeout: 45000 });
export function normalizedRealFilters(value: Filters) {
  const parsed = filtersSchema.parse(value);
  return Object.fromEntries(["from", "to", ...filterDimensions].map(key => [key, parsed[key as keyof Filters] ?? ""]));
}
export function assertExpectedUiChat(payload: unknown, scenario: RealScenario, conversation: string | null, sent: number) {
  assert.ok(sent >= 0 && sent < 2, "The two UI submission slots are exhausted.");
  const request = payload as { question: string; filters: Filters; conversation: string | null };
  assert.equal(request.question, scenario.question); assert.equal(request.conversation, conversation);
  assert.deepEqual(normalizedRealFilters(request.filters), normalizedRealFilters(scenario.filters));
}
/** Label text from options/help is part of its accessible name; use the direct title text. */
export async function findRealFilterControl(dialog: Locator, title: string) {
  const labels = dialog.locator("label");
  const matches = await labels.evaluateAll((elements, wanted) => elements.flatMap((element, index) => {
    const label = element as unknown as { childNodes: ArrayLike<{ nodeType: number; textContent: string | null }> };
    const ownText = Array.from(label.childNodes).filter(node => node.nodeType === 3).map(node => node.textContent ?? "").join("").trim();
    return ownText === wanted ? [index] : [];
  }), title);
  if (!matches.length) return null;
  assert.equal(matches.length, 1, "Filter title must identify exactly one field.");
  const field = labels.nth(matches[0]).locator("input, select");
  assert.equal(await field.count(), 1, "The filter label must contain exactly one input.");
  return field;
}

export class RealChatUiTransport {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private armed?: { scenario: RealScenario; conversation: string | null };
  private conversation: string | null = null;
  private sent = 0;
  private rejected = 0;
  private closed = true;
  private sourceConfirmed = false;
  private phase = "initialized";
  private failure?: { phase: string; errorType: string };
  private pageErrors: string[] = [];
  private network: { scenarioId: string; questionHash: string; status?: number; accepted: boolean }[] = [];
  private artifactRoot: string;
  constructor(private config: RealAcceptanceConfig, private actor: { email: string; password: string }, artifactRoot: string) {
    assert.equal(config.origin, origin);
    const privateRoot = resolve(".wrangler/hml-real"), output = resolve(artifactRoot), rel = relative(privateRoot, output);
    assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel)); this.artifactRoot = output;
  }
  summary() { return { sent: this.sent, rejected: this.rejected, sessionsClosed: this.closed, pageErrors: this.pageErrors.length }; }
  private async flush() {
    await mkdir(this.artifactRoot, { recursive: true });
    await writeFile(resolve(this.artifactRoot, "transport.json"), JSON.stringify({ ...this.summary(), phase: this.phase, failure: this.failure, network: this.network, pageErrors: this.pageErrors }, null, 2) + "\n", { mode: 0o600 });
  }
  private async setFilters(value: Filters, me: Session) {
    const page = this.page!;
    await page.getByRole("button", { name: /^Filtros/ }).click(); const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Primeiro mês", { exact: true }).fill(value.from); await dialog.getByLabel("Último mês", { exact: true }).fill(value.to);
    const labels = { region: "Regional", client: "Cliente", product: "Produto", regional: "Regional comercial", state: "UF", manager: "Gerente", category: "Categoria", ...me.data?.capabilities?.labels };
    for (const dimension of filterDimensions) {
      if (value[dimension] === undefined) continue;
      this.phase = "filters-" + dimension;
      const field = await findRealFilterControl(dialog, labels[dimension]);
      if (!field) { assert.ok(!value[dimension]); continue; }
      const tag = await field.evaluate(element => element.tagName.toLowerCase());
      if (tag === "select") await field.selectOption(value[dimension] ?? ""); else await field.fill(value[dimension] ?? "");
    }
    await dialog.getByRole("button", { name: "Aplicar filtros", exact: true }).click(); await expect(dialog).not.toBeVisible();
  }
  private async open(scenario: RealScenario) {
    this.phase = "launch";
    this.browser = await chromium.launch({ executablePath: process.env.UI_SMOKE_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
    this.context = await this.browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "pt-BR" }); this.closed = false;
    await this.context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === "/api/chat" && request.method() === "POST") {
        try {
          assert.ok(this.armed);
          const payload = JSON.parse(request.postData() ?? "null");
          assertExpectedUiChat(payload, this.armed.scenario, this.armed.conversation, this.sent);
          this.network.push({ scenarioId: this.armed.scenario.id, questionHash: createHash("sha256").update(this.armed.scenario.question).digest("hex"), accepted: true });
          this.sent++; this.armed = undefined; await this.flush(); return route.continue();
        } catch {
          this.rejected++; await this.flush(); return route.abort("blockedbyclient");
        }
      }
      return route.continue();
    });
    this.page = await this.context.newPage(); this.page.setDefaultTimeout(45000); this.page.on("pageerror", error => this.pageErrors.push(error.name));
    this.phase = "login";
    await this.page.goto(origin + "/");
    await this.page.getByLabel("E-mail corporativo", { exact: true }).fill(this.actor.email); await this.page.getByLabel("Senha", { exact: true }).fill(this.actor.password);
    await this.page.getByRole("button", { name: "Entrar no Comercial Insight", exact: true }).click(); await expect(this.page.locator(".sidebar")).toBeVisible();
    const meResponse: APIResponse = await this.context.request.get(origin + "/api/me", { maxRedirects: 0 }); assert.equal(meResponse.status(), 200); const me = await meResponse.json() as Session;
    assert.equal(me.user.role, "gerente"); assert.equal(me.user.national, false); assert.ok(me.user.regions.includes(scenario.filters.region));
    const source: APIResponse = await this.context.request.get(origin + "/api/data/status", { maxRedirects: 0 }); assert.equal(source.status(), 200);
    assert.equal((await source.json() as { active: { id: string } | null }).active?.id, this.config.activeSampleUuid); this.sourceConfirmed = true;
    this.phase = "navigate-chat";
    await this.page.goto(origin + "/conversas");
    this.phase = "filters";
    await this.setFilters(scenario.filters, me);
    this.phase = "new-conversation";
    await this.page.getByRole("button", { name: "Nova conversa", exact: true }).click();
    await expect(this.page.getByLabel("Sua pergunta", { exact: true })).toBeEnabled();
  }
  async submit(scenario: RealScenario, conversation: string | null): Promise<RealChatResponse> {
    assert.equal(scenario.actor, this.config.scenarios[2].actor);
    assert.equal(scenario.id, this.config.scenarios[this.sent + 2]?.id);
    assert.equal(conversation, this.conversation);
    if (!this.page) await this.open(scenario);
    const page = this.page!;
    this.phase = "question-input";
    await page.getByLabel("Sua pergunta", { exact: true }).fill(scenario.question);
    this.armed = { scenario, conversation };
    const responseEvent = page.waitForResponse(response => response.url() === origin + "/api/chat" && response.request().method() === "POST", { timeout: 100000 });
    this.phase = "submit";
    await page.getByRole("button", { name: "Enviar pergunta", exact: true }).click();
    const response = await responseEvent; const latest = this.network.at(-1); if (latest) latest.status = response.status(); await this.flush();
    assert.equal(response.status(), 200, "The observed live UI request failed.");
    const result = await response.json() as RealChatResponse; this.conversation = result.id;
    this.phase = "rendered-response";
    await expect(page.locator(".turn .bubble").filter({ hasText: scenario.question }).last()).toBeVisible();
    assert.equal(this.rejected, 0); assert.equal(this.pageErrors.length, 0);
    if (this.sourceConfirmed) await page.screenshot({ path: resolve(this.artifactRoot, `submission-${this.sent}.png`), fullPage: true });
    return result;
  }
  async captureFailure(error: unknown) {
    this.failure = { phase: this.phase, errorType: error instanceof Error ? error.name : "verification_failed" };
    if (this.page && this.sourceConfirmed) await this.page.screenshot({ path: resolve(this.artifactRoot, "failure.png"), fullPage: true }).catch(() => {});
    await this.flush();
  }
  async close() {
    this.armed = undefined;
    if (this.context) {
      try {
        const response = await this.context.request.post(origin + "/api/auth/logout", { headers: { Origin: origin }, data: {}, maxRedirects: 0 });
        assert.equal(response.status(), 200); assert.equal((await this.context.request.get(origin + "/api/me", { maxRedirects: 0 })).status(), 401); this.closed = true;
      } catch { this.closed = false; }
    }
    await this.context?.close(); await this.browser?.close(); await this.flush();
  }
}
