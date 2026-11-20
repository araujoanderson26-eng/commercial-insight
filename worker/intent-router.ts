import type { DataCapabilities, Filters, Group, Metric, Plan } from "../shared/domain";
import { canonicalState } from "./assistant";
import { isVisitRequest } from "./commercial";
import { fail } from "./core";

export type DeterministicIntentKind =
  | "customer_counts"
  | "buyers_period"
  | "rep_registered_count"
  | "rep_active_count"
  | "metric_summary"
  | "yoy_growth"
  | "ranking"
  | "category_filtered"
  | "category_mix_share"
  | "churned_clients"
  | "visit_briefing";

export type DeterministicIntent = {
  kind: DeterministicIntentKind;
  plan: Plan;
  visitRequested?: boolean;
};

const STATES: [string, string][] = [
  ["AC", "Acre"], ["AL", "Alagoas"], ["AP", "Amapá"], ["AM", "Amazonas"], ["BA", "Bahia"], ["CE", "Ceará"],
  ["DF", "Distrito Federal"], ["ES", "Espírito Santo"], ["GO", "Goiás"], ["MA", "Maranhão"], ["MT", "Mato Grosso"],
  ["MS", "Mato Grosso do Sul"], ["MG", "Minas Gerais"], ["PA", "Pará"], ["PB", "Paraíba"], ["PR", "Paraná"],
  ["PE", "Pernambuco"], ["PI", "Piauí"], ["RJ", "Rio de Janeiro"], ["RN", "Rio Grande do Norte"],
  ["RS", "Rio Grande do Sul"], ["RO", "Rondônia"], ["RR", "Roraima"], ["SC", "Santa Catarina"],
  ["SP", "São Paulo"], ["SE", "Sergipe"], ["TO", "Tocantins"],
];

const MONTHS: Record<string, string> = {
  janeiro: "01",
  jan: "01",
  fevereiro: "02",
  fev: "02",
  marco: "03",
  mar: "03",
  abril: "04",
  abr: "04",
  maio: "05",
  mai: "05",
  junho: "06",
  jun: "06",
  julho: "07",
  jul: "07",
  agosto: "08",
  ago: "08",
  setembro: "09",
  set: "09",
  outubro: "10",
  out: "10",
  novembro: "11",
  nov: "11",
  dezembro: "12",
  dez: "12",
};

const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .trim();

function extractPeriod(question: string, active: Filters): { from: string; to: string } {
  // Strip baseline comparison phrases ("em relação a 2025", "vs 2025", "contra 2025")
  const cleaned = question.replace(
    /\b(?:em\s+rela[cç][aã]o\s+a|comparad[oa]\s+(?:a|com)|frente\s+a|contra|vs\.?)\s+20\d{2}\b/giu,
    " ",
  );
  const folded = fold(cleaned);

  const monthYear = folded.match(
    /\b(janeiro|jan|fevereiro|fev|marco|mar|abril|abr|maio|mai|junho|jun|julho|jul|agosto|ago|setembro|set|outubro|out|novembro|nov|dezembro|dez)\s*(?:de\s*)?(20\d{2})\b/u,
  );
  if (monthYear) {
    const mm = MONTHS[monthYear[1]];
    const yyyy = monthYear[2];
    if (mm) return { from: `${yyyy}-${mm}`, to: `${yyyy}-${mm}` };
  }

  const yearMatch = cleaned.match(/\b(20\d{2})\b/u);
  if (yearMatch) {
    const yyyy = yearMatch[1];
    return { from: `${yyyy}-01`, to: `${yyyy}-12` };
  }

  return { from: active.from, to: active.to };
}

function detectState(question: string, capabilities?: DataCapabilities): string | undefined {
  const text = fold(question);
  const matches = STATES.filter(([code, name]) => {
    const named = new RegExp("(?:^|[^a-z])" + fold(name) + "(?:$|[^a-z])", "u").test(text);
    const qualified =
      code === "PA" ? /pará/iu.test(question) || /estado (?:do |de )?para\b/u.test(text) : named;
    return qualified || new RegExp("\\b" + code + "\\b", "u").test(question);
  }).filter(([code]) => code !== "MT" || !/mato grosso do sul/u.test(text));
  if (!matches.length) return undefined;
  if (matches.length > 1) {
    fail(
      422,
      "A pergunta menciona mais de uma UF. Selecione os estados nos filtros ou compare por UF.",
    );
  }
  const code = matches[0][0];
  if (capabilities && !capabilities.filters.includes("state")) {
    fail(422, "Esta fonte não tem filtro por UF validado.");
  }
  return canonicalState(code);
}

function extractFromClause(clause: string): string[] {
  if (!clause.trim()) return [];
  let rest = clause;
  const matched: string[] = [];
  // Longer, compound official categories MUST be matched and stripped first so base words
  // ("suco", "vinho", "vinagre", "granel") never absorb independent commercial categories.
  const specs: [RegExp, string][] = [
    [/\bsucos?\s+concentrados?\s+(?:de\s+)?uva\b/gu, "Macro Categoria: SUCO CONCENTRADO DE UVA"],
    [/\bsucos?\s+concentrados?\s+(?:de\s+)?maca\b/gu, "Macro Categoria: SUCO CONCENTRADO DE MAÇÃ"],
    [/\bsucos?\s+concentrados?\s+(?:de\s+)?laranja\b/gu, "Macro Categoria: SUCO CONCENTRADO DE LARANJA"],
    [/\bsucos?\s+concentrados?\s+(?:de\s+)?tangerina\b/gu, "Macro Categoria: SUCO CONCENTRADO DE TANGERINA"],
    [/\bsucos?\s+concentrados?\b/gu, "SUCOS CONCENTRADOS"],
    [/\bsucos?\s+importados?\b/gu, "SUCO IMPORTADO"],
    [/\bvinhos?\s+importados?\b/gu, "Macro Categoria: VINHO IMPORTADO"],
    [/\bvinhos?\s+(?:graneis|granel)\b/gu, "Macro Categoria: VINHO GRANEL"],
    [/\bvinagres?\s+(?:graneis|granel)\b/gu, "Macro Categoria: VINAGRE GRANEL"],
    [/\bbebidas?\s+quentes?\b/gu, "Macro Categoria: BEBIDA QUENTE"],
    [/\bvendas?\s+varejo\b/gu, "Macro Categoria: VENDA VAREJO"],
    [/\bsucos?\b/gu, "SUCO"],
    [/\bvinhos?\b/gu, "VINHO"],
    [/\bespumantes?\b/gu, "ESPUMANTE"],
    [/\bvinagres?\b/gu, "VINAGRE"],
    [/\b(?:graneis|granel)\b/gu, "GRANEL"],
  ];

  for (const [re, label] of specs) {
    if (re.test(rest)) {
      matched.push(label);
      rest = rest.replace(re, " ");
    }
  }
  return [...new Set(matched)];
}

function extractCategories(question: string): {
  include: string[];
  exclude: string[];
} {
  const f = fold(question);

  // Detect explicit exclusion clause (e.g. "excluindo Granel", "sem Granel", "exceto Vinho Importado")
  const excClauseMatch = f.match(/\b(?:exclu\w*|sem|exceto|menos)\s+(?:os?\s+|as?\s+)?([^\n,.?!;]+)/u);
  const excClause = excClauseMatch?.[1] ?? "";
  const incClause = excClauseMatch ? f.slice(0, excClauseMatch.index) : f;

  const exclude = extractFromClause(excClause);
  const include = extractFromClause(incClause);

  return { include, exclude };
}

function mergeFiltersWithQuestion(
  question: string,
  active: Filters,
  capabilities?: DataCapabilities,
  extractedCategories?: { include: string[]; exclude: string[] },
  explicitClient?: string,
): Filters {
  const period = extractPeriod(question, active);
  const mentionedState = detectState(question, capabilities);

  if (mentionedState && active.state && canonicalState(active.state) !== mentionedState) {
    fail(422, "Altere o filtro ativo de UF para analisar outro estado.");
  }

  const next: Filters = {
    ...active,
    from: period.from,
    to: period.to,
    ...(mentionedState ? { state: mentionedState } : {}),
    ...(explicitClient ? { client: explicitClient } : {}),
  };

  if (extractedCategories?.include.length) {
    if (
      active.categoriesInclude?.length &&
      JSON.stringify([...new Set(active.categoriesInclude)].sort()) !==
        JSON.stringify([...new Set(extractedCategories.include)].sort())
    ) {
      fail(422, "Altere as categorias ativas nos filtros para consultar outro recorte.");
    }
    next.categoriesInclude = extractedCategories.include;
  }
  if (extractedCategories?.exclude.length) {
    if (
      active.categoriesExclude?.length &&
      JSON.stringify([...new Set(active.categoriesExclude)].sort()) !==
        JSON.stringify([...new Set(extractedCategories.exclude)].sort())
    ) {
      fail(422, "Altere as exclusões de categorias ativas nos filtros para consultar outro recorte.");
    }
    next.categoriesExclude = extractedCategories.exclude;
  }

  return next;
}

function extractVisitClient(question: string, active: Filters): string | undefined {
  if (active.client.trim()) return active.client.trim();
  const stripped = question
    .replace(/\s+(?:amanh[aã]|hoje|nesta\s+semana|em\s+20\d{2})(?=$|[\s,.?!;]).*$/iu, "")
    .trim();
  const explicit = stripped.match(
    /(?:^|[^\p{L}\p{N}_])cliente\s+(["'“”]?[\p{L}\p{N}._/-]{2,}(?:\s+[\p{L}\p{N}._/-]+){0,4}["'“”]?)/iu,
  );
  const indirect = !explicit
    ? stripped.match(
        /(?:^|[^\p{L}\p{N}_])(?:visita(?:r)?|reuni[aã]o|briefing)\s+(?:(?:ao|a|para\s+(?:o|a)?|com\s+(?:o|a)?)\s+)?(["'“”]?[\p{L}\p{N}._/-]{2,}(?:\s+[\p{L}\p{N}._/-]+){0,4}["'“”]?)/iu,
      )
    : null;
  const raw = (explicit ?? indirect)?.[1];
  if (!raw) return undefined;
  const candidate = raw.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  if (/^(?:de|para|com|ao|a|amanh[aã]|hoje|no|na|em|uma|um)$/iu.test(candidate)) return undefined;
  return candidate;
}

/**
 * Synchronous (<2ms) fast-path classifier covering the 15 executive questions cleanly.
 * Returns null for open-ended/analytical/follow-up prompts so OpenAI handles nuance safely.
 */
export function routeCommercialIntent(
  question: string,
  activeFilters: Filters,
  capabilities: DataCapabilities | undefined,
  prior: { question: string; plan: string }[],
): DeterministicIntent | null {
  const f = fold(question);

  // Never intercept conversational follow-ups, open analysis prompts or unsupported concepts.
  if (
    prior.length > 0 &&
    /^(?:e\s+(?:quais|os|as|no|na|em|por)|nesse\s+|nessa\s+|dessa|disso|desses|acima|ele|ela)\b/u.test(
      f,
    )
  ) {
    return null;
  }
  if (/\b(?:margem|estoque|previsao|projecao|meta|orcamento|semana|semanas|hoje|ontem)\b/u.test(f)) {
    return null;
  }
  if (
    /\b(?:analis[ea]|como estamos|avali[ea]|explique|por que|motivo|causa|diagnostique|estrategia|parecer)\b/u.test(
      f,
    )
  ) {
    return null;
  }

  // 15. Visit briefing / commercial summary (leave open-ended meeting prep like "Prepare minha reunião" for OpenAI)
  if (isVisitRequest(question) && /\b(?:resumo|briefing|ficha)\b/iu.test(f)) {
    const client = extractVisitClient(question, activeFilters);
    if (!client) {
      fail(
        422,
        "Selecione um cliente ou informe seu código/nome para preparar a visita. Cadastros semelhantes exigem a escolha do código correto.",
      );
    }
    const merged = mergeFiltersWithQuestion(question, activeFilters, capabilities, undefined, client);
    return {
      kind: "visit_briefing",
      visitRequested: true,
      plan: { group: "month", metric: "revenue", order: "current", filters: merged },
    };
  }
  if (isVisitRequest(question)) return null;

  const cats = extractCategories(question);
  const filters = mergeFiltersWithQuestion(question, activeFilters, capabilities, cats);

  // 14. Churned clients (deixaram de comprar)
  if (
    /\bclientes?\b.*\b(?:deixaram de comprar|pararam de comprar|sem compras? no periodo|churn)\b|\b(?:deixaram de comprar|pararam de comprar)\b/u.test(
      f,
    )
  ) {
    return {
      kind: "churned_clients",
      plan: { group: "client", metric: "revenue", order: "decline", filters },
    };
  }

  // 1 & 2. Customer counts vs buyers in period
  if (
    /(?:\bquantos?\b|\btotal\b|\bqtd\b|\bquantidade\b|\bnumero\b).*\bclientes?\b|\bclientes?\s+(?:distintos|cadastrados|na base)\b/u.test(
      f,
    )
  ) {
    const askingBuyersSpecifically = /\bcompraram\b/u.test(f) && !/\b(?:na base|cadastrad|existem na base|distintos na base)\b/u.test(f);
    return {
      kind: askingBuyersSpecifically ? "buyers_period" : "customer_counts",
      plan: { group: "month", metric: "buyers", order: "current", filters },
    };
  }

  // 3 & 4. Representatives registered vs selling
  if (/(?:\bquantos?\b|\btotal\b|\bqtd\b|\bquantidade\b|\bnumero\b).*\brepresentantes?\b/u.test(f)) {
    const active = /\b(?:tiveram\s+vendas?|com\s+vendas?|venderam|faturaram|ativos)\b/u.test(f);
    return {
      kind: active ? "rep_active_count" : "rep_registered_count",
      plan: { group: "region", metric: "revenue", order: "current", filters },
    };
  }

  // 12. Category mix / share %
  if (
    /(?:participa[cç][aã]o|share|mix|peso|fatia|divis[aã]o|percentual).*(?:categori|grupo)/iu.test(question) ||
    /cada\s+categoria/iu.test(question)
  ) {
    return {
      kind: "category_mix_share",
      plan: { group: "category", metric: "revenue", order: "current", filters },
    };
  }

  // 9. Clients with biggest decline / growth / revenue
  if (/\bclientes?\b.*\b(?:maior\s+queda|maiores?\s+quedas|cairam|retracao|perda|perderam)\b|\b(?:maior\s+queda|cairam).*clientes?\b/u.test(f)) {
    return {
      kind: "ranking",
      plan: { group: "client", metric: "revenue", order: "decline", filters },
    };
  }
  if (/\b(?:quais|top|principais|maiores)\s+.*clientes?\b.*\b(?:cresceram|crescimento|alta|faturaram|compraram)\b/u.test(f)) {
    const order = /\b(?:cresceram|crescimento|alta)\b/u.test(f) ? "growth" : "current";
    return {
      kind: "ranking",
      plan: { group: "client", metric: "revenue", order, filters },
    };
  }

  // 10. Products with biggest growth / decline
  if (/\bprodutos?\b.*\b(?:maior\s+crescimento|mais\s+cresceram|cresceram|alta)\b/u.test(f)) {
    return {
      kind: "ranking",
      plan: { group: "product", metric: "revenue", order: "growth", filters },
    };
  }
  if (/\bprodutos?\b.*\b(?:maior\s+queda|mais\s+cairam|cairam|retracao)\b/u.test(f)) {
    return {
      kind: "ranking",
      plan: { group: "product", metric: "revenue", order: "decline", filters },
    };
  }

  // 13. Representatives ranking (growth / decline / current)
  if (/\brepresentantes?\b.*\b(?:mais\s+cresceram|maior\s+crescimento|cresceram|alta)\b/u.test(f)) {
    return {
      kind: "ranking",
      plan: { group: "region", metric: "revenue", order: "growth", filters },
    };
  }
  if (/\brepresentantes?\b.*\b(?:maior\s+queda|mais\s+cairam|cairam|retracao)\b/u.test(f)) {
    return {
      kind: "ranking",
      plan: { group: "region", metric: "revenue", order: "decline", filters },
    };
  }

  // 11. Category-filtered revenue question (e.g. "Quanto faturamos em Suco e Vinho excluindo Granel?")
  if (
    (cats.include.length > 0 || cats.exclude.length > 0) &&
    /\b(?:quanto|qual|fatur|venda|receita|bruto|liquido|devoluc)\b/u.test(f)
  ) {
    const metric: Metric = /\bbrut/u.test(f) ? "gross" : /\bdevoluc/u.test(f) ? "returns" : "revenue";
    const group: Group = /\bcategoria|grupo\b/u.test(f) || cats.include.length > 1 ? "category" : "month";
    return {
      kind: "category_filtered",
      plan: { group, metric, order: "current", filters },
    };
  }

  // 7. Returns total
  if (/(?:\bquais?\b|\bquanto\b|\bqual\b|\btotal\b|\bvalor\b).*\bdevoluc(?:ao|oes)\b/u.test(f)) {
    return {
      kind: "metric_summary",
      plan: { group: "month", metric: "returns", order: "current", filters },
    };
  }

  // 5 & 6. Gross / Net revenue factual question
  if (/(?:\bqual\b|\bquanto\b|\btotal\b|\bvalor\b).*\bfaturamento\s+brut/u.test(f)) {
    return {
      kind: "metric_summary",
      plan: { group: "month", metric: "gross", order: "current", filters },
    };
  }
  if (
    /(?:\bqual\b|\bquanto\b|\btotal\b|\bvalor\b).*\bfaturamento\s+liquid/u.test(f) ||
    /\bfaturamento\s+em\s+20\d{2}\b/u.test(f) ||
    /\b(?:quanto|qual)\s+(?:foi\s+o\s+|o\s+)?(?:nosso\s+)?(?:fatur(?:amos|ou|ado|amento)|vend(?:emos|eu|as))\b/u.test(f)
  ) {
    return {
      kind: "metric_summary",
      plan: { group: "month", metric: "revenue", order: "current", filters },
    };
  }

  // 8. YoY growth question
  if (/\b(?:qual\b|\bquanto\b).*\bcrescimento\b|\bcrescimento\s+(?:yoy|em\s+relacao|vs|comparado|frente)\b/u.test(f)) {
    return {
      kind: "yoy_growth",
      plan: { group: "month", metric: "revenue", order: "current", filters },
    };
  }

  return null;
}
