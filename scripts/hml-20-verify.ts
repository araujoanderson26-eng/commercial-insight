/**
 * Remote end-to-end verification suite for Commercial Insight 2.0 on HML ONLY.
 * Uses ephemeral session hashes on existing synthetic HML users (cleaned up in finally),
 * NEVER alters passwords/production, and sends ZERO data to OpenAI.
 *
 * Usage:
 *   node --import tsx scripts/hml-20-verify.ts [--batch <uuid>]
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "jsonc-parser";
import { chromium } from "playwright";

const HML_ORIGIN = "https://commercial-insight-hml.araujo-anderson26.workers.dev";
const HML_DB_UUID = "9717c220-a4b4-4fad-8183-f2b733787b61";
const PROD_DB_UUID = "5b333eba-7ace-4182-aa76-0d0f591a4ad6";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getBatchId(argv: string[]): string {
  const idx = argv.indexOf("--batch");
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  const receiptPath = resolve(".wrangler/hml/shadow-batch.json");
  if (existsSync(receiptPath)) {
    const parsed = JSON.parse(readFileSync(receiptPath, "utf8")) as { batchId?: string };
    if (parsed.batchId) return parsed.batchId;
  }
  throw Error("Informe --batch <uuid> ou execute scripts/load-csv-hml-shadow.ts antes.");
}

function assertHmlTarget() {
  const hml = parse(readFileSync("wrangler.hml.jsonc", "utf8")) as {
    name?: string;
    d1_databases?: { database_id?: string }[];
    vars?: { APP_ORIGIN?: string };
  };
  if (
    hml.name !== "commercial-insight-hml" ||
    hml.vars?.APP_ORIGIN !== HML_ORIGIN ||
    hml.d1_databases?.[0]?.database_id !== HML_DB_UUID ||
    hml.d1_databases?.[0]?.database_id === PROD_DB_UUID
  ) {
    throw Error("Alvo diverge de wrangler.hml.jsonc isolado.");
  }
}

function wranglerBin(): string {
  const pkg = JSON.parse(readFileSync("node_modules/wrangler/package.json", "utf8")) as { bin: { wrangler: string } };
  return resolve("node_modules/wrangler", pkg.bin.wrangler);
}

function d1Query<T = Record<string, unknown>>(sql: string): T[] {
  const out = execFileSync(
    process.execPath,
    [wranglerBin(), "d1", "execute", "DB", "--remote", "--config", "wrangler.hml.jsonc", "--json", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return (JSON.parse(out) as { results: T[] }[])[0]?.results ?? [];
}

async function httpApi<T>(
  path: string,
  method: "GET" | "POST" | "PUT" = "GET",
  bodyObj?: unknown,
  cookieSecret?: string,
  expectedStatuses = [200],
): Promise<{ status: number; data: T; headers: Headers; elapsedMs: number }> {
  const headers: Record<string, string> = {
    Origin: HML_ORIGIN,
    ...(bodyObj !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(cookieSecret ? { Cookie: `__Host-ci=${cookieSecret}` } : {}),
  };
  const t0 = performance.now();
  const res = await fetch(`${HML_ORIGIN}/api/${path}`, {
    method,
    headers,
    ...(method !== "GET" && bodyObj !== undefined ? { body: JSON.stringify(bodyObj) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(45000),
  });
  const text = await res.text();
  const elapsedMs = Number((performance.now() - t0).toFixed(1));
  const diag = [res.headers.get("x-hml-diagnostic"), res.headers.get("x-hml-diagnostic-detail")].filter(Boolean).join("/");
  assert.ok(
    expectedStatuses.includes(res.status),
    `${method} /api/${path} -> esperado ${expectedStatuses.join("/")}, recebido ${res.status}${diag ? ` [${diag}]` : ""}: ${text.slice(0, 300)}`,
  );
  return {
    status: res.status,
    data: (text ? JSON.parse(text) : null) as T,
    headers: res.headers,
    elapsedMs,
  };
}

async function runUiSmoke(adminSession: string) {
  let executablePath: string | undefined;
  for (const p of [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ]) {
    if (existsSync(p)) {
      executablePath = p;
      break;
    }
  }
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([
      {
        name: "__Host-ci",
        value: adminSession,
        url: HML_ORIGIN,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);

    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(HML_ORIGIN, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForSelector(".smart-filterbar", { timeout: 20000 });

    // Select synthetic covered period 2026-01..2026-01
    await page.locator(".filterbar-open-btn").click();
    await page.waitForSelector("dialog[open], .filter-sheet, form", { timeout: 10000 });
    const monthInputs = page.locator('input[type="month"]');
    const mCount = await monthInputs.count();
    if (mCount >= 2) {
      await monthInputs.nth(0).fill("2026-01");
      await monthInputs.nth(1).fill("2026-01");
    }
    const applyBtn = page.getByRole("button", { name: /Aplicar|Consultar|Filtrar/i }).first();
    if (await applyBtn.isVisible().catch(() => false)) {
      await applyBtn.click();
    }

    await page.waitForSelector(".smart-chart svg, .recharts-surface, svg", { timeout: 20000 });
    const desktopMetrics = await page.evaluate(() => ({
      svgs: document.querySelectorAll("svg").length,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    assert.equal(desktopMetrics.overflow, false, `Desktop horizontal overflow: ${JSON.stringify(desktopMetrics)}`);
    assert.ok(desktopMetrics.svgs >= 1, "Expected SVG charts rendered on desktop");

    // Toggle Participação % chart mode if present
    const shareBtn = page.getByRole("button", { name: /Participação/i }).first();
    if (await shareBtn.isVisible().catch(() => false)) {
      await shareBtn.click();
      await page.waitForTimeout(300);
    }

    // Mobile 390x844 check + Bottom Sheet
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const mobileMetrics = await page.evaluate(() => ({
      fabVisible: !!document.querySelector(".filter-fab"),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    assert.equal(mobileMetrics.overflow, false, `Mobile 390x844 overflow: ${JSON.stringify(mobileMetrics)}`);
    assert.equal(mobileMetrics.fabVisible, true, "Mobile filter FAB should exist");
    await page.locator(".filter-fab").click();
    await page.waitForSelector("dialog.filter-sheet[open]", { timeout: 10000 });
    await page.getByRole("button", { name: "Fechar" }).click();
    assert.equal(errors.length, 0, `Browser errors on remote HML UI: ${errors.join("; ")}`);

    return { desktopMetrics, mobileMetrics, browserErrors: errors.length };
  } finally {
    await browser.close();
  }
}

async function main() {
  assertHmlTarget();
  const batchId = getBatchId(process.argv.slice(2));
  const createdHashes: string[] = [];

  type DbUserRow = { id: string; role: string; update_only: number; version: number; national: number; regions: string; clients: string };
  const users = d1Query<DbUserRow>(
    "SELECT id, role, update_only, version, national, regions, clients FROM users WHERE active=1",
  );
  const adminUser = users.find((u) => u.role === "admin" && !u.update_only);
  const scopedUser = users.find((u) => (u.role === "comercial" || u.role === "gerente") && !u.update_only);
  const operatorUser = users.find((u) => u.update_only === 1);
  assert.ok(adminUser, "Nenhum admin ativo encontrado em HML.");

  const createSession = (user: DbUserRow) => {
    const token = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(token).digest("hex");
    const nowSec = Math.floor(Date.now() / 1000);
    d1Query(
      `INSERT INTO sessions(hash,user_id,version,expires,seen) VALUES('${hash}','${user.id}',${Number(user.version)},${nowSec + 900},${nowSec})`,
    );
    createdHashes.push(hash);
    return token;
  };

  let trySucceeded = false;
  let cleanupErr: unknown = null;
  try {
    const adminToken = createSession(adminUser);
    const scopedToken = scopedUser ? createSession(scopedUser) : null;
    const operatorToken = operatorUser ? createSession(operatorUser) : null;

    // 1. Anonymous & Root checks
    const rootRes = await fetch(HML_ORIGIN, { signal: AbortSignal.timeout(20000) });
    assert.equal(rootRes.status, 200);
    await httpApi("me", "GET", undefined, undefined, [401]);

    // 2. AI guardrails on HML
    const assistant = await httpApi<{ ready: boolean; pending: string[] }>("assistant/status", "GET", undefined, adminToken);
    assert.equal(assistant.data.ready, false);

    // 3. Validate shadow batch on live HML Worker
    const validateRes = await httpApi<{ passed: boolean; checks: { name: string; status: string }[]; reconciliation: Record<string, number> }>(
      `admin/csv/batches/${batchId}/validate`,
      "POST",
      {},
      adminToken,
    );
    assert.equal(validateRes.data.passed, true, `Validação falhou: ${JSON.stringify(validateRes.data)}`);

    await sleep(2500);

    // 4. Confirm owner-approved reconciliation indicators on HML D1
    const rec = (
      await httpApi<{
        batchId: string;
        status: string;
        mode: string;
        activeBatchId: string | null;
        fileCount: number;
        counts: Record<string, number>;
        ytd2026: Record<string, number>;
        examples: {
          exampleA_suco_vinho_excl_granel_2026: { gross: number; returns: number; net: number };
          exampleB_granel_only_2026: { gross: number };
          exampleC_suco_espumante_sp_2026: { gross: number };
        };
        independentCategories2026: { macroCategory: string; gross: number; returns: number; net: number }[];
        aggConsistency: { grossDeltaScaled: number; returnsDeltaScaled: number };
      }>(`admin/csv/batches/${batchId}/reconcile`, "GET", undefined, adminToken)
    ).data;

    assert.equal(rec.mode, "shadow");
    assert.equal(rec.activeBatchId, null);
    assert.equal(rec.status, "validated");
    assert.equal(rec.fileCount, 20);
    assert.equal(rec.aggConsistency.grossDeltaScaled, 0);
    assert.equal(rec.aggConsistency.returnsDeltaScaled, 0);

    assert.equal(rec.counts.salesRows, 404728);
    assert.equal(rec.counts.returnRows, 19430);
    assert.equal(rec.counts.distinctCustomers, 11097);
    assert.equal(rec.counts.customerConflicts, 0);
    assert.equal(rec.counts.products, 660);
    assert.equal(rec.counts.ordersOpen, 993);
    assert.equal(rec.counts.registeredReps, 150);
    assert.equal(rec.counts.activeReps2026, 98);
    assert.equal(rec.counts.buyers2026, 3538);
    assert.equal(rec.counts.distinctInvoices2026, 18881);
    assert.equal(rec.counts.churnedClientsFullYear2025vs2026, 1351);

    assert.equal(rec.ytd2026.gross, 266288149.1);
    assert.equal(rec.ytd2026.returns, 9525848.54);
    assert.equal(rec.ytd2026.net, 256762300.56);
    assert.equal(rec.ytd2026.prevYtdNet2025, 291854722.41);
    assert.equal(rec.ytd2026.yoyPct, -12.02);
    assert.equal(rec.ytd2026.ticketPerBuyer, 72572.72);
    assert.equal(rec.ytd2026.ticketPerInvoiceNet, 13598.98);
    assert.equal(rec.ytd2026.ticketPerInvoiceGross, 14103.5);

    assert.equal(rec.examples.exampleA_suco_vinho_excl_granel_2026.gross, 137914999.19);
    assert.equal(rec.examples.exampleA_suco_vinho_excl_granel_2026.returns, 5844282.04);
    assert.equal(rec.examples.exampleA_suco_vinho_excl_granel_2026.net, 132070717.15);
    assert.equal(rec.examples.exampleB_granel_only_2026.gross, 39439570.79);
    assert.equal(rec.examples.exampleC_suco_espumante_sp_2026.gross, 17571883.81);

    const macroSet = new Set(rec.independentCategories2026.map((m) => m.macroCategory));
    for (const reqMacro of ["SUCO", "SUCO CONCENTRADO DE UVA", "SUCO CONCENTRADO DE MAÇÃ", "SUCO CONCENTRADO DE LARANJA", "VINHO", "VINHO IMPORTADO", "VINHO GRANEL", "VINAGRE", "VINAGRE GRANEL", "ESPUMANTE"]) {
      assert.ok(macroSet.has(reqMacro), `Macro independente ausente: ${reqMacro}`);
    }

    // Breather after heavy full-batch validate + reconcile scans so D1 10s resource window resets cleanly
    await sleep(3000);

    // 5. Options & Multi-Filters (including independent category checks & conflicts)
    const baseFilters = { from: "2026-01", to: "2026-12", region: "", client: "", product: "" };
    const opts = await httpApi<{ values: { category: string[]; state: string[]; regional: string[]; channel: string[] } }>(
      `admin/csv/batches/${batchId}/options`,
      "POST",
      baseFilters,
      adminToken,
    );
    assert.ok(opts.data.values.category.includes("Macro Categoria: SUCO"));
    assert.ok(opts.data.values.category.includes("Macro Categoria: SUCO CONCENTRADO DE UVA"));
    assert.ok(opts.data.values.category.includes("Macro Categoria: VINHO IMPORTADO"));
    assert.ok(opts.data.values.category.includes("PA - GRANEL"));
    assert.ok(opts.data.values.state.length >= 27);

    // Independent SUCO only vs SUCO CONCENTRADO DE UVA only
    const sucoReport = await httpApi<{ total: { values: { gross: { current: number }; revenue: { current: number } } } }>(
      `admin/csv/batches/${batchId}/report`,
      "POST",
      { group: "month", metric: "revenue", order: "current", filters: { ...baseFilters, categoriesInclude: ["Macro Categoria: SUCO"] } },
      adminToken,
    );
    assert.equal(Number(sucoReport.data.total.values.gross.current.toFixed(2)), 112419733.94);

    const sucoConcUva = await httpApi<{ total: { values: { gross: { current: number }; revenue: { current: number } } } }>(
      `admin/csv/batches/${batchId}/report`,
      "POST",
      { group: "month", metric: "revenue", order: "current", filters: { ...baseFilters, categoriesInclude: ["Macro Categoria: SUCO CONCENTRADO DE UVA"] } },
      adminToken,
    );
    assert.equal(Number(sucoConcUva.data.total.values.gross.current.toFixed(2)), 34312824.73);

    // Multi-select UF + conflict check
    const multiUf = await httpApi<{ total: { values: { revenue: { current: number } } }; filterConflicts?: string[]; rows: unknown[] }>(
      `admin/csv/batches/${batchId}/report`,
      "POST",
      {
        group: "state",
        metric: "revenue",
        order: "current",
        filters: {
          ...baseFilters,
          states: ["SP", "RJ"],
          categoriesInclude: ["PA - GRANEL"],
          categoriesExclude: ["PA - GRANEL"],
        },
      },
      adminToken,
    );
    assert.ok((multiUf.data.filterConflicts?.length ?? 0) >= 1, "Conflict warning expected");

    // 6. Deterministic QA in shadow mode (ZERO OpenAI calls!)
    const askLatencies: Record<string, { ms: number; engine: string; openaiCalls: number }> = {};
    const ask = async (label: string, question: string, expected = [200]) => {
      await sleep(400);
      const r = await httpApi<{
        meta?: { engine: string; latencyMs: number; openaiCalls: number };
        report?: { total: { values: { gross: { current: number }; revenue: { current: number }; returns: { current: number } } }; plan: { group: string } };
        commentary?: { summary: string };
      }>(`admin/csv/batches/${batchId}/ask`, "POST", { question, filters: baseFilters }, adminToken, expected);
      if (r.status === 200 && r.data.meta) {
        assert.equal(r.data.meta.engine, "deterministic");
        assert.equal(r.data.meta.openaiCalls, 0);
        askLatencies[label] = { ms: r.elapsedMs, engine: r.data.meta.engine, openaiCalls: r.data.meta.openaiCalls };
      }
      return r.data;
    };

    const qaClients = await ask("q1_clientes_base", "Quantos clientes distintos existem na base?");
    assert.match(qaClients.commentary!.summary, /11\.097/);

    const qaBuyers = await ask("q2_compradores_2026", "Quantos clientes compraram em 2026?");
    assert.match(qaBuyers.commentary!.summary, /3\.538/);

    const qaReps = await ask("q3_reps_cadastrados", "Quantos representantes existem cadastrados?");
    assert.match(qaReps.commentary!.summary, /150/);

    const qaActiveReps = await ask("q4_reps_ativos", "Quantos representantes tiveram vendas em 2026?");
    assert.match(qaActiveReps.commentary!.summary, /98/);

    const qaNet = await ask("q6_liquido_2026", "Qual foi o faturamento líquido em 2026?");
    assert.equal(Number(qaNet.report!.total.values.revenue.current.toFixed(2)), 256762300.56);

    const qaExA = await ask("q11_suco_vinho_excl_granel", "Quanto faturamos em Suco e Vinho excluindo Granel em 2026?");
    assert.equal(Number(qaExA.report!.total.values.gross.current.toFixed(2)), 137914999.19);
    assert.equal(Number(qaExA.report!.total.values.revenue.current.toFixed(2)), 132070717.15);

    const qaConc = await ask("q_indep_suco_conc_uva", "Quanto faturamos em Suco Concentrado de Uva em 2026?");
    assert.equal(Number(qaConc.report!.total.values.gross.current.toFixed(2)), 34312824.73);

    const qaImp = await ask("q_indep_vinho_importado", "Quanto faturamos em Vinho Importado em 2026?");
    assert.equal(Number(qaImp.report!.total.values.gross.current.toFixed(2)), 12155544.05);

    await ask("q_guard_sucos_importados", "Quanto faturamos em Sucos Importados?", [422]);
    await ask("q_guard_sucos_concentrados", "Quanto faturamos em Sucos Concentrados?", [422]);

    // 7. Existing synthetic HML baseline + Edge Cache + Server-Timing
    const synFilters = { from: "2026-01", to: "2026-01", region: "", client: "", product: "" };
    const synPlan = { group: "month", metric: "revenue", order: "current", filters: synFilters };
    const rMiss = await httpApi<{ total: { values: { revenue: { current: number } } } }>("report", "POST", synPlan, adminToken);
    const rHit = await httpApi<{ total: { values: { revenue: { current: number } } } }>("report", "POST", synPlan, adminToken);
    assert.equal(rMiss.data.total.values.revenue.current, -684);
    assert.equal(rHit.data.total.values.revenue.current, -684);

    // 8. ACL & Role checks on HML
    if (scopedToken) {
      await httpApi("admin/csv/batches", "GET", undefined, scopedToken, [403]);
      await httpApi(`admin/csv/batches/${batchId}/reconcile`, "GET", undefined, scopedToken, [403]);
      await httpApi("report", "POST", { ...synPlan, filters: { ...synFilters, client: "INEXISTENTE_ACL" } }, scopedToken, [403]);
    }
    if (operatorToken) {
      await httpApi("report", "POST", synPlan, operatorToken, [403]);
      await httpApi(`admin/csv/batches/${batchId}/reconcile`, "GET", undefined, operatorToken, [403]);
    }

    // 9. Browser UI & ECharts SVG smoke
    const uiSmoke = await runUiSmoke(adminToken);

    const result = {
      ok: true,
      origin: HML_ORIGIN,
      batchId,
      mode: rec.mode,
      activeBatchId: rec.activeBatchId,
      fileCount: rec.fileCount,
      counts: rec.counts,
      ytd2026: rec.ytd2026,
      examples: rec.examples,
      independentMacroCount: rec.independentCategories2026.length,
      aggConsistency: rec.aggConsistency,
      edgeCache: {
        reportFirst: { cache: rMiss.headers.get("x-cache"), timing: rMiss.headers.get("server-timing"), ms: rMiss.elapsedMs },
        reportSecond: { cache: rHit.headers.get("x-cache"), timing: rHit.headers.get("server-timing"), ms: rHit.elapsedMs },
        sucoFilterMs: sucoReport.elapsedMs,
        multiUfMs: multiUf.elapsedMs,
      },
      askLatencies,
      uiSmoke,
      aclChecked: { scopedChecked: !!scopedToken, operatorChecked: !!operatorToken },
      completedAt: new Date().toISOString(),
    };

    mkdirSync(resolve(".wrangler/hml"), { recursive: true });
    writeFileSync(resolve(".wrangler/hml/hml-20-verification.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify(result, null, 2));
    trySucceeded = true;
  } finally {
    if (createdHashes.length) {
      const list = createdHashes.map((h) => `'${h}'`).join(",");
      let lastErr: unknown;
      let cleaned = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          d1Query(`DELETE FROM sessions WHERE hash IN (${list})`);
          cleaned = true;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < 3) await sleep(4000);
        }
      }
      if (!cleaned) {
        console.error("Falha ao limpar sessões efêmeras da HML:", lastErr);
        if (trySucceeded) cleanupErr = lastErr;
      }
    }
  }
  if (cleanupErr) throw cleanupErr;
}

void main();
