import {
  AlertTriangle,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  defaultFilters,
  detectFilterConflicts,
  filtersSchema,
  type DataCapabilities,
  type ExtendedFilterDimension,
  type FilterDimension,
  type Filters,
  type Session,
} from "../../shared/domain";
import { CategoryFilter } from "../CategoryFilter";
import {
  canonicalFiltersKey,
  getCached,
  getCachedSync,
  makeScope,
  optionsCacheKey,
  setCached,
} from "../lib/cache";
import {
  activeFilterChips,
  buildCompactFilterSummary,
  hasAnyActiveFilter,
  periodPresets,
  removeIncompatibleSelections,
  sanitizeFiltersForCapabilities,
} from "../lib/filter-state";
import { api, ErrorBox, isAbortError, message, period, sessionCapabilities } from "../ui";
import {
  DimensionMultiFilter,
  type OptionsPayload,
} from "./DimensionMultiFilter";

const DEFAULT_DIM_LABELS: Record<ExtendedFilterDimension, string> = {
  regional: "Regional",
  manager: "Gerente Regional",
  state: "UF",
  municipality: "Município",
  region: "Representante",
  client: "Cliente",
  segment: "Segmento",
  channel: "Canal comercial",
  macroCategory: "Macrocategoria",
  itemGroup: "Grupo do item",
  brand: "Marca",
  product: "Produto",
};

const DIMENSION_SECTIONS: { title: string; dims: ExtendedFilterDimension[] }[] = [
  {
    title: "Geografia e estrutura comercial",
    dims: ["regional", "manager", "state", "municipality", "region"],
  },
  {
    title: "Carteira e mercado",
    dims: ["client", "segment", "channel"],
  },
  {
    title: "Portfólio e categorias Power BI",
    dims: ["macroCategory", "itemGroup", "brand", "product"],
  },
];

function isDimensionSupported(dim: ExtendedFilterDimension, capabilities: DataCapabilities): boolean {
  switch (dim) {
    case "regional":
    case "manager":
    case "region":
    case "state":
    case "client":
    case "product":
      return capabilities.filters.includes(dim);
    case "municipality":
    case "channel":
    case "brand":
    case "segment":
      return Boolean(capabilities.extraFilters?.includes(dim));
    case "macroCategory":
    case "itemGroup":
      return capabilities.filters.includes("category") && Boolean(capabilities.extraFilters?.includes(dim));
  }
}

export function FilterBar({
  s,
  filters,
  onChange,
  onOpenSheet,
}: {
  s: Session;
  filters: Filters;
  onChange: (next: Filters) => void;
  onOpenSheet: () => void;
}) {
  const capabilities = sessionCapabilities(s);
  const scope = makeScope(s);
  const optKey = optionsCacheKey(filters);
  const cachedOptions = getCachedSync<OptionsPayload>(scope, optKey);
  const chips = activeFilterChips(filters, capabilities, cachedOptions?.labels);
  const summary = buildCompactFilterSummary(filters, capabilities, cachedOptions?.labels);
  const conflicts = detectFilterConflicts(filters);
  const presets = periodPresets();
  const hasAny = hasAnyActiveFilter(filters, capabilities);
  const activeCount = chips.length;

  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [quickQuery, setQuickQuery] = useState("");
  const [quickItems, setQuickItems] = useState<{ key: string; name: string; hasSalesInPeriod?: boolean }[]>([]);
  const [quickOpen, setQuickOpen] = useState(false);
  const quickRef = useRef<HTMLDivElement>(null);

  const quickCascadeFilters = useMemo<Filters>(
    () => ({ ...filters, client: "", clients: undefined, clientsExclude: undefined }),
    [filters],
  );
  const quickCascadeKey = useMemo(() => canonicalFiltersKey(quickCascadeFilters), [quickCascadeFilters]);

  useEffect(() => {
    if (s.data?.source !== "manual" || !s.data.ready || !capabilities.filters.includes("client")) {
      setQuickItems([]);
      return;
    }
    const q = quickQuery.trim();
    if (q.length < 2) {
      setQuickItems([]);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<{ items: { key: string; name: string; hasSalesInPeriod?: boolean }[] }>(
        "data/search",
        "POST",
        {
          filters: quickCascadeFilters,
          dimension: "client",
          query: q,
        },
        controller.signal,
      )
        .then((res) => {
          if (alive) {
            setQuickItems(res.items.slice(0, 8));
            setQuickOpen(true);
          }
        })
        .catch(() => {
          if (alive) setQuickItems([]);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    quickQuery,
    s.data?.source,
    s.data?.ready,
    s.data?.activeVersionId,
    quickCascadeKey,
    capabilities.filters,
  ]);

  useEffect(() => {
    if (!quickOpen) return;
    const onPointer = (ev: MouseEvent) => {
      if (quickRef.current && !quickRef.current.contains(ev.target as Node)) {
        setQuickOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [quickOpen]);

  useEffect(() => {
    if (chips.length <= 4 && detailsExpanded) {
      setDetailsExpanded(false);
    }
  }, [chips.length, detailsExpanded]);

  const compactMode = chips.length > 4;

  return (
    <div className="smart-filterbar">
      <div className="filterbar-main">
        <div className="filter-period-group">
          <div className="filterdate" title="Período selecionado">
            <CalendarDays size={15} />
            <span>{period(filters)}</span>
          </div>
          <div className="filter-presets" role="group" aria-label="Períodos rápidos">
            {presets.map((preset) => {
              const active = filters.from === preset.from && filters.to === preset.to;
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={active ? "preset-btn active" : "preset-btn"}
                  aria-pressed={active}
                  onClick={() => onChange({ ...filters, from: preset.from, to: preset.to })}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="filterbar-actions">
          {s.data?.source === "manual" &&
            s.data.ready &&
            capabilities.filters.includes("client") && (
              <div className="quick-search-wrap" ref={quickRef}>
                <label className="quick-search">
                  <Search size={14} />
                  <input
                    type="search"
                    maxLength={100}
                    aria-label="Busca rápida de cliente"
                    placeholder="Buscar cliente…"
                    value={quickQuery}
                    onFocus={() => {
                      if (quickItems.length > 0) setQuickOpen(true);
                    }}
                    onChange={(e) => setQuickQuery(e.target.value)}
                  />
                </label>
                {quickOpen && quickItems.length > 0 && (
                  <div className="quick-search-menu" role="listbox" aria-label="Sugestões de cliente">
                    {quickItems.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => {
                          onChange({ ...filters, client: item.key, clients: undefined });
                          setQuickQuery("");
                          setQuickItems([]);
                          setQuickOpen(false);
                        }}
                      >
                        <span>{item.name}</span>
                        {item.hasSalesInPeriod === false && (
                          <small className="muted"> · Sem venda no período</small>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

          {hasAny && (
            <button
              type="button"
              className="filter-clear-btn"
              onClick={() => onChange(defaultFilters())}
              title="Restaurar período padrão e limpar todos os filtros"
            >
              <RotateCcw size={13} />
              <span>Limpar filtros</span>
            </button>
          )}

          <button type="button" onClick={onOpenSheet} className="filterbtn filterbar-open-btn">
            <SlidersHorizontal size={15} />
            <span>Filtros</span>
            {activeCount > 0 && <span className="filter-badge">{activeCount}</span>}
          </button>
        </div>
      </div>

      {(chips.length > 0 || conflicts.length > 0) && (
        <div className="active-filters-area">
          {compactMode && (
            <div className="filter-summary-bar" role="status" aria-label="Resumo dos filtros ativos">
              <span className="filter-summary-text">
                <strong>{summary.totalCount} filtros ativos:</strong> {summary.summaryText}
              </span>
              {conflicts.length > 0 && (
                <button
                  type="button"
                  className="filter-conflict-pill"
                  onClick={onOpenSheet}
                  title={conflicts.join(" ")}
                >
                  <AlertTriangle size={13} />
                  <span>{conflicts.length} conflito(s)</span>
                </button>
              )}
              <button
                type="button"
                className="filter-link-btn"
                aria-expanded={detailsExpanded}
                onClick={() => setDetailsExpanded((v) => !v)}
              >
                {detailsExpanded ? "Recolher detalhes" : "Expandir detalhes"}
              </button>
            </div>
          )}

          {!compactMode && conflicts.length > 0 && (
            <div className="filter-summary-bar" role="status">
              <button
                type="button"
                className="filter-conflict-pill"
                onClick={onOpenSheet}
                title={conflicts.join(" ")}
              >
                <AlertTriangle size={13} />
                <span>{conflicts[0]}</span>
              </button>
            </div>
          )}

          {(!compactMode || detailsExpanded) && chips.length > 0 && (
            <div className="active-chips" aria-label="Filtros ativos">
              {chips.map((chip) => (
                <span
                  className={chip.mode === "exclude" ? "filter-chip exclude" : "filter-chip"}
                  key={chip.id}
                >
                  <span className="filter-chip-label">{chip.label}:</span>
                  <span className="filter-chip-value">{chip.value}</span>
                  <button
                    type="button"
                    aria-label={`Remover filtro ${chip.label} ${chip.value}`}
                    onClick={() => onChange(chip.remove(filters))}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onOpenSheet}
        className="filter-fab"
        aria-label={activeCount > 0 ? `Filtros (${activeCount} ativos)` : "Filtros"}
      >
        <SlidersHorizontal size={17} />
        <span>Filtros</span>
        {activeCount > 0 && <span className="filter-badge">{activeCount}</span>}
      </button>
    </div>
  );
}

export function FilterSheetModal({
  title,
  value,
  s,
  focusClient = false,
  apply,
  close,
}: {
  title: string;
  value: Filters;
  s: Session;
  focusClient?: boolean;
  apply: (f: Filters) => void;
  close: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [f, setF] = useState<Filters>(value);
  const [err, setErr] = useState("");
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionsPayload, setOptionsPayload] = useState<OptionsPayload | null>(null);
  const [openDims, setOpenDims] = useState<Set<ExtendedFilterDimension>>(
    () => new Set(focusClient ? ["client"] : []),
  );
  const [rangeOpen, setRangeOpen] = useState(false);

  const capabilities = sessionCapabilities(s);
  const scope = makeScope(s);
  const conflicts = detectFilterConflicts(f);
  const incompatible = optionsPayload?.incompatible ?? [];
  const isNational = s.user.role === "admin" || (s.user.role === "diretoria" && s.user.national);

  const validFilters = useMemo(() => filtersSchema.safeParse(f), [f]);
  const validKey = useMemo(
    () => (validFilters.success ? canonicalFiltersKey(validFilters.data) : null),
    [validFilters],
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    if (s.data?.source !== "manual" || !s.data.ready || !validKey) return;
    const valid = filtersSchema.safeParse(f);
    if (!valid.success) return;
    let alive = true;
    const controller = new AbortController();
    const optKey = optionsCacheKey(valid.data);
    const cached = getCachedSync<OptionsPayload>(scope, optKey);
    if (cached) {
      setOptionsPayload(cached);
    } else {
      void getCached<OptionsPayload>(scope, optKey).then((idbHit) => {
        if (alive && idbHit) setOptionsPayload(idbHit);
      });
    }

    const timer = setTimeout(() => {
      if (alive) setLoadingOptions(true);
      api<OptionsPayload>("data/options", "POST", valid.data, controller.signal)
        .then((res) => {
          if (alive) {
            setCached(scope, optKey, "options", res, 30 * 60 * 1000);
            setOptionsPayload(res);
            setLoadingOptions(false);
            setErr("");
          }
        })
        .catch((error) => {
          if (alive) {
            setLoadingOptions(false);
            if (!isAbortError(error)) setErr(message(error));
          }
        });
    }, 300);

    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [scope, s.data?.source, s.data?.ready, s.data?.activeVersionId, validKey]);

  function save(e: FormEvent) {
    e.preventDefault();
    const parsed = filtersSchema.safeParse(f);
    if (!parsed.success) {
      setErr(parsed.error.issues[0]?.message || "Informe entre 1 e 24 meses completos e confira os filtros.");
      return;
    }
    const clean = sanitizeFiltersForCapabilities(
      parsed.data,
      capabilities.filters,
      capabilities.extraFilters,
    );
    apply(clean);
  }

  const toggleDim = (dim: ExtendedFilterDimension) => {
    setOpenDims((prev) => {
      const next = new Set(prev);
      if (next.has(dim)) next.delete(dim);
      else next.add(dim);
      return next;
    });
  };

  const setNum = (field: "revenueMin" | "revenueMax" | "ticketMin" | "ticketMax", raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setF({ ...f, [field]: undefined });
      return;
    }
    const n = Number(trimmed);
    if (Number.isFinite(n)) setF({ ...f, [field]: n });
  };

  const rangeCount =
    (f.variationDirection && f.variationDirection !== "all" ? 1 : 0) +
    (f.revenueMin !== undefined || f.revenueMax !== undefined ? 1 : 0) +
    (f.ticketMin !== undefined || f.ticketMax !== undefined ? 1 : 0);

  const hasSplitPowerBiCategories =
    Boolean(capabilities.extraFilters?.includes("macroCategory")) ||
    Boolean(capabilities.extraFilters?.includes("itemGroup"));

  return (
    <dialog
      ref={dialogRef}
      className="filter-sheet"
      onCancel={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="sheet-handle" aria-hidden="true" />
      <form className="formpanel sheet-form" onSubmit={save}>
        <div className="sectionhead sheet-head">
          <div className="sheet-head-title">
            <h2>{title}</h2>
            {loadingOptions && (
              <span className="sheet-loading-pill" role="status">
                <LoaderCircle size={13} className="spin" />
                Atualizando opções…
              </span>
            )}
          </div>
          <button type="button" className="iconbtn" aria-label="Fechar" onClick={close}>
            <X size={19} />
          </button>
        </div>

        <div className="sheet-body">
          <div className="formgrid">
            {(["from", "to"] as const).map((k, i) => (
              <label key={k}>
                {i ? "Último mês" : "Primeiro mês"}
                <input
                  required
                  type="month"
                  value={f[k]}
                  onChange={(e) => setF({ ...f, [k]: e.target.value })}
                />
              </label>
            ))}
          </div>

          {conflicts.length > 0 && (
            <div className="conflict-alert" role="status">
              <AlertTriangle size={15} />
              <div>
                {conflicts.map((msg) => (
                  <p key={msg}>{msg}</p>
                ))}
              </div>
            </div>
          )}

          {incompatible.length > 0 && (
            <div className="incompatible-alert" role="status">
              <AlertTriangle size={15} />
              <div className="incompatible-body">
                <strong>Seleções incompatíveis com o recorte atual</strong>
                <ul>
                  {incompatible.map((item) => (
                    <li key={item.dimension}>{item.message}</li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="soft compact"
                  onClick={() => setF((curr) => removeIncompatibleSelections(curr, incompatible))}
                >
                  Corrigir seleções incompatíveis
                </button>
              </div>
            </div>
          )}

          {capabilities.filters.includes("category") &&
            s.data?.source === "manual" &&
            !hasSplitPowerBiCategories && (
              <CategoryFilter
                values={optionsPayload?.values?.category ?? []}
                include={f.categoriesInclude ?? (f.category ? [f.category] : [])}
                exclude={f.categoriesExclude ?? []}
                onChange={(categoriesInclude, categoriesExclude) =>
                  setF({ ...f, category: "", categoriesInclude, categoriesExclude })
                }
              />
            )}

          {DIMENSION_SECTIONS.map((sec) => {
            const dims = sec.dims.filter((dim) => isDimensionSupported(dim, capabilities));
            if (!dims.length) return null;
            return (
              <div className="filter-section-group" key={sec.title}>
                <h3 className="filter-section-heading">{sec.title}</h3>
                <div className="filter-accordion-grid">
                  {dims.map((dim) => {
                    const restricted =
                      !isNational && dim === "region" && s.user.regions.length
                        ? s.user.regions
                        : !isNational && dim === "client" && s.user.clients.length
                          ? s.user.clients
                          : undefined;
                    const incList = incompatible
                      .filter((x) => x.dimension === dim)
                      .flatMap((x) => x.values);
                    const capLabel =
                      capabilities.labels?.[dim as FilterDimension | ExtendedFilterDimension] ??
                      DEFAULT_DIM_LABELS[dim];
                    const searchSupported =
                      s.data?.source === "manual" &&
                      Boolean(s.data.ready) &&
                      (dim === "client" || dim === "product" || dim === "municipality");
                    return (
                      <DimensionMultiFilter
                        key={dim}
                        dimension={dim}
                        title={capLabel}
                        open={openDims.has(dim)}
                        onToggle={() => toggleDim(dim)}
                        filters={f}
                        onChangeFilters={setF}
                        options={optionsPayload?.values?.[dim] ?? []}
                        labels={optionsPayload?.labels?.[dim] ?? {}}
                        registeredProducts={
                          dim === "product" ? optionsPayload?.registeredProducts ?? [] : []
                        }
                        registeredHasMore={
                          dim === "product" ? Boolean(optionsPayload?.meta?.productHasMoreRegistered) : false
                        }
                        incompatibleValues={incList}
                        searchEndpointSupported={searchSupported}
                        restrictedOptions={restricted}
                        autoFocusSearch={focusClient && dim === "client"}
                        scopeHint={
                          dim === "region" && capabilities.labels?.region === "Representante"
                            ? "Permissões de representante são aplicadas automaticamente no servidor."
                            : undefined
                        }
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}

          {s.data?.source === "manual" && (
            <section className={rangeOpen ? "filter-card open" : "filter-card"}>
              <div className="filter-card-top">
                <button
                  type="button"
                  className="filter-card-head"
                  aria-expanded={rangeOpen}
                  data-filter-dim="ranges"
                  onClick={() => setRangeOpen((v) => !v)}
                >
                  <span className="filter-card-title">Faixas e direção de variação</span>
                  <span className="filter-card-badges">
                    {rangeCount > 0 && <span className="filter-pill include">{rangeCount}</span>}
                  </span>
                  <span className="filter-card-chevron" aria-hidden="true">
                    {rangeOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </span>
                </button>
              </div>
              {rangeOpen && (
                <div className="filter-card-body">
                  <label>
                    Direção da variação (ranking)
                    <select
                      value={f.variationDirection ?? "all"}
                      onChange={(e) =>
                        setF({
                          ...f,
                          variationDirection:
                            e.target.value === "all"
                              ? undefined
                              : (e.target.value as "growth" | "decline"),
                        })
                      }
                    >
                      <option value="all">Todas as variações</option>
                      <option value="growth">Somente crescimento (Δ &gt; 0)</option>
                      <option value="decline">Somente queda (Δ &lt; 0)</option>
                    </select>
                  </label>
                  <div className="formgrid">
                    <label>
                      Faturamento mín. (R$)
                      <input
                        type="number"
                        step="0.01"
                        value={f.revenueMin ?? ""}
                        placeholder="Sem mínimo"
                        onChange={(e) => setNum("revenueMin", e.target.value)}
                      />
                    </label>
                    <label>
                      Faturamento máx. (R$)
                      <input
                        type="number"
                        step="0.01"
                        value={f.revenueMax ?? ""}
                        placeholder="Sem máximo"
                        onChange={(e) => setNum("revenueMax", e.target.value)}
                      />
                    </label>
                    <label>
                      Ticket mín. (R$)
                      <input
                        type="number"
                        step="0.01"
                        value={f.ticketMin ?? ""}
                        placeholder="Sem mínimo"
                        onChange={(e) => setNum("ticketMin", e.target.value)}
                      />
                    </label>
                    <label>
                      Ticket máx. (R$)
                      <input
                        type="number"
                        step="0.01"
                        value={f.ticketMax ?? ""}
                        placeholder="Sem máximo"
                        onChange={(e) => setNum("ticketMax", e.target.value)}
                      />
                    </label>
                  </div>
                </div>
              )}
            </section>
          )}
          {err && <ErrorBox>{err}</ErrorBox>}
        </div>

        <div className="row spread sheet-footer">
          <button type="button" className="soft" onClick={() => setF(defaultFilters())}>
            Limpar
          </button>
          <button className="primary">
            <Check size={15} />
            Aplicar filtros
          </button>
        </div>
      </form>
    </dialog>
  );
}
