/** Real HTTPS browser verification. This script refuses every host except the isolated HML Worker. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { Report } from "../shared/domain";

const allowedOrigin = "https://commercial-insight-hml.araujo-anderson26.workers.dev";
const privateRoot = resolve(".wrangler/hml");
const credentialPath = resolve(process.argv[2] ?? "");
const credentialRelative = relative(privateRoot, credentialPath);
if (!process.argv[2] || !credentialRelative || credentialRelative.startsWith("..") || isAbsolute(credentialRelative)) {
  throw Error("Informe o arquivo de credenciais próprio da homologação dentro de .wrangler/hml.");
}
const credentials = JSON.parse(await readFile(credentialPath, "utf8")) as {
  origin: string;
  admin: { email: string; password: string };
};
if (credentials.origin !== allowedOrigin || !credentials.admin?.email || !credentials.admin.password) {
  throw Error("Origem ou credenciais isoladas de homologação inválidas.");
}
const origin = credentials.origin;
const artifacts = resolve(privateRoot, "browser-" + new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(artifacts, { recursive: true });
const checks: { name: string; passed: boolean; elapsedMs: number }[] = [];
const started = Date.now();
let currentStep = "iniciar navegador", browser: Browser | undefined, context: BrowserContext | undefined;
let page: Page | undefined, savedId: string | undefined, syntheticConfirmed = false;
const pageErrors: string[] = [];
const reports: Report[] = [];
async function check(name: string, fn: () => Promise<void>) {
  currentStep = name;
  const began = Date.now();
  await fn();
  checks.push({ name, passed: true, elapsedMs: Date.now() - began });
}
async function fitViewport() {
  expect(await page!.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
async function periodJanuary() {
  await page!.getByRole("button", { name: /^Filtros/ }).click();
  const dialog = page!.getByRole("dialog");
  await dialog.getByLabel("Primeiro mês", { exact: true }).fill("2026-01");
  await dialog.getByLabel("Último mês", { exact: true }).fill("2026-01");
  await dialog.getByRole("button", { name: "Aplicar filtros", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
try {
  browser = await chromium.launch({
    executablePath: process.env.UI_SMOKE_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "pt-BR", acceptDownloads: true });
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(45000);
  page.on("pageerror", error => pageErrors.push(error.name));
  page.on("response", response => {
    if (response.url() === origin + "/api/report" && response.ok()) {
      void response.json().then((value: Report) => reports.push(value)).catch(() => {});
    }
    if (response.url() === origin + "/api/saved-reports" && response.request().method() === "POST" && response.ok()) {
      void response.json().then((value: { id: string }) => { savedId = value.id; }).catch(() => {});
    }
  });
  await check("login pelo formulário HTTPS com usuário exclusivo de homologação", async () => {
    await page!.goto(origin + "/relatorios");
    await page!.getByLabel("E-mail corporativo", { exact: true }).fill(credentials.admin.email);
    await page!.getByLabel("Senha", { exact: true }).fill(credentials.admin.password);
    await page!.getByRole("button", { name: "Entrar no Comercial Insight", exact: true }).click();
    await expect(page!.getByRole("heading", { name: "Relatórios", exact: true })).toBeVisible();
  });
  await check("fonte remota identificada como sintética antes de validar e capturar telas", async () => {
    const response = await context!.request.get(origin + "/api/data/status", { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    const source = await response.json() as { source: string; active: { model: string } | null };
    expect(source.source).toBe("manual");
    expect(source.active?.model).toMatch(/SINT[EÉ]TICO/i);
    syntheticConfirmed = true;
  });
  await check("relatório nacional janeiro/2026 confere bruto, devoluções, líquido e compradores", async () => {
    await periodJanuary();
    await expect.poll(() => reports.at(-1)?.plan.filters.from).toBe("2026-01");
    await expect.poll(() => reports.at(-1)?.plan.filters.to).toBe("2026-01");
    await expect.poll(() => reports.at(-1)?.total.values.revenue.current).toBe(-684);
    const result = reports.at(-1)!;
    expect(result.source).toBe("Arquivo manual (D1)");
    expect(result.total.values.gross.current).toBe(350);
    expect(result.total.values.returns.current).toBe(1034);
    expect(result.total.values.buyers.current).toBe(2);
    expect(result.total.values.revenue.previous).toBe(90);
    await expect(page!.locator(".kpi-revenue strong")).toContainText(/[-−]\s*R\$\s*684,00/);
    await expect(page!.locator(".kpi-gross strong")).toContainText(/R\$\s*350,00/);
    await expect(page!.locator(".kpi-returns strong")).toContainText(/R\$\s*1\.034,00/);
    await expect(page!.locator(".kpi-buyers strong")).toHaveText("2");
    await expect(page!.locator(".kpi-revenue .negative")).toHaveCount(1);
    await fitViewport();
  });
  await check("ranking com código e descrição e arquivo XLSX real", async () => {
    await page!.getByLabel("Agrupar por", { exact: true }).selectOption("client");
    await expect(page!.getByRole("button", { name: /0001 — Cliente SINTÉTICO 0001/ })).toBeVisible();
    const event = page!.waitForEvent("download");
    await page!.getByRole("button", { name: "Exportar Excel", exact: true }).click();
    const download = await event;
    const path = resolve(artifacts, "relatorio-sintetico.xlsx");
    await download.saveAs(path);
    const archive = await readFile(path);
    expect(archive.subarray(0, 2).toString()).toBe("PK");
    expect(archive.toString("utf8")).toContain('<t xml:space="preserve">0001</t>');
    await page!.screenshot({ path: resolve(artifacts, "relatorio-desktop.png"), fullPage: true });
  });
  await check("consulta favorita salva e reaberta com indicador e ordem originais", async () => {
    const title = "Consulta SINTÉTICA navegador " + Date.now();
    await page!.getByLabel("Indicador", { exact: true }).selectOption("returns");
    await page!.getByLabel("Ordenar por", { exact: true }).selectOption("decline");
    await expect.poll(() => reports.at(-1)?.plan.metric).toBe("returns");
    await expect.poll(() => reports.at(-1)?.plan.order).toBe("decline");
    await page!.getByRole("button", { name: "Salvar consulta", exact: true }).click();
    await page!.getByLabel("Nome da consulta", { exact: true }).fill(title);
    await page!.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page!.getByRole("button", { name: title, exact: true })).toBeVisible();
    await page!.getByLabel("Indicador", { exact: true }).selectOption("gross");
    await page!.getByRole("button", { name: title, exact: true }).click();
    await expect(page!.getByLabel("Indicador", { exact: true })).toHaveValue("returns");
    await expect(page!.getByLabel("Ordenar por", { exact: true })).toHaveValue("decline");
    await expect.poll(() => reports.at(-1)?.plan.metric).toBe("returns");
    await expect.poll(() => reports.at(-1)?.plan.order).toBe("decline");
  });
  await check("briefing de visita real sem OpenAI e identificação de cliente", async () => {
    await page!.getByRole("button", { name: "Preparar visita", exact: true }).first().click();
    await page!.getByLabel("Cliente da visita", { exact: true }).fill("Cliente SINTÉTICO 0001");
    await page!.getByRole("button", { name: "0001 — Cliente SINTÉTICO 0001", exact: true }).click();
    await page!.getByRole("button", { name: "Preparar briefing", exact: true }).click();
    await expect(page!.getByRole("heading", { name: "Objetivos da reunião", exact: true })).toBeVisible();
    await expect(page!.locator(".visit-result .kpi-revenue strong")).toContainText(/R\$\s*135,00/);
    await expect(page!.locator(".visit-facts")).toContainText("2026-01-02");
    await expect(page!.locator(".visit-facts")).toContainText("2 dias com compra");
    await fitViewport();
    await page!.screenshot({ path: resolve(artifacts, "visita-desktop.png"), fullPage: true });
  });
  await check("impressão PDF mantém briefing e oculta navegação", async () => {
    await page!.emulateMedia({ media: "print" });
    await expect(page!.locator(".sidebar")).not.toBeVisible();
    await expect(page!.locator(".visit-selector")).not.toBeVisible();
    const path = resolve(artifacts, "visita-sintetica.pdf");
    await page!.pdf({ path, format: "A4", printBackground: true });
    expect((await readFile(path)).subarray(0, 4).toString()).toBe("%PDF");
    await page!.emulateMedia({ media: "screen" });
  });
  await check("celular 390px sem rolagem horizontal indevida", async () => {
    await page!.setViewportSize({ width: 390, height: 844 });
    await fitViewport();
    await page!.screenshot({ path: resolve(artifacts, "visita-mobile.png"), fullPage: true });
  });
  await check("assistente informa chave e autorização pendentes sem chamada externa", async () => {
    await page!.goto(origin + "/conversas");
    await expect(page!.locator(".assistant-status")).toContainText("OPENAI_API_KEY");
    await expect(page!.locator(".assistant-status")).toContainText(/desabilitad/i);
    expect(pageErrors).toEqual([]);
  });
  await check("logout encerra a sessão de navegador", async () => {
    if (savedId) {
      const removed = await context!.request.delete(origin + "/api/saved-reports/" + savedId, { headers: { Origin: origin }, maxRedirects: 0 });
      expect(removed.status()).toBe(200);
      savedId = undefined;
    }
    await page!.goto(origin + "/perfil");
    await page!.getByRole("button", { name: "Sair da conta", exact: true }).click();
    await expect(page!.getByRole("heading", { name: "Acesse sua conta", exact: true })).toBeVisible();
    const response = await context!.request.get(origin + "/api/me", { maxRedirects: 0 });
    expect(response.status()).toBe(401);
  });
} catch (error) {
  // Playwright call logs may contain fill values; never persist or print the raw error.
  checks.push({ name: currentStep, passed: false, elapsedMs: Date.now() - started });
  process.exitCode = 1;
  await writeFile(resolve(artifacts, "failure.json"), JSON.stringify({ step: currentStep, errorType: error instanceof Error ? error.name : "unknown" }, null, 2));
} finally {
  if (context) {
    if (syntheticConfirmed && savedId) await context.request.delete(origin + "/api/saved-reports/" + savedId, { headers: { Origin: origin }, maxRedirects: 0 }).catch(() => {});
    await context.request.post(origin + "/api/auth/logout", { headers: { Origin: origin }, data: {}, maxRedirects: 0 }).catch(() => {});
  }
  await browser?.close();
  const summary = { ok: !process.exitCode, origin, syntheticConfirmed, checks, pageErrors, elapsedMs: Date.now() - started };
  await writeFile(resolve(artifacts, "report.json"), JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ ok: summary.ok, passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed).length, report: relative(resolve(), resolve(artifacts, "report.json")) }) + "\n");
}
