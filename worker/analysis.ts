import {
  metricKeys,
  monthsBetween,
  type Metric,
  type ModelConfig,
  type Plan,
  type Report,
  type Row,
  type User,
} from "../shared/domain";
import { fail, publicUser, type DbUser, type Env } from "./core";
import { access } from "./entra";
const quoted = (v: string) => '"' + v.replaceAll('"', '""') + '"';
const col = (c: { table: string; column: string }) => "'" + c.table + "'[" + c.column + "]";
export function policy(u: User, m: ModelConfig, p: Plan) {
  const national = u.role === "admin" || (u.role === "diretoria" && u.national);
  if (!national) {
    if (!m.scopedMeasuresReviewed)
      fail(
        403,
        "O administrador precisa validar as medidas e os relacionamentos para consultas com escopo restrito.",
      );
    if (u.role === "gerente" && !u.regions.length) fail(403, "Regional ainda não autorizada.");
    if (!u.regions.length && !u.clients.length)
      fail(403, "Nenhuma carteira ou regional autorizada.");
  }
  const filters: string[] = [];
  for (const [dimension, allowed] of [
    ["region", u.regions],
    ["client", u.clients],
    ["product", []],
  ] as const) {
    const request = p.filters[dimension];
    const scoped = !national && allowed.length > 0;
    if (request && scoped && !(allowed as readonly string[]).includes(request))
      fail(403, "Seleção fora do seu escopo.");
    const values = request ? [request] : scoped ? allowed : [];
    if (values.length)
      filters.push(
        "KEEPFILTERS(TREATAS({" +
          values.map(quoted).join(",") +
          "}," +
          col(m.columns[dimension]) +
          "))",
      );
  }
  return filters;
}
function dateParts(ym: string, offset = 0) {
  return [+ym.slice(0, 4) + offset, +ym.slice(5)];
}
function range(m: ModelConfig, from: string, to: string, offset: number) {
  return (
    "DATESBETWEEN(" +
    col(m.columns.date) +
    ",DATE(" +
    dateParts(from, offset).join(",") +
    ",1),EOMONTH(DATE(" +
    dateParts(to, offset).join(",") +
    ",1),0))"
  );
}
function expressions(m: ModelConfig, from: string, to: string) {
  const args: string[] = [];
  for (const metric of metricKeys) {
    for (const [suffix, offset] of [
      ["c", 0],
      ["p", -1],
    ] as const) {
      const measure = m.measures[metric],
        dates = range(m, from, to, offset);
      const visible = "CALCULATE(COUNTROWS('" + m.factTable + "')," + dates + ") > 0";
      const expr = measure
        ? "IF(" + visible + ", CALCULATE([" + measure + "]," + dates + "))"
        : "BLANK()";
      args.push(quoted(metric + "_" + suffix), expr);
    }
  }
  return args.join(", ");
}
export function compile(m: ModelConfig, u: User, p: Plan) {
  const acl = policy(u, m, p),
    { from, to } = p.filters;
  if (!m.measures[p.metric]) fail(422, "Indicador não mapeado no modelo.");
  const total = 'ROW("kind","total","label","Total",' + expressions(m, from, to) + ")";
  let details: string;
  if (p.group === "month") {
    const [year, month] = dateParts(from);
    const rows = [];
    for (let i = 0; i <= monthsBetween(from, to); i++) {
      const ym = new Date(Date.UTC(year, month - 1 + i, 1)).toISOString().slice(0, 7);
      rows.push('ROW("kind","entry","label",' + quoted(ym) + "," + expressions(m, ym, ym) + ")");
    }
    details = rows.join(",\n");
  } else {
    const dim = col(m.columns[p.group]),
      fields = metricKeys
        .flatMap((k) => ["c", "p"].flatMap((t) => [quoted(k + "_" + t), "[" + k + "_" + t + "]"]))
        .join(",");
    const c = "[" + p.metric + "_c]",
      before = "[" + p.metric + "_p]";
    const base = "ADDCOLUMNS(VALUES(" + dim + ")," + expressions(m, from, to) + ")";
    const available =
      "FILTER(" +
      base +
      ",NOT ISBLANK(" +
      dim +
      ") && (NOT ISBLANK(" +
      c +
      ") || NOT ISBLANK(" +
      before +
      ")))";
    const order = p.order === "current" ? c : "COALESCE(" + c + ",0)-COALESCE(" + before + ",0)";
    const top =
      "TOPN(31," +
      available +
      "," +
      order +
      "," +
      (p.order === "decline" ? "ASC" : "DESC") +
      "," +
      dim +
      ",ASC)";
    details = "SELECTCOLUMNS(" + top + ',"kind","entry","label",' + dim + ' & "",' + fields + ")";
  }
  const table = "UNION(" + total + ",\n" + details + ")";
  return "EVALUATE " + (acl.length ? "CALCULATETABLE(" + table + "," + acl.join(",") + ")" : table);
}
function parseRow(raw: Record<string, unknown>, m: ModelConfig): Row {
  const num = (metric: Metric, k: string) => {
    const x = raw["[" + metric + "_" + k + "]"];
    if (x == null) return null;
    if (typeof x !== "number" || !Number.isFinite(x))
      fail(502, "Uma medida retornou texto ou valor inválido. Verifique seu tipo no modelo.");
    return metric === "margin" && m.marginScale === "fraction" ? x * 100 : x;
  };
  return {
    name: String(raw["[label]"] ?? ""),
    values: Object.fromEntries(
      metricKeys.map((k) => [k, { current: num(k, "c"), previous: num(k, "p") }]),
    ) as Row["values"],
  };
}
export function readResult(
  data: {
    error?: unknown;
    results?: {
      error?: unknown;
      tables?: { error?: unknown; rows?: Record<string, unknown>[] }[];
    }[];
  },
  m: ModelConfig,
  p: Plan,
): Report {
  const result = data.results?.[0],
    table = result?.tables?.[0];
  if (data.error || result?.error || table?.error || !table?.rows)
    fail(502, "O Power BI devolveu erro ou um resultado incompleto. Revise o mapeamento.");
  const t = table.rows.find((r) => r["[kind]"] === "total");
  if (!t) fail(502, "A consulta não devolveu os totais.");
  const rows = table.rows.filter((r) => r["[kind]"] === "entry").map((r) => parseRow(r, m));
  if (p.group === "month") rows.sort((a, b) => a.name.localeCompare(b.name));
  else {
    const score = (r: Row) => {
      const a = r.values[p.metric];
      return p.order === "current"
        ? (a.current ?? -Infinity)
        : (a.current ?? 0) - (a.previous ?? 0);
    };
    rows.sort(
      (a, b) =>
        (p.order === "decline" ? 1 : -1) * (score(a) - score(b)) ||
        a.name.localeCompare(b.name, "pt-BR"),
    );
  }
  return {
    total: parseRow(t, m),
    rows: rows.slice(0, 30),
    plan: p,
    asOf: new Date().toISOString(),
    truncated: rows.length > 30,
    source: "Power BI",
  };
}
export async function query(e: Env, m: ModelConfig, rev: number, u: DbUser, p: Plan) {
  const dax = compile(m, publicUser(u), p);
  const t = await access(e, m, rev, u);
  const resp = await fetch(
    "https://api.powerbi.com/v1.0/myorg/groups/" +
      m.workspace +
      "/datasets/" +
      m.dataset +
      "/executeQueries",
    {
      method: "POST",
      headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" },
      body: JSON.stringify({
        queries: [{ query: dax }],
        serializerSettings: { includeNulls: true },
      }),
      signal: AbortSignal.timeout(35000),
    },
  );
  if (!resp.ok) {
    if (resp.status === 429)
      fail(429, "Limite do Power BI atingido. Aguarde e consulte novamente.");
    if ([401, 403].includes(resp.status))
      fail(403, "Power BI recusou o acesso. Revise as permissões de leitura e Build.");
    fail(502, "Falha na consulta ao modelo. Confira workspace, modelo, tabelas e medidas.");
  }
  return readResult(await resp.json(), m, p);
}
