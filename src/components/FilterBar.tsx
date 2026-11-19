import { CalendarDays, Check, RotateCcw, Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  defaultFilters,
  filtersSchema,
  type DataCapabilities,
  type FilterDimension,
  type Filters,
  type Session,
} from "../../shared/domain";
import { CategoryFilter } from "../CategoryFilter";
import { getCached, getCachedSync, makeScope, optionsCacheKey, setCached } from "../lib/cache";
import {
  activeFilterChips,
  hasAnyActiveFilter,
  periodPresets,
} from "../lib/filter-state";
import { api, ErrorBox, isAbortError, message, period, sessionCapabilities } from "../ui";

type OptionsMap = Partial<Record<FilterDimension, string[]>>;
type OptionLabelsMap = Partial<Record<FilterDimension, Record<string, string>>>;
type OptionsPayload = { values: OptionsMap; labels?: OptionLabelsMap };

const DIMENSION_LABELS: Record<FilterDimension, string> = {
  region: "Regional",
  client: "Cliente",
  product: "Produto",
  regional: "Regional comercial",
  state: "UF",
  manager: "Gerente",
  category: "Categoria",
};

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
  const presets = periodPresets();
  const hasAny = hasAnyActiveFilter(filters, capabilities);
  const activeCount = chips.length;

  const [quickQuery, setQuickQuery] = useState("");
  const [quickItems, setQuickItems] = useState<{ key: string; name: string }[]>([]);
  const [quickOpen, setQuickOpen] = useState(false);
  const quickRef = useRef<HTMLDivElement>(null);

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
      api<{ items: { key: string; name: string }[] }>(
        "data/search",
        "POST",
        {
          filters: { ...filters, client: "" },
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
    filters.from,
    filters.to,
    filters.region,
    filters.regional,
    filters.state,
    filters.manager,
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
                          onChange({ ...filters, client: item.key });
                          setQuickQuery("");
                          setQuickItems([]);
                          setQuickOpen(false);
                        }}
                      >
                        {item.name}
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

      {chips.length > 0 && (
        <div className="active-chips" aria-label="Filtros ativos">
          {chips.map((chip) => (
            <span className="filter-chip" key={chip.id}>
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

function DimensionField({
  dimension,
  title,
  value,
  options,
  optionLabels,
  capabilities,
  s,
  filters,
  focusClient,
  onChange,
}: {
  dimension: FilterDimension;
  title: string;
  value: string;
  options: string[];
  optionLabels: Record<string, string>;
  capabilities: DataCapabilities;
  s: Session;
  filters: Filters;
  focusClient: boolean;
  onChange: (nextValue: string) => void;
}) {
  const [matches, setMatches] = useState<{ key: string; name: string }[]>([]);
  const restrictedList =
    dimension === "region"
      ? s.user.regions
      : dimension === "client"
        ? s.user.clients
        : [];
  const hasRestrictedSelect =
    restrictedList.length > 0 &&
    !(s.user.role === "admin" || (s.user.role === "diretoria" && s.user.national));
  const supportsRemoteSearch =
    s.data?.source === "manual" &&
    s.data.ready &&
    !hasRestrictedSelect &&
    (dimension === "client" || dimension === "product");

  useEffect(() => {
    if (!supportsRemoteSearch) {
      setMatches([]);
      return;
    }
    const q = value.trim();
    if (q.length < 2 || options.includes(q)) {
      setMatches([]);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<{ items: { key: string; name: string }[] }>(
        "data/search",
        "POST",
        {
          filters: { ...filters, [dimension]: "" },
          dimension,
          query: q,
        },
        controller.signal,
      )
        .then((res) => {
          if (alive) setMatches(res.items.slice(0, 6));
        })
        .catch(() => {
          if (alive) setMatches([]);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [supportsRemoteSearch, value, options, dimension, filters.from, filters.to]);

  return (
    <label>
      {title}
      {hasRestrictedSelect ? (
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Todos no meu escopo</option>
          {restrictedList.map((v) => (
            <option key={v} value={v}>
              {optionLabels[v] ?? v}
            </option>
          ))}
        </select>
      ) : (
        <input
          list={"source-options-" + dimension}
          autoFocus={focusClient && dimension === "client"}
          maxLength={140}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Todos · pesquise código ou descrição"
        />
      )}
      <datalist id={"source-options-" + dimension}>
        {options.map((v) => (
          <option key={v} value={v} label={optionLabels[v] ?? v} />
        ))}
      </datalist>
      {matches.length > 0 && (
        <div className="sheet-suggestions" role="list" aria-label={`Sugestões de ${title}`}>
          {matches.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                onChange(item.key);
                setMatches([]);
              }}
            >
              {item.name}
            </button>
          ))}
        </div>
      )}
      {optionLabels[value] && <small className="muted">{optionLabels[value]}</small>}
      {dimension === "region" && capabilities.labels?.region === "Representante" && (
        <small className="muted">
          As permissões cadastradas para este campo continuam aplicadas ao representante autorizado.
        </small>
      )}
    </label>
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
  const [options, setOptions] = useState<OptionsMap>({});
  const [optionLabels, setOptionLabels] = useState<OptionLabelsMap>({});

  const capabilities = sessionCapabilities(s);
  const selectedDimensions = capabilities.filters;
  const scope = makeScope(s);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    if (s.data?.source !== "manual" || !s.data.ready) return;
    const valid = filtersSchema.safeParse(f);
    if (!valid.success) return;
    let alive = true;
    const controller = new AbortController();
    const optKey = optionsCacheKey(valid.data);
    const cached = getCachedSync<OptionsPayload>(scope, optKey);
    if (cached) {
      setOptions(cached.values);
      setOptionLabels(cached.labels ?? {});
    } else {
      void getCached<OptionsPayload>(scope, optKey).then((idbHit) => {
        if (alive && idbHit) {
          setOptions(idbHit.values);
          setOptionLabels(idbHit.labels ?? {});
        }
      });
    }

    const timer = setTimeout(() => {
      api<OptionsPayload>(
        "data/options",
        "POST",
        { ...valid.data, categoriesInclude: [], categoriesExclude: [], category: "" },
        controller.signal,
      )
        .then((v) => {
          if (alive) {
            setCached(scope, optKey, "options", v, 30 * 60 * 1000);
            setOptions(v.values);
            setOptionLabels(v.labels ?? {});
            setErr("");
          }
        })
        .catch((e) => {
          if (alive && !isAbortError(e)) setErr(message(e));
        });
    }, 300);

    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [scope, s.data?.source, s.data?.ready, s.data?.activeVersionId, f.from, f.to]);

  function save(e: FormEvent) {
    e.preventDefault();
    const parsed = filtersSchema.safeParse(f);
    if (!parsed.success) {
      setErr("Informe entre 1 e 24 meses completos e confira os filtros.");
      return;
    }
    const supported = { ...parsed.data };
    for (const dimension of ["regional", "state", "manager", "category"] as const) {
      if (!capabilities.filters.includes(dimension)) delete supported[dimension];
    }
    if (!capabilities.filters.includes("category")) {
      delete supported.categoriesInclude;
      delete supported.categoriesExclude;
    }
    apply(supported);
  }

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
          <h2>{title}</h2>
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

          {capabilities.filters.includes("category") && s.data?.source === "manual" && (
            <CategoryFilter
              values={options.category ?? []}
              include={f.categoriesInclude ?? (f.category ? [f.category] : [])}
              exclude={f.categoriesExclude ?? []}
              onChange={(categoriesInclude, categoriesExclude) =>
                setF({ ...f, category: "", categoriesInclude, categoriesExclude })
              }
            />
          )}

          {selectedDimensions
            .filter((k) => k !== "category" || s.data?.source !== "manual")
            .map((k) => (
              <DimensionField
                key={k}
                dimension={k}
                title={capabilities.labels?.[k] ?? DIMENSION_LABELS[k]}
                value={f[k] ?? ""}
                options={options[k] ?? []}
                optionLabels={optionLabels[k] ?? {}}
                capabilities={capabilities}
                s={s}
                filters={f}
                focusClient={focusClient}
                onChange={(val) => setF({ ...f, [k]: val })}
              />
            ))}
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
