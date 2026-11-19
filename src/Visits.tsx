import {printReport} from "./print-report";
import { CalendarDays, Download, Printer, Search, Target } from "lucide-react";
import { useEffect, useState } from "react";
import type { Filters, Session } from "../shared/domain";
import type { VisitBriefing } from "../shared/commercial";
import { api, Busy, Empty, ErrorBox, Graph, Kpis, message, period, ReportContext } from "./ui";
import { downloadWorkbook, reportSheet } from "./exports";

export default function Visits({ filters, s }: { filters: Filters; s: Session }) {
  const [query, Q] = useState(filters.client), [client, C] = useState(filters.client),
    [options, O] = useState<string[]>([]), [labels, L] = useState<Record<string, string>>({}),
    [briefing, V] = useState<VisitBriefing | null>(null), [busy, B] = useState(false), [error, E] = useState("");
  useEffect(() => {
    if (s.data?.source !== "manual" || !s.data.ready) return;
    if (!query.trim() || (client && query === labels[client])) { O([]); return; }
    let alive = true;
    const timer = setTimeout(() => { void api<{ items: { key: string; name: string }[]; truncated: boolean }>("data/search", "POST", { filters: { ...filters, client: "" }, dimension: "client", query: query.trim() }).then((data) => {
      if (alive) { O(data.items.map((item) => item.key)); L((previous) => ({ ...previous, ...Object.fromEntries(data.items.map((item) => [item.key, item.name])) })); E(""); }
    }).catch((err) => { if (alive) E(message(err)); }); }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [s.data?.activeVersionId, filters.from, filters.to, filters.region, filters.regional, filters.state, query]);
  async function prepare() {
    if (!client.trim() || busy) return;
    E(""); B(true); V(null);
    try { V(await api<VisitBriefing>("visit", "POST", { ...filters, client: client.trim() })); }
    catch (err) { E(message(err)); }
    finally { B(false); }
  }
  const matches = options.filter((code) => (labels[code] ?? code).toLocaleLowerCase("pt-BR").includes(query.toLocaleLowerCase("pt-BR"))).slice(0, 15);
  return <div className="stack visit-page">
    <div className="pageintro"><div className="mini"><CalendarDays size={15} /> Preparação comercial</div><h1>Preparar visita</h1><p>Transforme o histórico autorizado do cliente em uma pauta para a reunião.</p></div>
    <form className="panel visit-selector" onSubmit={(event) => { event.preventDefault(); void prepare(); }}>
      <label>Pesquisar cliente por código ou nome<div className="ranking-search"><Search size={16} /><input required maxLength={100} disabled={busy} aria-label="Cliente da visita" autoComplete="off" value={query} onChange={(event) => { Q(event.target.value); C(options.includes(event.target.value) ? event.target.value : ""); V(null); }} placeholder="Digite o código ou procure a razão social" /></div></label>
      {query && query !== (labels[client] ?? client) && matches.length > 0 && <div className="client-matches" role="list" aria-label="Clientes encontrados">{matches.map((code) => <button type="button" key={code} className={"client-match " + (client === code ? "selected" : "")} onClick={() => { C(code); Q(labels[code] ?? code); }}><span>{labels[code] ?? code}</span>{client === code && <small>Selecionado</small>}</button>)}</div>}
      {client && <p className="sub">Cliente selecionado: <b>{labels[client] ?? client}</b> · {period(filters)}</p>}
      {!client && query && matches.length === 0 && <p className="sub">Nenhum nome encontrado. Confira a pesquisa ou informe o código exato.</p>}
      {!client && query && <button type="button" className="textlink" onClick={() => C(query.trim())}>Usar o código exato {query.trim()}</button>}
      <div className="row"><button className="primary" disabled={!client || busy || !s.data?.ready}><CalendarDays size={16} />Preparar briefing</button><small className="muted">A preparação usa cálculos da fonte e funciona sem uma chave de IA.</small></div>
    </form>
    {error && <ErrorBox>{error}</ErrorBox>}
    {busy && <Busy label="Consultando histórico, mix e variações do cliente…" />}
    {!briefing && !busy && <Empty title="Uma reunião preparada com dados">Selecione o cliente correto. Nomes semelhantes aparecem separados pelo código para evitar analisar outra conta.</Empty>}
    {briefing && <VisitResult briefing={briefing} />}
  </div>;
}

export function VisitResult({ briefing }: { briefing: VisitBriefing }) {
  const losses = { ...briefing.productLosses, rows: briefing.productLosses.rows.filter((row) => row.values.revenue.current != null && row.values.revenue.previous != null && row.values.revenue.current < row.values.revenue.previous) };
  return <div className="stack visit-result">
      <section className="panel visit-overview"><div className="sectionhead"><div><div className="mini">Briefing de visita</div><h2>{briefing.client.name}</h2><p className="sub">Código {briefing.client.code} · {briefing.client.municipality ?? "Município indisponível"}{briefing.client.states.length > 0 ? " · " + briefing.client.states.join(", ") : ""}</p></div><div className="report-actions"><button className="soft compact" onClick={() => printReport(briefing.timeline,briefing)}><Printer size={15} />Imprimir / PDF</button><button className="soft compact" onClick={() => downloadWorkbook([
        reportSheet(briefing.timeline, "Histórico"), reportSheet(briefing.products, "Mix"), reportSheet(briefing.productLosses, "Perdas de mix"),
        { name: "Pauta", rows: [["Cliente", briefing.client.name], ["Período", period(briefing.filters)], ["Categorias",JSON.stringify({incluir:briefing.filters.categoriesInclude??[],excluir:briefing.filters.categoriesExclude??[]})], ["Resumo", briefing.summary], ...briefing.objectives.map((text) => ["Objetivo", text]), ...briefing.questions.map((text) => ["Pergunta", text]), ...briefing.recommendations.map((text) => ["Recomendação", text]), ...briefing.limitations.map((text) => ["Limitação", text])] },
      ], "visita-" + briefing.client.code)}><Download size={15} />Excel</button></div></div>
      <p className="visit-summary">{briefing.summary}</p><dl className="visit-facts"><div><dt>Representante</dt><dd>{briefing.client.representatives.join(", ") || "Indisponível"}</dd></div><div><dt>Regional</dt><dd>{briefing.client.regionals.join(", ") || "Indisponível"}</dd></div><div><dt>Última compra no recorte</dt><dd>{briefing.activity.lastPurchase ?? (briefing.activity.lastPurchaseMonth ? briefing.activity.lastPurchaseMonth + " (mês)" : "Indisponível")}</dd></div><div><dt>Meses com compra</dt><dd>{briefing.activity.monthsWithPurchases} de {briefing.activity.monthsAnalyzed} analisados{briefing.activity.purchaseDays != null ? ` · ${briefing.activity.purchaseDays} dias com compra` : ""}</dd></div></dl></section>
      <ReportContext r={briefing.timeline} /><Kpis r={briefing.timeline} /><Graph r={briefing.timeline} />
      <section className="panel"><div className="mini"><Target size={14} /> Diagnóstico fundamentado</div><h2>O que levar para a conversa</h2><div className="insight-list">{briefing.insights.map((insight) => <article className={"commercial-insight " + insight.severity} key={insight.id}><span className="pill">{insight.kind === "fact" ? "Fato observado" : insight.kind === "hypothesis" ? "Hipótese a confirmar" : "Recomendação"}</span><h3>{insight.title}</h3><p>{insight.detail}</p><small>{insight.period.from} a {insight.period.to}</small><p className="insight-action">{insight.action}</p></article>)}</div></section>
      <Graph r={briefing.products} />{losses.rows.length > 0 ? <Graph r={losses} title="Produtos com queda no período comparável" /> : <section className="panel"><h3>Quedas de mix</h3><p className="sub">O ranking retornado não contém produtos com queda e valores disponíveis nos dois períodos. Produtos sem base comparável precisam de investigação específica.</p></section>}{briefing.categories && <Graph r={briefing.categories} />}
      <div className="visit-plan">{[["Objetivos da reunião", briefing.objectives], ["Perguntas para o cliente", briefing.questions], ["Próximas ações sugeridas", briefing.recommendations]].map(([title, list]) => <section className="panel" key={title as string}><h2>{title as string}</h2><ol>{(list as string[]).map((text) => <li key={text}>{text}</li>)}</ol></section>)}</div>
      {briefing.limitations.length > 0 && <section className="panel limitations"><h3>Limites desta análise</h3><ul>{briefing.limitations.map((item) => <li key={item}>{item}</li>)}</ul></section>}
  </div>;
}
