import {
  Bell,
  CalendarDays,
  Check,
  ChevronRight,
  LayoutGrid,
  SlidersHorizontal,
  WifiOff,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  defaultFilters,
  filtersSchema,
  roles,
  type Filters,
  type Group,
  type Session,
  type FilterDimension,
  type Plan,
} from "../shared/domain";
import { Audit, Integrations, Team } from "./Admin";
import Auth from "./Auth";
import Chat, { type Seed } from "./Chat";
import Profile from "./Profile";
import { DataUpdates } from "./DataUpdates";
import Visits from "./Visits";
import "./style.css";
import { api, Brand, Busy, Credit, Empty, ErrorBox, isAbortError, message, period, sessionCapabilities } from "./ui";
import { adminNav, Home, mainNav, navs, Reports } from "./WorkspaceViews";
const cleanPath = () => location.pathname === "/admin/atualizacao-dados" ? "atualizacao-dados" : location.pathname.split("/")[1] || "inicio";
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section>
        <div className="sectionhead">
          <h2>{title}</h2>
          <button className="iconbtn" aria-label="Fechar" onClick={close}>
            <X size={19} />
          </button>
        </div>
        {children}
      </section>
    </dialog>
  );
}
function FilterForm({
  value,
  apply,
  s,
  focusClient = false,
}: {
  value: Filters;
  apply: (f: Filters) => void;
  s: Session;
  focusClient?: boolean;
}) {
  const [f, F] = useState(value),
    [err, E] = useState(""),
    [options, O] = useState<Partial<Record<FilterDimension, string[]>>>({}),
    [optionLabels, OL] = useState<Partial<Record<FilterDimension, Record<string, string>>>>({});
  const capabilities = sessionCapabilities(s);
  const selectedDimensions = capabilities.filters;
  useEffect(() => {
    if (s.data?.source !== "manual" || !s.data.ready) return;
    const valid = filtersSchema.safeParse(f);
    if (!valid.success) return;
    let alive = true;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<{ values: typeof options; labels?: typeof optionLabels }>("data/options", "POST", valid.data, controller.signal)
        .then((v) => { if (alive) { O(v.values); OL(v.labels ?? {}); E(""); } })
        .catch((e) => { if (alive && !isAbortError(e)) E(message(e)); });
    }, 300);
    return () => { alive = false; clearTimeout(timer); controller.abort(); };
  }, [s.data?.activeVersionId, f.from, f.to]);
  function save(e: FormEvent) {
    e.preventDefault();
    const parsed = filtersSchema.safeParse(f);
    if (!parsed.success) {
      E("Informe entre 1 e 24 meses completos e confira os filtros.");
      return;
    }
    const supported = { ...parsed.data };
    for (const dimension of ["regional", "state", "manager", "category"] as const)
      if (!capabilities.filters.includes(dimension)) delete supported[dimension];
    apply(supported);
  }
  return (
    <form className="formpanel" onSubmit={save}>
      <div className="formgrid">
        {(["from", "to"] as const).map((k, i) => (
          <label key={k}>
            {i ? "Último mês" : "Primeiro mês"}
            <input
              required
              type="month"
              value={f[k]}
              onChange={(e) => F({ ...f, [k]: e.target.value })}
            />
          </label>
        ))}
      </div>
      {selectedDimensions.map((k) => {
        const list = k === "region" ? s.user.regions : k === "client" ? s.user.clients : [];
        const title = capabilities.labels?.[k] ?? { region: "Regional", client: "Cliente", product: "Produto", regional: "Regional comercial", state: "UF", manager: "Gerente", category: "Categoria" }[k];
        return (
          <label key={k}>
            {title}
            {list.length && !(s.user.role === "admin" || (s.user.role === "diretoria" && s.user.national)) ? (
              <select value={f[k] ?? ""} onChange={(e) => F({ ...f, [k]: e.target.value })}>
                <option value="">Todos no meu escopo</option>
                {list.map((v) => (
                  <option key={v} value={v}>{optionLabels[k]?.[v] ?? v}</option>
                ))}
              </select>
            ) : (
              <input
                list={"source-options-" + k}
                autoFocus={focusClient && k === "client"}
                maxLength={140}
                value={f[k] ?? ""}
                onChange={(e) => F({ ...f, [k]: e.target.value })}
                placeholder={"Todos · pesquise código ou descrição"}
              />
            )}
            <datalist id={"source-options-" + k}>
              {(options[k] ?? []).map((v) => <option key={v} value={v} label={optionLabels[k]?.[v] ?? v} />)}
            </datalist>
            {optionLabels[k]?.[f[k] ?? ""] && <small className="muted">{optionLabels[k]![f[k] ?? ""]}</small>}
            {k === "region" && capabilities.labels?.region === "Representante" && <small className="muted">As permissões cadastradas para este campo continuam aplicadas ao representante autorizado.</small>}
          </label>
        );
      })}
      {err && <ErrorBox>{err}</ErrorBox>}
      <div className="row spread">
        <button type="button" className="soft" onClick={() => F(defaultFilters())}>
          Limpar
        </button>
        <button className="primary">
          <Check size={15} />
          Aplicar filtros
        </button>
      </div>
    </form>
  );
}
function Shell({ s, reload, logout }: { s: Session; reload: () => void; logout: () => void }) {
  const [page, V] = useState(cleanPath),
    [filters, F] = useState(defaultFilters),
    [modal, W] = useState(""),
    [seed, S] = useState<Seed | null>(null),
    [chatKey, K] = useState(0),
    [reportGroup, G] = useState<Group>("month"),
    [restoredPlan, RP] = useState<Plan | undefined>();
  const ready =
      s.data?.ready ?? (s.integrations.configured && (s.integrations.mode === "application" || s.integrations.linked)),
    admin = s.user.role === "admin",
    operator = s.user.role === "operador";
  useEffect(() => { if (operator && page !== "atualizacao-dados" && page !== "perfil" && page !== "mais") go("atualizacao-dados"); }, [operator, page]);
  const sourceFilters = JSON.stringify(sessionCapabilities(s).filters);
  useEffect(() => {
    const supported = JSON.parse(sourceFilters) as FilterDimension[];
    F((current) => {
      const next = { ...current };
      for (const dimension of ["regional", "state", "manager", "category"] as const)
        if (!supported.includes(dimension)) delete next[dimension];
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  }, [sourceFilters]);
  function go(p: string) {
    W("");
    if (p !== page) {
      history.pushState({}, "", p === "inicio" ? "/" : p === "atualizacao-dados" ? "/admin/atualizacao-dados" : "/" + p);
      V(p);
      window.scrollTo(0, 0);
    }
  }
  useEffect(() => {
    const fn = () => {
      V(cleanPath());
      W("");
    };
    window.addEventListener("popstate", fn);
    return () => window.removeEventListener("popstate", fn);
  }, []);
  function chat(question: string, send: boolean) {
    S({ question, send, key: Date.now() });
    K((k) => k + 1);
    go("conversas");
  }
  function card(p: string) {
    if (p === "pergunta") return chat("", false);
    if (p === "analisar") return W("analisar");
    if (p === "visita") return W("visita");
    if (p === "regional") {
      G(sessionCapabilities(s).groups.includes("regional") ? "regional" : "region");
      return go("relatorios");
    }
    go(p);
  }
  const navigation = (items: typeof mainNav) =>
    items.map((n) => (
      <button
        key={n.p}
        className={page === n.p ? "navitem active" : "navitem"}
        onClick={() => {
          if (n.p === "relatorios") { G("month"); RP(undefined); }
          go(n.p);
        }}
      >
        <n.icon size={18} />
        {n.label}
      </button>
    ));
  const initials = s.user.name
    .trim()
    .split(/\s+/)
    .filter((_, i, a) => i === 0 || i === a.length - 1)
    .map((v) => v[0])
    .join("");
  return (
    <div className="workspace">
      <aside className="sidebar">
        <Brand />
        <div className="sidegroup">
          <p>Navegação</p>
          {navigation(operator ? adminNav.slice(0, 1) : mainNav)}
        </div>
        {admin && (
          <div className="sidegroup">
            <p>Administração</p>
            {navigation(adminNav)}
          </div>
        )}
        <div className="sidebottom">
          <div className="sideprofile" onClick={() => go("perfil")}>
            <button className="avatar" aria-label="Meu perfil">
              {initials}
            </button>
            <div>
              <b>{s.user.name}</b>
              <small>{roles[s.user.role]}</small>
            </div>
            <ChevronRight size={14} />
          </div>
          <Credit />
        </div>
      </aside>
      <main className="surface">
        <header className="topbar">
          <div className="breadcrumb">
            <LayoutGrid size={16} />
            <span>Workspace comercial</span>
            <ChevronRight size={13} />
            <b>{navs.find((n) => n.p === page)?.label || "Início"}</b>
          </div>
          <div className="mobilebrand">
            <Brand />
          </div>
          <div className="row">
            <button
              className="iconbtn"
              onClick={() => go("alertas")}
              aria-label="Notificações comerciais"
            >
              <Bell size={19} />
            </button>
            <button className="avatar small" onClick={() => go("perfil")} aria-label="Meu perfil">
              {initials}
            </button>
          </div>
        </header>
        <div className="content">
          {s.data?.source === "manual" && (
            <div className="notice" role="status">
              {s.data.extractedAt ? "Arquivo manual · base extraída em " + new Date(s.data.extractedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "Arquivo manual · nenhuma versão válida publicada."}
              {s.data.stale ? " · Base desatualizada: solicite uma atualização ao administrador." : ""}
            </div>
          )}
          {!["integracoes", "atualizacao-dados", "equipe", "auditoria", "perfil", "mais"].includes(page) && (
            <div className="filterbar">
              <div className="filterdate">
                <CalendarDays size={15} />
                {period(filters)}
              </div>
              <button onClick={() => W("filtros")} className="filterbtn">
                <SlidersHorizontal size={15} />
                Filtros
                {sessionCapabilities(s).filters.map((dimension) => filters[dimension]).filter(Boolean).length > 0
                  ? " · " + sessionCapabilities(s).filters.map((dimension) => filters[dimension]).filter(Boolean).length
                  : ""}
              </button>
            </div>
          )}
          {page === "inicio" ? (
            <Home
              s={s}
              filters={filters}
              ready={ready}
              go={go}
              ask={(q) => chat(q, true)}
              card={card}
            />
          ) : page === "conversas" ? (
            <Chat
              key={chatKey}
              seed={seed}
              initialId={null}
              clearSeed={() => S(null)}
              filters={filters}
            />
          ) : page === "visitas" ? (
            <Visits filters={filters} s={s} />
          ) : ["relatorios", "produtos", "clientes", "alertas"].includes(page) ? (
            <Reports
              key={page + reportGroup + JSON.stringify(restoredPlan)}
              page={page}
              filters={filters}
              ready={ready}
              s={s}
              go={go}
              ask={(q) => chat(q, true)}
              initialGroup={reportGroup}
              initialPlan={restoredPlan}
              restore={(plan) => { F(plan.filters); G(plan.group); RP(plan); go("relatorios"); }}
              drill={(k, v) => {
                F({ ...filters, [k]: v });
                G("month");
                RP(undefined);
                go("relatorios");
              }}
            />
          ) : page === "perfil" ? (
            <Profile s={s} logout={logout} reload={reload} />
          ) : page === "integracoes" && admin ? (
            <Integrations changed={reload} />
          ) : page === "atualizacao-dados" && (admin || operator) ? (
            <DataUpdates changed={reload} operator={operator} />
          ) : page === "equipe" && admin ? (
            <Team self={s.user.id} scopeLabel={sessionCapabilities(s).labels?.region === "Representante" ? "Representantes" : "Regionais"} />
          ) : page === "auditoria" && admin ? (
            <Audit />
          ) : page === "mais" ? (
            <section className="panel moremenu">
              <h1>Mais opções</h1>
              {navigation([
                ...(operator ? [] : mainNav.slice(4)),
                ...(admin ? adminNav : []),
                navs.find((n) => n.p === "perfil")!,
              ])}
            </section>
          ) : (
            <Empty title="Página indisponível">
              <button className="textlink" onClick={() => go("inicio")}>
                Voltar ao início
              </button>
            </Empty>
          )}
          <div className="footcredit">
            <Credit />
          </div>
        </div>
      </main>
      <nav className="mobilebar">
        {(operator ? [adminNav[0], navs.find((item) => item.p === "perfil")!] : [...mainNav.slice(0, 4), navs[navs.length - 1]]).map((n) => (
          <button
            key={n.p}
            className={
              page === n.p || (n.p === "mais" && !mainNav.slice(0, 4).some((v) => v.p === page))
                ? "active"
                : ""
            }
            onClick={() => go(n.p)}
          >
            <n.icon size={20} />
            <span>{n.label}</span>
          </button>
        ))}
      </nav>
      {modal && (
        <Modal
          title={
            modal === "analisar"
              ? "Analisar cliente"
              : modal === "visita"
                ? "Preparar visita"
                : "Filtros da análise"
          }
          close={() => W("")}
        >
          <FilterForm
            s={s}
            value={filters}
            focusClient={modal !== "filtros"}
            apply={(f) => {
              F(f);
              W("");
              if (modal === "analisar") {
                G("month");
                go(f.client ? "relatorios" : "clientes");
              }
              if (modal === "visita")
                chat(
                  f.client
                    ? "Prepare uma visita para " +
                        f.client +
                        " com base no histórico comercial disponível."
                    : "Prepare uma pauta de visita para o cliente ",
                  !!f.client,
                );
            }}
          />
        </Modal>
      )}
    </div>
  );
}
function App() {
  const [s, S] = useState<Session | null>(null),
    [wait, B] = useState(true),
    [err, E] = useState(""),
    [net, N] = useState(navigator.onLine),
    [update, U] = useState<ServiceWorker | null>(null);
  const clear = () => {
    S(null);
    if (location.pathname !== "/redefinir") history.replaceState({}, "", "/");
  };
  async function reload() {
    try {
      const v = await api<Session>("me");
      E("");
      S(v);
    } catch (e) {
      if (
        !["Entre para continuar.", "Sua sessão terminou. Entre novamente."].includes(message(e))
      ) {
        E(message(e));
      }
      clear();
    } finally {
      B(false);
    }
  }
  useEffect(() => {
    void reload();
    const offline = () => {
      N(false);
      S(null);
      E("Conecte-se à internet para consultar os dados comerciais.");
    };
    const online = () => {
      N(true);
      void reload();
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    window.addEventListener("session-ended", clear);
    const focus = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", focus);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      window.removeEventListener("session-ended", clear);
      document.removeEventListener("visibilitychange", focus);
    };
  }, []);
  useEffect(() => {
    if (!s) return;
    const t = setTimeout(clear, Math.max(1, s.expires * 1000 - Date.now()));
    return () => clearTimeout(t);
  }, [s]);
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
    let accepting = false;
    const change = () => {
      if (accepting) location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", change);
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        const announce = () => {
          if (reg.waiting && navigator.serviceWorker.controller) U(reg.waiting);
        };
        announce();
        reg.addEventListener("updatefound", () =>
          reg.installing?.addEventListener("statechange", announce),
        );
      })
      .catch(() => {});
    const accept = () => {
      accepting = true;
    };
    window.addEventListener("ci-update", accept);
    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", change);
      window.removeEventListener("ci-update", accept);
    };
  }, []);
  return (
    <>
      {!net && (
        <div className="net">
          <WifiOff size={15} />
          Sem conexão
        </div>
      )}
      {update && (
        <div className="net">
          Nova versão disponível.{" "}
          <button
            onClick={() => {
              window.dispatchEvent(new Event("ci-update"));
              update.postMessage("ACTIVATE");
            }}
          >
            Atualizar agora
          </button>
        </div>
      )}
      {err && (
        <ErrorBox>
          {err}{" "}
          <button className="textlink" onClick={reload}>
            Tentar novamente
          </button>
        </ErrorBox>
      )}
      {wait ? (
        <Busy label="Abrindo Comercial Insight…" />
      ) : s ? (
        <Shell
          key={s.user.id + "|" + s.policyVersion + "|" + JSON.stringify(s.user)}
          s={s}
          reload={reload}
          logout={clear}
        />
      ) : (
        <Auth done={reload} />
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
