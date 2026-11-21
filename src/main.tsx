import {
  Bell,
  ChevronRight,
  LayoutGrid,
  WifiOff,
} from "lucide-react";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { createRoot } from "react-dom/client";
import {
  defaultFilters,
  roles,
  type FilterDimension,
  type Filters,
  type Group,
  type Plan,
  type Session,
} from "../shared/domain";
import { Audit, Integrations, Team } from "./Admin";
import Auth from "./Auth";
import Chat, { type Seed } from "./Chat";
import { FilterBar, FilterSheetModal } from "./components/FilterBar";
import { AppBootSkeleton } from "./components/Skeletons";
import { DataUpdates } from "./DataUpdates";
import { loadSessionSnapshot, makeScope, purgeClientCache, saveSessionSnapshot } from "./lib/cache";
import {
  buildFilterSearch,
  loadInitialFilters,
  persistFilters,
  sanitizeFiltersForCapabilities,
} from "./lib/filter-state";
import {
  clearNativeToken,
  hydrateNativeSession,
  initMobileRuntime,
  isNativeApp,
  setNativeToken,
} from "./lib/runtime";
import Profile from "./Profile";
import "./style.css";
import { api, Brand, Credit, Empty, ErrorBox, message, sessionCapabilities } from "./ui";
import Visits from "./Visits";
import { adminNav, Home, mainNav, navs, Reports } from "./WorkspaceViews";

const cleanPath = () =>
  location.pathname === "/admin/atualizacao-dados"
    ? "atualizacao-dados"
    : location.pathname.split("/")[1] || "inicio";

function Shell({
  s,
  reload,
  logout,
  backHandlerRef,
}: {
  s: Session;
  reload: () => void;
  logout: () => void;
  backHandlerRef: MutableRefObject<() => boolean>;
}) {
  const capabilities = sessionCapabilities(s);
  const [page, V] = useState(cleanPath),
    [filters, F] = useState<Filters>(() => loadInitialFilters(s.user.id, capabilities.filters)),
    [modal, W] = useState(""),
    [seed, S] = useState<Seed | null>(null),
    [chatKey, K] = useState(0),
    [reportGroup, G] = useState<Group>("month"),
    [restoredPlan, RP] = useState<Plan | undefined>();
  const previousPeriodRef = useRef<{ from: string; to: string } | null>(null);

  useEffect(() => {
    backHandlerRef.current = () => {
      if (modal) {
        W("");
        return true;
      }
      if (page !== "inicio") {
        go("inicio");
        return true;
      }
      return false;
    };
  }, [backHandlerRef, modal, page]);

  const ready =
      s.data?.ready ?? (s.integrations.configured && (s.integrations.mode === "application" || s.integrations.linked)),
    admin = s.user.role === "admin",
    operator = s.user.role === "operador";

  useEffect(() => {
    if (operator && page !== "atualizacao-dados" && page !== "perfil" && page !== "mais")
      go("atualizacao-dados");
  }, [operator, page]);

  const sourceFilters = JSON.stringify(capabilities.filters);
  useEffect(() => {
    const supported = JSON.parse(sourceFilters) as FilterDimension[];
    F((current) => {
      const next = sanitizeFiltersForCapabilities(current, supported);
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  }, [sourceFilters]);

  useEffect(() => {
    const supported = JSON.parse(sourceFilters) as FilterDimension[];
    persistFilters(s.user.id, filters, supported);
  }, [s.user.id, filters, sourceFilters]);

  function go(p: string) {
    W("");
    if (p !== page) {
      const target =
        p === "inicio" ? "/" : p === "atualizacao-dados" ? "/admin/atualizacao-dados" : "/" + p;
      history.pushState({}, "", target + buildFilterSearch(filters));
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

  function handleCrossFilter(dimension: FilterDimension | "month", value: string) {
    if (dimension === "month") {
      F((current) => {
        if (current.from === value && current.to === value && previousPeriodRef.current) {
          const restored = previousPeriodRef.current;
          previousPeriodRef.current = null;
          return { ...current, from: restored.from, to: restored.to };
        }
        if (current.from !== value || current.to !== value) {
          previousPeriodRef.current = { from: current.from, to: current.to };
          return { ...current, from: value, to: value };
        }
        const base = defaultFilters();
        return { ...current, from: base.from, to: base.to };
      });
      return;
    }
    if (dimension === "category" && s.data?.source === "manual") {
      F((current) => {
        const existing = current.categoriesInclude ?? [];
        const next = existing.length === 1 && existing[0] === value ? [] : [value];
        return { ...current, category: "", categoriesInclude: next };
      });
      return;
    }
    F((current) => ({
      ...current,
      [dimension]: current[dimension] === value ? "" : value,
    }));
  }

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
      G(capabilities.groups.includes("regional") ? "regional" : "region");
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
          if (n.p === "relatorios") {
            G("month");
            RP(undefined);
          }
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

  const showFilters = ![
    "integracoes",
    "atualizacao-dados",
    "equipe",
    "auditoria",
    "perfil",
    "mais",
  ].includes(page);

  return (
    <div className="workspace" data-source-scope={makeScope(s)}>
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
              {s.data.storageEngine === "csv" && s.data.extractedAt
                ? `Base CSV estruturada (${s.data.model ?? "20 CSVs"}) · ativa desde ${new Date(s.data.extractedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}${s.data.referenceDate ? ` · dados até ${s.data.referenceDate.split("-").reverse().join("/")}` : ""}`
                : s.data.extractedAt
                  ? "Arquivo manual · base extraída em " +
                    new Date(s.data.extractedAt).toLocaleString("pt-BR", {
                      timeZone: "America/Sao_Paulo",
                    })
                  : "Arquivo manual · nenhuma versão válida publicada."}
              {s.data.stale ? " · Base desatualizada: solicite uma atualização ao administrador." : ""}
            </div>
          )}
          {showFilters && (
            <FilterBar
              s={s}
              filters={filters}
              onChange={F}
              onOpenSheet={() => W("filtros")}
            />
          )}
          {page === "inicio" ? (
            <Home
              s={s}
              filters={filters}
              ready={ready}
              go={go}
              ask={(q) => chat(q, true)}
              card={card}
              onCrossFilter={handleCrossFilter}
            />
          ) : page === "conversas" ? (
            <Chat
              key={chatKey}
              seed={seed}
              initialId={null}
              clearSeed={() => S(null)}
              filters={filters}
              go={go}
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
              onCrossFilter={handleCrossFilter}
              restore={(plan) => {
                F(plan.filters);
                G(plan.group);
                RP(plan);
                go("relatorios");
              }}
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
            <Team
              self={s.user.id}
              scopeLabel={
                capabilities.labels?.region === "Representante" ? "Representantes" : "Regionais"
              }
            />
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
        {(operator
          ? [adminNav[0], navs.find((item) => item.p === "perfil")!]
          : [...mainNav.slice(0, 4), navs[navs.length - 1]]
        ).map((n) => (
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
        <FilterSheetModal
          title={
            modal === "analisar"
              ? "Analisar cliente"
              : modal === "visita"
                ? "Preparar visita"
                : "Filtros da análise"
          }
          s={s}
          value={filters}
          focusClient={modal !== "filtros"}
          close={() => W("")}
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
      )}
    </div>
  );
}

function App() {
  const nativeMode = isNativeApp();
  const [s, S] = useState<Session | null>(null),
    [wait, B] = useState(true),
    [err, E] = useState(""),
    [net, N] = useState(navigator.onLine),
    [update, U] = useState<ServiceWorker | null>(null);
  const lastValidatedRef = useRef(0);
  const backHandlerRef = useRef<() => boolean>(() => false);
  const refreshInFlightRef = useRef(false);

  const clear = (resetCache = true) => {
    S(null);
    void clearNativeToken();
    if (resetCache) void purgeClientCache();
    if (location.pathname !== "/redefinir") history.replaceState({}, "", "/");
  };

  async function reload() {
    if (nativeMode && typeof navigator !== "undefined" && !navigator.onLine) {
      E("Sem conexão com a internet. Conecte-se para consultar os dados comerciais.");
      void purgeClientCache();
      B(false);
      return;
    }
    try {
      const v = await api<Session>("me");
      lastValidatedRef.current = Date.now();
      saveSessionSnapshot(v);
      E("");
      S(v);
    } catch (e) {
      if (!nativeMode && !navigator.onLine) {
        const snap = loadSessionSnapshot();
        if (snap) {
          S(snap);
          E("Sem conexão no momento. Exibindo dados em cache quando disponíveis.");
          return;
        }
      }
      if (
        !["Entre para continuar.", "Sua sessão terminou. Entre novamente."].includes(message(e))
      ) {
        E(message(e));
        if (nativeMode && !navigator.onLine) {
          void purgeClientCache();
        } else {
          clear(false);
        }
      } else {
        clear(true);
      }
    } finally {
      B(false);
    }
  }

  useEffect(() => {
    let alive = true;
    let disposeMobile: (() => void) | undefined;

    void (async () => {
      await hydrateNativeSession();
      if (!alive) return;
      disposeMobile = await initMobileRuntime({
        onNetworkChange: (connected) => {
          if (!alive) return;
          N(connected);
          if (!connected) {
            if (nativeMode) {
              void purgeClientCache();
              E("Sem conexão com a internet. Os dados comerciais exigem conexão ativa.");
            } else {
              E("Sem conexão. Exibindo últimos dados em cache quando disponíveis.");
            }
          } else {
            void reload();
          }
        },
        onAppResume: () => {
          if (alive && Date.now() - lastValidatedRef.current > 15_000) {
            void reload();
          }
        },
        onBackButton: () => backHandlerRef.current(),
      });
      if (!alive) {
        disposeMobile();
        return;
      }
      void reload();
    })();

    const offline = () => {
      N(false);
      if (nativeMode) {
        void purgeClientCache();
        E("Sem conexão com a internet. Os dados comerciais exigem conexão ativa.");
      } else {
        E("Sem conexão. Exibindo últimos dados em cache quando disponíveis.");
      }
    };
    const online = () => {
      N(true);
      void reload();
    };
    const sessionEnded = () => clear(true);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    window.addEventListener("session-ended", sessionEnded);
    const focus = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastValidatedRef.current > 60_000
      ) {
        void reload();
      }
    };
    document.addEventListener("visibilitychange", focus);
    return () => {
      alive = false;
      disposeMobile?.();
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      window.removeEventListener("session-ended", sessionEnded);
      document.removeEventListener("visibilitychange", focus);
    };
  }, []);

  useEffect(() => {
    if (!s) return;
    const msLeft = s.expires * 1000 - Date.now();
    const t = setTimeout(() => clear(true), Math.max(1, msLeft));
    const checkRefresh = () => {
      if (
        refreshInFlightRef.current ||
        !navigator.onLine ||
        s.expires * 1000 - Date.now() > 90 * 60 * 1000
      ) {
        return;
      }
      refreshInFlightRef.current = true;
      void api<{ ok: boolean; token?: string; expires?: number }>("auth/refresh", "POST", {})
        .then(async (res) => {
          if (nativeMode && res.token) await setNativeToken(res.token);
          if (res.expires) {
            S((prev) => (prev ? { ...prev, expires: res.expires! } : prev));
          }
        })
        .catch(() => {})
        .finally(() => {
          refreshInFlightRef.current = false;
        });
    };
    const interval = setInterval(checkRefresh, 60_000);
    return () => {
      clearTimeout(t);
      clearInterval(interval);
    };
  }, [nativeMode, s]);

  useEffect(() => {
    if (nativeMode || !("serviceWorker" in navigator) || !import.meta.env.PROD) return;
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
  }, [nativeMode]);

  return (
    <>
      {!net && (
        <div className="net" role="status">
          <WifiOff size={15} />
          {nativeMode
            ? "Sem conexão · reconecte-se para consultar os dados"
            : "Sem conexão · modo offline limitado ao cache"}
        </div>
      )}
      {update && !nativeMode && (
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
      {err && !(nativeMode && !net) && (
        <ErrorBox>
          {err}{" "}
          <button className="textlink" onClick={reload}>
            Tentar novamente
          </button>
        </ErrorBox>
      )}
      {wait ? (
        <AppBootSkeleton />
      ) : nativeMode && !net ? (
        <main className="offline-screen">
          <section className="panel offline-state" role="status" aria-label="Sem conexão">
            <div className="mini">
              <WifiOff size={16} /> Conectividade necessária
            </div>
            <h1>Você está sem conexão com a internet</h1>
            <p>
              Para proteger as informações comerciais e evitar o uso de números financeiros
              desatualizados, o Comercial Insight consulta os indicadores online e não mantém base
              comercial offline no aparelho.
            </p>
            <div className="row">
              <button type="button" className="primary" onClick={() => void reload()}>
                Tentar reconectar
              </button>
              {s && (
                <button
                  type="button"
                  className="soft"
                  onClick={() => {
                    void api("auth/logout", "POST", {}).catch(() => {});
                    clear(true);
                  }}
                >
                  Encerrar sessão
                </button>
              )}
            </div>
          </section>
        </main>
      ) : s ? (
        <Shell
          key={s.user.id + "|" + s.policyVersion + "|" + JSON.stringify(s.user)}
          s={s}
          reload={reload}
          logout={() => clear(true)}
          backHandlerRef={backHandlerRef}
        />
      ) : (
        <Auth done={reload} />
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
