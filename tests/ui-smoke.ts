/** Local-only smoke: real React and Worker, SQLite and private in-memory R2. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import worker from "../worker/index";
import { processManualJobs } from "../worker/manual";
import { passwordHash } from "../shared/password.mjs";
import { makeStore } from "./fixtures";
import { fakeR2, fixturePackage, testFacts } from "./manual-fixtures";

const store = makeStore();
const privateStorage = fakeR2();
const artifactDir = resolve(".wrangler");
const staticRoot = resolve("dist");
const email = "admin@ui-smoke.test";
const password = "Senha sintética somente para smoke local";
const owner = randomUUID();
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript",
  ".css": "text/css", ".png": "image/png", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json", ".md": "text/plain; charset=utf-8", ".zip": "application/zip",
};
Object.assign(store.env, { BUCKET: privateStorage.bucket, MANUAL_ALLOW_SYNTHETIC: "true" });
delete store.env.MS_CLIENT_SECRET;
delete store.env.OPENAI_API_KEY;
store.sql.prepare("INSERT INTO users(id,email,name,password,role,created) VALUES(?,?,?,?,?,unixepoch())")
  .run(owner, email, "Admin de teste local", await passwordHash(password), "admin");
async function assets(request: Request) {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  let candidate = resolve(staticRoot, "." + pathname);
  if (candidate !== staticRoot && !candidate.startsWith(staticRoot + sep)) return new Response("Invalid path", { status: 400 });
  if (!extname(candidate)) candidate = resolve(staticRoot, "index.html");
  try {
    const data = await readFile(candidate);
    return new Response(data, { headers: { "Content-Type": mime[extname(candidate)] || "application/octet-stream", "Cache-Control": "no-store" } });
  } catch {
    return new Response("Asset missing", { status: 404 });
  }
}
store.env.ASSETS = { fetch: assets } as Fetcher;
async function serve(incoming: IncomingMessage, outgoing: ServerResponse) {
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) if (value != null) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const response = await worker.fetch(new Request(store.env.APP_ORIGIN + incoming.url, {
      method: incoming.method, headers, body,
    }), store.env, { waitUntil(job: Promise<unknown>) { void job.catch(() => {}); } } as unknown as ExecutionContext);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.writeHead(500, { "Content-Type": "text/plain" });
    outgoing.end(error instanceof Error ? error.message : "Smoke server failed");
  }
}
const server = createServer((req, res) => { void serve(req, res); });
await new Promise<void>((done, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", done);
});
const address = server.address();
if (!address || typeof address === "string") throw Error("Smoke address missing");
store.env.APP_ORIGIN = `http://127.0.0.1:${address.port}`;
let processing = false;
const timer = setInterval(() => {
  if (processing) return;
  processing = true;
  void processManualJobs(store.env).finally(() => { processing = false; });
}, 100);
const errors: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await mkdir(artifactDir, { recursive: true });
  await readFile(resolve(staticRoot, "index.html"));
  browser = await chromium.launch({
    executablePath: process.env.UI_SMOKE_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "pt-BR" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(store.env.APP_ORIGIN + "/admin/atualizacao-dados");
  await page.getByLabel("E-mail corporativo").fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "Entrar no Comercial Insight" }).click();
  await expect(page.getByRole("button", { name: "Equipe e permissões", exact: true })).toBeVisible({ timeout: 15000 });
  // The login may normalize the initial path; explicitly exercise the admin deep link.
  await page.goto(store.env.APP_ORIGIN + "/admin/atualizacao-dados");
  await expect(page.getByRole("heading", { name: "Atualização de dados", exact: true })).toBeVisible();
  await page.getByLabel("Fonte selecionada").selectOption("manual");
  await page.getByRole("button", { name: "Salvar configuração" }).click();
  await expect(page.getByText("Configuração da fonte salva.", { exact: true })).toBeVisible();
  await expect(page.getByText("Nenhuma versão manual publicada", { exact: true })).toBeVisible();

  async function upload(name: string, pkg: ReturnType<typeof fixturePackage>) {
    const path = resolve(artifactDir, name);
    await writeFile(path, pkg.data);
    await page.getByLabel("Selecionar pacote de atualização Comercial Insight").setInputFiles(path);
    await expect(page.getByRole("button", { name: "Enviar e atualizar base", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Enviar e atualizar base", exact: true }).click();
    await expect.poll(() => store.sql.prepare("SELECT status FROM ci_imports WHERE filename=? ORDER BY seq DESC LIMIT 1").get(name)?.status, { timeout: 25000 })
      .toMatch(/published|failed/);
    return store.sql.prepare("SELECT id,status,error FROM ci_imports WHERE filename=? ORDER BY seq DESC LIMIT 1").get(name)!;
  }
  const first = await upload("ui-SINTETICO-primeiro.ci.ndjson", fixturePackage());
  expect(first.status, String(first.error ?? "")).toBe("published");
  await expect(page.locator(".du-version dd")).toHaveText(String(first.id), { timeout: 15000 });
  await expect(page.locator(".du-metadata").getByText("1 tabelas · 4 linhas", { exact: true })).toBeVisible();
  const modified = testFacts.map((fact) => ({
    ...fact, values: { revenue: fact.date.startsWith("2026") && fact.region === "Sul" ? "45.25" : fact.values.revenue },
  }));
  const second = await upload("ui-SINTETICO-segundo.ci.ndjson", fixturePackage(modified));
  expect(second.status, String(second.error ?? "")).toBe("published");
  await expect(page.locator(".du-version dd")).toHaveText(String(second.id), { timeout: 15000 });
  const firstHistory = page.locator(".du-history-item").filter({ has: page.getByText("ui-SINTETICO-primeiro.ci.ndjson", { exact: true }) });
  await firstHistory.getByRole("button", { name: "Restaurar esta versão" }).click();
  await expect(page.locator(".du-version dd")).toHaveText(String(first.id), { timeout: 15000 });
  expect(store.sql.prepare("SELECT active_version_id FROM ci_sources").get()!.active_version_id).toBe(first.id);
  await firstHistory.getByRole("button", { name: "Validações e detalhes" }).click();
  await expect(firstHistory.getByText(/controles DAX reconciliados/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(artifactDir, "ui-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Atualização de dados", exact: true })).toBeVisible();
  await expect(page.locator(".du-version dd")).toHaveText(String(first.id));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(artifactDir, "ui-mobile.png"), fullPage: true });
  const invalid = fixturePackage(testFacts, (manifest) => { manifest.controls[0].expected = "99999999"; });
  const rejected = await upload("ui-SINTETICO-invalido.ci.ndjson", invalid);
  expect(rejected.status).toBe("failed");
  expect(store.sql.prepare("SELECT active_version_id FROM ci_sources").get()!.active_version_id).toBe(first.id);
  const failedHistory = page.locator(".du-history-item").filter({ has: page.getByText("ui-SINTETICO-invalido.ci.ndjson", { exact: true }) });
  await expect(failedHistory.getByText(/Divergência em controle DAX essencial/)).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".du-version dd")).toHaveText(String(first.id));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  console.log("UI smoke passed: own login, admin deep link, manual source, 2 uploads, reconciled publication, rollback, rejected KPI, desktop/mobile layout.");
  console.log("Screenshots: .wrangler/ui-desktop.png and .wrangler/ui-mobile.png (synthetic local test only).");
} catch (error) {
  console.error("UI smoke failed:", error);
  if (browser?.contexts()[0]?.pages()[0]) await browser.contexts()[0].pages()[0].screenshot({ path: resolve(artifactDir, "ui-failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  clearInterval(timer);
  await browser?.close();
  await new Promise<void>((done) => server.close(() => done()));
  // Allow the bounded local driver to finish before closing SQLite.
  while (processing) await new Promise<void>((done) => setTimeout(done, 10));
  store.sql.close();
}
