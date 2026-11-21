import {
  AlertTriangle,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
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
  const activeCount = activeFilterChips(filters, capabilities).length;
  const conflicts = detectFilterConflicts(filters);
  const presets = periodPresets();
  const hasAny = hasAnyActiveFilter(filters, capabilities);

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
          <button
            type="button"
            onClick={onOpenSheet}
            data-filter-trigger="main"
            className={hasAny ? "filter-status-btn has-active" : "filter-status-btn"}
          >
            <SlidersHorizontal size={15} />
            <span className="filter-status-label">
              {hasAny ? "Filtros aplicados — Consultar filtros escolhidos" : "Consultar filtros"}
            </span>
            {activeCount > 0 && (
              <span className="filter-count-pill">
                {activeCount} {activeCount === 1 ? "filtro ativo" : "filtros ativos"}
              </span>
            )}
            {conflicts.length > 0 && (
              <span
                className="filter-conflict-dot"
                title="Há conflitos entre inclusão e exclusão nos filtros"
              >
                <AlertTriangle size={12} />
                {conflicts.length}
              </span>
            )}
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={onOpenSheet}
        className="filter-fab"
        aria-label={activeCount > 0 ? `Filtros (${activeCount} ativos)` : "Consultar filtros"}
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
  const draftCachedOptions = useMemo(
    () => (validFilters.success ? getCachedSync<OptionsPayload>(scope, optionsCacheKey(validFilters.data)) : null),
    [scope, validFilters],
  );
  const draftChips = useMemo(
    () => activeFilterChips(f, capabilities, optionsPayload?.labels ?? draftCachedOptions?.labels),
    [f, capabilities, optionsPayload?.labels, draftCachedOptions?.labels],
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

          <section className="sheet-selected-box" aria-label="Filtros escolhidos">
            <div className="sheet-selected-head">
              <h3>Filtros escolhidos ({draftChips.length})</h3>
              {draftChips.length > 0 && (
                <button
                  type="button"
                  className="filter-link-btn"
                  onClick={() =>
                    setF((curr) => ({
                      from: curr.from,
                      to: curr.to,
                      region: "",
                      client: "",
                      product: "",
                    }))
                  }
                >
                  Limpar todos
                </button>
              )}
            </div>
            {draftChips.length > 0 ? (
              <div className="sheet-selected-list">
                {draftChips.map((chip) => (
                  <span
                    className={
                      chip.mode === "exclude" ? "sheet-selected-chip exclude" : "sheet-selected-chip"
                    }
                    key={chip.id}
                  >
                    <span className="sheet-selected-chip-label">
                      {chip.mode === "exclude" && !chip.label.startsWith("Excluir")
                        ? `Excluir ${chip.label}`
                        : chip.label}
                      :
                    </span>
                    <span className="sheet-selected-chip-value">{chip.value}</span>
                    <button
                      type="button"
                      aria-label={`Remover ${chip.label} ${chip.value}`}
                      onClick={() => setF((curr) => chip.remove(curr))}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="sheet-selected-empty">
                Nenhum filtro específico selecionado — exibindo todo o escopo autorizado no período.
              </p>
            )}
          </section>

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
                        truncated={Boolean(optionsPayload?.truncated?.[dim])}
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

        <div className="sheet-footer">
          <button type="button" className="soft" onClick={() => setF(defaultFilters())}>
            Limpar tudo
          </button>
          <div className="sheet-footer-actions">
            <button type="button" className="soft" onClick={close}>
              Cancelar
            </button>
            <button type="submit" className="primary">
              <Check size={15} />
              Aplicar filtros
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
