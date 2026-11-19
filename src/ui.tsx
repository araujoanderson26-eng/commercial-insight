import {
  ArrowDownRight,
  ArrowUpRight,
  ChartNoAxesCombined,
  ChevronRight,
  Database,
  Info,
  LoaderCircle,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  change,
  deltaTitle,
  groups,
  metricKeys,
  metrics,
  pretty,
  type DataCapabilities,
  type FilterDimension,
  type Filters,
  type Group,
  type Metric,
  type Pair,
  type Plan,
  type Report,
  type Session,
} from "../shared/domain";
import { SmartChart, type SmartChartMode } from "./components/SmartChart";
import { projectCompatibleReport } from "./lib/analytics";
import {
  canonicalPlanKey,
  getCached,
  getCachedSync,
  listCachedReports,
  listCachedReportsSync,
  purgeClientCache,
  setCached,
} from "./lib/cache";
import { apiUrl, clearNativeToken, getNativeToken, isNativeApp } from "./lib/runtime";

const legacyGroups: Group[] = ["month", "client", "region", "product", "category"];
const legacyMetrics: Metric[] = ["revenue", "margin", "buyers", "returns"];

export function sessionCapabilities(session: Session): DataCapabilities {
  return session.data?.source === "manual" && session.data.capabilities
    ? session.data.capabilities
    : { metrics: legacyMetrics, groups: legacyGroups, filters: ["region", "client", "product"] };
}

export const groupLabel = (group: Group, capabilities?: DataCapabilities) =>
  capabilities?.labels?.[group] ?? groups[group];

export const metricLabel = (metric: Metric, capabilities?: DataCapabilities) =>
  capabilities?.labels?.[metric] ?? metrics[metric].label;

const reportMetricKeys = (report: Report) =>
  (
    report.sourceInfo?.capabilities?.metrics ??
    metricKeys.filter(
      (metric) =>
        metric !== "gross" ||
        report.sourceInfo?.metrics?.gross?.status === "validated" ||
        report.total.values.gross?.current != null ||
        report.total.values.gross?.previous != null,
    )
  )
    .slice()
    .sort(
      (a, b) =>
        ["revenue", "gross", "returns", "buyers", "margin"].indexOf(a) -
        ["revenue", "gross", "returns", "buyers", "margin"].indexOf(b),
    );

const pair = (row: Report["total"], metric: Metric) =>
  row.values[metric] ?? { current: null, previous: null };

export const isAbortError = (error: unknown) =>
  error !== null && typeof error === "object" && "name" in error && error.name === "AbortError";

export async function api<T>(
  path: string,
  method = "GET",
  payload?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const native = isNativeApp();
  const token = native ? getNativeToken() : null;
  const headers: Record<string, string> = {};
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  if (native) {
    headers["X-Client-Platform"] = "capacitor";
    if (token) headers.Authorization = "Bearer " + token;
  }
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method,
      credentials: native ? "include" : "same-origin",
      cache: "no-store",
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    throw Error("Conexão indisponível. Conecte-se à internet e tente novamente.");
  }
  const data = await response.json().catch((error) => {
    if (signal?.aborted || isAbortError(error)) throw error;
    return { error: "Resposta do servidor indisponível." };
  });
  if (!response.ok) {
    if (response.status === 401 && !["auth/login", "me"].includes(path)) {
      clearNativeToken();
      void purgeClientCache();
      window.dispatchEvent(new Event("session-ended"));
    }
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
  const key = canonicalPlanKey(plan);
  const scope = sourceKey || "default";
  const lastScopeKey = useRef<string>("");

  const [state, set] = useState<{
    data?: Report;
    error?: string;
    loading: boolean;
    refreshing: boolean;
    fromCache: boolean;
  }>(() => {
    if (!enabled) return { loading: false, refreshing: false, fromCache: false };
    const syncHit =
      getCachedSync<Report>(scope, key) ??
      projectCompatibleReport(plan, listCachedReportsSync(scope));
    return syncHit
      ? { data: syncHit, loading: false, refreshing: true, fromCache: true }
      : { loading: true, refreshing: false, fromCache: false };
  });

  const parsedPlanJson = JSON.stringify(plan);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const targetPlan = JSON.parse(parsedPlanJson) as Plan;
    const scopeKey = `${scope}|${key}`;
    const sameQuery = lastScopeKey.current === scopeKey;
    lastScopeKey.current = scopeKey;

    if (!enabled) {
      set({ loading: false, refreshing: false, fromCache: false });
      return () => {
        alive = false;
        controller.abort();
      };
    }

    const syncHit =
      getCachedSync<Report>(scope, key) ??
      projectCompatibleReport(targetPlan, listCachedReportsSync(scope));

    if (syncHit) {
      set({ data: syncHit, loading: false, refreshing: true, fromCache: true });
    } else if (sameQuery) {
      set((prev) => ({
        data: prev.data,
        loading: !prev.data,
        refreshing: !!prev.data,
        fromCache: !!prev.data,
      }));
    } else {
      set({ loading: true, refreshing: false, fromCache: false });
      void (async () => {
        const idbHit =
          (await getCached<Report>(scope, key)) ??
          projectCompatibleReport(targetPlan, await listCachedReports(scope));
        if (alive && idbHit) {
          set((prev) =>
            prev.data && !prev.fromCache
              ? prev
              : { data: idbHit, loading: false, refreshing: true, fromCache: true },
          );
        }
      })();
    }

    api<Report>("report", "POST", targetPlan, controller.signal)
      .then((data) => {
        if (!alive) return;
        const ttlMs = data.source === "Arquivo manual (D1)" ? 30 * 60 * 1000 : 5 * 60 * 1000;
        setCached(scope, key, "report", data, ttlMs);
        set({ data, loading: false, refreshing: false, fromCache: false });
      })
      .catch((e) => {
        if (!alive || isAbortError(e)) return;
        set((prev) => {
          if (prev.data && typeof navigator !== "undefined" && !navigator.onLine) {
            return { data: prev.data, loading: false, refreshing: false, fromCache: true };
          }
          return {
            data: sameQuery ? prev.data : undefined,
            error: message(e),
            loading: false,
            refreshing: false,
            fromCache: sameQuery ? !!prev.data : false,
          };
        });
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [key, parsedPlanJson, enabled, refresh, scope]);

  return state;
}

export function Delta({ r, m }: { r: Report["total"]; m: Metric }) {
  const d = change(pair(r, m), m);
  if (d === null) {
    const previous = pair(r, m).previous;
    return (
      <small
        className="muted"
        title={
          previous !== null && previous < 0
            ? "Base anterior negativa: avalie a diferença em reais, sem percentual convencional de crescimento."
            : undefined
        }
      >
        {previous !== null && previous < 0
          ? "Base anterior negativa"
          : previous === 0
            ? "Base anterior zero"
            : "Sem base comparável"}
      </small>
    );
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
          {r.sourceInfo?.metrics?.[m]?.status !== undefined &&
            r.sourceInfo.metrics[m]?.status !== "validated" && (
              <small className="muted">
                {r.sourceInfo.metrics[m]?.reason ?? "Indicador sem equivalência validada"}
              </small>
            )}
          <div className="kpi-comparison">
            <Delta r={r.total} m={m} />
          </div>
          <small className="kpi-context">
            Anterior: {pretty(pair(r.total, m).previous, m, true)}
          </small>
          <small className="kpi-context">Diferença: {absoluteChange(pair(r.total, m), m)}</small>
        </div>
      ))}
      {available.includes("revenue") && available.includes("buyers") && (
        <div className="kpi kpi-ticket">
          <span>Ticket por comprador</span>
          <strong title={pretty(ticket.current, "revenue")}>
            {pretty(ticket.current, "revenue", Math.abs(ticket.current ?? 0) >= 10000)}
          </strong>
          <div className="kpi-comparison">
            <Delta r={{ ...r.total, values: { ...r.total.values, revenue: ticket } }} m="revenue" />
          </div>
          <small className="kpi-context">Anterior: {pretty(ticket.previous, "revenue")}</small>
          <small className="kpi-context">
            {metricLabel("revenue", r.sourceInfo?.capabilities)} ÷ compradores distintos. Não é média
            por pedido.
          </small>
        </div>
      )}
      {r.summaryStats?.ticketPerInvoice != null && (
        <div className="kpi kpi-nf">
          <span>Ticket médio por NF</span>
          <strong title={pretty(r.summaryStats.ticketPerInvoice, "revenue")}>
            {pretty(r.summaryStats.ticketPerInvoice, "revenue", Math.abs(r.summaryStats.ticketPerInvoice) >= 10000)}
          </strong>
          <small className="kpi-context">
            {metricLabel("revenue", r.sourceInfo?.capabilities)} ÷{" "}
            {r.summaryStats.invoiceCount?.toLocaleString("pt-BR") ?? "—"} notas fiscais (Serial).
          </small>
        </div>
      )}
      {r.summaryStats?.activeReps != null && (
        <div className="kpi kpi-reps">
          <span>Representantes ativos</span>
          <strong>{r.summaryStats.activeReps.toLocaleString("pt-BR")}</strong>
          <small className="kpi-context">Com faturamento no período e escopo selecionados.</small>
        </div>
      )}
    </div>
  );
}

export function ticketPerBuyer(revenue: Pair, buyers: Pair): Pair {
  const calculate = (value: number | null, count: number | null) =>
    value != null && count != null && count > 0 && Number.isFinite(value) && Number.isFinite(count)
      ? value / count
      : null;
  return {
    current: calculate(revenue.current, buyers.current),
    previous: calculate(revenue.previous, buyers.previous),
  };
}

export function absoluteChange(
  value: { current: number | null; previous: number | null },
  metric: Metric,
) {
  if (value.current == null || value.previous == null) return "—";
  const difference = value.current - value.previous;
  return (
    (difference > 0 ? "+" : "") +
    (metric === "margin"
      ? difference.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " p.p."
      : pretty(difference, metric))
  );
}

export function ReportContext({ r }: { r: Report }) {
  const sourceDate = r.sourceInfo?.extractedAt ?? r.asOf;
  const date = (value: string) =>
    new Date(value + "T12:00:00Z").toLocaleDateString("pt-BR", { timeZone: "UTC" });
  return (
    <div className="report-context">
      {r.plan.filters.categoriesInclude?.length || r.plan.filters.categoriesExclude?.length ? (
        <p>
          Incluir: {r.plan.filters.categoriesInclude?.join(", ") || "Todas"}. Excluir:{" "}
          {r.plan.filters.categoriesExclude?.join(", ") || "Nenhuma"}.
        </p>
      ) : null}
      <span>
        <Info size={12} />
        {r.comparison
          ? date(r.comparison.current.from) +
            " a " +
            date(r.comparison.current.to) +
            " × " +
            date(r.comparison.previous.from) +
            " a " +
            date(r.comparison.previous.to)
          : period(r.plan.filters) + " · comparação com meses equivalentes do ano anterior"}
      </span>
      <span>
        <Database size={12} />
        {r.source} ·{" "}
        {new Date(sourceDate).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}
      </span>
      {r.sourceInfo && <span>Base até {date(r.sourceInfo.referenceDate)}</span>}
      {r.comparison?.reason && <p>{r.comparison.reason}</p>}
      {r.filterConflicts?.map((conflict) => (
        <p className="report-warning" key={conflict}>
          {conflict}
        </p>
      ))}
      {r.warnings?.map((warning) => (
        <p className="report-warning" key={warning}>
          {warning}
        </p>
      ))}
    </div>
  );
}

export function Graph({
  r,
  metric = r.plan.metric,
  title,
  onCrossFilter,
  activeFilterValue,
  refreshing = false,
}: {
  r: Report;
  metric?: Metric;
  title?: string;
  onCrossFilter?: (dimension: FilterDimension | "month", value: string) => void;
  activeFilterValue?: string;
  refreshing?: boolean;
}) {
  const [table, setTable] = useState(false);
  const [mode, setMode] = useState<SmartChartMode>("primary");
  const [zoomed, setZoomed] = useState(false);
  const [resetZoomNonce, setResetZoomNonce] = useState(0);

  const isMonth = r.plan.group === "month";
  const effectiveMode: SmartChartMode = isMonth && mode === "share" ? "primary" : mode;
  const data = r.rows.map((row) => ({
    label: isMonth ? monthName(row.name) : row.name,
    atual: row.values[metric].current,
    anterior: row.values[metric].previous,
  }));
  const yr = (s: string) => s.slice(0, 4);
  const f = r.plan.filters;
  const capabilities = r.sourceInfo?.capabilities;
  const canFilterGroup =
    !!onCrossFilter &&
    (isMonth || (capabilities?.filters ?? legacyGroups).includes(r.plan.group as FilterDimension));

  return (
    <section className="panel graph">
      <div className="sectionhead">
        <div>
          <div className="mini">
            <ChartNoAxesCombined size={14} /> Análise comparativa
            {refreshing && <span className="chart-sync-pill">Atualizando…</span>}
          </div>
          <h2>
            {title ??
              (isMonth
                ? "Evolução mensal"
                : r.plan.order === "decline"
                  ? "Variação · menores diferenças absolutas"
                  : r.plan.order === "growth"
                    ? "Variação · maiores diferenças absolutas"
                    : groupLabel(r.plan.group, capabilities) +
                      " por " +
                      metricLabel(metric, capabilities).toLowerCase())}
          </h2>
        </div>
        <div className="chart-controls">
          {!table && (
            <div className="chart-segmented" role="group" aria-label="Modo de visualização">
              <button
                type="button"
                className={effectiveMode === "primary" ? "active" : ""}
                onClick={() => setMode("primary")}
              >
                {isMonth ? "Linha" : "Comparativo"}
              </button>
              <button
                type="button"
                className={effectiveMode === "secondary" ? "active" : ""}
                onClick={() => setMode("secondary")}
              >
                {isMonth ? "Colunas" : "Variação Δ"}
              </button>
              {!isMonth && (
                <button
                  type="button"
                  className={effectiveMode === "share" ? "active" : ""}
                  onClick={() => setMode("share")}
                >
                  Participação %
                </button>
              )}
            </div>
          )}
          {!table && zoomed && (
            <button
              type="button"
              className="soft compact"
              onClick={() => setResetZoomNonce((n) => n + 1)}
              title="Resetar zoom"
            >
              <RotateCcw size={13} />
              Resetar
            </button>
          )}
          <button className="soft compact" onClick={() => setTable(!table)}>
            {table ? "Gráfico" : "Tabela"}
          </button>
        </div>
      </div>
      <div className="chartsub">
        <span>
          {metricLabel(metric, capabilities)} · {period(f)}
        </span>
        {activeFilterValue && (
          <span className="chart-active-badge">
            Filtro no gráfico: <b>{activeFilterValue}</b>
          </span>
        )}
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
          {!isMonth && effectiveMode === "secondary" ? (
            <div className="legend">
              <i className="legend-good" />
              Variação favorável <i className="legend-bad" />
              Variação desfavorável
            </div>
          ) : !isMonth && effectiveMode === "share" ? (
            <div className="legend">
              <i />
              Participação % no total do recorte
            </div>
          ) : (
            <div className="legend">
              <i />
              Período selecionado <i />
              Ano anterior
            </div>
          )}
          <SmartChart
            r={r}
            metric={metric}
            mode={effectiveMode}
            activeKey={activeFilterValue}
            resetZoomNonce={resetZoomNonce}
            onZoomChange={setZoomed}
            onSelectPoint={
              canFilterGroup
                ? (item) => {
                    if (!item.canDrill) return;
                    onCrossFilter(
                      item.isMonth ? "month" : (r.plan.group as FilterDimension),
                      item.key,
                    );
                  }
                : undefined
            }
          />
          {canFilterGroup && (
            <p className="chart-hint">
              Toque em um ponto ou barra para filtrar os demais indicadores (toque novamente para
              limpar).
            </p>
          )}
        </>
      )}
      <div className="source">
        <span>
          <Database size={12} /> {r.source} ·{" "}
          {r.sourceInfo
            ? "extração " +
              new Date(r.sourceInfo.extractedAt).toLocaleString("pt-BR", {
                timeZone: "America/Sao_Paulo",
              }) +
              " · versão " +
              r.sourceInfo.versionId.slice(0, 8)
            : "consulta " +
              new Date(r.asOf).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
        </span>
        <span>
          {yr(f.to)} × {+yr(f.to) - 1}
          {r.truncated ? " · Top 30" : ""}
        </span>
      </div>
      {!isMonth && data.length > 8 && !table && (
        <p className="sub chart-note">
          Exibindo {data.length} registros com rolagem no gráfico e detalhamento na tabela.
        </p>
      )}
    </section>
  );
}

export function Signals({ r, ask }: { r: Report; ask: (q: string) => void }) {
  const rankedSignals = r.rows
    .filter((row) => {
      const value = pair(row, r.plan.metric);
      return value.current != null && value.previous != null && value.current !== value.previous;
    })
    .sort((a, b) => {
      const impact = (row: Report["total"]) =>
        (pair(row, r.plan.metric).current! - pair(row, r.plan.metric).previous!) *
        (metrics[r.plan.metric].up ? 1 : -1);
      return impact(a) - impact(b);
    })
    .slice(0, 3);
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
                ask(
                  "Analise a evolução de " +
                    metricLabel(m, r.sourceInfo?.capabilities) +
                    " no período selecionado.",
                )
              }
            >
              <div>
                <b>{metricLabel(m, r.sourceInfo?.capabilities)}</b>
                <span>{d === 0 ? "Estável" : d > 0 ? "Acima" : "Abaixo"} do ano anterior</span>
                <small>
                  {absoluteChange(pair(r.total, m), m)} · {period(r.plan.filters)}
                </small>
              </div>
              <Delta r={r.total} m={m} />
              <ChevronRight size={14} />
            </button>
          );
        })
      ) : (
        <Empty title="Sem comparação disponível">São necessários valores nos dois períodos.</Empty>
      )}
      {rankedSignals.length > 0 && (
        <div className="ranked-signals">
          <h3>Variações para investigar</h3>
          {rankedSignals.map((row) => (
            <button
              className="signal"
              key={row.key ?? row.name}
              onClick={() =>
                ask(
                  "Analise a variação de " +
                    (r.plan.group === "month" ? monthName(row.name) : row.name) +
                    " em " +
                    metricLabel(r.plan.metric, r.sourceInfo?.capabilities) +
                    ". Separe os fatos das hipóteses e sugira uma ação.",
                )
              }
            >
              <div>
                <b>{r.plan.group === "month" ? monthName(row.name) : row.name}</b>
                <span>Impacto: {absoluteChange(pair(row, r.plan.metric), r.plan.metric)}</span>
                <small>{period(r.plan.filters)} · conferir composição e causas na análise.</small>
              </div>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
