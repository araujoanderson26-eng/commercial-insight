/** Multi-resolution mobile & tablet UI smoke test using built dist/ and synthetic API responses. */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { chromium, expect } from "@playwright/test";
import type { Plan, Report, Session } from "../shared/domain";
import type { VisitBriefing } from "../shared/commercial";

const version = "20000000-0000-4000-8000-000000000002";
const capabilities = {
  metrics: ["gross", "revenue", "returns", "buyers"] as const,
  groups: ["month", "client", "product", "category", "region", "state", "regional", "manager"] as const,
  filters: ["region", "client", "product", "category", "state", "regional", "manager"] as const,
  labels: {
    revenue: "Faturamento líquido",
    region: "Representante",
    regional: "Regional",
    state: "UF",
    manager: "Gerente",
  },
};

const user = {
  id: version,
  name: "Gestor Mobile SINTÉTICO",
  email: "mobile@synthetic.test",
  role: "diretoria" as const,
  national: true,
  active: true,
  regions: [],
  clients: [],
  entraOid: null,
};

let loggedIn = false;
const plans: Plan[] = [];
const values = {
  revenue: { current: 12450.5, previous: 11200.25 },
  gross: { current: 13200.0, previous: 11900.0 },
  returns: { current: 749.5, previous: 699.75 },
  buyers: { current: 42, previous: 38 },
  margin: { current: null, previous: null },
};

function makeReport(plan: Plan): Report {
  return {
    plan,
    total: { name: "Total SINTÉTICO", values },
    rows:
      plan.group === "month"
        ? [
            { name: plan.filters.from, values },
            { name: plan.filters.to, values },
          ]
        : [
            { key: "000101", name: "000101 — Cliente Exemplo Mobile", values },
            { key: "000102", name: "000102 — Distribuidora Sul Exemplo", values },
          ],
    source: "Arquivo manual (D1)",
    asOf: "2026-11-20T18:00:00Z",
    truncated: false,
    sourceInfo: {
      versionId: version,
      extractedAt: "2026-11-20T18:00:00Z",
      sourceUpdatedAt: null,
      referenceDate: "2026-11-17",
      coverage: { from: "2025-01-01", to: "2026-11-17" },
      model: "Synthetic Mobile Suite",
      capabilities: {
        metrics: [...capabilities.metrics],
        groups: [...capabilities.groups],
        filters: [...capabilities.filters],
        labels: capabilities.labels,
      },
    },
  };
}

const root = resolve("dist");
const artifactDir = resolve(".wrangler/mobile-ui");
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const bodyText = Buffer.concat(chunks).toString();
    const body = bodyText ? JSON.parse(bodyText) : null;
    const json = (data: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(data));
    };

    if (url.pathname === "/api/auth/login") {
      loggedIn = true;
      return json({ ok: true, expires: Math.floor(Date.now() / 1000) + 28800 });
    }
    if (url.pathname === "/api/auth/logout") {
      loggedIn = false;
      return json({ ok: true });
    }
    if (url.pathname === "/api/me") {
      if (!loggedIn) return json({ error: "Entre para continuar." }, 401);
      const session: Session = {
        user,
        policyVersion: "synthetic-mobile",
        expires: Math.floor(Date.now() / 1000) + 28800,
        integrations: { configured: false, mode: "delegated", linked: false, ai: false },
        data: {
          source: "manual",
          ready: true,
          activeVersionId: version,
          extractedAt: "2026-11-20T18:00:00Z",
          referenceDate: "2026-11-17",
          model: "Synthetic CSV Mobile",
          storageEngine: "csv",
          stale: false,
          capabilities: {
            metrics: [...capabilities.metrics],
            groups: [...capabilities.groups],
            filters: [...capabilities.filters],
            labels: capabilities.labels,
          },
        },
      };
      return json(session);
    }
    if (url.pathname === "/api/report") {
      plans.push(body as Plan);
      return json(makeReport(body as Plan));
    }
    if (url.pathname === "/api/data/options") {
      return json({
        values: {
          region: ["Rep Alfa", "Rep Beta"],
          client: ["000101", "000102"],
          product: ["P001", "P002"],
          category: ["Macro Categoria: SUCO", "Macro Categoria: VINHO", "PA - GRANEL"],
          state: ["SP", "RS"],
          regional: ["Sudeste", "Sul"],
          manager: ["Gerente A"],
        },
        labels: {
          client: { "000101": "000101 — Cliente Exemplo Mobile", "000102": "000102 — Distribuidora Sul Exemplo" },
          product: { P001: "P001 — Suco Uva Integral", P002: "P002 — Vinho Tinto Seco" },
        },
      });
    }
    if (url.pathname === "/api/data/search") {
      return json({
        items: [{ key: "000101", name: "000101 — Cliente Exemplo Mobile" }],
        truncated: false,
      });
    }
    if (url.pathname === "/api/visit") {
      const filters = body;
      const basePlan: Plan = { filters, group: "month", metric: "revenue", order: "current" };
      const briefing: VisitBriefing = {
        client: {
          code: filters.client || "000101",
          name: "000101 — Cliente Exemplo Mobile",
          municipality: "São Paulo",
          states: ["SP"],
          representatives: ["Rep Alfa"],
          regionals: ["Sudeste"],
        },
        filters,
        timeline: makeReport(basePlan),
        products: makeReport({ ...basePlan, group: "product" }),
        productLosses: makeReport({ ...basePlan, group: "product", order: "decline" }),
        categories: makeReport({ ...basePlan, group: "category" }),
        insights: [
          {
            id: "i1",
            kind: "fact",
            severity: "favorable",
            title: "Crescimento em Suco Integral",
            detail: "Alta de 11,16% sobre o período homólogo anterior.",
            metric: "revenue",
            impact: 1250.25,
            period: { from: filters.from, to: filters.to },
            action: "Reforçar reposição de mix para o próximo trimestre.",
          },
        ],
        summary: "Cliente em expansão consistente com foco em Suco e Vinho.",
        objectives: ["Consolidar linhas de maior giro."],
        questions: ["Como está a cobertura nos PDVs de São Paulo?"],
        recommendations: ["Apresentar campanha sazonal."],
        activity: {
          lastPurchase: "2026-11-15",
          lastPurchaseMonth: "2026-11",
          purchaseDays: 14,
          monthsWithPurchases: 6,
          monthsAnalyzed: 6,
          observedProductCount: 2,
          productCountIsPartial: false,
        },
        limitations: ["Estoque do cliente não disponível nesta base."],
        generatedAt: "2026-11-20T18:00:00Z",
      };
      return json(briefing);
    }
    if (url.pathname === "/api/assistant/status") {
      return json({
        source: "manual",
        enabledForSource: true,
        credentialConfigured: true,
        model: "gpt-4.1-mini-2025-04-14",
        ready: false,
        reason: "credits_unverified",
        pending: ["credits_unverified"],
        message: "Créditos disponíveis aguardam verificação.",
        deterministic: {
          ready: true,
          source: "csv",
          message: "Consultas comerciais diretas disponíveis na base CSV estruturada (D1), sem uso de créditos OpenAI.",
        },
        advancedAI: {
          ready: false,
          reason: "credits_unverified",
          message: "Créditos disponíveis aguardam verificação.",
        },
      });
    }
    if (url.pathname === "/api/conversations") return json([]);
    if (url.pathname === "/api/chat") {
      const filters = body.filters;
      const p: Plan = { filters, group: "month", metric: "revenue", order: "current" };
      return json({
        id: version,
        turn: crypto.randomUUID(),
        report: makeReport(p),
        commentary: {
          summary: "Faturamento líquido no recorte: R$ 12.450,50 (+11,16% ante R$ 11.200,25).",
          actions: ["Detalhar por cliente."],
        },
        meta: { engine: "deterministic", latencyMs: 12, openaiCalls: 0 },
      });
    }
    if (url.pathname.startsWith("/api/")) return json({});

    let path = resolve(root, "." + decodeURIComponent(url.pathname));
    if (path !== root && !path.startsWith(root + sep)) throw Error("Invalid path");
    if (!extname(path)) path = resolve(root, "index.html");
    const fileBytes = await readFile(path);
    res.writeHead(200, { "Content-Type": mime[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(fileBytes);
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
});

await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const addr = server.address();
if (!addr || typeof addr === "string") throw Error("Missing address");
const origin = `http://127.0.0.1:${addr.port}`;

const viewports = [
  { name: "android-compact-360x800", width: 360, height: 800 },
  { name: "iphone-390x844", width: 390, height: 844 },
  { name: "iphone-promax-430x932", width: 430, height: 932 },
  { name: "tablet-768x1024", width: 768, height: 1024 },
];

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await mkdir(artifactDir, { recursive: true });
  browser = await chromium.launch({
    executablePath: process.env.UI_SMOKE_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });

  for (const vp of viewports) {
    loggedIn = false;
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      locale: "pt-BR",
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    const assertNoOverflow = async (screen: string) => {
      const fits = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      );
      expect(fits, `Horizontal overflow on ${vp.name} (${screen})`).toBe(true);
    };

    // 1. Login flow
    await page.goto(origin);
    await page.getByLabel("E-mail corporativo").fill("mobile@synthetic.test");
    await page.locator('input[type="password"]').fill("Senha Sintética Mobile 2026");
    await page.getByRole("button", { name: "Entrar no Comercial Insight" }).click();
    await expect(page.locator(".kpi-revenue")).toBeVisible({ timeout: 15000 });
    await assertNoOverflow("home");

    // Verify ECharts fits viewport without clipping
    await expect
      .poll(() =>
        page.locator(".chart svg").first().evaluate((svg) => {
          const rect = svg.getBoundingClientRect();
          return rect.width > 0 && rect.width <= (svg.parentElement?.clientWidth ?? rect.width) + 4;
        }),
      )
      .toBe(true);

    // 2. Open Filter modal & apply multi-category filter on narrow viewport
    if (vp.width <= 760) {
      await page.getByRole("button", { name: /^Filtros/ }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(/Incluir/i).first().check().catch(() => {});
      await dialog.getByRole("button", { name: "Aplicar filtros" }).click();
      await assertNoOverflow("after-filters");
    }

    // 3. Navigate via mobile/desktop navigation to Reports, Clientes, Produtos and validate Excel + PDF preview
    if (vp.width <= 760) {
      await page.locator(".mobilebar").getByRole("button", { name: "Relatórios" }).click();
    } else {
      await page.locator(".sidebar").getByRole("button", { name: "Relatórios" }).click();
    }
    await expect(page.locator(".kpis")).toBeVisible();
    await assertNoOverflow("relatorios");
    const dlPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exportar Excel", exact: true }).click();
    const dl = await dlPromise;
    const dlPath = await dl.path();
    expect(dlPath).toBeTruthy();
    if (dlPath) {
      const bytes = await readFile(dlPath);
      expect(bytes.subarray(0, 2).toString()).toBe("PK");
    }

    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Imprimir / PDF", exact: true }).click();
    const printPopup = await popupPromise;
    await printPopup.waitForLoadState("domcontentloaded");
    await expect(printPopup.locator("h1")).toContainText("Relatório Comercial");
    await printPopup.close();

    // Check Clientes, Produtos & Representantes grouping
    if (vp.width <= 760) {
      await page.locator(".mobilebar").getByRole("button", { name: "Clientes" }).click();
    } else {
      await page.locator(".sidebar").getByRole("button", { name: "Clientes" }).click();
    }
    await expect(page.locator(".kpis")).toBeVisible();
    await assertNoOverflow("clientes");

    if (vp.width <= 760) {
      await page.locator(".mobilebar").getByRole("button", { name: "Mais" }).click();
      await page.locator(".moremenu").getByRole("button", { name: "Produtos e mix" }).click();
    } else {
      await page.locator(".sidebar").getByRole("button", { name: "Produtos e mix" }).click();
    }
    await expect(page.locator(".kpis")).toBeVisible();
    await assertNoOverflow("produtos");

    // 4. Visits briefing (select disambiguated client item before submitting)
    if (vp.width <= 760) {
      await page.locator(".mobilebar").getByRole("button", { name: "Mais" }).click();
      await page.locator(".moremenu").getByRole("button", { name: "Preparar visita" }).click();
    } else {
      await page.locator(".sidebar").getByRole("button", { name: "Preparar visita" }).click();
    }
    await page.getByLabel("Cliente da visita").fill("000101");
    await page.getByRole("button", { name: "000101 — Cliente Exemplo Mobile", exact: true }).click();
    await page.getByRole("button", { name: "Preparar briefing", exact: true }).click();
    await expect(page.locator(".visit-overview")).toBeVisible();
    await assertNoOverflow("visitas");

    // 5. Chat two-mode banner + deterministic response
    if (vp.width <= 760) {
      await page.locator(".mobilebar").getByRole("button", { name: "Conversas" }).click();
    } else {
      await page.locator(".sidebar").getByRole("button", { name: "Conversas" }).click();
    }
    await expect(page.locator(".assistant-status")).toContainText("Consultas comerciais");
    await expect(page.locator(".assistant-status")).toContainText("Disponíveis");
    await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
    await page.getByLabel("Sua pergunta").fill("Quanto faturamos em 2026?");
    await page.getByRole("button", { name: "Enviar pergunta", exact: true }).click();
    await expect(page.locator(".aibox")).toContainText("12.450,50");
    await assertNoOverflow("conversas");

    // 6. Offline status notice & Logout
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(page.locator(".net").first()).toContainText("Sem conexão");
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    await page.goto(origin + "/perfil");
    await assertNoOverflow("perfil");
    await page.getByRole("button", { name: "Sair da conta" }).click();
    await expect(page.getByRole("button", { name: "Entrar no Comercial Insight" })).toBeVisible();

    expect(errors, `Page errors on ${vp.name}`).toEqual([]);
    await context.close();
  }

  console.log(
    `Mobile UI smoke passed cleanly across ${viewports.map((v) => v.name).join(", ")} (browser viewports only).`,
  );
} finally {
  if (browser) await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
