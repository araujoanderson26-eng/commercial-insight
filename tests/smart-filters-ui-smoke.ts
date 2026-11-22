/** Browser smoke test for Smart Filters Integrated with Power BI (synthetic API only). */
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium, expect } from "@playwright/test";
import {
  formatOfficialRegionalName,
  normalizeRegionalKey,
  type DataCapabilities,
  type Filters,
  type Plan,
  type Report,
} from "../shared/domain";

const capabilities: DataCapabilities = {
  metrics: ["gross", "revenue", "returns", "buyers"],
  groups: ["month", "client", "region", "product", "category", "state", "regional", "manager"],
  filters: ["region", "client", "product", "category", "state", "regional", "manager"],
  extraFilters: ["municipality", "channel", "brand", "segment", "macroCategory", "itemGroup"],
  labels: {
    revenue: "Faturamento líquido",
    region: "Representante",
    regional: "Regional",
    state: "UF",
    manager: "Gerente Regional",
    municipality: "Município",
    channel: "Canal comercial",
    brand: "Marca",
    segment: "Segmento",
    macroCategory: "Macrocategoria",
    itemGroup: "Grupo do item",
  },
};

type SynRow = {
  regional: string;
  manager: string;
  state: string;
  municipality: string;
  region: string;
  client: string;
  clientName: string;
  segment: string;
  channel: string;
  macro: string;
  group: string;
  brand: string;
  product: string;
  productName: string;
};

const ROWS: SynRow[] = [
  {
    regional: "CENTRO OESTE 1",
    manager: "Alessandro",
    state: "AC",
    municipality: "Rio Branco",
    region: "Rep CO SINTÉTICO",
    client: "C_CO1",
    clientName: "Cliente CO Acre SINTÉTICO",
    segment: "Distribuidor",
    channel: "Clientes Canal Indireto",
    macro: "SUCO CONCENTRADO DE UVA",
    group: "SUCO CONCENTRADO",
    brand: "Panizzon",
    product: "P_CO1",
    productName: "Suco Concentrado Uva SINTÉTICO",
  },
  {
    regional: "CENTRO OESTE 1",
    manager: "Alessandro",
    state: "MS",
    municipality: "Campo Grande",
    region: "Rep CO SINTÉTICO",
    client: "C_CO2",
    clientName: "Cliente CO MS SINTÉTICO",
    segment: "Atacado",
    channel: "Clientes Canal Direto",
    macro: "SUCO",
    group: "PA - SUCO",
    brand: "Panizzon",
    product: "P_SUCO1",
    productName: "Suco Integral Uva SINTÉTICO",
  },
  {
    regional: "CENTRO OESTE 1",
    manager: "Alessandro",
    state: "MT",
    municipality: "Cuiabá",
    region: "Rep CO SINTÉTICO",
    client: "C_CO3",
    clientName: "Cliente CO MT SINTÉTICO",
    segment: "Atacado",
    channel: "Clientes Canal Direto",
    macro: "SUCO",
    group: "PA - SUCO",
    brand: "Panizzon",
    product: "P_SUCO1",
    productName: "Suco Integral Uva SINTÉTICO",
  },
  {
    regional: "CENTRO OESTE 1",
    manager: "Alessandro",
    state: "RO",
    municipality: "Porto Velho",
    region: "Rep CO SINTÉTICO",
    client: "C_CO4",
    clientName: "Cliente CO RO SINTÉTICO",
    segment: "Varejo",
    channel: "Clientes Canal Indireto",
    macro: "ESPUMANTE",
    group: "PA - ESPUMANTE",
    brand: "Panizzon",
    product: "P_ESP1",
    productName: "Espumante Brut SINTÉTICO",
  },
  {
    regional: "SP",
    manager: "Renata",
    state: "SP",
    municipality: "São Paulo",
    region: "Rep SP SINTÉTICO",
    client: "C_SP1",
    clientName: "Cliente SP SINTÉTICO",
    segment: "Varejo",
    channel: "E-Commerce",
    macro: "VINHO",
    group: "PA - VINHO TINTO",
    brand: "Pérgola",
    product: "P_VIN1",
    productName: "Vinho Tinto Seco SINTÉTICO",
  },
  {
    regional: "SUDESTE 1",
    manager: "Fabio",
    state: "RJ",
    municipality: "Niterói",
    region: "Rep SE1 SINTÉTICO",
    client: "C_RJ1",
    clientName: "Cliente RJ SINTÉTICO",
    segment: "B2B",
    channel: "Clientes Canal Direto",
    macro: "VINHO GRANEL",
    group: "PA - GRANEL",
    brand: "Granel House",
    product: "P_GRN1",
    productName: "Vinho Tinto Granel SINTÉTICO",
  },
  {
    regional: "EX",
    manager: "Exportação",
    state: "EX",
    municipality: "Montevideo",
    region: "Rep EX SINTÉTICO",
    client: "C_EX1",
    clientName: "Cliente EX SINTÉTICO",
    segment: "Distribuidor",
    channel: "Clientes Exportação",
    macro: "VINHO IMPORTADO",
    group: "PA - IMPORTADO",
    brand: "Import House",
    product: "P_IMP1",
    productName: "Vinho Importado SINTÉTICO",
  },
];

function computeSyntheticOptions(f: Filters) {
  const norm = (s: string) => s.normalize("NFC").trim().toLocaleUpperCase("pt-BR");
  const merge = (single?: string, list?: string[]) => [
    ...(single?.trim() ? [single.trim()] : []),
    ...(list ?? []),
  ];
  const regInc = merge(f.regional, f.regionals).map((v) => normalizeRegionalKey(v) ?? norm(v));
  const regExc = (f.regionalsExclude ?? []).map((v) => normalizeRegionalKey(v) ?? norm(v));
  const stateInc = merge(f.state, f.states).map(norm);
  const stateExc = (f.statesExclude ?? []).map(norm);
  const mgrInc = merge(f.manager, f.managers).map(norm);
  const mgrExc = (f.managersExclude ?? []).map(norm);
  const repInc = merge(f.region, f.regions).map(norm);
  const segInc = (f.segments ?? []).map(norm);
  const macroInc = (f.categoriesInclude ?? [])
    .filter((v) => v.toLowerCase().startsWith("macro categoria:"))
    .map((v) => norm(v.replace(/^macro categoria:\s*/iu, "")));
  const macroExc = (f.categoriesExclude ?? [])
    .filter((v) => v.toLowerCase().startsWith("macro categoria:"))
    .map((v) => norm(v.replace(/^macro categoria:\s*/iu, "")));

  const matchExcluding = (omit: string) =>
    ROWS.filter((r) => {
      if (omit !== "regional") {
        if (regInc.length && !regInc.includes(r.regional)) return false;
        if (regExc.includes(r.regional)) return false;
      }
      if (omit !== "state") {
        if (stateInc.length && !stateInc.includes(norm(r.state))) return false;
        if (stateExc.includes(norm(r.state))) return false;
      }
      if (omit !== "manager") {
        if (mgrInc.length && !mgrInc.includes(norm(r.manager))) return false;
        if (mgrExc.includes(norm(r.manager))) return false;
      }
      if (omit !== "region" && repInc.length && !repInc.includes(norm(r.region))) return false;
      if (omit !== "segment" && segInc.length && !segInc.includes(norm(r.segment))) return false;
      if (omit !== "macroCategory") {
        if (macroInc.length && !macroInc.includes(norm(r.macro))) return false;
        if (macroExc.includes(norm(r.macro))) return false;
      }
      return true;
    });

  const uniq = (arr: string[]) => [...new Set(arr)].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const regional = uniq(matchExcluding("regional").map((r) => r.regional));
  const manager = uniq(matchExcluding("manager").map((r) => r.manager));
  const state = uniq(matchExcluding("state").map((r) => r.state));
  const region = uniq(matchExcluding("region").map((r) => r.region));
  const municipality = uniq(matchExcluding("municipality").map((r) => r.municipality));
  const client = uniq(matchExcluding("client").map((r) => r.client));
  const product = uniq(matchExcluding("product").map((r) => r.product));
  const segment = uniq(matchExcluding("segment").map((r) => r.segment));
  const channel = uniq(matchExcluding("channel").map((r) => r.channel));
  const brand = uniq(matchExcluding("brand").map((r) => r.brand));
  const macroCategory = uniq(matchExcluding("macroCategory").map((r) => `Macro Categoria: ${r.macro}`));
  const itemGroup = uniq(matchExcluding("itemGroup").map((r) => r.group));

  const incompatible: { dimension: string; values: string[]; labels: string[]; message: string }[] = [];
  const stateSel = merge(f.state, f.states);
  const badStates = stateSel.filter((st) => !state.map(norm).includes(norm(st)));
  if (badStates.length) {
    incompatible.push({
      dimension: "state",
      values: badStates,
      labels: badStates,
      message: `UF: ${badStates.join(", ")} não pertence ao recorte selecionado.`,
    });
  }

  return {
    values: {
      regional,
      manager,
      state,
      municipality,
      region,
      client,
      product,
      segment,
      channel,
      brand,
      macroCategory,
      itemGroup,
      category: [...macroCategory, ...itemGroup],
    },
    labels: {
      regional: Object.fromEntries(regional.map((k) => [k, formatOfficialRegionalName(k)])),
      macroCategory: Object.fromEntries(
        macroCategory.map((k) => [k, k.replace(/^macro categoria:\s*/iu, "")]),
      ),
      client: Object.fromEntries(ROWS.map((r) => [r.client, `${r.client} — ${r.clientName}`])),
      product: {
        ...Object.fromEntries(ROWS.map((r) => [r.product, `${r.product} — ${r.productName}`])),
        P_REG_ZERO: "P_REG_ZERO — Produto Cadastrado Sem Movimento SINTÉTICO",
      },
    },
    registeredProducts: ["P_REG_ZERO"],
    meta: {
      productActiveCount: product.length,
      productRegisteredCount: product.length + 1,
      productHasMoreRegistered: false,
    },
    incompatible,
    sourceVersion: "csv-batch-sintetico-1",
  };
}

const plans: Plan[] = [];
const optionRequests: Filters[] = [];
const root = resolve("dist");
const artifacts = resolve(".wrangler/smart-filters-ui");
const user = {
  id: "10000000-0000-4000-8000-000000000099",
  name: "Gestor SINTÉTICO",
  email: "sintetico@smartfilters.test",
  role: "admin",
  national: true,
  active: true,
  regions: [],
  clients: [],
  entraOid: null,
};
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const json = (data: unknown) => {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(data));
    };

    if (url.pathname === "/api/me") {
      return json({
        user,
        policyVersion: "smart-filters-ui",
        expires: Math.floor(Date.now() / 1000) + 3600,
        integrations: { configured: false, mode: "delegated", linked: false, ai: false },
        data: {
          source: "manual",
          ready: true,
          activeVersionId: "csv-batch-sintetico-1",
          storageEngine: "csv",
          extractedAt: "2026-11-18T12:00:00Z",
          stale: false,
          capabilities,
        },
      });
    }
    if (url.pathname === "/api/data/options") {
      const f = JSON.parse(body.toString()) as Filters;
      optionRequests.push(f);
      return json(computeSyntheticOptions(f));
    }
    if (url.pathname === "/api/data/search") {
      const { dimension, query, filters: searchFilters } = JSON.parse(body.toString()) as {
        dimension: string;
        query: string;
        filters?: Filters;
      };
      const fold = (v: string) =>
        v.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
      const q = fold(query.trim());
      if (dimension === "client") {
        const scopedKeys = searchFilters
          ? new Set(computeSyntheticOptions(searchFilters).values.client)
          : null;
        const seen = new Set<string>();
        const allClients = ROWS.filter((r) => {
          if (seen.has(r.client)) return false;
          seen.add(r.client);
          return !scopedKeys || scopedKeys.has(r.client);
        }).map((r) => ({
          key: r.client,
          name: `${r.client} — ${r.clientName}`,
          hasSalesInPeriod: true,
        }));
        return json({
          items: allClients.filter((i) => fold(i.name).includes(q) || fold(i.key).includes(q)),
          truncated: false,
        });
      }
      if (dimension === "product") {
        const all = [
          ...ROWS.map((r) => ({ key: r.product, name: `${r.product} — ${r.productName}`, hasSalesInPeriod: true })),
          {
            key: "P_REG_ZERO",
            name: "P_REG_ZERO — Produto Cadastrado Sem Movimento SINTÉTICO",
            hasSalesInPeriod: false,
          },
        ];
        return json({ items: all.filter((i) => fold(i.name).includes(q)), truncated: false });
      }
      return json({ items: [], truncated: false });
    }
    if (url.pathname === "/api/report") {
      const plan = JSON.parse(body.toString()) as Plan;
      plans.push(plan);
      const values = {
        gross: { current: 5000, previous: 4200 },
        returns: { current: 150, previous: 120 },
        revenue: { current: 4850, previous: 4080 },
        buyers: { current: 7, previous: 6 },
        margin: { current: null, previous: null },
      };
      const report: Report = {
        plan,
        total: { name: "Total", values },
        rows: [{ name: plan.group === "regional" ? "Centro-Oeste 1" : plan.filters.from, values }],
        source: "Arquivo manual (D1)",
        asOf: "2026-11-18T18:00:00Z",
        truncated: false,
        sourceInfo: {
          versionId: "csv-batch-sintetico-1",
          extractedAt: "2026-11-18T12:00:00Z",
          sourceUpdatedAt: "2026-11-18T10:00:00Z",
          referenceDate: "2026-11-18",
          coverage: { from: "2025-01-01", to: "2026-11-18" },
          capabilities,
        },
      };
      return json(report);
    }
    if (url.pathname.startsWith("/api/")) return json({});

    let path = resolve(root, "." + decodeURIComponent(url.pathname));
    if (path !== root && !path.startsWith(root + sep)) throw Error("Invalid static path");
    if (!extname(path)) path = resolve(root, "index.html");
    const bytes = await readFile(path);
    response.writeHead(200, {
      "Content-Type": mime[extname(path)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(bytes);
  } catch {
    response.writeHead(500);
    response.end("Synthetic Smart Filters UI server failed");
  }
});

await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (!address || typeof address === "string") throw Error("UI address missing");
const origin = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch({
  executablePath:
    process.env.UI_SMOKE_BROWSER ||
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});

try {
  await mkdir(artifacts, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "pt-BR" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(origin + "/relatorios");

  // 0. Painel fechado por padrão, nenhum chip na tela principal e aviso discreto "Consultar filtros"
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".filter-chip")).toHaveCount(0);
  await expect(page.locator(".active-chips")).toHaveCount(0);
  const mainTrigger = page.locator('[data-filter-trigger="main"]');
  await expect(mainTrigger).toContainText("Consultar filtros");

  await mainTrigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Desktop: verificar painel lateral ancorado à direita
  const desktopDrawerBox = await dialog.boundingBox();
  expect(desktopDrawerBox).not.toBeNull();
  expect(desktopDrawerBox!.x + desktopDrawerBox!.width).toBeGreaterThanOrEqual(1430);
  expect(desktopDrawerBox!.height).toBeGreaterThanOrEqual(950);

  // 1. Verificar nomes oficiais de Regional (nunca gerentes) vs Gerente Regional separado
  await dialog.locator('[data-filter-dim="regional"]').click();
  const regionalGroup = dialog.getByRole("group", { name: "Opções de Regional" });
  await expect(regionalGroup).toContainText("Centro-Oeste 1");
  await expect(regionalGroup).toContainText("São Paulo");
  await expect(regionalGroup).toContainText("Sudeste 1");
  await expect(regionalGroup).toContainText("Exportação (EX)");
  await expect(regionalGroup).not.toContainText("Renata");
  await expect(regionalGroup).not.toContainText("Alessandro");
  await expect(regionalGroup).not.toContainText("Fabio");

  await dialog.locator('[data-filter-dim="manager"]').click();
  const mgrGroup = dialog.getByRole("group", { name: "Opções de Gerente Regional" });
  await expect(mgrGroup).toContainText("Alessandro");
  await expect(mgrGroup).toContainText("Renata");
  await dialog.locator('[data-filter-dim="manager"]').click(); // recolhe gerente

  // 2. Cascata: selecionar Centro-Oeste 1 restringe Clientes apenas ao CO1
  await regionalGroup.locator(".filter-option-row", { hasText: "Centro-Oeste 1" }).locator("input").check();
  await dialog.locator('[data-filter-dim="client"]').click();
  const clientGroup = dialog.getByRole("group", { name: "Opções de Cliente" });
  await expect(clientGroup).toContainText("C_CO1");
  await expect(clientGroup).toContainText("C_CO4");
  await expect(clientGroup).not.toContainText("C_SP1");
  await expect(clientGroup).not.toContainText("C_RJ1");
  await expect(clientGroup).not.toContainText("C_EX1");

  // Multi-select regional: adicionar São Paulo amplia Clientes para a união (CO1 + SP)
  await regionalGroup.locator(".filter-option-row", { hasText: "São Paulo" }).locator("input").check();
  await expect(clientGroup).toContainText("C_SP1");
  await expect(clientGroup).toContainText("C_CO1");
  await expect(clientGroup).not.toContainText("C_RJ1");
  await expect(clientGroup).not.toContainText("C_EX1");

  // Multisseleção real de Cliente por pesquisa (código e nome) com checkboxes
  const clientSearch = dialog.getByLabel("Pesquisar Cliente");
  await clientSearch.fill("C_CO1");
  await clientGroup.locator(".filter-option-row", { hasText: "C_CO1" }).locator("input").check();
  await clientSearch.fill("CO MS");
  await expect(clientGroup).toContainText("C_CO2");
  await clientGroup.locator(".filter-option-row", { hasText: "C_CO2" }).locator("input").check();
  await clientSearch.fill("");
  const selectedBox = dialog.locator(".sheet-selected-box");
  await expect(selectedBox).toContainText("C_CO1");
  await expect(selectedBox).toContainText("C_CO2");

  const beforeOpt = optionRequests.length;
  await expect.poll(() => optionRequests.length, { timeout: 2500 }).toBeGreaterThanOrEqual(beforeOpt);

  await dialog.locator('[data-filter-dim="state"]').click();
  const stateGroup = dialog.getByRole("group", { name: "Opções de UF" });
  for (const uf of ["AC", "MS", "MT", "RO", "SP"]) {
    await expect(stateGroup).toContainText(uf);
  }
  await expect(stateGroup).not.toContainText("RJ");
  await expect(stateGroup).not.toContainText("EX");

  // 3. Incompatibilidade automática + correção em 1 clique
  await stateGroup.locator(".filter-option-row", { hasText: "SP" }).locator("input").check();
  await regionalGroup.locator(".filter-option-row", { hasText: "São Paulo" }).locator("input").uncheck();
  const incompBox = dialog.locator(".incompatible-alert");
  await expect(incompBox).toBeVisible({ timeout: 2500 });
  await incompBox.getByRole("button", { name: "Corrigir seleções incompatíveis" }).click();
  await expect(incompBox).toHaveCount(0);

  // 4. Incluir + Excluir com detecção de conflito em Macrocategoria
  await dialog.locator('[data-filter-dim="macroCategory"]').click();
  const macroGroup = dialog.getByRole("group", { name: "Opções de Macrocategoria" });
  await macroGroup.locator(".filter-option-row", { hasText: "SUCO" }).first().locator("input").check();

  const macroCard = dialog.getByRole("region", { name: "Filtro Macrocategoria" });
  await macroCard.getByRole("button", { name: /^Excluir/ }).click();
  await macroGroup.locator(".filter-option-row", { hasText: "SUCO CONCENTRADO DE UVA" }).locator("input").check();

  // Seleciona Segmento, Canal comercial e Produto cadastrado sem venda
  await dialog.locator('[data-filter-dim="segment"]').click();
  await dialog.getByRole("group", { name: "Opções de Segmento" }).locator(".filter-option-row", { hasText: "Atacado" }).locator("input").check();
  await dialog.locator('[data-filter-dim="channel"]').click();
  await dialog.getByRole("group", { name: "Opções de Canal comercial" }).locator(".filter-option-row", { hasText: "Clientes Canal Direto" }).locator("input").check();

  await dialog.locator('[data-filter-dim="product"]').click();
  await dialog.getByLabel(/Mostrar cadastrados sem venda no período/).check();
  const prodGroup = dialog.getByRole("group", { name: "Opções de Produto" });
  await expect(prodGroup).toContainText("P_REG_ZERO");
  await expect(prodGroup).toContainText("Sem venda no período");
  await prodGroup.locator(".filter-option-row", { hasText: "P_SUCO1" }).locator("input").check();

  // Garante painel selecionado visível no topo do drawer para screenshot
  await dialog.locator(".sheet-body").evaluate((el) => el.scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(artifacts, "desktop-drawer-open.png") });

  // 5. Aplicar filtros => fecha automaticamente, preserva filtros aplicados e NÃO exibe chips/valores na tela principal
  await dialog.getByRole("button", { name: "Aplicar filtros" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => (plans.at(-1)?.filters.segments ?? []).includes("Atacado")).toBe(true);
  expect(plans.at(-1)?.filters.clients).toEqual(["C_CO1", "C_CO2"]);

  await expect(mainTrigger).toContainText("Filtros aplicados — Consultar filtros escolhidos");
  await expect(mainTrigger).toContainText("filtros ativos");
  await expect(page.locator(".filter-chip")).toHaveCount(0);
  await expect(page.locator(".active-chips")).toHaveCount(0);
  await expect(page.locator(".chart-active-badge")).toHaveCount(0);
  await expect(page.locator(".report-filter-summary")).not.toBeVisible();

  const barText = await page.locator(".smart-filterbar").innerText();
  for (const forbiddenLeak of ["Centro-Oeste 1", "C_CO1", "C_CO2", "Atacado", "SUCO", "P_SUCO1"]) {
    expect(barText).not.toContain(forbiddenLeak);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(artifacts, "desktop-main-active.png") });

  // 6. Cancelar alterações não descarta filtros anteriormente aplicados
  const plansBeforeCancel = plans.length;
  const activeTextBefore = await mainTrigger.innerText();
  await mainTrigger.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".sheet-selected-box")).toContainText("C_CO1");
  await dialog.getByRole("button", { name: "Limpar tudo" }).click();
  await expect(dialog.locator(".sheet-selected-box")).toContainText("Nenhum filtro específico selecionado");
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  await expect(dialog).toHaveCount(0);
  expect(plans.length).toBe(plansBeforeCancel);
  expect(await mainTrigger.innerText()).toBe(activeTextBefore);

  // Reabrir confirma que os filtros permanecem preservados
  await mainTrigger.click();
  await expect(dialog.locator(".sheet-selected-box")).toContainText("C_CO1");
  await dialog.getByRole("button", { name: "Cancelar" }).click();
  await expect(dialog).toHaveCount(0);

  // 7. Validação Android/Mobile em 390x844 e 360x800 (bottom sheet + overflow zero + sem chips)
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(mainTrigger).toContainText("Filtros aplicados — Consultar filtros escolhidos");
  await expect(page.locator(".filter-chip")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(artifacts, "mobile-main-active.png") });

  await mainTrigger.click();
  await expect(dialog).toBeVisible();
  const mobileSheetBox = await dialog.boundingBox();
  expect(mobileSheetBox).not.toBeNull();
  expect(mobileSheetBox!.y + mobileSheetBox!.height).toBeGreaterThanOrEqual(838);
  expect(mobileSheetBox!.y).toBeGreaterThan(20);
  await dialog.locator('[data-filter-dim="client"]').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(artifacts, "mobile-sheet-open.png") });

  await dialog.getByRole("button", { name: "Cancelar" }).click();
  await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(mainTrigger).toContainText("Filtros aplicados — Consultar filtros escolhidos");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  expect(errors).toEqual([]);
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}

console.log(
  "Smart filters UI smoke passed: official regionals, multi-select cascade, incompatible fix, include/exclude, registered products, compact summary, desktop & Android viewports. Synthetic API only.",
);
