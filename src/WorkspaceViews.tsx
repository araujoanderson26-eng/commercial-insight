import {printReport} from "./print-report";
import {
  Activity,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BarChart3,
  Bell,
  BookOpen,
  Boxes,
  CalendarDays,
  ChartNoAxesColumnIncreasing,
  ChevronRight,
  CircleUserRound,
  Ellipsis,
  House,
  LayoutGrid,
  Link2,
  MapPinned,
  MessageCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Store,
  Target,
  Users,
  Download,
  Printer,
  Star,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  pretty,
  type Filters,
  type Group,
  type Metric,
  type Plan,
  type Session,
  type FilterDimension,
} from "../shared/domain";
import {
  api,
  Delta,
  ErrorBox,
  Graph,
  Kpis,
  planFor,
  Signals,
  useReport,
  sessionCapabilities,
  groupLabel,
  metricLabel,
  absoluteChange,
  ReportContext,
  message,
} from "./ui";
import { ReportSkeleton } from "./components/Skeletons";
import { filterRowsLocally } from "./lib/analytics";
import { makeScope } from "./lib/cache";
import { exportReport } from "./exports";
export const mainNav = [
  { p: "inicio", label: "Início", icon: House },
  { p: "conversas", label: "Conversas", icon: MessageCircle },
  { p: "relatorios", label: "Relatórios", icon: ChartNoAxesColumnIncreasing },
  { p: "clientes", label: "Clientes", icon: Users },
  { p: "produtos", label: "Produtos e mix", icon: Boxes },
  { p: "visitas", label: "Preparar visita", icon: CalendarDays },
  { p: "alertas", label: "Alertas e ações", icon: Bell },
];
export const adminNav = [
  { p: "atualizacao-dados", label: "Atualização de dados", icon: RefreshCw },
  { p: "integracoes", label: "Integrações", icon: Link2 },
  { p: "equipe", label: "Equipe e permissões", icon: ShieldCheck },
  { p: "auditoria", label: "Auditoria", icon: BookOpen },
];
export const navs = [
  ...mainNav,
  ...adminNav,
  { p: "perfil", label: "Meu perfil", icon: CircleUserRound },
  { p: "mais", label: "Mais", icon: Ellipsis },
];
export type Go = (page: string) => void;
const cards = [
  {
    title: "Analisar cliente",
    desc: "Histórico e evolução comercial.",
    icon: Store,
    color: "blue",
    to: "analisar",
  },
  {
    title: "Minha regional",
    desc: "Resultados e ranking regional.",
    icon: MapPinned,
    color: "purple",
    to: "regional",
  },
  {
    title: "Preparar visita",
    desc: "Pauta e argumentos de venda.",
    icon: CalendarDays,
    color: "cyan",
    to: "visitas",
  },
  {
    title: "Carteira de clientes",
    desc: "Compradores, quedas e potencial.",
    icon: Users,
    color: "orange",
    to: "clientes",
  },
  {
    title: "Produtos e mix",
    desc: "Categorias e desempenho por item.",
    icon: Boxes,
    color: "violet",
    to: "produtos",
  },
  {
    title: "Alertas e ações",
    desc: "Variações e prioridades.",
    icon: Target,
    color: "red",
    to: "alertas",
  },
];
function Connection({ s, go }: { s: Session; go: Go }) {
  if (s.data?.source === "manual") return (
    <div className="connectbox">
      <div><b>Nenhuma versão válida publicada</b><p>Os indicadores estarão disponíveis após a importação e validação do pacote.</p></div>
      {s.user.role === "admin" && <button className="soft compact" onClick={() => go("atualizacao-dados")}>Atualizar dados<ArrowRight size={14} /></button>}
    </div>
  );
  const config = !s.integrations.configured;
  const title = config ? "Conecte o modelo semântico" : "Vincule sua conta Microsoft";
  return (
    <div className="connectbox">
      <div className="bi">
        <i />
        <i />
        <i />
      </div>
      <div>
        <b>{title}</b>
        <p>
          {config
            ? "A consulta estará disponível após configurar o Power BI."
            : "Use a identidade corporativa autorizada para consultar os indicadores."}
        </p>
      </div>
      {(!config || s.user.role === "admin") && (
        <button className="soft compact" onClick={() => go(config ? "integracoes" : "perfil")}>
          {config ? "Configurar" : "Vincular"}
          <ArrowRight size={14} />
        </button>
      )}
    </div>
  );
}
export function Home({
  s,
  filters,
  go,
  ask,
  card,
  ready,
  onCrossFilter,
}: {
  s: Session;
  filters: Filters;
  go: Go;
  ask: (q: string) => void;
  card: (p: string) => void;
  ready: boolean;
  onCrossFilter?: (dimension: FilterDimension | "month", value: string) => void;
}) {
  const [q, Q] = useState(""),
    [refresh, R] = useState(0),
    report = useReport(planFor(filters), ready, refresh, makeScope(s));
  const hour = Number(
    new Intl.DateTimeFormat("pt-BR", {
      hour: "2-digit",
      hour12: false,
      timeZone: "America/Sao_Paulo",
    }).format(new Date()),
  );
  const greeting = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
  return (
    <div className="stack home">
      <section className="hero">
        <div className="herowords">
          <div className="heroeyebrow">
            <span className="starbox">
              <Sparkles size={14} />
            </span>{" "}
            Assistente comercial com IA
          </div>
          <h1>
            {greeting}, {s.user.name.split(" ")[0]}!
          </h1>
          <p>
            Analise resultados, clientes e oportunidades
            <br className="wideonly" /> com os dados da sua fonte comercial.
          </p>
        </div>
        <form
          className="askbox"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim().length > 1) ask(q);
            else card("pergunta");
          }}
        >
          <span className="aigem">
            <Sparkles size={21} />
          </span>
          <textarea
            rows={1}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (q.trim().length > 1) ask(q);
                else card("pergunta");
              }
            }}
            value={q}
            maxLength={900}
            onChange={(e) => Q(e.target.value)}
            aria-label="Pergunta para o assistente"
            placeholder="Pergunte sobre um cliente, produto ou resultado…"
          />
          <button aria-label="Abrir assistente" className="send">
            <ArrowUp size={19} />
          </button>
        </form>
      </section>
      <section>
        <div className="sectionhead">
          <div>
            <div className="mini">
              <LayoutGrid size={13} /> Ferramentas comerciais
            </div>
            <h2>O que você quer analisar?</h2>
          </div>
        </div>
        <div className="features">
          {cards.map((c) => (
            <button className={"feature " + c.color} key={c.to} onClick={() => card(c.to)}>
              <div className="feathead">
                <span>
                  <c.icon size={23} />
                </span>
                <ArrowUpRight size={14} />
              </div>
              <b>{c.title}</b>
              <small>{c.desc}</small>
            </button>
          ))}
        </div>
      </section>
      <section>
        <div className="sectionhead">
          <div>
            <div className="mini">
              <Activity size={14} /> Indicadores
            </div>
            <h2>Pulso comercial</h2>
          </div>
          {ready && (
            <button className="soft compact" onClick={() => R(refresh + 1)}>
              <RefreshCw size={14} />
              Atualizar
            </button>
          )}
        </div>
        {!ready ? (
          <Connection s={s} go={go} />
        ) : report.error && !report.data ? (
          <ErrorBox>{report.error}</ErrorBox>
        ) : report.data ? (
          <>
            {report.error && <ErrorBox>{report.error}</ErrorBox>}
            <ReportContext r={report.data} />
            <Kpis r={report.data} />
            <div className="analytics">
              <Graph
                r={report.data}
                refreshing={report.refreshing}
                onCrossFilter={onCrossFilter}
                activeFilterValue={filters.from === filters.to ? filters.from : undefined}
              />
              <Signals r={report.data} ask={ask} />
            </div>
          </>
        ) : (
          <ReportSkeleton withSignals />
        )}
      </section>
    </div>
  );
}
export function Reports({
  page,
  filters,
  ready,
  s,
  go,
  ask,
  initialGroup,
  initialPlan,
  drill,
  restore,
  onCrossFilter,
}: {
  page: string;
  filters: Filters;
  ready: boolean;
  s: Session;
  go: Go;
  ask: (q: string) => void;
  initialGroup: Group;
  initialPlan?: Plan;
  drill: (key: FilterDimension, name: string) => void;
  restore: (plan: Plan) => void;
  onCrossFilter?: (dimension: FilterDimension | "month", value: string) => void;
}) {
  const group0 = page === "clientes" ? "client" : page === "produtos" ? "product" : initialGroup;
  const [group, G] = useState<Group>(initialPlan?.group ?? group0),
    [metric, M] = useState<Metric>(initialPlan?.metric ?? "revenue"),
    [order, O] = useState<Plan["order"]>(initialPlan?.order ?? "current"),
    [refresh, R] = useState(0),
    [search, S] = useState(""),
    [saveTitle, ST] = useState(""),
    [saveOpen, SO] = useState(false),
    [saved, SS] = useState<{ id: string; title: string; plan: Plan }[]>([]),
    [notice, N] = useState(""),
    [savedError, SE] = useState("");
  useEffect(() => { api<typeof saved>("saved-reports").then(SS).catch((error) => SE(message(error))); }, []);
  async function save() {
    if (!report.data || !saveTitle.trim()) return;
    try {
      await api("saved-reports", "POST", { title: saveTitle.trim(), plan: report.data.plan });
      SS(await api<typeof saved>("saved-reports")); SO(false); N("Consulta salva. Ao reabrir, os dados serão consultados com suas permissões atuais."); SE("");
    } catch (error) { SE(message(error)); }
  }
  async function removeSaved(id: string) {
    try { await api("saved-reports/" + id, "DELETE"); SS((items) => items.filter((item) => item.id !== id)); }
    catch (error) { SE(message(error)); }
  }
  const capabilities = sessionCapabilities(s);
  const effectiveGroup = capabilities.groups.includes(group) ? group : "month";
  const effectiveMetric = capabilities.metrics.includes(metric) ? metric : "revenue";
  const report = useReport({ ...planFor(filters, effectiveGroup, effectiveMetric), order }, ready, refresh, makeScope(s));
  const activeFilterValue =
    effectiveGroup === "month"
      ? filters.from === filters.to
        ? filters.from
        : undefined
      : effectiveGroup === "category" && s.data?.source === "manual"
        ? filters.categoriesInclude?.length === 1
          ? filters.categoriesInclude[0]
          : filters.category || undefined
        : filters[effectiveGroup as FilterDimension] || undefined;
  const title = navs.find((n) => n.p === page)?.label || "Relatórios";
  return (
    <div className="stack">
      <div className="pageintro">
        <div className="mini">
          <BarChart3 size={15} /> Inteligência comercial
        </div>
        <h1>{title}</h1>
        <p>
          {page === "alertas"
            ? "Variações favoráveis e pontos de atenção no período selecionado."
            : page === "clientes"
              ? "Compare os compradores e aprofunde a análise de uma conta."
              : page === "produtos"
                ? "Acompanhe os itens e categorias que compõem as vendas."
                : "Explore o desempenho e compare com o mesmo período do ano anterior."}
        </p>
      </div>
      {saved.length > 0 && <section className="panel saved-reports"><div className="mini"><Star size={14} /> Consultas favoritas</div><div className="saved-list">{saved.map((item) => <div key={item.id}><button className="soft compact" onClick={() => { G(item.plan.group); M(item.plan.metric); O(item.plan.order); restore(item.plan); }}><Star size={13} />{item.title}</button><button className="iconbtn" aria-label={"Excluir consulta " + item.title} onClick={() => void removeSaved(item.id)}><Trash2 size={13} /></button></div>)}</div></section>}
      {notice && <div className="notice" role="status">{notice}</div>}
      {savedError && <ErrorBox>{savedError}</ErrorBox>}
      <div className="panel toolbar">
        <label>
          Agrupar por
          <select value={effectiveGroup} onChange={(e) => G(e.target.value as Group)}>
            {capabilities.groups.map((k) => (
              <option key={k} value={k}>
                {groupLabel(k, capabilities)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Indicador
          <select value={effectiveMetric} onChange={(e) => M(e.target.value as Metric)}>
            {capabilities.metrics.map((k) => (
              <option key={k} value={k}>
                {metricLabel(k, capabilities)}
              </option>
            ))}
          </select>
        </label>
        {effectiveGroup !== "month" && (
          <label>
            Ordenar por
            <select value={order} onChange={(e) => O(e.target.value as Plan["order"])}>
              <option value="current">Maior valor atual</option>
              <option value="decline">Maiores quedas absolutas</option>
              <option value="growth">Maiores ganhos absolutos</option>
            </select>
          </label>
        )}
        <button className="soft" disabled={!ready || report.loading} onClick={() => R(refresh + 1)}>
          <RefreshCw size={15} />
          Atualizar
        </button>
        <button className="soft" title="Janeiro ao último mês selecionado, com o corte equivalente da fonte" disabled={!ready} onClick={() => restore({ ...planFor({ ...filters, from: filters.to.slice(0, 4) + "-01" }, effectiveGroup, effectiveMetric), order })}><CalendarDays size={15} />Acumulado do ano</button>
      </div>
      {!ready ? (
        <Connection s={s} go={go} />
      ) : report.error && !report.data ? (
        <ErrorBox>{report.error}</ErrorBox>
      ) : !report.data ? (
        <ReportSkeleton withTable />
      ) : (
        <>
          {report.error && <ErrorBox>{report.error}</ErrorBox>}
          <ReportContext r={report.data} />
          <div className="report-actions"><button className="soft compact" onClick={() => exportReport(report.data!)}><Download size={15} />Exportar Excel</button><button className="soft compact" onClick={() => printReport(report.data!)}><Printer size={15} />Imprimir / PDF</button><button className="soft compact" onClick={() => { ST(title + " · " + filters.to); SO(!saveOpen); }}><Star size={15} />Salvar consulta</button></div>
          {saveOpen && <form className="panel save-report-form" onSubmit={(event) => { event.preventDefault(); void save(); }}><label>Nome da consulta<input required maxLength={120} value={saveTitle} onChange={(event) => ST(event.target.value)} /></label><button className="primary">Salvar</button><button type="button" className="soft" onClick={() => SO(false)}>Cancelar</button></form>}
          <Kpis r={report.data} />
          {page === "alertas" ? (
            <Signals r={report.data} ask={ask} />
          ) : (
            <Graph
              r={report.data}
              refreshing={report.refreshing}
              onCrossFilter={onCrossFilter}
              activeFilterValue={activeFilterValue}
            />
          )}
          <section className="panel">
            <div className="sectionhead">
              <h2>{effectiveGroup === "month" ? "Detalhamento mensal" : "Ranking · " + groupLabel(effectiveGroup, capabilities)}</h2>
              <span className="pill">
                {report.data.rows.length} {effectiveGroup === "month" ? "meses" : "registros"}
              </span>
            </div>
            {effectiveGroup !== "month" && <label className="ranking-search"><Search size={16} /><input aria-label="Pesquisar no ranking" placeholder="Pesquisar código ou descrição neste ranking" value={search} onChange={(event) => S(event.target.value)} /></label>}
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>{groupLabel(effectiveGroup, capabilities)}</th>
                    <th>Período</th>
                    <th>Ano anterior</th>
                    <th>Variação</th>
                    <th>Diferença absoluta</th>
                  </tr>
                </thead>
                <tbody>
                  {(effectiveGroup === "month" ? report.data.rows : filterRowsLocally(report.data.rows, search)).map((row) => (
                    <tr key={row.name}>
                      <td>
                        {capabilities.filters.includes(effectiveGroup as FilterDimension) && row.canDrill !== false ? (
                          <button
                            className="textlink"
                            onClick={() =>
                              drill(effectiveGroup as FilterDimension, row.key ?? row.name)
                            }
                          >
                            {row.name}
                            <ChevronRight size={12} />
                          </button>
                        ) : (
                          <span title={row.canDrill === false ? "Grupo sem valor de filtro" : undefined}>{row.name}</span>
                        )}
                      </td>
                      <td>{pretty(row.values[effectiveMetric].current, effectiveMetric)}</td>
                      <td>{pretty(row.values[effectiveMetric].previous, effectiveMetric)}</td>
                      <td>
                        <Delta r={row} m={effectiveMetric} />
                      </td>
                      <td>{absoluteChange(row.values[effectiveMetric], effectiveMetric)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.data.truncated && (
              <p className="sub">Exibindo os primeiros 30 resultados da ordenação selecionada. Para pesquisar toda a base, utilize os filtros.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
