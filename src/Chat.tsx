import {printReport} from "./print-report";
import {
  ArrowUp,
  ChevronRight,
  History,
  MessageCircle,
  Plus,
  Sparkles,
  Target,
  Trash2,
  Download,
  Printer,
  Star,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  type Commentary,
  type Filters,
  type Plan,
  type Report,
} from "../shared/domain";
import type { AssistantStatus, VisitBriefing } from "../shared/commercial";
import { VisitResult } from "./Visits";
import { filterLabel } from "./export-model";
import { api, Busy, Empty, ErrorBox, Graph, Kpis, message, period, groupLabel, metricLabel, ReportContext } from "./ui";
import { exportReport } from "./exports";
type Turn = {
  id: string;
  question: string;
  plan: Plan;
  created: number;
  source_type?: string;
  source_version?: string | null;
  engine?: "deterministic" | "openai";
  report?: Report;
  commentary?: Commentary;
  visit?: VisitBriefing;
};
type Thread = { id: string; title: string; updated: number };
export type Seed = { question: string; send: boolean; key: number };

function advancedModeBadge(reason?: AssistantStatus["reason"]) {
  switch (reason) {
    case "ready":
      return "Disponível";
    case "credits_unverified":
      return "Aguardando verificação de créditos";
    case "budget_exhausted":
      return "Orçamento mensal atingido";
    case "policy_disabled":
      return "Aguardando liberação financeira";
    case "account_not_authorized":
      return "Restrita ao administrador autorizado";
    case "request_in_progress":
      return "Chamada em conciliação";
    case "source_disabled":
      return "Desabilitada para esta fonte";
    case "credential_missing":
      return "Credencial OpenAI pendente";
    default:
      return "Temporariamente indisponível";
  }
}
function Answer({ turn, onLoad }: { turn: Turn; onLoad: (r: Report, c: Commentary, visit?: VisitBriefing) => void }) {
  const [err, E] = useState(""),
    [busy, B] = useState(false), [saved, S] = useState(false);
  async function favorite() {
    try { await api("saved-reports", "POST", { title: turn.question.slice(0, 120), plan: turn.plan, question: turn.question }); S(true); }
    catch (error) { E(message(error)); }
  }
  async function refresh() {
    E("");
    B(true);
    try {
      const v = await api<{ report: Report; commentary: Commentary; visit?: VisitBriefing }>(
        "turns/" + turn.id + "/reopen",
        "POST",
        {},
      );
      onLoad(v.report, v.commentary, v.visit);
    } catch (e) {
      E(message(e));
    } finally {
      B(false);
    }
  }
  return (
    <article className="turn">
      <div className="bubble">{turn.question}</div>
      <div className="answer">
        <div className="mini">
          <Sparkles size={15} /> Comercial Insight
          {turn.engine === "deterministic" && (
            <span className="pill good">Consulta comercial direta (D1)</span>
          )}
          {turn.engine === "openai" && (
            <span className="pill">Análise avançada (OpenAI)</span>
          )}
        </div>
        <h2>
          {metricLabel(turn.plan.metric, turn.report?.sourceInfo?.capabilities)} · {groupLabel(turn.plan.group, turn.report?.sourceInfo?.capabilities)}
        </h2>
        <p className="sub">
          {period(turn.plan.filters)}
          {turn.report ? ` · ${filterLabel(turn.report)}` : ""}
        </p>
        {turn.visit ? <VisitResult briefing={turn.visit} /> : turn.report ? (
          <>
            <ReportContext r={turn.report} />
            <div className="report-actions"><button className="soft compact" onClick={() => exportReport(turn.report!)}><Download size={14} />Excel</button><button className="soft compact" onClick={() => printReport(turn.report!)}><Printer size={14} />Imprimir / PDF</button><button className="soft compact" disabled={saved} onClick={() => void favorite()}><Star size={14} />{saved ? "Consulta salva" : "Salvar consulta"}</button></div>
            <Kpis r={turn.report} />
            <Graph r={turn.report} />
            {turn.commentary && (
              <>
                <div className="aibox">
                  <h3>
                    <Sparkles size={16} /> Leitura dos resultados
                  </h3>
                  <p>{turn.commentary.summary}</p>
                </div>
                {turn.commentary.actions.length > 0 && (
                  <div className="actionsbox">
                    <h3>
                      <Target size={16} /> Prioridades recomendadas
                    </h3>
                    <ol>
                      {turn.commentary.actions.map((v, i) => (
                        <li key={i}>{v}</li>
                      ))}
                    </ol>
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <button className="soft" onClick={refresh} disabled={busy}>
            {busy ? "Consultando…" : turn.source_type === "manual" ? "Reabrir valores da versão original" : "Consultar valores na fonte online"}
            <ChevronRight size={15} />
          </button>
        )}
        {err && <ErrorBox>{err}</ErrorBox>}
      </div>
    </article>
  );
}
export default function Chat({
  filters,
  seed,
  initialId,
  clearSeed,
}: {
  filters: Filters;
  seed: Seed | null;
  initialId: string | null;
  clearSeed: () => void;
}) {
  const [id, I] = useState<string | null>(initialId),
    [turns, T] = useState<Turn[]>([]),
    [draft, D] = useState(seed?.question || ""),
    [busy, B] = useState(false),
    [pending, P] = useState(""),
    [err, E] = useState(""),
    [list, L] = useState(!seed && !initialId),
    [threads, H] = useState<Thread[]>([]),
    [remove, R] = useState<string | null>(null),
    [status, ST] = useState<AssistantStatus | null>(null);
  const guard = useRef(false),
    end = useRef<HTMLDivElement>(null),
    used = useRef(false);
  async function historyList() {
    L(true);
    E("");
    try {
      H(await api<Thread[]>("conversations"));
    } catch (e) {
      E(message(e));
    }
  }
  async function open(thread: string) {
    E("");
    B(true);
    L(false);
    try {
      const rows = await api<Turn[]>("conversations/" + thread);
      I(thread);
      T(rows);
    } catch (e) {
      E(message(e));
    } finally {
      B(false);
    }
  }
  function fresh() {
    I(null);
    T([]);
    L(false);
    D("");
    E("");
  }
  async function send(q: string, thread = id) {
    if (q.trim().length < 2 || guard.current) return;
    guard.current = true;
    E("");
    B(true);
    P(q);
    L(false);
    D("");
    try {
      const v = await api<{
        id: string;
        turn: string;
        report: Report;
        commentary: Commentary;
        visit?: VisitBriefing;
        meta?: { engine?: "deterministic" | "openai"; latencyMs?: number; openaiCalls?: number };
      }>(
        "chat",
        "POST",
        { question: q.trim(), conversation: thread, filters },
      );
      I(v.id);
      T((t) => [
        ...t,
        {
          id: v.turn,
          question: q,
          plan: v.report.plan,
          created: Date.now() / 1000,
          engine: v.meta?.engine,
          report: v.report,
          commentary: v.commentary,
          visit: v.visit,
        },
      ]);
    } catch (e) {
      E(message(e));
      D(q);
    } finally {
      P("");
      B(false);
      guard.current = false;
      void api<AssistantStatus>("assistant/status").then(ST).catch(() => {});
    }
  }
  useEffect(() => {
    let alive = true;
    api<AssistantStatus>("assistant/status").then((value) => { if (alive) ST(value); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (used.current) return;
    used.current = true;
    if (seed) {
      clearSeed();
      if (seed.send) void send(seed.question, null);
    } else if (initialId) void open(initialId);
    else void historyList();
  }, []);
  useEffect(() => {
    if (turns.length || pending)
      end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [turns.length, pending]);
  async function drop(thread: string) {
    try {
      await api("conversations/" + thread, "DELETE");
      if (id === thread) {
        I(null);
        T([]);
      }
      R(null);
      await historyList();
    } catch (e) {
      E(message(e));
    }
  }
  return (
    <div className="stack">
      <div className="pageintro split">
        <div>
          <div className="mini">
            <Sparkles size={15} /> Inteligência comercial com IA
          </div>
          <h1>{list ? "Conversas" : "Assistente comercial"}</h1>
          <p>
            {list
              ? "Retome uma pergunta ou inicie uma nova análise."
              : "Consulte os dados do seu escopo em linguagem natural."}
          </p>
        </div>
        <div className="row">
          {!list && (
            <button disabled={busy} className="soft" onClick={historyList}>
              <History size={16} />
              Histórico
            </button>
          )}
          <button disabled={busy} className="primary" onClick={fresh}>
            <Plus size={16} />
            Nova conversa
          </button>
        </div>
      </div>
      {err && <ErrorBox>{err}</ErrorBox>}
      {status && (() => {
        const deterministicReady = status.deterministic?.ready ?? false;
        const deterministicMsg =
          status.deterministic?.message ??
          "Consultas comerciais diretas indisponíveis para esta fonte.";
        const advancedReady = status.advancedAI?.ready ?? status.ready;
        const advancedReason = status.advancedAI?.reason ?? status.reason;
        const advancedMsg = status.advancedAI?.message ?? status.message;
        return (
          <div
            className={`panel assistant-status ${advancedReady ? "is-ready" : "is-limited"}`}
            role="status"
            aria-label="Disponibilidade do assistente"
          >
            <div className="assistant-modes">
              <div className="assistant-mode">
                <div className="assistant-mode-head">
                  <strong>Consultas comerciais</strong>
                  <span className={deterministicReady ? "pill good" : "pill warn"}>
                    {deterministicReady ? "Disponíveis" : "Indisponíveis"}
                  </span>
                </div>
                <p className="sub">{deterministicMsg}</p>
              </div>
              <div className="assistant-mode">
                <div className="assistant-mode-head">
                  <strong>Análise avançada com OpenAI</strong>
                  <span className={advancedReady ? "pill good" : "pill warn"}>
                    {advancedModeBadge(advancedReason)}
                  </span>
                </div>
                <p className="sub">{advancedMsg}</p>
              </div>
            </div>
            {!advancedReady && (
              <>
                <p className="sub">
                  {deterministicReady
                    ? "Você pode fazer perguntas comerciais diretas aqui mesmo (faturamento, clientes, representantes, categorias e quedas) ou abrir os relatórios e visitas."
                    : "Você pode consultar os relatórios e preparar uma visita com os dados autorizados."}
                </p>
                <div className="report-actions">
                  <a className="soft compact" href="/relatorios">Abrir relatórios</a>
                  <a className="soft compact" href="/visitas">Preparar visita</a>
                </div>
              </>
            )}
          </div>
        );
      })()}
        {status?.budget && <section className="panel" aria-label="Consumo da IA">
          <strong>Orçamento da IA · {status.budget.month} (UTC)</strong>
          <p>Limite mensal: US$ {status.budget.capUsd.toFixed(2)}. Reservas comprometidas: US$ {status.budget.reservedUsd.toFixed(4)}. Consumo com tokens conhecidos, sem desconto de cache: US$ {status.budget.usageUpperUsd.toFixed(6)}.</p>
          <p className="sub">As reservas incluem margem de segurança e chamadas com consumo desconhecido; não são o valor da fatura. A disponibilidade depende também dos créditos verificados.</p>
          {status.budget.unknownUsageCount > 0 && <p role="status">Há {status.budget.unknownUsageCount} chamada(s) sem consumo confirmado.</p>}
          {status.budget.alerts.map(alert => <p role="alert" key={alert.thresholdUsd + alert.event}>{alert.event === 'budget_blocked' ? 'Novas chamadas bloqueadas por orçamento ou créditos insuficientes.' : `Alerta: as reservas atingiram US$ ${alert.thresholdUsd.toFixed(2)} no mês.`}</p>)}
        </section>}
      {list ? (
        <section className="panel">
          {threads.length ? (
            threads.map((t) => (
              <div className="thread" key={t.id}>
                <button onClick={() => open(t.id)}>
                  <MessageCircle size={17} />
                  <div>
                    <b>{t.title}</b>
                    <small>{new Date(t.updated * 1000).toLocaleString("pt-BR")}</small>
                  </div>
                </button>
                {remove === t.id ? (
                  <>
                    <button className="textlink" onClick={() => drop(t.id)}>
                      Excluir
                    </button>
                    <button className="textlink" onClick={() => R(null)}>
                      Cancelar
                    </button>
                  </>
                ) : (
                  <button className="iconbtn" aria-label="Excluir conversa" onClick={() => R(t.id)}>
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))
          ) : (
            <Empty title="Sua primeira conversa começa aqui">
              Abra uma nova conversa para analisar faturamento, carteira ou produtos.
            </Empty>
          )}
        </section>
      ) : (
        <>
          <div className="chatbody">
            {!turns.length && !pending && !busy && (
              <div className="chatintro panel">
                <div className="aigem">
                  <Sparkles />
                </div>
                <h2>Que resultado você quer entender?</h2>
                <p className="sub">Consultas comerciais diretas respondem pelos dados autorizados no D1 sem consumir créditos OpenAI.</p>
                {[
                  "Quanto faturamos em 2026?",
                  "Quais clientes apresentaram maior queda?",
                  "Quanto vendemos de Suco e Vinho, excluindo Granel?",
                  "Quantos representantes venderam em 2026?",
                ].map((q) => (
                  <button key={q} className="suggest" onClick={() => D(q)}>
                    {q}
                    <ChevronRight size={15} />
                  </button>
                ))}
              </div>
            )}
            {turns.map((t) => (
              <Answer
                key={t.id}
                turn={t}
                onLoad={(report, commentary, visit) =>
                  T((prior) => prior.map((v) => (v.id === t.id ? { ...v, report, commentary, visit } : v)))
                }
              />
            ))}
            {pending && <div className="bubble">{pending}</div>}
            {busy && (
              <Busy label={pending ? "Analisando os dados autorizados…" : "Carregando conversa…"} />
            )}
            <div ref={end} />
          </div>
          <form
            className="composer"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void send(draft);
            }}
          >
            <Sparkles size={20} />
            <textarea
              aria-label="Sua pergunta"
              rows={1}
              maxLength={900}
              value={draft}
              onChange={(e) => D(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(draft);
                }
              }}
              placeholder="Faça outra pergunta…"
            />
            <button
              aria-label="Enviar pergunta"
              className="send"
              disabled={busy || draft.trim().length < 2}
            >
              <ArrowUp size={20} />
            </button>
          </form>
          <p className="chat-footnote">Valores vêm da fonte autorizada. Recomendações comerciais precisam ser avaliadas na reunião. A conversa preserva o contexto das perguntas anteriores.</p>
        </>
      )}
    </div>
  );
}
