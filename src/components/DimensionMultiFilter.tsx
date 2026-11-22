import { ChevronDown, ChevronUp, RotateCcw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  formatOfficialRegionalName,
  normalizeRegionalKey,
  type ExtendedFilterDimension,
  type FilterDimension,
  type Filters,
} from "../../shared/domain";
import { api } from "../ui";

export type SearchItem = {
  key: string;
  name: string;
  hasSalesInPeriod?: boolean;
};

export type IncompatibleSelection = {
  dimension: ExtendedFilterDimension;
  values: string[];
  labels: string[];
  message: string;
};

export type OptionsMap = Partial<Record<FilterDimension | ExtendedFilterDimension, string[]>>;
export type OptionLabelsMap = Partial<Record<FilterDimension | ExtendedFilterDimension, Record<string, string>>>;
export type OptionsPayload = {
  values: OptionsMap;
  labels?: OptionLabelsMap;
  registeredProducts?: string[];
  meta?: {
    productActiveCount: number;
    productRegisteredCount: number;
    productHasMoreRegistered: boolean;
  };
  incompatible?: IncompatibleSelection[];
  truncated?: Record<string, boolean>;
  sourceVersion?: string;
};

type ScalarField = "regional" | "manager" | "region" | "state" | "municipality" | "client" | "product";
type ArrayField = keyof Pick<
  Filters,
  | "regionals"
  | "regionalsExclude"
  | "managers"
  | "managersExclude"
  | "regions"
  | "regionsExclude"
  | "states"
  | "statesExclude"
  | "municipalities"
  | "municipalitiesExclude"
  | "clients"
  | "clientsExclude"
  | "products"
  | "productsExclude"
  | "channels"
  | "channelsExclude"
  | "segments"
  | "segmentsExclude"
  | "brands"
  | "brandsExclude"
>;

const SCALAR_ARRAY_MAP: Record<
  ScalarField,
  { single: ScalarField; multi: ArrayField; exc: ArrayField; requiredSingle?: boolean }
> = {
  regional: { single: "regional", multi: "regionals", exc: "regionalsExclude" },
  manager: { single: "manager", multi: "managers", exc: "managersExclude" },
  region: { single: "region", multi: "regions", exc: "regionsExclude", requiredSingle: true },
  state: { single: "state", multi: "states", exc: "statesExclude" },
  municipality: { single: "municipality", multi: "municipalities", exc: "municipalitiesExclude" },
  client: { single: "client", multi: "clients", exc: "clientsExclude", requiredSingle: true },
  product: { single: "product", multi: "products", exc: "productsExclude", requiredSingle: true },
};

const PURE_ARRAY_MAP: Record<"channel" | "brand" | "segment", { inc: ArrayField; exc: ArrayField }> = {
  channel: { inc: "channels", exc: "channelsExclude" },
  brand: { inc: "brands", exc: "brandsExclude" },
  segment: { inc: "segments", exc: "segmentsExclude" },
};

const foldUpper = (s: string) => s.normalize("NFC").trim().toLocaleUpperCase("pt-BR");
const foldSearch = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("pt-BR");
const isMacroEntry = (v: string) => v.normalize("NFC").trim().toLocaleLowerCase("pt-BR").startsWith("macro categoria:");
const stripMacroPrefix = (v: string) => v.replace(/^macro categoria:\s*/iu, "");

function normDimKey(dimension: ExtendedFilterDimension, raw: string): string {
  if (dimension === "regional") return normalizeRegionalKey(raw) ?? foldUpper(raw);
  if (dimension === "macroCategory") return foldUpper(stripMacroPrefix(raw));
  return foldUpper(raw);
}

function dedupByNorm(dimension: ExtendedFilterDimension, items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const trimmed = raw.normalize("NFC").trim();
    if (!trimmed) continue;
    const k = normDimKey(dimension, trimmed);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(trimmed);
  }
  return out;
}

export function readDimensionSelection(
  filters: Filters,
  dimension: ExtendedFilterDimension,
): { include: string[]; exclude: string[] } {
  if (dimension in SCALAR_ARRAY_MAP) {
    const cfg = SCALAR_ARRAY_MAP[dimension as ScalarField];
    const single = filters[cfg.single]?.trim();
    const multi = filters[cfg.multi] ?? [];
    const exc = filters[cfg.exc] ?? [];
    return {
      include: dedupByNorm(dimension, [...(single ? [single] : []), ...multi]),
      exclude: dedupByNorm(dimension, exc),
    };
  }
  if (dimension === "macroCategory") {
    return {
      include: dedupByNorm(dimension, (filters.categoriesInclude ?? []).filter(isMacroEntry)),
      exclude: dedupByNorm(dimension, (filters.categoriesExclude ?? []).filter(isMacroEntry)),
    };
  }
  if (dimension === "itemGroup") {
    const single = filters.category?.trim();
    const incGroups = (filters.categoriesInclude ?? []).filter((v) => !isMacroEntry(v));
    const excGroups = (filters.categoriesExclude ?? []).filter((v) => !isMacroEntry(v));
    return {
      include: dedupByNorm(dimension, [...(single ? [single] : []), ...incGroups]),
      exclude: dedupByNorm(dimension, excGroups),
    };
  }
  const cfg = PURE_ARRAY_MAP[dimension as "channel" | "brand" | "segment"];
  return {
    include: dedupByNorm(dimension, filters[cfg.inc] ?? []),
    exclude: dedupByNorm(dimension, filters[cfg.exc] ?? []),
  };
}

export function writeDimensionSelection(
  filters: Filters,
  dimension: ExtendedFilterDimension,
  include: string[],
  exclude: string[],
): Filters {
  const cleanInc = dedupByNorm(dimension, include);
  const cleanExc = dedupByNorm(dimension, exclude);
  if (dimension in SCALAR_ARRAY_MAP) {
    const cfg = SCALAR_ARRAY_MAP[dimension as ScalarField];
    const emptySingle = cfg.requiredSingle ? "" : undefined;
    return {
      ...filters,
      [cfg.single]: cleanInc.length === 1 ? cleanInc[0] : emptySingle,
      [cfg.multi]: cleanInc.length > 1 ? cleanInc : undefined,
      [cfg.exc]: cleanExc.length ? cleanExc : undefined,
    };
  }
  if (dimension === "macroCategory") {
    const keptInc = (filters.categoriesInclude ?? []).filter((v) => !isMacroEntry(v));
    const keptExc = (filters.categoriesExclude ?? []).filter((v) => !isMacroEntry(v));
    const normalizedMacros = cleanInc.map((v) => (isMacroEntry(v) ? v : `Macro Categoria: ${v}`));
    const normalizedExc = cleanExc.map((v) => (isMacroEntry(v) ? v : `Macro Categoria: ${v}`));
    const nextInc = [...keptInc, ...normalizedMacros];
    const nextExc = [...keptExc, ...normalizedExc];
    return {
      ...filters,
      categoriesInclude: nextInc.length ? nextInc : undefined,
      categoriesExclude: nextExc.length ? nextExc : undefined,
    };
  }
  if (dimension === "itemGroup") {
    const keptIncMacros = (filters.categoriesInclude ?? []).filter(isMacroEntry);
    const keptExcMacros = (filters.categoriesExclude ?? []).filter(isMacroEntry);
    const nextInc = [...keptIncMacros, ...cleanInc];
    const nextExc = [...keptExcMacros, ...cleanExc];
    return {
      ...filters,
      category: "",
      categoriesInclude: nextInc.length ? nextInc : undefined,
      categoriesExclude: nextExc.length ? nextExc : undefined,
    };
  }
  const cfg = PURE_ARRAY_MAP[dimension as "channel" | "brand" | "segment"];
  return {
    ...filters,
    [cfg.inc]: cleanInc.length ? cleanInc : undefined,
    [cfg.exc]: cleanExc.length ? cleanExc : undefined,
  };
}

function formatItemLabel(
  dimension: ExtendedFilterDimension,
  rawKey: string,
  labels: Record<string, string>,
): string {
  if (labels[rawKey]) return labels[rawKey];
  if (dimension === "regional") return formatOfficialRegionalName(rawKey);
  if (dimension === "macroCategory") return stripMacroPrefix(rawKey);
  return rawKey;
}

const PAGE_SIZE = 50;

export function DimensionMultiFilter({
  dimension,
  title,
  open,
  onToggle,
  filters,
  onChangeFilters,
  options,
  labels = {},
  registeredProducts = [],
  registeredHasMore = false,
  incompatibleValues = [],
  truncated = false,
  searchEndpointSupported = false,
  restrictedOptions,
  autoFocusSearch = false,
  scopeHint,
}: {
  dimension: ExtendedFilterDimension;
  title: string;
  open: boolean;
  onToggle: () => void;
  filters: Filters;
  onChangeFilters: (next: Filters) => void;
  options: string[];
  labels?: Record<string, string>;
  registeredProducts?: string[];
  registeredHasMore?: boolean;
  incompatibleValues?: string[];
  truncated?: boolean;
  searchEndpointSupported?: boolean;
  restrictedOptions?: string[];
  autoFocusSearch?: boolean;
  scopeHint?: string;
}) {
  const [mode, setMode] = useState<"include" | "exclude">("include");
  const [searchText, setSearchText] = useState("");
  const [remoteItems, setRemoteItems] = useState<SearchItem[]>([]);
  const [remoteTruncated, setRemoteTruncated] = useState(false);
  const [searchingRemote, setSearchingRemote] = useState(false);
  const [showRegistered, setShowRegistered] = useState(false);
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);

  const { include, exclude } = useMemo(
    () => readDimensionSelection(filters, dimension),
    [filters, dimension],
  );

  const incSet = useMemo(() => new Set(include.map((v) => normDimKey(dimension, v))), [include, dimension]);
  const excSet = useMemo(() => new Set(exclude.map((v) => normDimKey(dimension, v))), [exclude, dimension]);
  const incompSet = useMemo(
    () => new Set(incompatibleValues.map((v) => normDimKey(dimension, v))),
    [incompatibleValues, dimension],
  );
  const restrictedNormSet = useMemo(
    () => (restrictedOptions?.length ? new Set(restrictedOptions.map((v) => normDimKey(dimension, v))) : null),
    [restrictedOptions, dimension],
  );

  const withoutSelfFilters = useMemo(
    () => writeDimensionSelection(filters, dimension, [], []),
    [filters, dimension],
  );
  const withoutSelfJson = useMemo(() => JSON.stringify(withoutSelfFilters), [withoutSelfFilters]);

  useEffect(() => {
    setVisibleLimit(PAGE_SIZE);
  }, [open, searchText, options]);

  useEffect(() => {
    const canSearch =
      open &&
      searchEndpointSupported &&
      !restrictedNormSet &&
      (dimension === "client" || dimension === "product" || dimension === "municipality");
    const q = searchText.trim();
    if (!canSearch || q.length < 2) {
      setRemoteItems([]);
      setRemoteTruncated(false);
      setSearchingRemote(false);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    setSearchingRemote(true);
    const parsedFilters = JSON.parse(withoutSelfJson) as Filters;
    const timer = setTimeout(() => {
      api<{ items: SearchItem[]; truncated?: boolean }>(
        "data/search",
        "POST",
        {
          filters: parsedFilters,
          dimension,
          query: q,
        },
        controller.signal,
      )
        .then((res) => {
          if (alive) {
            setRemoteItems(res.items);
            setRemoteTruncated(Boolean(res.truncated));
            setSearchingRemote(false);
          }
        })
        .catch(() => {
          if (alive) {
            setRemoteItems([]);
            setRemoteTruncated(false);
            setSearchingRemote(false);
          }
        });
    }, 250);

    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, searchEndpointSupported, restrictedNormSet, dimension, searchText, withoutSelfJson]);

  const effectiveOptions = useMemo(() => {
    if (!restrictedNormSet) return options;
    const filtered = options.filter((opt) => restrictedNormSet.has(normDimKey(dimension, opt)));
    return filtered.length ? filtered : restrictedOptions ?? [];
  }, [options, restrictedNormSet, restrictedOptions, dimension]);

  const visibleItems = useMemo(() => {
    type Candidate = {
      key: string;
      norm: string;
      label: string;
      hasSalesInPeriod?: boolean;
    };
    const byNorm = new Map<string, Candidate>();
    const addCandidate = (rawKey: string, explicitLabel?: string, hasSales?: boolean) => {
      const k = normDimKey(dimension, rawKey);
      if (!k) return;
      const existing = byNorm.get(k);
      if (existing) {
        if (explicitLabel && existing.label === existing.key) existing.label = explicitLabel;
        if (existing.hasSalesInPeriod === undefined && hasSales !== undefined) existing.hasSalesInPeriod = hasSales;
        return;
      }
      byNorm.set(k, {
        key: rawKey,
        norm: k,
        label: explicitLabel || formatItemLabel(dimension, rawKey, labels),
        hasSalesInPeriod: hasSales,
      });
    };

    for (const k of effectiveOptions) addCandidate(k, undefined, true);
    for (const r of remoteItems) addCandidate(r.key, r.name, r.hasSalesInPeriod);
    if (dimension === "product" && showRegistered) {
      for (const k of registeredProducts) addCandidate(k, undefined, false);
    }
    const regKeyNorms = new Set(registeredProducts.map((k) => normDimKey(dimension, k)));
    for (const sel of [...include, ...exclude]) {
      const n = normDimKey(dimension, sel);
      const isRegZero = dimension === "product" && regKeyNorms.has(n);
      addCandidate(sel, undefined, isRegZero ? false : undefined);
    }

    const qFold = foldSearch(searchText.trim());
    const all = [...byNorm.values()];
    return qFold
      ? all.filter((item) => foldSearch(item.label).includes(qFold) || foldSearch(item.key).includes(qFold))
      : all;
  }, [
    dimension,
    effectiveOptions,
    remoteItems,
    registeredProducts,
    showRegistered,
    include,
    exclude,
    labels,
    searchText,
  ]);

  const filteredItems = visibleItems;
  const pagedItems = useMemo(
    () => filteredItems.slice(0, visibleLimit),
    [filteredItems, visibleLimit],
  );

  const toggleItem = (key: string) => {
    const kNorm = normDimKey(dimension, key);
    const list = mode === "include" ? include : exclude;
    const activeSet = mode === "include" ? incSet : excSet;
    const nextList = activeSet.has(kNorm)
      ? list.filter((v) => normDimKey(dimension, v) !== kNorm)
      : [...list, key];
    if (mode === "include") {
      onChangeFilters(writeDimensionSelection(filters, dimension, nextList, exclude));
    } else {
      onChangeFilters(writeDimensionSelection(filters, dimension, include, nextList));
    }
  };

  const selectAllVisible = () => {
    const keysToAdd = pagedItems.map((i) => i.key);
    if (!keysToAdd.length) return;
    if (mode === "include") {
      onChangeFilters(writeDimensionSelection(filters, dimension, [...include, ...keysToAdd], exclude));
    } else {
      onChangeFilters(writeDimensionSelection(filters, dimension, include, [...exclude, ...keysToAdd]));
    }
  };

  const clearCurrentMode = () => {
    if (mode === "include") {
      onChangeFilters(writeDimensionSelection(filters, dimension, [], exclude));
    } else {
      onChangeFilters(writeDimensionSelection(filters, dimension, include, []));
    }
  };

  const clearDimension = () => {
    onChangeFilters(writeDimensionSelection(filters, dimension, [], []));
  };

  const totalSelected = include.length + exclude.length;
  const activeModeCount = mode === "include" ? include.length : exclude.length;

  return (
    <section className={open ? "filter-card open" : "filter-card"} aria-label={`Filtro ${title}`}>
      <div className="filter-card-top">
        <button
          type="button"
          className="filter-card-head"
          aria-expanded={open}
          data-filter-dim={dimension}
          onClick={onToggle}
        >
          <span className="filter-card-title">{title}</span>
          <span className="filter-card-badges">
            {include.length > 0 && (
              <span className="filter-pill include" title={`${include.length} incluído(s)`}>
                +{include.length}
              </span>
            )}
            {exclude.length > 0 && (
              <span className="filter-pill exclude" title={`${exclude.length} excluído(s)`}>
                −{exclude.length}
              </span>
            )}
            {incompSet.size > 0 && (
              <span className="filter-pill warn" title="Há seleções incompatíveis com o recorte">
                !
              </span>
            )}
            <span className="filter-count-muted" title="Opções disponíveis no recorte">
              {effectiveOptions.length}
            </span>
          </span>
          <span className="filter-card-chevron" aria-hidden="true">
            {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </span>
        </button>

        {totalSelected > 0 && (
          <button
            type="button"
            className="filter-card-clear"
            aria-label={`Limpar ${title}`}
            title={`Limpar seleções de ${title}`}
            onClick={clearDimension}
          >
            <RotateCcw size={13} />
          </button>
        )}
      </div>

      {open && (
        <div className="filter-card-body">
          <div className="filter-mode-tabs" role="group" aria-label={`Modo de seleção de ${title}`}>
            <button
              type="button"
              className={mode === "include" ? "filter-mode-btn active include" : "filter-mode-btn"}
              aria-pressed={mode === "include"}
              onClick={() => setMode("include")}
            >
              Incluir ({include.length})
            </button>
            <button
              type="button"
              className={mode === "exclude" ? "filter-mode-btn active exclude" : "filter-mode-btn"}
              aria-pressed={mode === "exclude"}
              onClick={() => setMode("exclude")}
            >
              Excluir ({exclude.length})
            </button>
          </div>

          <div className="filter-search-box">
            <Search size={14} />
            <input
              type="search"
              aria-label={`Pesquisar ${title}`}
              placeholder={
                dimension === "client"
                  ? "Pesquisar por código ou razão social/nome…"
                  : dimension === "product"
                    ? "Pesquisar por código ou descrição do produto…"
                    : `Pesquisar ${title.toLocaleLowerCase("pt-BR")}…`
              }
              autoFocus={autoFocusSearch}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
          </div>

          <div className="filter-quick-actions">
            <button
              type="button"
              className="filter-link-btn"
              disabled={pagedItems.length === 0}
              onClick={selectAllVisible}
            >
              Selecionar visíveis ({pagedItems.length})
            </button>
            {activeModeCount > 0 && (
              <button type="button" className="filter-link-btn" onClick={clearCurrentMode}>
                {mode === "include" ? "Limpar incluídos" : "Limpar excluídos"}
              </button>
            )}
            {totalSelected > 0 && (
              <button type="button" className="filter-link-btn" onClick={clearDimension}>
                Limpar filtro
              </button>
            )}
          </div>

          {dimension === "product" && registeredProducts.length > 0 && (
            <label className="filter-registered-toggle">
              <input
                type="checkbox"
                checked={showRegistered}
                onChange={(e) => setShowRegistered(e.target.checked)}
              />
              <span>
                Mostrar cadastrados sem venda no período ({registeredProducts.length}
                {registeredHasMore ? "+" : ""})
              </span>
            </label>
          )}

          {searchingRemote && (
            <p className="filter-option-status" role="status">
              Buscando na base…
            </p>
          )}

          <div className="filter-option-list" role="group" aria-label={`Opções de ${title}`}>
            {pagedItems.length === 0 ? (
              <p className="filter-option-empty">
                {searchText.trim()
                  ? "Nenhum item encontrado para a pesquisa."
                  : "Nenhuma opção disponível para o recorte atual."}
              </p>
            ) : (
              <>
                {pagedItems.map((item) => {
                  const isInc = incSet.has(item.norm);
                  const isExc = excSet.has(item.norm);
                  const checked = mode === "include" ? isInc : isExc;
                  const isOverlap = isInc && isExc;
                  const isIncompatible = incompSet.has(item.norm);
                  return (
                    <label
                      key={item.norm}
                      className={
                        isOverlap
                          ? "filter-option-row overlap"
                          : isIncompatible
                            ? "filter-option-row incompatible"
                            : "filter-option-row"
                      }
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleItem(item.key)}
                      />
                      <span className="filter-option-text">{item.label}</span>
                      <span className="filter-option-badges">
                        {isOverlap && <span className="filter-option-badge warn">Exclusão prevalece</span>}
                        {!isOverlap && mode === "include" && isExc && (
                          <span className="filter-option-badge exclude">Excluído</span>
                        )}
                        {!isOverlap && mode === "exclude" && isInc && (
                          <span className="filter-option-badge include">Incluído</span>
                        )}
                        {isIncompatible && <span className="filter-option-badge warn">Fora do recorte</span>}
                        {item.hasSalesInPeriod === false && (
                          <span className="filter-option-badge muted">Sem venda no período</span>
                        )}
                      </span>
                    </label>
                  );
                })}
                {filteredItems.length > visibleLimit && (
                  <button
                    type="button"
                    className="filter-load-more-btn"
                    onClick={() => setVisibleLimit((n) => n + PAGE_SIZE)}
                  >
                    Mostrar mais {Math.min(PAGE_SIZE, filteredItems.length - visibleLimit)} (
                    {pagedItems.length} de {filteredItems.length})
                  </button>
                )}
              </>
            )}
          </div>

          {(truncated || remoteTruncated || filteredItems.length > pagedItems.length) && (
            <small className="filter-truncated-hint">
              Exibindo {pagedItems.length} itens
              {filteredItems.length > pagedItems.length ? ` de ${filteredItems.length}` : ""} no recorte.
              Use a pesquisa acima para localizar outros itens.
            </small>
          )}

          {restrictedOptions?.length ? (
            <small className="muted">
              Opções restritas ao seu escopo autorizado ({restrictedOptions.length}).
            </small>
          ) : scopeHint ? (
            <small className="muted">{scopeHint}</small>
          ) : null}
        </div>
      )}
    </section>
  );
}
