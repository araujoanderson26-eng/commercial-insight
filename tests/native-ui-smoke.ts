/** Browser contract smoke. All responses and upload contents below are synthetic. */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { chromium, expect } from "@playwright/test";
import { fixturePackage } from "./manual-fixtures";
import type { DataCapabilities, Filters, Plan, Report } from "../shared/domain";

const capabilities: DataCapabilities = {
  metrics: ["gross", "revenue", "returns", "buyers"],
  groups: ["month", "client", "region", "product", "category", "state", "regional", "manager"],
  filters: ["region", "client", "product", "regional", "state", "manager"],
  labels: { revenue: "Faturamento líquido", region: "Representante", regional: "Regional", state: "UF", manager: "Gerente" },
};
const first = "10000000-0000-4000-8000-000000000001", second = "10000000-0000-4000-8000-000000000002";
let activeId = first, accepted = false;
const plans: Plan[] = [];
const optionRequests: Filters[] = [];
let delayOptions = false, cancelledOptions = 0;
const root = resolve("dist"), artifacts = resolve(".wrangler/native-ui");
const actor = "Administrador SINTÉTICO UI";
const user = { id: first, name: actor, email: "sintetico@native-ui.test", role: "admin", national: true, active: true, regions: [], clients: [], entraOid: null };
const active = () => ({ id: activeId, publishedAt: "2026-11-18T18:00:00Z", actor, extractedAt: "2026-11-18T12:00:00Z", sourceUpdatedAt: "2026-11-18T10:00:00Z", from: "2025-01-01", to: "2026-11-18", rows: 6, tables: 2, capabilities });
const history = () => accepted ? [{ id: second, versionId: second, filename: "SINTETICO-ui.ci.ndjson", bytes: 1000, uploadedBytes: 1000, processedBytes: 1000, rows: 6, tables: 2, created: "2026-11-18T18:00:00Z", updated: "2026-11-18T18:00:00Z", status: "published", error: null, report: { checks: [{ name: "reconciliacao", status: "passed", detail: "Controles SINTÉTICOS conferidos." }] } }] : [];
const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const json = (data: unknown) => { response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(data)); };
    if (url.pathname === "/api/me") return json({ user, policyVersion: "ui-only", expires: Math.floor(Date.now() / 1000) + 3600, integrations: { configured: false, mode: "delegated", linked: false, ai: false }, data: { source: "manual", ready: true, activeVersionId: activeId, extractedAt: "2026-11-18T12:00:00Z", stale: false, capabilities } });
    if (url.pathname === "/api/data/options") {
      optionRequests.push(JSON.parse(body.toString()));
      const options = { values: { region: ["Representante SINTÉTICO"], client: ["0001"], product: ["P"], regional: ["Regional SINTÉTICA"], state: ["SP"], manager: ["Gerente SINTÉTICO"] }, sourceVersion: activeId };
      if (!delayOptions) return json(options);
      const timer = setTimeout(() => { if (!response.destroyed) json(options); }, 1500);
      response.once("close", () => { clearTimeout(timer); if (!response.writableEnded) cancelledOptions++; });
      return;
    }
    if (url.pathname === "/api/admin/users") return json([user]);
    if (url.pathname === "/api/report") {
      const plan = JSON.parse(body.toString()) as Plan; plans.push(plan);
      const values = { gross: { current: 100, previous: 90 }, revenue: { current: 90, previous: 81 }, returns: { current: 10, previous: 9 }, buyers: { current: 4, previous: 3 }, margin: { current: null, previous: null } };
      const report: Report = { plan, total: { name: "Total", values }, rows: [{ name: plan.group === "month" ? plan.filters.from : "Grupo SINTÉTICO", values }, ...(plan.group === "manager" ? [{ name: "(Em branco)", canDrill: false, values }] : [])], source: "Arquivo manual (D1)", asOf: "2026-11-18T18:00:00Z", truncated: false, sourceInfo: { versionId: activeId, extractedAt: "2026-11-18T12:00:00Z", sourceUpdatedAt: "2026-11-18T10:00:00Z", referenceDate: "2026-11-18", coverage: { from: "2025-01-01", to: "2026-11-18" }, capabilities } };
      return json(report);
    }
    if (url.pathname === "/api/admin/data") return json({ source: "manual", staleDays: 7, allowAI: false, active: active(), history: history(), limits: { maxBytes: 134217728, partBytes: 5242880, format: ".ci.ndjson" } });
    if (url.pathname === "/api/admin/data/imports") return json({ id: second, status: "uploading", partBytes: 5242880, parts: 1, uploadedParts: [] });
    if (url.pathname.endsWith("/parts/1")) return json({ part: 1, etag: "synthetic-ui-only" });
    if (url.pathname.endsWith("/complete")) { activeId = second; accepted = true; return json({ id: second, status: "queued" }); }
    if (url.pathname.startsWith("/api/")) return json({});
    let path = resolve(root, "." + decodeURIComponent(url.pathname));
    if (path !== root && !path.startsWith(root + sep)) throw Error("Invalid static path");
    if (!extname(path)) path = resolve(root, "index.html");
    const bytes = await readFile(path); response.writeHead(200, { "Content-Type": mime[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" }); response.end(bytes);
  } catch { response.writeHead(500); response.end("Synthetic UI server failed"); }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address(); if (!address || typeof address === "string") throw Error("UI address missing");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ executablePath: process.env.UI_SMOKE_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
try {
  await mkdir(artifacts, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "pt-BR" });
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/relatorios");
  await expect(page.locator(".kpis")).toContainText("Faturamento bruto");
  await expect(page.locator(".kpis")).toContainText("Faturamento líquido");
  await expect(page.locator(".kpis")).not.toContainText("Margem comercial");
  await page.getByLabel(/^Indicador/).selectOption("gross");
  await expect.poll(() => plans.at(-1)?.metric).toBe("gross");
  await page.getByRole("button", { name: /^(Filtros|Consultar filtros)/ }).first().click();
  const dialog = page.getByRole("dialog");
  await expect.poll(() => optionRequests.length).toBeGreaterThan(0);
  await page.clock.install({ time: new Date("2026-11-19T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-11-19T12:00:01Z"));
  const beforeRapidEdits = optionRequests.length;
  await dialog.getByLabel("Primeiro mês", { exact: true }).fill("2026-02");
  await dialog.getByLabel("Último mês", { exact: true }).fill("2026-10");
  await dialog.getByLabel("Primeiro mês", { exact: true }).fill("2026-01");
  await page.clock.runFor(299);
  expect(optionRequests.length).toBe(beforeRapidEdits);
  await dialog.getByRole("button", { name: "Fechar", exact: true }).click({ force: true });
  await page.clock.runFor(1000); expect(optionRequests.length).toBe(beforeRapidEdits);
  await page.getByRole("button", { name: /^(Filtros|Consultar filtros)/ }).first().click({ force: true });
  await dialog.getByLabel("Primeiro mês", { exact: true }).fill("2026-01");
  await dialog.getByLabel("Último mês", { exact: true }).fill("2026-10");
  await page.clock.runFor(299); expect(optionRequests.length).toBe(beforeRapidEdits);
  await page.clock.runFor(1); await expect.poll(() => optionRequests.length).toBe(beforeRapidEdits + 1);
  expect(optionRequests.at(-1)?.from).toBe("2026-01"); expect(optionRequests.at(-1)?.to).toBe("2026-10");
  delayOptions = true;
  await dialog.getByLabel("Primeiro mês", { exact: true }).fill("2026-02");
  await page.clock.runFor(300); await expect.poll(() => optionRequests.length).toBe(beforeRapidEdits + 2);
  await dialog.getByRole("button", { name: "Fechar", exact: true }).click({ force: true });
  await expect.poll(() => cancelledOptions).toBe(1); await expect(page.getByRole("alert")).toHaveCount(0);
  delayOptions = false; await page.clock.resume();
  await page.getByRole("button", { name: /^(Filtros|Consultar filtros)/ }).first().click();
  for (const key of ["region", "regional", "state", "manager"] as const) {
    await expect(dialog.locator(`[data-filter-dim="${key}"]`)).toBeVisible();
  }
  const selectDimOption = async (dim: string, optionText: string) => {
    await dialog.locator(`[data-filter-dim="${dim}"]`).click();
    await dialog.locator(".filter-option-row", { hasText: optionText }).locator('input[type="checkbox"]').check();
  };
  await selectDimOption("region", "Representante SINTÉTICO");
  await selectDimOption("regional", "Regional SINTÉTICA");
  await selectDimOption("state", "SP");
  await selectDimOption("manager", "Gerente SINTÉTICO");
  await dialog.getByRole("button", { name: "Aplicar filtros" }).click();
  await expect.poll(() => plans.at(-1)?.filters.manager).toBe("Gerente SINTÉTICO");
  expect(plans.at(-1)?.filters.region).toBe("Representante SINTÉTICO"); expect(plans.at(-1)?.filters.regional).toBe("Regional SINTÉTICA");
  await page.getByLabel(/^Agrupar por/).selectOption("manager");
  await expect.poll(() => plans.at(-1)?.group).toBe("manager");
  await expect(page.getByRole("button", { name: "Grupo SINTÉTICO", exact: true })).toBeVisible();
  await expect(page.getByTitle("Grupo sem valor de filtro")).toHaveText("(Em branco)");
  await expect(page.getByRole("button", { name: "(Em branco)", exact: true })).toHaveCount(0);
  await page.goto(origin + "/equipe"); await page.getByRole("button", { name: /Novo usuário/ }).click();
  await expect(page.getByLabel(/Representantes · um valor por linha/)).toBeVisible();
  await page.goto(origin + "/admin/atualizacao-dados");
  const upload = resolve(artifacts, "SINTETICO-ui.ci.ndjson"); await writeFile(upload, fixturePackage().data);
  await page.getByLabel("Selecionar pacote de atualização Comercial Insight").setInputFiles(upload);
  await page.getByRole("button", { name: "Enviar e atualizar base", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Base atualizada com sucesso" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("status", { name: "Confirmação da atualização" })).toContainText(actor);
  await expect(page.getByText(/^Arquivo recebido por completo/)).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(artifacts, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(artifacts, "mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
} finally { await browser.close(); await new Promise<void>((done) => server.close(() => done())); }
console.log("Native UI contract smoke passed: gross/net/returns, proven dimensions, filter debounce/abort, scope labels, payloads, publication receipt, desktop/mobile. Synthetic API only.");
