import {
  change,
  deltaTitle,
  detectFilterConflicts,
  groups,
  metricKeys,
  metrics,
  pretty,
  type Commentary,
  type FilterDimension,
  type Filters,
  type Group,
  type Plan,
  type Report,
  type Row,
} from "../shared/domain";
import { normalizeCsvKey } from "../shared/csv";
import { fail, stmt, type DbUser, type Env } from "./core";
import { routeCommercialIntent } from "./intent-router";
import { resolvePlanEntities, type DataProvider } from "./providers";

const MONETARY_SCALE = 4;
const MONEY_DIV = 10 ** MONETARY_SCALE;

type BatchMetaRow = {
  id: string;
  status: string;
  source_label: string;
  reference_date: string | null;
  coverage_from: string | null;
  coverage_to: string | null;
  file_count: number;
  sales_rows: number;
  return_rows: number;
  customer_rows: number;
  product_rows: number;
  summary_json: string | null;
};

type WhereSpec = {
  joins: string;
  clause: string;
  args: (string | number | null)[];
};

function scopeForUser(u: DbUser, filters?: Filters): {
  allowedRegions: string[];
  allowedClients: string[];
} {
  if (u.role === "operador" || u.update_only) {
    fail(403, "O operador de atualização não tem acesso às análises comerciais.");
  }
  const regions = (JSON.parse(u.regions) as string[]).map((v) => normalizeCsvKey(v)).filter((v): v is string => !!v);
  const clients = (JSON.parse(u.clients) as string[]).map((v) => normalizeCsvKey(v)).filter((v): v is string => !!v);
  const national = u.role === "admin" || (u.role === "diretoria" && !!u.national);
  if (!national && ((u.role === "gerente" && !regions.length) || (!regions.length && !clients.length))) {
    fail(403, "Nenhuma carteira ou regional autorizada.");
  }
  if (!national && filters) {
    const reqRegions = mergeNormalizedKeys(filters.region, filters.regions);
    const reqClients = mergeNormalizedKeys(filters.client, filters.clients);
    if (regions.length && reqRegions.some((r) => !regions.includes(r))) {
      fail(403, "Seleção fora do seu escopo.");
    }
    if (clients.length && reqClients.some((c) => !clients.includes(c))) {
      fail(403, "Seleção fora do seu escopo.");
    }
  }
  return {
    allowedRegions: national ? [] : regions,
    allowedClients: national ? [] : clients,
  };
}

function mergeNormalizedKeys(single?: string, list?: string[]): string[] {
  const out = new Set<string>();
  const add = (val?: string) => {
    const k = normalizeCsvKey(val);
    if (k) out.add(k);
  };
  add(single);
  for (const item of list ?? []) add(item);
  return [...out];
}

function splitCategories(single?: string, list?: string[]): { macros: string[]; groups: string[] } {
  const macros = new Set<string>();
  const grps = new Set<string>();
  const all = [...(single ? [single] : []), ...(list ?? [])];
  for (const raw of all) {
    const trimmed = raw.normalize("NFC").trim();
    if (!trimmed) continue;
    if (trimmed.toLocaleLowerCase("pt-BR").startsWith("macro categoria:")) {
      const k = normalizeCsvKey(trimmed.slice("macro categoria:".length));
      if (k) macros.add(k);
    } else {
      const k = normalizeCsvKey(trimmed);
      if (k) grps.add(k);
    }
  }
  return { macros: [...macros], groups: [...grps] };
}

export function csvComparisonPeriod(
  filters: Pick<Filters, "from" | "to">,
  coverageFrom: string | null,
  coverageTo: string | null,
  referenceDate: string | null,
): NonNullable<Report["comparison"]> {
  const fromDay = `${filters.from}-01`;
  const requestedTo = new Date(Date.UTC(Number(filters.to.slice(0, 4)), Number(filters.to.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10);
  const bounds = [referenceDate, coverageTo].filter((v): v is string => !!v).sort();
  const limit = bounds[0] ?? requestedTo;
  const toDay = requestedTo > limit ? limit : requestedTo;

  const shiftYear = (day: string) => {
    const y = Number(day.slice(0, 4)) - 1;
    const m = Number(day.slice(5, 7));
    const d = Number(day.slice(8, 10));
    return new Date(Date.UTC(y, m - 1, Math.min(d, new Date(Date.UTC(y, m, 0)).getUTCDate())))
      .toISOString()
      .slice(0, 10);
  };

  const current = { from: fromDay, to: toDay };
  const previous = { from: shiftYear(current.from), to: shiftYear(current.to) };
  const outside =
    current.from > current.to ||
    (coverageFrom !== null && (current.from < coverageFrom || previous.from < coverageFrom));

  return {
    current,
    previous,
    status: outside ? "outside-coverage" : toDay !== requestedTo ? "partial" : "comparable",
    ...(outside
      ? { reason: "A cobertura da versão não contém integralmente um dos períodos. Valores fora da cobertura ficam indisponíveis." }
      : toDay !== requestedTo
        ? { reason: "Período incompleto: comparação encerrada no mesmo dia do ano anterior, conforme a última data coberta pela versão." }
        : {}),
  };
}

function buildFactWhere(
  alias: "s" | "r",
  batchId: string,
  filters: Filters,
  acl: { allowedRegions: string[]; allowedClients: string[] },
  dateFrom: string,
  dateTo: string,
  hasCalendar: boolean,
): WhereSpec {
  const clauses: string[] = [`${alias}.batch_id = ?`, `${alias}.date >= ?`, `${alias}.date <= ?`];
  const args: (string | number | null)[] = [batchId, dateFrom, dateTo];

  if (hasCalendar) {
    clauses.push(
      `EXISTS(SELECT 1 FROM ci_dim_calendar cal WHERE cal.batch_id = ${alias}.batch_id AND cal.date = ${alias}.date)`,
    );
  }

  const joins = [
    `LEFT JOIN ci_dim_customers c ON c.batch_id = ${alias}.batch_id AND c.client_key = ${alias}.client_key`,
    `LEFT JOIN ci_dim_products p ON p.batch_id = ${alias}.batch_id AND p.product_key = ${alias}.product_key`,
    `LEFT JOIN ci_dim_regions rg ON rg.batch_id = ${alias}.batch_id AND rg.state_key = ${alias}.state_key`,
  ].join(" ");

  if (acl.allowedRegions.length) {
    clauses.push("c.representative_key IN (SELECT value FROM json_each(?))");
    args.push(JSON.stringify(acl.allowedRegions));
  }
  if (acl.allowedClients.length) {
    clauses.push(`${alias}.client_key IN (SELECT value FROM json_each(?))`);
    args.push(JSON.stringify(acl.allowedClients));
  }

  const reqRegions = mergeNormalizedKeys(filters.region, filters.regions);
  if (reqRegions.length) {
    clauses.push("c.representative_key IN (SELECT value FROM json_each(?))");
    args.push(JSON.stringify(reqRegions));
  }
  const reqClients = mergeNormalizedKeys(filters.client, filters.clients);
  if (reqClients.length) {
    clauses.push(`${alias}.client_key IN (SELECT value FROM json_each(?))`);
    args.push(JSON.stringify(reqClients));
  }
  const reqProducts = mergeNormalizedKeys(filters.product, filters.products);
  if (reqProducts.length) {
    clauses.push(`${alias}.product_key IN (SELECT value FROM json_each(?))`);
    args.push(JSON.stringify(reqProducts));
  }
  const reqStates = mergeNormalizedKeys(filters.state, filters.states);
  if (reqStates.length) {
    clauses.push(`${alias}.state_key IN (SELECT value FROM json_each(?))`);
    args.push(JSON.stringify(reqStates));
  }
  const reqRegionals = mergeNormalizedKeys(filters.regional, filters.regionals);
  if (reqRegionals.length) {
    clauses.push("rg.regional_key IN (SELECT value FROM json_each(?))");
    args.push(JSON.stringify(reqRegionals));
  }
  const reqManagers = mergeNormalizedKeys(filters.manager, filters.managers);
  if (reqManagers.length) {
    clauses.push("rg.manager_key IN (SELECT value FROM json_each(?))");
    args.push(JSON.stringify(reqManagers));
  }
  const reqSegments = mergeNormalizedKeys(undefined, filters.segments);
  if (reqSegments.length) {
    clauses.push("UPPER(TRIM(c.segment)) IN (SELECT value FROM json_each(?))");
    args.push(JSON.stringify(reqSegments));
  }
  const reqBrands = mergeNormalizedKeys(undefined, filters.brands);
  if (reqBrands.length) {
    clauses.push("UPPER(TRIM(p.brand)) IN (SELECT value FROM json_each(?))");
    args.push(JSON.stringify(reqBrands));
  }
  const reqChannels = mergeNormalizedKeys(undefined, filters.channels);
  if (reqChannels.length) {
    if (alias === "s") {
      clauses.push("UPPER(TRIM(s.channel)) IN (SELECT value FROM json_each(?))");
      args.push(JSON.stringify(reqChannels));
    } else {
      clauses.push(
        `EXISTS(SELECT 1 FROM ci_fact_sales fs WHERE fs.batch_id = r.batch_id AND fs.date BETWEEN ? AND ? AND fs.client_key = r.client_key AND UPPER(TRIM(fs.channel)) IN (SELECT value FROM json_each(?)))`,
      );
      args.push(dateFrom, dateTo, JSON.stringify(reqChannels));
    }
  }

  // Strictly independent commercial categories: NEVER auto-group SUCO with SUCO CONCENTRADO*
  // or VINHO with VINHO IMPORTADO / VINHO GRANEL or VINAGRE with VINAGRE GRANEL.
  const inc = splitCategories(filters.category, filters.categoriesInclude);
  const exc = splitCategories(undefined, filters.categoriesExclude);
  const macroExpr = `COALESCE(p.macro_category_key, ${alias}.macro_key)`;

  if (inc.macros.length && inc.groups.length) {
    clauses.push(
      `(${macroExpr} IN (SELECT value FROM json_each(?)) OR ${alias}.group_key IN (SELECT value FROM json_each(?)))`,
    );
    args.push(JSON.stringify(inc.macros), JSON.stringify(inc.groups));
  } else if (inc.macros.length) {
    clauses.push(`${macroExpr} IN (SELECT value FROM json_each(?))`);
    args.push(JSON.stringify(inc.macros));
  } else if (inc.groups.length) {
    clauses.push(`${alias}.group_key IN (SELECT value FROM json_each(?))`);
    args.push(JSON.stringify(inc.groups));
  }

  if (exc.macros.length) {
    clauses.push(`(${macroExpr} IS NULL OR ${macroExpr} NOT IN (SELECT value FROM json_each(?)))`);
    args.push(JSON.stringify(exc.macros));
  }
  if (exc.groups.length) {
    clauses.push(`(${alias}.group_key IS NULL OR ${alias}.group_key NOT IN (SELECT value FROM json_each(?)))`);
    args.push(JSON.stringify(exc.groups));
  }

  return { joins, clause: clauses.join(" AND "), args };
}

function groupExpressions(alias: "s" | "r", group: Exclude<Group, "month">): { keyExpr: string; labelExpr: string } {
  switch (group) {
    case "client":
      return {
        keyExpr: `${alias}.client_key`,
        labelExpr: `COALESCE(MAX(CASE WHEN c.name IS NOT NULL AND c.name <> '' THEN COALESCE(c.client_raw, ${alias}.client_key) || ' — ' || c.name END), MAX(${alias}.client_raw), ${alias}.client_key)`,
      };
    case "product":
      return {
        keyExpr: `${alias}.product_key`,
        labelExpr: `COALESCE(MAX(CASE WHEN p.description IS NOT NULL AND p.description <> '' THEN COALESCE(p.product_raw, ${alias}.product_key) || ' — ' || p.description END), MAX(${alias}.product_raw), ${alias}.product_key)`,
      };
    case "category":
      return {
        keyExpr: `COALESCE(p.macro_category_key, ${alias}.macro_key, ${alias}.group_key)`,
        labelExpr: `COALESCE(MAX(p.macro_category_raw), MAX(p.macro_category_key), MAX(${alias}.macro_key), MAX(${alias}.group_raw), ${alias}.group_key)`,
      };
    case "region":
      return {
        keyExpr: "c.representative_key",
        labelExpr: "COALESCE(MAX(c.representative_raw), c.representative_key)",
      };
    case "regional":
      return {
        keyExpr: "rg.regional_key",
        labelExpr: "COALESCE(MAX(rg.regional_raw), rg.regional_key)",
      };
    case "state":
      return {
        keyExpr: `${alias}.state_key`,
        labelExpr: `${alias}.state_key`,
      };
    case "manager":
      return {
        keyExpr: "rg.manager_key",
        labelExpr: "COALESCE(MAX(rg.manager_raw), rg.manager_key)",
      };
  }
}

async function loadBatchMeta(e: Env, batchId: string): Promise<{ batch: BatchMetaRow; hasCalendar: boolean }> {
  const batch = await stmt(
    e,
    "SELECT id,status,source_label,reference_date,coverage_from,coverage_to,file_count,sales_rows,return_rows,customer_rows,product_rows,summary_json FROM ci_csv_batches WHERE id=?",
    batchId,
  ).first<BatchMetaRow>();
  if (!batch) fail(404, "Lote CSV não encontrado.");
  const cal = await stmt(e, "SELECT 1 AS yes FROM ci_dim_calendar WHERE batch_id=? LIMIT 1", batchId).first<{ yes: number }>();
  return { batch, hasCalendar: !!cal?.yes };
}

export async function searchCsvCategory(
  e: Env,
  batchId: string,
  query: string,
): Promise<{ items: { key: string; name: string }[]; truncated: boolean }> {
  const rows = (
    await stmt(
      e,
      "SELECT dimension, value_key, display FROM ci_dim_catalog WHERE batch_id=? AND dimension IN ('macro_category','group') ORDER BY dimension, value_key",
      batchId,
    ).all<{ dimension: string; value_key: string; display: string }>()
  ).results;

  const q = query.normalize("NFC").trim().toLocaleLowerCase("pt-BR");
  const all = rows.map((r) =>
    r.dimension === "macro_category"
      ? { key: `Macro Categoria: ${r.value_key}`, name: `Macro Categoria: ${r.display || r.value_key}` }
      : { key: r.value_key, name: r.display || r.value_key },
  );
  const filtered = all.filter(
    (item) =>
      item.key.normalize("NFC").toLocaleLowerCase("pt-BR").includes(q) ||
      item.name.normalize("NFC").toLocaleLowerCase("pt-BR").includes(q),
  );
  return { items: filtered.slice(0, 60), truncated: filtered.length > 60 };
}

export async function queryCsvOptions(
  e: Env,
  u: DbUser,
  batchId: string,
  filters?: Filters,
): Promise<{
  values: Partial<Record<FilterDimension | "channel" | "segment" | "brand", string[]>>;
  truncated: Record<string, boolean>;
  batchId: string;
}> {
  const acl = scopeForUser(u, filters);
  await loadBatchMeta(e, batchId);

  const catalog = (
    await stmt(
      e,
      "SELECT dimension, value_key, display FROM ci_dim_catalog WHERE batch_id=? ORDER BY dimension, display",
      batchId,
    ).all<{ dimension: string; value_key: string; display: string }>()
  ).results;

  const pick = (dim: string) => catalog.filter((r) => r.dimension === dim);
  const filterReps = pick("representative")
    .filter((r) => !acl.allowedRegions.length || acl.allowedRegions.includes(r.value_key))
    .map((r) => r.display || r.value_key);

  const macroCats = pick("macro_category").map((r) => `Macro Categoria: ${r.value_key}`);
  const groupCats = pick("group").map((r) => r.display || r.value_key);
  const categories = [...new Set([...macroCats, ...groupCats])].sort((a, b) => a.localeCompare(b, "pt-BR"));

  const states = pick("state").map((r) => r.value_key).sort((a, b) => a.localeCompare(b, "pt-BR"));
  const regionals = pick("regional").map((r) => r.display || r.value_key);
  const managers = pick("manager").map((r) => r.display || r.value_key);
  const channels = pick("channel").map((r) => r.display || r.value_key);
  const segments = pick("segment").map((r) => r.display || r.value_key);
  const brands = pick("brand").map((r) => r.display || r.value_key);

  return {
    batchId,
    values: {
      state: states.slice(0, 250),
      regional: regionals.slice(0, 250),
      manager: managers.slice(0, 250),
      region: filterReps.slice(0, 250),
      category: categories.slice(0, 250),
      client: acl.allowedClients.slice(0, 250),
      product: [],
      channel: channels.slice(0, 250),
      segment: segments.slice(0, 250),
      brand: brands.slice(0, 250),
    },
    truncated: {
      state: states.length > 250,
      regional: regionals.length > 250,
      manager: managers.length > 250,
      region: filterReps.length > 250,
      category: categories.length > 250,
    },
  };
}

export async function queryCsvReport(
  e: Env,
  u: DbUser,
  batchId: string,
  plan: Plan,
): Promise<Report> {
  const acl = scopeForUser(u, plan.filters);
  const { batch, hasCalendar } = await loadBatchMeta(e, batchId);
  const comp = csvComparisonPeriod(plan.filters, batch.coverage_from, batch.coverage_to, batch.reference_date);
  const f = plan.filters;

  const curSalesW = buildFactWhere("s", batchId, f, acl, comp.current.from, comp.current.to, hasCalendar);
  const curRetW = buildFactWhere("r", batchId, f, acl, comp.current.from, comp.current.to, hasCalendar);
  const prevSalesW = buildFactWhere("s", batchId, f, acl, comp.previous.from, comp.previous.to, hasCalendar);
  const prevRetW = buildFactWhere("r", batchId, f, acl, comp.previous.from, comp.previous.to, hasCalendar);

  const [curTotS, curTotR, prevTotS, prevTotR, activeRepsRow] = await Promise.all([
    stmt(
      e,
      `SELECT SUM(s.gross_amount) AS gross, COUNT(*) AS rows_n, COUNT(DISTINCT s.client_key) AS buyers, COUNT(DISTINCT CASE WHEN s.doc_no IS NOT NULL AND s.doc_no<>'' THEN s.doc_no END) AS docs FROM ci_fact_sales s ${curSalesW.joins} WHERE ${curSalesW.clause}`,
      ...curSalesW.args,
    ).first<{ gross: number | null; rows_n: number; buyers: number; docs: number }>(),
    stmt(
      e,
      `SELECT COALESCE(SUM(r.return_amount),0) AS returns FROM ci_fact_returns r ${curRetW.joins} WHERE ${curRetW.clause}`,
      ...curRetW.args,
    ).first<{ returns: number }>(),
    stmt(
      e,
      `SELECT SUM(s.gross_amount) AS gross, COUNT(*) AS rows_n, COUNT(DISTINCT s.client_key) AS buyers FROM ci_fact_sales s ${prevSalesW.joins} WHERE ${prevSalesW.clause}`,
      ...prevSalesW.args,
    ).first<{ gross: number | null; rows_n: number; buyers: number }>(),
    stmt(
      e,
      `SELECT COALESCE(SUM(r.return_amount),0) AS returns FROM ci_fact_returns r ${prevRetW.joins} WHERE ${prevRetW.clause}`,
      ...prevRetW.args,
    ).first<{ returns: number }>(),
    stmt(
      e,
      `SELECT COUNT(DISTINCT c.representative_key) AS n FROM ci_fact_sales s ${curSalesW.joins} WHERE ${curSalesW.clause} AND c.representative_key IS NOT NULL`,
      ...curSalesW.args,
    ).first<{ n: number }>(),
  ]);

  const toPair = (cVal: number | null, pVal: number | null) => ({ current: cVal, previous: pVal });
  const curGross = curTotS?.rows_n ? Number(curTotS.gross ?? 0) / MONEY_DIV : null;
  const prevGross = prevTotS?.rows_n ? Number(prevTotS.gross ?? 0) / MONEY_DIV : null;
  const curRet = curTotR ? Number(curTotR.returns ?? 0) / MONEY_DIV : 0;
  const prevRet = prevTotR ? Number(prevTotR.returns ?? 0) / MONEY_DIV : 0;
  const curRev = curGross !== null || curRet > 0 ? (curGross ?? 0) - curRet : null;
  const prevRev = prevGross !== null || prevRet > 0 ? (prevGross ?? 0) - prevRet : null;
  const curBuyers = curTotS?.rows_n ? curTotS.buyers : null;
  const prevBuyers = prevTotS?.rows_n ? prevTotS.buyers : null;

  const totalRow: Row = {
    name: "Total",
    values: {
      gross: toPair(curGross, prevGross),
      returns: toPair(curRet, prevRet),
      revenue: toPair(curRev, prevRev),
      buyers: toPair(curBuyers, prevBuyers),
      margin: toPair(null, null),
    },
  };

  let rows: Row[] = [];
  if (plan.group === "month") {
    const prevMonthExpr = "(CAST(SUBSTR(month_key,1,4) AS INTEGER)+1) || SUBSTR(month_key,5,3)";
    const [cs, cr, ps, pr] = await Promise.all([
      stmt(
        e,
        `SELECT s.month_key AS g, SUM(s.gross_amount) AS gross, COUNT(DISTINCT s.client_key) AS buyers FROM ci_fact_sales s ${curSalesW.joins} WHERE ${curSalesW.clause} GROUP BY s.month_key`,
        ...curSalesW.args,
      ).all<{ g: string; gross: number; buyers: number }>(),
      stmt(
        e,
        `SELECT r.month_key AS g, SUM(r.return_amount) AS returns FROM ci_fact_returns r ${curRetW.joins} WHERE ${curRetW.clause} GROUP BY r.month_key`,
        ...curRetW.args,
      ).all<{ g: string; returns: number }>(),
      stmt(
        e,
        `SELECT ${prevMonthExpr} AS g, SUM(s.gross_amount) AS gross, COUNT(DISTINCT s.client_key) AS buyers FROM ci_fact_sales s ${prevSalesW.joins} WHERE ${prevSalesW.clause} GROUP BY s.month_key`,
        ...prevSalesW.args,
      ).all<{ g: string; gross: number; buyers: number }>(),
      stmt(
        e,
        `SELECT ${prevMonthExpr} AS g, SUM(r.return_amount) AS returns FROM ci_fact_returns r ${prevRetW.joins} WHERE ${prevRetW.clause} GROUP BY r.month_key`,
        ...prevRetW.args,
      ).all<{ g: string; returns: number }>(),
    ]);

    const mMap = new Map<string, { cg: number | null; cr: number; cb: number | null; pg: number | null; pr: number; pb: number | null }>();
    const touch = (m: string) => {
      let entry = mMap.get(m);
      if (!entry) {
        entry = { cg: null, cr: 0, cb: null, pg: null, pr: 0, pb: null };
        mMap.set(m, entry);
      }
      return entry;
    };
    for (const r of cs.results) {
      const e0 = touch(r.g);
      e0.cg = r.gross / MONEY_DIV;
      e0.cb = r.buyers;
    }
    for (const r of cr.results) touch(r.g).cr = r.returns / MONEY_DIV;
    for (const r of ps.results) {
      const e0 = touch(r.g);
      e0.pg = r.gross / MONEY_DIV;
      e0.pb = r.buyers;
    }
    for (const r of pr.results) touch(r.g).pr = r.returns / MONEY_DIV;

    rows = [...mMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({
        name: month,
        values: {
          gross: toPair(v.cg, v.pg),
          returns: toPair(v.cr, v.pr),
          revenue: toPair(v.cg !== null || v.cr > 0 ? (v.cg ?? 0) - v.cr : null, v.pg !== null || v.pr > 0 ? (v.pg ?? 0) - v.pr : null),
          buyers: toPair(v.cb, v.pb),
          margin: toPair(null, null),
        },
      }));
  } else {
    const sg = groupExpressions("s", plan.group);
    const rg = groupExpressions("r", plan.group);
    const [cs, cr, ps, pr] = await Promise.all([
      stmt(
        e,
        `SELECT ${sg.keyExpr} AS g, ${sg.labelExpr} AS name, SUM(s.gross_amount) AS gross, COUNT(DISTINCT s.client_key) AS buyers FROM ci_fact_sales s ${curSalesW.joins} WHERE ${curSalesW.clause} GROUP BY ${sg.keyExpr}`,
        ...curSalesW.args,
      ).all<{ g: string | null; name: string | null; gross: number; buyers: number }>(),
      stmt(
        e,
        `SELECT ${rg.keyExpr} AS g, ${rg.labelExpr} AS name, SUM(r.return_amount) AS returns FROM ci_fact_returns r ${curRetW.joins} WHERE ${curRetW.clause} GROUP BY ${rg.keyExpr}`,
        ...curRetW.args,
      ).all<{ g: string | null; name: string | null; returns: number }>(),
      stmt(
        e,
        `SELECT ${sg.keyExpr} AS g, ${sg.labelExpr} AS name, SUM(s.gross_amount) AS gross, COUNT(DISTINCT s.client_key) AS buyers FROM ci_fact_sales s ${prevSalesW.joins} WHERE ${prevSalesW.clause} GROUP BY ${sg.keyExpr}`,
        ...prevSalesW.args,
      ).all<{ g: string | null; name: string | null; gross: number; buyers: number }>(),
      stmt(
        e,
        `SELECT ${rg.keyExpr} AS g, ${rg.labelExpr} AS name, SUM(r.return_amount) AS returns FROM ci_fact_returns r ${prevRetW.joins} WHERE ${prevRetW.clause} GROUP BY ${rg.keyExpr}`,
        ...prevRetW.args,
      ).all<{ g: string | null; name: string | null; returns: number }>(),
    ]);

    const gMap = new Map<
      string,
      { key: string | null; name: string; cg: number | null; cr: number; cb: number | null; pg: number | null; pr: number; pb: number | null }
    >();
    const touch = (k: string | null, name: string | null) => {
      const id = k ?? "__NULL__";
      let entry = gMap.get(id);
      if (!entry) {
        entry = { key: k, name: name || k || "(Em branco)", cg: null, cr: 0, cb: null, pg: null, pr: 0, pb: null };
        gMap.set(id, entry);
      }
      return entry;
    };
    for (const r of cs.results) {
      const e0 = touch(r.g, r.name);
      e0.cg = r.gross / MONEY_DIV;
      e0.cb = r.buyers;
    }
    for (const r of cr.results) touch(r.g, r.name).cr = r.returns / MONEY_DIV;
    for (const r of ps.results) {
      const e0 = touch(r.g, r.name);
      e0.pg = r.gross / MONEY_DIV;
      e0.pb = r.buyers;
    }
    for (const r of pr.results) touch(r.g, r.name).pr = r.returns / MONEY_DIV;

    rows = [...gMap.values()].map((v) => ({
      name: v.name,
      ...(v.key === null ? { canDrill: false } : { key: v.key }),
      values: {
        gross: toPair(v.cg, v.pg),
        returns: toPair(v.cr, v.pr),
        revenue: toPair(v.cg !== null || v.cr > 0 ? (v.cg ?? 0) - v.cr : null, v.pg !== null || v.pr > 0 ? (v.pg ?? 0) - v.pr : null),
        buyers: toPair(v.cb, v.pb),
        margin: toPair(null, null),
      },
    }));

    const hasRowFilters = Boolean(
      (f.variationDirection && f.variationDirection !== "all") ||
        f.revenueMin !== undefined ||
        f.revenueMax !== undefined ||
        f.ticketMin !== undefined ||
        f.ticketMax !== undefined,
    );
    if (hasRowFilters) {
      rows = rows.filter((r) => {
        const cur = r.values.revenue.current;
        const prev = r.values.revenue.previous;
        if (f.variationDirection === "growth" && (cur === null || prev === null || cur <= prev)) return false;
        if (f.variationDirection === "decline" && (cur === null || prev === null || cur >= prev)) return false;
        if (f.revenueMin !== undefined && (cur === null || cur < f.revenueMin)) return false;
        if (f.revenueMax !== undefined && (cur === null || cur > f.revenueMax)) return false;
        if (f.ticketMin !== undefined || f.ticketMax !== undefined) {
          const buyers = r.values.buyers.current;
          const tkt = cur !== null && buyers !== null && buyers > 0 ? cur / buyers : null;
          if (f.ticketMin !== undefined && (tkt === null || tkt < f.ticketMin)) return false;
          if (f.ticketMax !== undefined && (tkt === null || tkt > f.ticketMax)) return false;
        }
        return true;
      });
    }

    const score = (r: Row) =>
      plan.order === "current"
        ? (r.values[plan.metric].current ?? -Infinity)
        : (r.values[plan.metric].current ?? 0) - (r.values[plan.metric].previous ?? 0);
    rows.sort((a, b) => (plan.order === "decline" ? 1 : -1) * (score(a) - score(b)) || a.name.localeCompare(b.name, "pt-BR"));
  }

  const conflicts = detectFilterConflicts(f);
  const docs = curTotS?.docs ?? 0;
  const ticketPerBuyer = curRev !== null && curBuyers && curBuyers > 0 ? curRev / curBuyers : null;
  const ticketPerInvoice = curRev !== null && docs > 0 ? curRev / docs : null;

  return {
    total: totalRow,
    rows: rows.slice(0, 30),
    plan,
    asOf: new Date().toISOString(),
    truncated: rows.length > 30,
    source: "Arquivo manual (D1)",
    comparison: comp,
    ...(conflicts.length ? { filterConflicts: conflicts } : {}),
    summaryStats: {
      activeReps: activeRepsRow?.n ?? 0,
      ticketPerBuyer,
      invoiceCount: docs,
      ticketPerInvoice,
    },
    sourceInfo: {
      versionId: batch.id,
      extractedAt: new Date().toISOString(),
      sourceUpdatedAt: null,
      referenceDate: batch.reference_date ?? comp.current.to,
      coverage: {
        from: batch.coverage_from ?? comp.current.from,
        to: batch.coverage_to ?? comp.current.to,
      },
      model: batch.source_label,
    },
  };
}

export async function reconcileCsvBatch(e: Env, batchId: string) {
  const { batch } = await loadBatchMeta(e, batchId);
  const refDate = batch.reference_date || batch.coverage_to || "2026-11-17";
  const prevEnd = (() => {
    const year = Number(refDate.slice(0, 4)) - 1;
    const month = Number(refDate.slice(5, 7));
    const day = Number(refDate.slice(8, 10));
    const clamped = Math.min(day, new Date(Date.UTC(year, month, 0)).getUTCDate());
    return `${year}-${String(month).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
  })();

  const [
    activeRow,
    filesRows,
    sales26,
    ret26,
    sales25,
    ret25,
    repsStats,
    ordersCount,
    exARow,
    exBRow,
    exCRow,
    macros26,
    churnFull,
    churnYtd,
    aggCheck,
  ] = await Promise.all([
    stmt(e, "SELECT active_batch_id,mode FROM ci_csv_active WHERE id=1").first<{ active_batch_id: string | null; mode: string }>(),
    stmt(e, "SELECT role,filename,sha256,bytes,row_count,duplicate_count,rejected_count,status FROM ci_csv_files WHERE batch_id=? ORDER BY role,filename", batchId).all<{
      role: string;
      filename: string;
      sha256: string;
      bytes: number;
      row_count: number;
      duplicate_count: number;
      rejected_count: number;
      status: string;
    }>(),
    stmt(
      e,
      "SELECT COUNT(*) AS rows_n, COALESCE(SUM(gross_amount),0) AS gross, COUNT(DISTINCT client_key) AS buyers, COUNT(DISTINCT CASE WHEN doc_no IS NOT NULL AND doc_no<>'' THEN doc_no END) AS docs FROM ci_fact_sales WHERE batch_id=? AND date BETWEEN '2026-01-01' AND ?",
      batchId,
      refDate,
    ).first<{ rows_n: number; gross: number; buyers: number; docs: number }>(),
    stmt(
      e,
      "SELECT COUNT(*) AS rows_n, COALESCE(SUM(return_amount),0) AS returns FROM ci_fact_returns WHERE batch_id=? AND date BETWEEN '2026-01-01' AND ?",
      batchId,
      refDate,
    ).first<{ rows_n: number; returns: number }>(),
    stmt(
      e,
      "SELECT COALESCE(SUM(gross_amount),0) AS gross FROM ci_fact_sales WHERE batch_id=? AND date BETWEEN '2025-01-01' AND ?",
      batchId,
      prevEnd,
    ).first<{ gross: number }>(),
    stmt(
      e,
      "SELECT COALESCE(SUM(return_amount),0) AS returns FROM ci_fact_returns WHERE batch_id=? AND date BETWEEN '2025-01-01' AND ?",
      batchId,
      prevEnd,
    ).first<{ returns: number }>(),
    stmt(
      e,
      `SELECT
        (SELECT COUNT(DISTINCT representative_key) FROM ci_dim_customers WHERE batch_id=? AND representative_key IS NOT NULL) AS registered,
        (SELECT COUNT(DISTINCT c.representative_key) FROM ci_fact_sales s JOIN ci_dim_customers c ON c.batch_id=s.batch_id AND c.client_key=s.client_key WHERE s.batch_id=? AND s.date BETWEEN '2026-01-01' AND ? AND c.representative_key IS NOT NULL) AS active`,
      batchId,
      batchId,
      refDate,
    ).first<{ registered: number; active: number }>(),
    stmt(e, "SELECT COUNT(*) AS n FROM ci_fact_orders_open WHERE batch_id=?", batchId).first<{ n: number }>(),
    stmt(
      e,
      "SELECT SUM(gross_amount) AS g, SUM(return_amount) AS r, SUM(net_amount) AS n FROM ci_agg_monthly WHERE batch_id=? AND month_key BETWEEN '2026-01' AND '2026-12' AND macro_key IN ('SUCO','VINHO') AND group_key NOT LIKE '%GRANEL%'",
      batchId,
    ).first<{ g: number | null; r: number | null; n: number | null }>(),
    stmt(
      e,
      "SELECT SUM(gross_amount) AS g FROM ci_agg_monthly WHERE batch_id=? AND month_key BETWEEN '2026-01' AND '2026-12' AND group_key LIKE '%GRANEL%'",
      batchId,
    ).first<{ g: number | null }>(),
    stmt(
      e,
      "SELECT SUM(gross_amount) AS g FROM ci_agg_monthly WHERE batch_id=? AND month_key BETWEEN '2026-01' AND '2026-12' AND state_key='SP' AND macro_key IN ('SUCO','ESPUMANTE')",
      batchId,
    ).first<{ g: number | null }>(),
    stmt(
      e,
      "SELECT macro_key, SUM(gross_amount) AS g, SUM(return_amount) AS r, SUM(net_amount) AS n FROM ci_agg_monthly WHERE batch_id=? AND month_key BETWEEN '2026-01' AND '2026-12' GROUP BY macro_key ORDER BY n DESC",
      batchId,
    ).all<{ macro_key: string; g: number; r: number; n: number }>(),
    stmt(
      e,
      "SELECT COUNT(*) AS n FROM (SELECT client_key, SUM(CASE WHEN month_key BETWEEN '2025-01' AND '2025-12' THEN gross_amount ELSE 0 END) AS y25, SUM(CASE WHEN month_key BETWEEN '2026-01' AND '2026-12' THEN gross_amount ELSE 0 END) AS y26 FROM ci_fact_sales WHERE batch_id=? GROUP BY client_key HAVING y25>0 AND y26=0)",
      batchId,
    ).first<{ n: number }>(),
    stmt(
      e,
      "SELECT COUNT(*) AS n FROM (SELECT client_key, SUM(CASE WHEN date BETWEEN '2025-01-01' AND ? THEN gross_amount ELSE 0 END) AS p, SUM(CASE WHEN date BETWEEN '2026-01-01' AND ? THEN gross_amount ELSE 0 END) AS c FROM ci_fact_sales WHERE batch_id=? GROUP BY client_key HAVING p>0 AND c=0)",
      prevEnd,
      refDate,
      batchId,
    ).first<{ n: number }>(),
    stmt(
      e,
      `SELECT
         (SELECT COALESCE(SUM(gross_amount),0) FROM ci_fact_sales WHERE batch_id=?) AS fact_gross,
         (SELECT COALESCE(SUM(return_amount),0) FROM ci_fact_returns WHERE batch_id=?) AS fact_ret,
         (SELECT COALESCE(SUM(gross_amount),0) FROM ci_agg_monthly WHERE batch_id=?) AS agg_gross,
         (SELECT COALESCE(SUM(return_amount),0) FROM ci_agg_monthly WHERE batch_id=?) AS agg_ret`,
      batchId,
      batchId,
      batchId,
      batchId,
    ).first<{ fact_gross: number; fact_ret: number; agg_gross: number; agg_ret: number }>(),
  ]);

  const gross26 = (sales26?.gross ?? 0) / MONEY_DIV;
  const returns26 = (ret26?.returns ?? 0) / MONEY_DIV;
  const net26 = Number((gross26 - returns26).toFixed(2));
  const net25 = Number((((sales25?.gross ?? 0) - (ret25?.returns ?? 0)) / MONEY_DIV).toFixed(2));
  const yoyPct = net25 > 0 ? Number((((net26 - net25) / net25) * 100).toFixed(2)) : null;
  const buyers26 = sales26?.buyers ?? 0;
  const docs26 = sales26?.docs ?? 0;
  const summaryMeta = batch.summary_json ? (JSON.parse(batch.summary_json) as { customerDuplicates?: number; customerConflicts?: string[] }) : {};

  return {
    batchId: batch.id,
    status: batch.status,
    mode: activeRow?.mode ?? "shadow",
    activeBatchId: activeRow?.active_batch_id ?? null,
    coverage: { from: batch.coverage_from, to: batch.coverage_to, referenceDate: refDate, previousEndDate: prevEnd },
    fileCount: filesRows.results.length,
    files: filesRows.results.map((f) => ({
      role: f.role,
      filename: f.filename,
      rows: f.row_count,
      duplicates: f.duplicate_count,
      rejected: f.rejected_count,
      bytes: f.bytes,
      status: f.status,
      sha256Prefix: f.sha256.slice(0, 12),
    })),
    counts: {
      salesRows: batch.sales_rows,
      returnRows: batch.return_rows,
      distinctCustomers: batch.customer_rows,
      customerDuplicatesRemoved: summaryMeta.customerDuplicates ?? 0,
      customerConflicts: summaryMeta.customerConflicts?.length ?? 0,
      products: batch.product_rows,
      ordersOpen: ordersCount?.n ?? 0,
      registeredReps: repsStats?.registered ?? 0,
      activeReps2026: repsStats?.active ?? 0,
      buyers2026: buyers26,
      distinctInvoices2026: docs26,
      churnedClientsFullYear2025vs2026: churnFull?.n ?? 0,
      churnedClientsYtd: churnYtd?.n ?? 0,
    },
    ytd2026: {
      gross: Number(gross26.toFixed(2)),
      returns: Number(returns26.toFixed(2)),
      net: net26,
      prevYtdNet2025: net25,
      yoyPct,
      ticketPerBuyer: buyers26 > 0 ? Number((net26 / buyers26).toFixed(2)) : null,
      ticketPerInvoiceNet: docs26 > 0 ? Number((net26 / docs26).toFixed(2)) : null,
      ticketPerInvoiceGross: docs26 > 0 ? Number((gross26 / docs26).toFixed(2)) : null,
    },
    examples: {
      exampleA_suco_vinho_excl_granel_2026: {
        gross: Number(((exARow?.g ?? 0) / MONEY_DIV).toFixed(2)),
        returns: Number(((exARow?.r ?? 0) / MONEY_DIV).toFixed(2)),
        net: Number(((exARow?.n ?? 0) / MONEY_DIV).toFixed(2)),
      },
      exampleB_granel_only_2026: {
        gross: Number(((exBRow?.g ?? 0) / MONEY_DIV).toFixed(2)),
      },
      exampleC_suco_espumante_sp_2026: {
        gross: Number(((exCRow?.g ?? 0) / MONEY_DIV).toFixed(2)),
      },
    },
    independentCategories2026: macros26.results.map((m) => ({
      macroCategory: m.macro_key || "(Sem macro)",
      gross: Number((m.g / MONEY_DIV).toFixed(2)),
      returns: Number((m.r / MONEY_DIV).toFixed(2)),
      net: Number((m.n / MONEY_DIV).toFixed(2)),
    })),
    aggConsistency: {
      grossDeltaScaled: (aggCheck?.fact_gross ?? 0) - (aggCheck?.agg_gross ?? 0),
      returnsDeltaScaled: (aggCheck?.fact_ret ?? 0) - (aggCheck?.agg_ret ?? 0),
    },
  };
}

export async function askCsvDeterministic(
  e: Env,
  u: DbUser,
  batchId: string,
  question: string,
  activeFilters: Filters,
): Promise<{
  plan: Plan;
  report: Report;
  commentary: Commentary;
  meta: { engine: "deterministic"; latencyMs: number; openaiCalls: 0; mode: "shadow" };
}> {
  const t0 = Date.now();
  const acl = scopeForUser(u, activeFilters);
  const { batch, hasCalendar } = await loadBatchMeta(e, batchId);

  const capabilities: NonNullable<Report["sourceInfo"]>["capabilities"] = {
    metrics: ["gross", "revenue", "returns", "buyers"],
    groups: ["month", "client", "region", "product", "category", "state", "regional", "manager"],
    filters: ["region", "client", "product", "category", "state", "regional", "manager"],
  };

  const intent = routeCommercialIntent(question, activeFilters, capabilities, []);
  if (!intent) {
    fail(422, "Pergunta aberta fora do roteador determinístico; o modo shadow não envia dados reais à OpenAI.");
  }

  const shadowProvider: DataProvider = {
    sourceType: "manual",
    versionId: batchId,
    semantics: {
      allowAI: false,
      measures: { revenue: "Faturamento líquido", gross: "Faturamento bruto", returns: "Devoluções", buyers: "Clientes compradores", margin: null },
      capabilities,
    },
    query: (p) => queryCsvReport(e, u, batchId, p),
    search: (_f, dimension, query) =>
      dimension === "category"
        ? searchCsvCategory(e, batchId, query)
        : Promise.resolve({ items: [], truncated: false }),
  };

  const plan = await resolvePlanEntities(shadowProvider, intent.plan, activeFilters);
  const report = await queryCsvReport(e, u, batchId, plan);
  const comp = report.comparison!;
  const netCurrent = report.total.values.revenue.current;
  const srcNote = `Fonte: Camada CSV estruturada (shadow · base até ${batch.reference_date ?? comp.current.to}). Recorte: ${comp.current.from} a ${comp.current.to} contra ${comp.previous.from} a ${comp.previous.to}.`;

  let commentary: Commentary;
  if (
    intent.kind === "customer_counts" ||
    intent.kind === "buyers_period" ||
    intent.kind === "rep_registered_count" ||
    intent.kind === "rep_active_count"
  ) {
    const custWhere = acl.allowedRegions.length
      ? "representative_key IN (SELECT value FROM json_each(?))"
      : acl.allowedClients.length
        ? "client_key IN (SELECT value FROM json_each(?))"
        : "1=1";
    const custArgs = acl.allowedRegions.length
      ? [JSON.stringify(acl.allowedRegions)]
      : acl.allowedClients.length
        ? [JSON.stringify(acl.allowedClients)]
        : [];
    const regCounts = await stmt(
      e,
      `SELECT COUNT(DISTINCT client_key) AS clients, COUNT(DISTINCT representative_key) AS reps FROM ci_dim_customers WHERE batch_id=? AND ${custWhere}`,
      batchId,
      ...custArgs,
    ).first<{ clients: number; reps: number }>();

    const registeredClients = regCounts?.clients ?? 0;
    const buyingClients = report.total.values.buyers.current ?? 0;
    const registeredReps = regCounts?.reps ?? 0;
    const activeReps = report.summaryStats?.activeReps ?? 0;

    if (intent.kind === "customer_counts") {
      commentary = {
        summary: `Existem ${registeredClients.toLocaleString("pt-BR")} clientes distintos cadastrados na Base Clientes dentro do seu escopo autorizado. No período selecionado, ${buyingClients.toLocaleString("pt-BR")} compraram. ${srcNote}`,
        actions: ["Separar a carteira cadastrada da compradora ativa."],
      };
    } else if (intent.kind === "buyers_period") {
      commentary = {
        summary: `${buyingClients.toLocaleString("pt-BR")} clientes distintos realizaram compras no período selecionado, de ${registeredClients.toLocaleString("pt-BR")} cadastrados. Líquido: ${pretty(netCurrent, "revenue")}. ${srcNote}`,
        actions: ["Comparar evolução de compradores por UF ou regional."],
      };
    } else if (intent.kind === "rep_registered_count") {
      commentary = {
        summary: `Existem ${registeredReps.toLocaleString("pt-BR")} representantes distintos cadastrados no escopo autorizado; ${activeReps.toLocaleString("pt-BR")} tiveram vendas no período. ${srcNote}`,
        actions: ["Revisar representantes cadastrados sem venda no período."],
      };
    } else {
      commentary = {
        summary: `${activeReps.toLocaleString("pt-BR")} representantes distintos tiveram vendas no período selecionado, de ${registeredReps.toLocaleString("pt-BR")} cadastrados. Líquido: ${pretty(netCurrent, "revenue")}. ${srcNote}`,
        actions: ["Consultar ranking de representantes para detalhar expansão."],
      };
    }
  } else if (intent.kind === "churned_clients") {
    const curW = buildFactWhere("s", batchId, plan.filters, acl, comp.current.from, comp.current.to, hasCalendar);
    const prevW = buildFactWhere("s", batchId, plan.filters, acl, comp.previous.from, comp.previous.to, hasCalendar);
    const churnRows = (
      await stmt(
        e,
        `WITH by_c AS (
           SELECT s.client_key,
             SUM(CASE WHEN ${curW.clause} AND s.gross_amount>0 THEN s.gross_amount ELSE 0 END) AS cur_g,
             SUM(CASE WHEN ${prevW.clause} THEN s.gross_amount ELSE 0 END) AS prev_g
           FROM ci_fact_sales s ${curW.joins}
           WHERE s.batch_id=? AND s.client_key IS NOT NULL AND ((s.date BETWEEN ? AND ?) OR (s.date BETWEEN ? AND ?))
           GROUP BY s.client_key
         )
         SELECT client_key, prev_g, (SELECT COUNT(*) FROM by_c WHERE prev_g>0 AND cur_g=0) AS total_churned
         FROM by_c WHERE prev_g>0 AND cur_g=0 ORDER BY prev_g DESC LIMIT 10`,
        ...curW.args,
        ...prevW.args,
        batchId,
        comp.current.from,
        comp.current.to,
        comp.previous.from,
        comp.previous.to,
      ).all<{ client_key: string; prev_g: number; total_churned: number }>()
    ).results;
    const n = churnRows[0]?.total_churned ?? 0;
    commentary = {
      summary: `${n.toLocaleString("pt-BR")} clientes compraram no período homólogo anterior (${comp.previous.from} a ${comp.previous.to}) e zeraram no período atual (${comp.current.from} a ${comp.current.to}). ${srcNote}`,
      actions: ["Priorizar contato com clientes inativados de maior volume histórico."],
    };
  } else if (intent.kind === "category_mix_share") {
    const totalNet = netCurrent ?? 0;
    const denom = totalNet > 0 ? totalNet : report.rows.reduce((a, r) => a + Math.max(0, r.values.revenue.current ?? 0), 0);
    const shares = report.rows
      .slice(0, 8)
      .map((r) => {
        const v = r.values.revenue.current ?? 0;
        const pct = denom > 0 ? (v / denom) * 100 : 0;
        return `${r.name}: ${pretty(v, "revenue")} (${pct.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%)`;
      })
      .join("; ");
    commentary = {
      summary: `Participação sobre o líquido de ${pretty(netCurrent, "revenue")}: ${shares}. ${srcNote}`,
      actions: ["Usar filtros individuais por Macro Categoria ou Grupo Item para isolar linhas independentes."],
    };
  } else if (intent.kind === "category_filtered" || intent.kind === "metric_summary" || intent.kind === "yoy_growth") {
    const m = plan.metric;
    const p = report.total.values[m];
    const diff = p.current !== null && p.previous !== null ? p.current - p.previous : null;
    const pct = change(p, m);
    const filterDesc = [
      plan.filters.state ? `UF ${plan.filters.state}` : "",
      plan.filters.categoriesInclude?.length ? `Incluindo: ${plan.filters.categoriesInclude.join(", ")}` : "",
      plan.filters.categoriesExclude?.length ? `Excluindo: ${plan.filters.categoriesExclude.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    commentary = {
      summary: `${filterDesc ? `[${filterDesc}] ` : ""}${metrics[m].label}: ${pretty(p.current, m)} ante ${pretty(p.previous, m)} (diferença ${diff !== null ? (diff > 0 ? "+" : "") + pretty(diff, m) : "—"}; ${deltaTitle(pct, m)}). Bruto: ${pretty(report.total.values.gross.current, "gross")}, devoluções: ${pretty(report.total.values.returns.current, "returns")}. ${srcNote}`,
      actions: ["Detalhar por categoria, produto, cliente ou UF nos relatórios."],
    };
  } else {
    const top = report.rows
      .slice(0, 5)
      .map((r) => `${r.name}: ${pretty(r.values[plan.metric].current, plan.metric)} vs ${pretty(r.values[plan.metric].previous, plan.metric)}`)
      .join("; ");
    commentary = {
      summary: `Ranking de ${groups[plan.group]}: ${top || "sem registros"}. Total: ${pretty(netCurrent, "revenue")}. ${srcNote}`,
      actions: ["Abrir o ranking completo nos Relatórios."],
    };
  }

  return {
    plan,
    report,
    commentary,
    meta: {
      engine: "deterministic",
      latencyMs: Date.now() - t0,
      openaiCalls: 0,
      mode: "shadow",
    },
  };
}

export { metricKeys };
