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
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
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
} from "../shared/domain";
export async function api<T>(path: string, method = "GET", payload?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/" + path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: payload === undefined ? {} : { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  } catch {
    throw Error("Conexão indisponível. Conecte-se à internet e tente novamente.");
  }
  const data = await response.json().catch(() => ({ error: "Resposta do servidor indisponível." }));
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
  const d = change(r.values[m], m);
  if (d === null) return <small className="muted">Sem base comparável</small>;
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
  return (
    <div className="kpis">
      {metricKeys.map((m) => (
        <div className="kpi" key={m}>
          <span>{metrics[m].label}</span>
          <strong title={pretty(r.total.values[m].current, m)}>
            {pretty(r.total.values[m].current, m, true)}
          </strong>
          {r.sourceInfo?.metrics?.[m]?.status !== undefined && r.sourceInfo.metrics[m]?.status !== "validated" && <small className="muted">{r.sourceInfo.metrics[m]?.reason ?? "Indicador sem equivalência validada"}</small>}
          <Delta r={r.total} m={m} />
        </div>
      ))}
    </div>
  );
}
export function Graph({ r, metric = r.plan.metric }: { r: Report; metric?: Metric }) {
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
            {isMonth
              ? "Evolução mensal"
              : groups[r.plan.group] + " por " + metrics[metric].label.toLowerCase()}
          </h2>
        </div>
        <button className="soft compact" onClick={() => setTable(!table)}>
          {table ? "Gráfico" : "Tabela"}
        </button>
      </div>
      <div className="chartsub">
        {metrics[metric].label} · {period(f)}
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
              <BarChart data={graph} margin={{ top: 10, right: 4, left: 0, bottom: 5 }}>
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
                <Bar dataKey="anterior" fill="#b3c5de" radius={[3, 3, 0, 0]} maxBarSize={25} />
                <Bar dataKey="atual" fill="#5750db" radius={[3, 3, 0, 0]} maxBarSize={25} />
              </BarChart>
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
    </section>
  );
}
export function Signals({ r, ask }: { r: Report; ask: (q: string) => void }) {
  const items = metricKeys
    .filter((m) => change(r.total.values[m], m) !== null)
    .sort((a, b) => {
      const risk = (m: Metric) => (change(r.total.values[m], m)! > 0 !== metrics[m].up ? 1 : 0);
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
          const d = change(r.total.values[m], m)!;
          return (
            <button
              key={m}
              className="signal"
              onClick={() =>
                ask("Analise a evolução de " + metrics[m].label + " no período selecionado.")
              }
            >
              <div>
                <b>{metrics[m].label}</b>
                <span>{d === 0 ? "Estável" : d > 0 ? "Acima" : "Abaixo"} do ano anterior</span>
              </div>
              <Delta r={r.total} m={m} />
              <ChevronRight size={14} />
            </button>
          );
        })
      ) : (
        <Empty title="Sem comparação disponível">São necessários valores nos dois períodos.</Empty>
      )}
    </section>
  );
}
