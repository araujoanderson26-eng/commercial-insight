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
} from "lucide-react";
import { useState } from "react";

import {
  groups,
  metricKeys,
  metrics,
  pretty,
  type Filters,
  type Group,
  type Metric,
  type Plan,
  type Session,
} from "../shared/domain";
import { Busy, Delta, ErrorBox, Graph, Kpis, planFor, Signals, useReport } from "./ui";
export const mainNav = [
  { p: "inicio", label: "Início", icon: House },
  { p: "conversas", label: "Conversas", icon: MessageCircle },
  { p: "relatorios", label: "Relatórios", icon: ChartNoAxesColumnIncreasing },
  { p: "clientes", label: "Clientes", icon: Users },
  { p: "produtos", label: "Produtos e mix", icon: Boxes },
  { p: "alertas", label: "Alertas e ações", icon: Bell },
];
export const adminNav = [
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
    desc: "Histórico, evolução e margem.",
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
    to: "visita",
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
}: {
  s: Session;
  filters: Filters;
  go: Go;
  ask: (q: string) => void;
  card: (p: string) => void;
  ready: boolean;
}) {
  const [q, Q] = useState(""),
    [refresh, R] = useState(0),
    report = useReport(planFor(filters), ready, refresh);
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
            <br className="wideonly" /> com os dados do seu Power BI.
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
                q.trim().length > 1 ? ask(q) : card("pergunta");
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
        ) : report.error ? (
          <ErrorBox>{report.error}</ErrorBox>
        ) : report.data ? (
          <>
            <Kpis r={report.data} />
            <div className="analytics">
              <Graph r={report.data} />
              <Signals r={report.data} ask={ask} />
            </div>
          </>
        ) : (
          <Busy />
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
  drill,
}: {
  page: string;
  filters: Filters;
  ready: boolean;
  s: Session;
  go: Go;
  ask: (q: string) => void;
  initialGroup: Group;
  drill: (key: "client" | "product" | "region", name: string) => void;
}) {
  const group0 = page === "clientes" ? "client" : page === "produtos" ? "product" : initialGroup;
  const [group, G] = useState<Group>(group0),
    [metric, M] = useState<Metric>("revenue"),
    [order, O] = useState<Plan["order"]>("current"),
    [refresh, R] = useState(0);
  const report = useReport({ ...planFor(filters, group, metric), order }, ready, refresh);
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
      <div className="panel toolbar">
        <label>
          Agrupar por
          <select value={group} onChange={(e) => G(e.target.value as Group)}>
            {Object.entries(groups).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Indicador
          <select value={metric} onChange={(e) => M(e.target.value as Metric)}>
            {metricKeys.map((k) => (
              <option key={k} value={k}>
                {metrics[k].label}
              </option>
            ))}
          </select>
        </label>
        {group !== "month" && (
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
      </div>
      {!ready ? (
        <Connection s={s} go={go} />
      ) : report.error ? (
        <ErrorBox>{report.error}</ErrorBox>
      ) : !report.data ? (
        <Busy />
      ) : (
        <>
          <Kpis r={report.data} />
          {page === "alertas" ? <Signals r={report.data} ask={ask} /> : <Graph r={report.data} />}
          <section className="panel">
            <div className="sectionhead">
              <h2>{group === "month" ? "Detalhamento mensal" : "Ranking · " + groups[group]}</h2>
              <span className="pill">
                {report.data.rows.length} {group === "month" ? "meses" : "registros"}
              </span>
            </div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>{groups[group]}</th>
                    <th>Período</th>
                    <th>Ano anterior</th>
                    <th>Variação</th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.rows.map((row) => (
                    <tr key={row.name}>
                      <td>
                        {["region", "product", "client"].includes(group) ? (
                          <button
                            className="textlink"
                            onClick={() =>
                              drill(group as "region" | "product" | "client", row.name)
                            }
                          >
                            {row.name}
                            <ChevronRight size={12} />
                          </button>
                        ) : (
                          row.name
                        )}
                      </td>
                      <td>{pretty(row.values[metric].current, metric)}</td>
                      <td>{pretty(row.values[metric].previous, metric)}</td>
                      <td>
                        <Delta r={row} m={metric} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.data.truncated && (
              <p className="sub">Exibindo os primeiros 30 resultados da ordenação selecionada.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
