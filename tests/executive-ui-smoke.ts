/** Browser contract tests with synthetic API responses. No business data or external providers. */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { chromium, expect } from "@playwright/test";
import type { Plan, Report, Session } from "../shared/domain";
import type { VisitBriefing } from "../shared/commercial";

const version = "10000000-0000-4000-8000-000000000001";
const capabilities = { metrics: ["revenue", "gross", "returns", "buyers"] as const, groups: ["month", "client", "product", "category"] as const, filters: ["client", "product"] as const, labels: { revenue: "Faturamento líquido" } };
const session: Session = { user: { id: version, name: "Diretor SINTÉTICO", email: "sintetico@example.test", role: "diretoria", national: true, active: true, regions: [], clients: [], entraOid: null }, policyVersion: "synthetic", expires: Math.floor(Date.now() / 1000) + 3600, integrations: { configured: false, mode: "delegated", linked: false, ai: false }, data: { source: "manual", ready: true, activeVersionId: version, extractedAt: "2026-11-19T12:00:00Z", stale: false, capabilities: { ...capabilities, metrics: [...capabilities.metrics], groups: [...capabilities.groups], filters: [...capabilities.filters] } } };
const values = { revenue: { current: 515, previous: -60 }, gross: { current: 600, previous: 80 }, returns: { current: 85, previous: 140 }, buyers: { current: 10, previous: 15 }, margin: { current: null, previous: null } };
function report(plan: Plan): Report {
  return { plan, total: { name: "Total SINTÉTICO", values }, rows: plan.group === "month" ? [{ name: plan.filters.from, values }, { name: plan.filters.to, values }] : [{ key: "000123", name: "000123 — Cliente SINTÉTICO & Filhos", values }], source: "Arquivo manual (D1)", asOf: "2026-11-19T12:00:00Z", truncated: false, sourceInfo: { versionId: version, extractedAt: "2026-11-19T12:00:00Z", sourceUpdatedAt: null, referenceDate: "2026-11-17", coverage: { from: "2025-01-01", to: "2026-11-17" }, capabilities: session.data!.capabilities! } };
}
const plans: Plan[] = [], visits: unknown[] = [], chats: { question: string; conversation: string | null }[] = [];
const saved: { id: string; title: string; plan: Plan }[] = [];
let latestVisit: VisitBriefing | undefined;
const root = resolve("dist"), artifact = resolve(".wrangler/executive-ui");
const mime: Record<string, string> = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part));
    const body = Buffer.concat(chunks).toString(), data = body ? JSON.parse(body) : null;
    const json = (value: unknown) => { response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); };
    if (url.pathname === "/api/me") return json(session);
    if (url.pathname === "/api/report") { plans.push(data); return json(report(data)); }
    if (url.pathname === "/api/saved-reports") {
      if (request.method === "POST") saved.push({ ...data, id: version });
      return json(request.method === "GET" ? saved : saved.at(-1));
    }
    if (url.pathname.startsWith("/api/saved-reports/")) { saved.splice(0); return json({ ok: true }); }
    if (url.pathname === "/api/assistant/status") return json({ source: "manual", enabledForSource: false, credentialConfigured: false, model: "synthetic", ready: false, reason: "source_disabled", pending: ["source_disabled", "credential_missing"], message: "A análise com IA está desabilitada para esta fonte. Solicite a configuração ao administrador." });
    if (url.pathname === "/api/conversations") return json(chats.length ? [{ id: version, title: "Visita SINTÉTICA", updated: Date.now() / 1000 }] : []);
    if (url.pathname.startsWith("/api/conversations/")) return json([{ id: version, question: "Preparar visita SINTÉTICA", plan: latestVisit!.timeline.plan, created: Date.now() / 1000, source_type: "manual" }]);
    if (url.pathname.startsWith("/api/turns/")) return json({ report: latestVisit!.timeline, commentary: { summary: "Resumo SINTÉTICO", actions: [] }, visit: latestVisit });
    if (url.pathname === "/api/data/options") return json({ values: { client: ["000123"], product: ["P01"] }, labels: { client: { "000123": "000123 — Cliente SINTÉTICO & Filhos" }, product: { P01: "P01 — Produto SINTÉTICO" } } });
    if (url.pathname === "/api/data/search") return json({ items: [{ key: "000123", name: "000123 — Cliente SINTÉTICO & Filhos" }, { key: "000124", name: "000124 — Cliente SINTÉTICO Centro" }], truncated: false });
    if (url.pathname === "/api/visit") {
      visits.push(data);
      const plan: Plan = { filters: data, group: "month", metric: "revenue", order: "current" };
      latestVisit = { client: { code: data.client, name: "000123 — Cliente SINTÉTICO & Filhos", municipality: null, states: ["SP"], representatives: ["Representante SINTÉTICO"], regionals: [] }, filters: data, timeline: report(plan), products: report({ ...plan, group: "product" }), productLosses: report({ ...plan, group: "product", order: "decline" }), categories: null, insights: [{ id: "synthetic", kind: "fact", severity: "warning", title: "Base anterior negativa", detail: "Faturamento anterior sintético de -R$ 60,00.", metric: "revenue", impact: 575, period: { from: data.from, to: data.to }, action: "Conferir devoluções do período com o cliente." }], summary: "Resumo SINTÉTICO de preparação de visita.", objectives: ["Conferir o histórico de devoluções."], questions: ["Quais itens precisam ser revisados?"], recommendations: ["Registrar as hipóteses para confirmação na visita."], activity: { lastPurchase: null, lastPurchaseMonth: "2026-10", monthsWithPurchases: 3, monthsAnalyzed: 6, observedProductCount: 1, productCountIsPartial: false }, limitations: ["Estoque e preços não estão disponíveis."], generatedAt: "2026-11-19T12:00:00Z" };
      return json(latestVisit);
    }
    if (url.pathname === "/api/chat") { chats.push(data); return json({ id: version, turn: crypto.randomUUID(), report: report({ filters: data.filters, group: "month", metric: "revenue", order: "current" }), commentary: { summary: "Análise SINTÉTICA", actions: [] }, visit: latestVisit }); }
    if (url.pathname.startsWith("/api/")) return json({});
    let path = resolve(root, "." + decodeURIComponent(url.pathname));
    if (path !== root && !path.startsWith(root + sep)) throw Error("Invalid path");
    if (!extname(path)) path = resolve(root, "index.html");
    const bytes = await readFile(path); response.writeHead(200, { "Content-Type": mime[extname(path)] || "application/octet-stream" }); response.end(bytes);
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address(); if (!address || typeof address === "string") throw Error("Address missing");
const origin = `http://127.0.0.1:${address.port}`;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await mkdir(artifact, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.UI_SMOKE_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "pt-BR" });
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/clientes");
  await expect(page.locator(".kpi-revenue")).toContainText("Base anterior negativa");
  await expect(page.locator(".kpi-revenue .positive")).toHaveCount(0);
  await expect(page.locator(".kpi-revenue")).toContainText("Diferença: +R$");
  await expect(page.locator(".kpi-ticket")).toContainText("R$ 51,50");
  await page.getByRole("button", { name: "000123 — Cliente SINTÉTICO & Filhos", exact: true }).click();
  await expect.poll(() => plans.at(-1)?.filters.client).toBe("000123");
  await page.getByLabel("Agrupar por").selectOption("product");
  await page.getByLabel("Indicador").selectOption("returns");
  await page.getByLabel("Ordenar por").selectOption("decline");
  await expect.poll(() => plans.at(-1)?.order).toBe("decline");
  await page.getByRole("button", { name: "Salvar consulta", exact: true }).click();
  await page.getByLabel("Nome da consulta").fill("Recuperação SINTÉTICA");
  await page.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(page.getByRole("button", { name: "Recuperação SINTÉTICA", exact: true })).toBeVisible();
  await page.getByLabel("Indicador").selectOption("gross");
  await page.getByRole("button", { name: "Recuperação SINTÉTICA", exact: true }).click();
  await expect(page.getByLabel("Indicador")).toHaveValue("returns");
  await expect(page.getByLabel("Ordenar por")).toHaveValue("decline");
  await page.getByRole("button", { name: "Acumulado do ano", exact: true }).click();
  await expect.poll(() => plans.at(-1)?.filters.from).toBe(plans.at(-1)!.filters.to.slice(0, 4) + "-01");
  expect(plans.at(-1)?.filters.client).toBe("000123");
  expect(plans.at(-1)?.metric).toBe("returns"); expect(plans.at(-1)?.order).toBe("decline");
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Exportar Excel", exact: true }).click();
  const download = await downloadEvent; await download.saveAs(resolve(artifact, "relatorio-sintetico.xlsx"));
  expect((await readFile(resolve(artifact, "relatorio-sintetico.xlsx"))).subarray(0, 2).toString()).toBe("PK");
  await page.goto(origin + "/visitas");
  await page.getByLabel("Cliente da visita").fill("Cliente SINTÉTICO");
  await page.getByRole("button", { name: "000123 — Cliente SINTÉTICO & Filhos", exact: true }).click();
  await page.getByRole("button", { name: "Preparar briefing", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Objetivos da reunião", exact: true })).toBeVisible();
  await expect(page.locator(".visit-summary")).toHaveText("Resumo SINTÉTICO de preparação de visita.");
  await expect(page.locator(".visit-facts")).toContainText("2026-10 (mês)");
  expect((visits.at(-1) as { client: string }).client).toBe("000123");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(artifact, "visita-desktop.png"), fullPage: true });
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".sidebar")).not.toBeVisible();
  await expect(page.locator(".visit-selector")).not.toBeVisible();
  await page.pdf({ path: resolve(artifact, "visita-sintetica.pdf"), format: "A4", printBackground: true });
  await page.emulateMedia({ media: "screen" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(artifact, "visita-mobile.png"), fullPage: true });
  await page.goto(origin + "/conversas");
  await expect(page.locator(".assistant-status")).toContainText("desabilitada");
  await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
  await page.getByLabel("Sua pergunta").fill("Vou visitar o cliente 000123. Prepare minha reunião.");
  await page.getByRole("button", { name: "Enviar pergunta", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Objetivos da reunião", exact: true })).toBeVisible();
  await page.getByLabel("Sua pergunta").fill("E quais produtos perderam participação?");
  await page.getByRole("button", { name: "Enviar pergunta", exact: true }).click();
  await expect.poll(() => chats.length).toBe(2); expect(chats[1].conversation).toBe(version);
  await page.getByRole("button", { name: "Histórico", exact: true }).click();
  await page.locator(".thread > button").first().click();
  await page.getByRole("button", { name: "Reabrir valores da versão original", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Objetivos da reunião", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  console.log("Executive UI passed: negative base, code drill, saved query, genuine XLSX download, client disambiguation, visit briefing, PDF print CSS, desktop/mobile overflow, assistant diagnosis and chat continuity. All data SYNTHETIC.");
} catch (error) { await writeFile(resolve(artifact, "failure.txt"), String(error)); throw error; }
finally { await browser?.close(); await new Promise<void>((done) => server.close(() => done())); }
