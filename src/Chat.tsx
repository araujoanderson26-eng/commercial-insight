import {
  ArrowUp,
  ChevronRight,
  History,
  MessageCircle,
  Plus,
  Sparkles,
  Target,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  groups,
  metrics,
  type Commentary,
  type Filters,
  type Plan,
  type Report,
} from "../shared/domain";
import { api, Busy, Empty, ErrorBox, Graph, Kpis, message, period } from "./ui";
type Turn = {
  id: string;
  question: string;
  plan: Plan;
  created: number;
  source_type?: string;
  source_version?: string | null;
  report?: Report;
  commentary?: Commentary;
};
type Thread = { id: string; title: string; updated: number };
export type Seed = { question: string; send: boolean; key: number };
function Answer({ turn, onLoad }: { turn: Turn; onLoad: (r: Report, c: Commentary) => void }) {
  const [err, E] = useState(""),
    [busy, B] = useState(false);
  async function refresh() {
    E("");
    B(true);
    try {
      const v = await api<{ report: Report; commentary: Commentary }>(
        "turns/" + turn.id + "/reopen",
        "POST",
        {},
      );
      onLoad(v.report, v.commentary);
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
        </div>
        <h2>
          {metrics[turn.plan.metric].label} · {groups[turn.plan.group]}
        </h2>
        <p className="sub">
          {period(turn.plan.filters)}
          {[turn.plan.filters.region, turn.plan.filters.client, turn.plan.filters.product]
            .filter(Boolean)
            .map((t) => " · " + t)}
        </p>
        {turn.report ? (
          <>
            <Kpis r={turn.report} />
            <Graph r={turn.report} />
            {turn.commentary && (
              <>
                <div className="aibox">
                  <h3>
                    <Sparkles size={16} /> Minha análise
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
    [remove, R] = useState<string | null>(null);
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
      const v = await api<{ id: string; turn: string; report: Report; commentary: Commentary }>(
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
          report: v.report,
          commentary: v.commentary,
        },
      ]);
    } catch (e) {
      E(message(e));
      D(q);
    } finally {
      P("");
      B(false);
      guard.current = false;
    }
  }
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
              Abra uma nova conversa para analisar faturamento, carteira ou margem.
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
                <p className="sub">A análise considera o modelo publicado e suas permissões.</p>
                {[
                  "Como está meu faturamento em relação ao ano anterior?",
                  "Quais clientes mais perderam faturamento?",
                  "Quais produtos lideram no período?",
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
                onLoad={(report, commentary) =>
                  T((prior) => prior.map((v) => (v.id === t.id ? { ...v, report, commentary } : v)))
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
        </>
      )}
    </div>
  );
}
