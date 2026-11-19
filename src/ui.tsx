import {
  ArrowDownRight,
  ArrowUpRight,
  ChartNoAxesCombined,
  ChevronRight,
  Database,
  Info,
  LoaderCircle,
  Sparkles,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  change,
  deltaTitle,
  groups,
  metricKeys,
  metrics,
  pretty,
  type Filters,
  type Metric,
  type Plan,
  type Report,
  type DataCapabilities,
  type Group,
  type Session,
  type Pair,
} from "../shared/domain";
const legacyGroups: Group[] = ["month", "client", "region", "product", "category"];
const legacyMetrics: Metric[] = ["revenue", "margin", "buyers", "returns"];
export function sessionCapabilities(session: Session): DataCapabilities {
  return session.data?.source === "manual" && session.data.capabilities
    ? session.data.capabilities
    : { metrics: legacyMetrics, groups: legacyGroups, filters: ["region", "client", "product"] };
}
export const groupLabel = (group: Group, capabilities?: DataCapabilities) => capabilities?.labels?.[group] ?? groups[group];
export const metricLabel = (metric: Metric, capabilities?: DataCapabilities) => capabilities?.labels?.[metric] ?? metrics[metric].label;
const reportMetricKeys = (report: Report) => (report.sourceInfo?.capabilities?.metrics ?? metricKeys.filter((metric) => metric !== "gross" || report.sourceInfo?.metrics?.gross?.status === "validated" || report.total.values.gross?.current != null || report.total.values.gross?.previous != null)).slice().sort((a, b) => ["revenue", "gross", "returns", "buyers", "margin"].indexOf(a) - ["revenue", "gross", "returns", "buyers", "margin"].indexOf(b));
const pair = (row: Report["total"], metric: Metric) => row.values[metric] ?? { current: null, previous: null };
export const isAbortError = (error: unknown) => error !== null && typeof error === "object" && "name" in error && error.name === "AbortError";
export async function api<T>(path: string, method = "GET", payload?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/" + path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: payload === undefined ? {} : { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    throw Error("Conexão indisponível. Conecte-se à internet e tente novamente.");
  }
  const data = await response.json().catch(error => {
    if (signal?.aborted || isAbortError(error)) throw error;
    return { error: "Resposta do servidor indisponível." };
  });
  if (!response.ok) {
    if (response.status === 401 && !["auth/login", "me"].includes(path))
      window.dispatchEvent(new Event("session-ended"));
    throw Error(data.error + (data.fields?.length ? " " + data.fields.join(", ") : ""));
  }
  return data;
}
export const message = (e: unknown) => (e instanceof Error ? e.message : "Falha na operação.");
export function Brand() {
  return (
    <div className="brand">
      <img src="/icon-192.png" alt="" />
      <div>
        Comercial <strong>Insight</strong>
      </div>
    </div>
  );
}
export function Credit() {
  return (
    <span className="credit">
      Desenvolvido por <b>Anderson de Araujo</b>
    </span>
  );
}
export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div className="errorbox" role="alert">
      <Info size={17} />
      <span>{children}</span>
    </div>
  );
}
export function Busy({ label = "Consultando…" }: { label?: string }) {
  return (
    <div className="busy" role="status">
      <LoaderCircle size={17} className="spin" />
      {label}
    </div>
  );
}
export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <Database size={24} />
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}
export const planFor = (
  filters: Filters,
  group: Plan["group"] = "month",
  metric: Metric = "revenue",
): Plan => ({ group, metric, order: "current", filters });
export const monthName = (s: string, long = false) =>
  new Intl.DateTimeFormat("pt-BR", {
    month: long ? "long" : "short",
    year: long ? "numeric" : "2-digit",
    timeZone: "UTC",
  })
    .format(new Date(s + "-15T12:00:00Z"))
    .replace(". de ", "/")
    .replace(" de ", "/");
export const period = (f: Filters) => monthName(f.from) + " – " + monthName(f.to);
export function useReport(plan: Plan, enabled: boolean, refresh = 0, sourceKey = "") {
  const [state, set] = useState<{ data?: Report; error?: string; loading: boolean }>({
    loading: enabled,
  });
  const key = JSON.stringify(plan);
  useEffect(() => {
    let alive = true;
    set({ loading: enabled });
    if (enabled)
      api<Report>("report", "POST", JSON.parse(key))
        .then((data) => {
          if (alive) set({ data, loading: false });
        })
        .catch((e) => {
          if (alive) set({ error: message(e), loading: false });
        });
    return () => {
      alive = false;
    };
  }, [key, enabled, refresh, sourceKey]);
  return state;
}
export function Delta({ r, m }: { r: Report["total"]; m: Metric }) {
  const d = change(pair(r, m), m);
  if (d === null) {
    const previous = pair(r, m).previous;
    return <small className="muted" title={previous !== null && previous < 0 ? "Base anterior negativa: avalie a diferença em reais, sem percentual convencional de crescimento." : undefined}>{previous !== null && previous < 0 ? "Base anterior negativa" : previous === 0 ? "Base anterior zero" : "Sem base comparável"}</small>;
  }
  const Icon = d < 0 ? ArrowDownRight : ArrowUpRight;
  return (
    <span
      className={
        "delta " + (d === 0 ? "neutral" : d > 0 === metrics[m].up ? "positive" : "negative")
      }
    >
      <Icon size={13} />
      {deltaTitle(d, m)}
    </span>
  );
}
export function Kpis({ r }: { r: Report }) {
  const available = reportMetricKeys(r);
  const ticket = ticketPerBuyer(pair(r.total, "revenue"), pair(r.total, "buyers"));
  return (
    <div className="kpis">
      {available.map((m) => (
        <div className={"kpi kpi-" + m} key={m}>
          <span>{metricLabel(m, r.sourceInfo?.capabilities)}</span>
          <strong title={pretty(pair(r.total, m).current, m)}>
            {pretty(pair(r.total, m).current, m, Math.abs(pair(r.total, m).current ?? 0) >= 10000)}
          </strong>
          {r.sourceInfo?.metrics?.[m]?.status !== undefined && r.sourceInfo.metrics[m]?.status !== "validated" && <small className="muted">{r.sourceInfo.metrics[m]?.reason ?? "Indicador sem equivalência validada"}</small>}
          <div className="kpi-comparison"><Delta r={r.total} m={m} /></div>
          <small className="kpi-context">Anterior: {pretty(pair(r.total, m).previous, m, true)}</small>
          <small className="kpi-context">Diferença: {absoluteChange(pair(r.total, m), m)}</small>
        </div>
      ))}
      {available.includes("revenue") && available.includes("buyers") && <div className="kpi kpi-ticket"><span>Ticket por comprador</span><strong title={pretty(ticket.current, "revenue")}>{pretty(ticket.current, "revenue", Math.abs(ticket.current ?? 0) >= 10000)}</strong><div className="kpi-comparison"><Delta r={{ ...r.total, values: { ...r.total.values, revenue: ticket } }} m="revenue" /></div><small className="kpi-context">Anterior: {pretty(ticket.previous, "revenue")}</small><small className="kpi-context">{metricLabel("revenue", r.sourceInfo?.capabilities)} ÷ compradores distintos. Não é média por pedido.</small></div>}
    </div>
  );
}
export function ticketPerBuyer(revenue: Pair, buyers: Pair): Pair {
  const calculate = (value: number | null, count: number | null) => value != null && count != null && count > 0 && Number.isFinite(value) && Number.isFinite(count) ? value / count : null;
  return { current: calculate(revenue.current, buyers.current), previous: calculate(revenue.previous, buyers.previous) };
}
export function absoluteChange(value: { current: number | null; previous: number | null }, metric: Metric) {
  if (value.current == null || value.previous == null) return "—";
  const difference = value.current - value.previous;
  return (difference > 0 ? "+" : "") + (metric === "margin" ? difference.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " p.p." : pretty(difference, metric));
}
export function ReportContext({ r }: { r: Report }) {
  const sourceDate = r.sourceInfo?.extractedAt ?? r.asOf;
  const date = (value: string) => new Date(value + "T12:00:00Z").toLocaleDateString("pt-BR", { timeZone: "UTC" });
  return <div className="report-context"><span><Info size={12} />{r.comparison ? date(r.comparison.current.from) + " a " + date(r.comparison.current.to) + " × " + date(r.comparison.previous.from) + " a " + date(r.comparison.previous.to) : period(r.plan.filters) + " · comparação com meses equivalentes do ano anterior"}</span><span><Database size={12} />{r.source} · {new Date(sourceDate).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</span>{r.sourceInfo && <span>Base até {date(r.sourceInfo.referenceDate)}</span>}{r.comparison?.reason && <p>{r.comparison.reason}</p>}{r.warnings?.map((warning) => <p className="report-warning" key={warning}>{warning}</p>)}</div>;
}
export function Graph({ r, metric = r.plan.metric, title }: { r: Report; metric?: Metric; title?: string }) {
  const [table, setTable] = useState(false);
  const isMonth = r.plan.group === "month";
  const data = r.rows.map((row) => ({
    label: isMonth ? monthName(row.name) : row.name,
    atual: row.values[metric].current,
    anterior: row.values[metric].previous,
  }));
  const graph = isMonth ? data : data.slice(0, 8);
  const yr = (s: string) => s.slice(0, 4);
  const f = r.plan.filters;
  return (
    <section className="panel graph">
      <div className="sectionhead">
        <div>
          <div className="mini">
            <ChartNoAxesCombined size={14} /> Análise comparativa
          </div>
          <h2>
            {title ?? (isMonth
              ? "Evolução mensal"
              : r.plan.order === "decline" ? "Variação · menores diferenças absolutas" : r.plan.order === "growth" ? "Variação · maiores diferenças absolutas" : groupLabel(r.plan.group, r.sourceInfo?.capabilities) + " por " + metricLabel(metric, r.sourceInfo?.capabilities).toLowerCase())}
          </h2>
        </div>
        <button className="soft compact" onClick={() => setTable(!table)}>
          {table ? "Gráfico" : "Tabela"}
        </button>
      </div>
      <div className="chartsub">
        {metricLabel(metric, r.sourceInfo?.capabilities)} · {period(f)}
      </div>
      {data.every((x) => x.atual === null && x.anterior === null) ? (
        <Empty title="Sem valores no recorte">Confira o indicador e os filtros selecionados.</Empty>
      ) : table ? (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>{isMonth ? "Mês" : "Descrição"}</th>
                <th>Período</th>
                <th>Ano anterior</th>
              </tr>
            </thead>
            <tbody>
              {data.map((x) => (
                <tr key={x.label}>
                  <td>{x.label}</td>
                  <td>{pretty(x.atual, metric)}</td>
                  <td>{pretty(x.anterior, metric)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="legend">
            <i />
            Período selecionado <i />
            Ano anterior
          </div>
          <div className="chart">
            <ResponsiveContainer width="100%" height="100%">
              {isMonth ? <LineChart data={graph} margin={{ top: 10, right: 12, left: 0, bottom: 5 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 4" stroke="#e3e8f1" />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 10, fill: "#627089" }}
                  tickFormatter={(v) => String(v).slice(0, 14)}
                />
                <YAxis
                  width={60}
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fill: "#627089" }}
                  tickFormatter={(v) => pretty(Number(v), metric, true)}
                />
                <Tooltip
                  cursor={{ fill: "#f0f3fc" }}
                  formatter={(v, n) => [
                    pretty(v == null ? null : Number(v), metric),
                    n === "atual" ? "Período" : "Ano anterior",
                  ]}
                />
                <Line dataKey="anterior" stroke="#9aadc7" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls={false} isAnimationActive={false} />
                <Line dataKey="atual" stroke="#6750d8" strokeWidth={3} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
              </LineChart> : <BarChart data={graph} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 5 }}>
                <CartesianGrid horizontal={false} strokeDasharray="3 4" stroke="#e3e8f1" />
                <XAxis type="number" tickCount={4} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "#627089" }} tickFormatter={(v) => pretty(Number(v), metric, true)} />
                <YAxis type="category" dataKey="label" width={125} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "#627089" }} tickFormatter={(v) => String(v).length > 21 ? String(v).slice(0, 20) + "…" : String(v)} />
                <Tooltip cursor={{ fill: "#f0f3fc" }} formatter={(v, n) => [pretty(v == null ? null : Number(v), metric), n === "atual" ? "Período" : "Ano anterior"]} />
                <Bar dataKey="anterior" fill="#b3c5de" radius={[0, 3, 3, 0]} maxBarSize={13} isAnimationActive={false} />
                <Bar dataKey="atual" fill="#6750d8" radius={[0, 3, 3, 0]} maxBarSize={13} isAnimationActive={false} />
              </BarChart>}
            </ResponsiveContainer>
          </div>
        </>
      )}
      <div className="source">
        <span>
          <Database size={12} /> {r.source} · {r.sourceInfo ? "extração " + new Date(r.sourceInfo.extractedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) + " · versão " + r.sourceInfo.versionId.slice(0, 8) : "consulta " + new Date(r.asOf).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
        </span>
        <span>
          {yr(f.to)} × {+yr(f.to) - 1}
          {r.truncated ? " · Top 30" : ""}
        </span>
      </div>
      {!isMonth && data.length > graph.length && !table && <p className="sub chart-note">Gráfico com os {graph.length} primeiros resultados. A tabela inclui {data.length} registros.</p>}
    </section>
  );
}
export function Signals({ r, ask }: { r: Report; ask: (q: string) => void }) {
  const rankedSignals = r.rows.filter((row) => {
    const value = pair(row, r.plan.metric);
    return value.current != null && value.previous != null && value.current !== value.previous;
  }).sort((a, b) => {
    const impact = (row: Report["total"]) => (pair(row, r.plan.metric).current! - pair(row, r.plan.metric).previous!) * (metrics[r.plan.metric].up ? 1 : -1);
    return impact(a) - impact(b);
  }).slice(0, 3);
  const items = reportMetricKeys(r)
    .filter((m) => change(pair(r.total, m), m) !== null)
    .sort((a, b) => {
      const risk = (m: Metric) => (change(pair(r.total, m), m)! > 0 !== metrics[m].up ? 1 : 0);
      return risk(b) - risk(a);
    });
  return (
    <section className="panel">
      <div className="mini">
        <Sparkles size={14} /> Leitura do período
      </div>
      <h2>Sinais comerciais</h2>
      <p className="sub">Comparação com os mesmos meses do ano anterior.</p>
      {items.length ? (
        items.map((m) => {
          const d = change(pair(r.total, m), m)!;
          return (
            <button
              key={m}
              className="signal"
              onClick={() =>
                ask("Analise a evolução de " + metricLabel(m, r.sourceInfo?.capabilities) + " no período selecionado.")
              }
            >
              <div>
                <b>{metricLabel(m, r.sourceInfo?.capabilities)}</b>
                <span>{d === 0 ? "Estável" : d > 0 ? "Acima" : "Abaixo"} do ano anterior</span>
                <small>{absoluteChange(pair(r.total, m), m)} · {period(r.plan.filters)}</small>
              </div>
              <Delta r={r.total} m={m} />
              <ChevronRight size={14} />
            </button>
          );
        })
      ) : (
        <Empty title="Sem comparação disponível">São necessários valores nos dois períodos.</Empty>
      )}
      {rankedSignals.length > 0 && <div className="ranked-signals"><h3>Variações para investigar</h3>{rankedSignals.map((row) => <button className="signal" key={row.key ?? row.name} onClick={() => ask("Analise a variação de " + (r.plan.group === "month" ? monthName(row.name) : row.name) + " em " + metricLabel(r.plan.metric, r.sourceInfo?.capabilities) + ". Separe os fatos das hipóteses e sugira uma ação.")}><div><b>{r.plan.group === "month" ? monthName(row.name) : row.name}</b><span>Impacto: {absoluteChange(pair(row, r.plan.metric), r.plan.metric)}</span><small>{period(r.plan.filters)} · conferir composição e causas na análise.</small></div><ChevronRight size={14} /></button>)}</div>}
    </section>
  );
}
