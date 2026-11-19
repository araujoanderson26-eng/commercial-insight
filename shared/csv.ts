import { decimalInteger } from "./manual";

export type CsvRole =
  | "sales"
  | "returns"
  | "customers"
  | "products"
  | "regions"
  | "calendar"
  | "orders"
  | "stock"
  | "targets"
  | "budget"
  | "rep_area";

export const csvRoles: CsvRole[] = [
  "sales",
  "returns",
  "customers",
  "products",
  "regions",
  "calendar",
  "orders",
  "stock",
  "targets",
  "budget",
  "rep_area",
];

export type CsvFieldSpec = {
  field: string;
  aliases: string[];
  required: boolean;
};

export type CsvRoleSchema = {
  role: CsvRole;
  defaultFilename: string;
  grain: string;
  fields: CsvFieldSpec[];
};

export const CSV_SCHEMAS: Record<CsvRole, CsvRoleSchema> = {
  sales: {
    role: "sales",
    defaultFilename: "Faturamento.csv",
    grain: "Item de nota fiscal emitida (Serial)",
    fields: [
      { field: "date", aliases: ["Data do lanc.", "Data do lançamento", "Data"], required: true },
      { field: "docNo", aliases: ["Serial", "Nº Documento", "Nº documento", "Nº interno"], required: false },
      { field: "client", aliases: ["Codigo Cliente", "Código Cliente", "Cód. Cliente"], required: true },
      { field: "clientName", aliases: ["Cliente", "Razão Social"], required: false },
      { field: "channel", aliases: ["Canal"], required: false },
      { field: "state", aliases: ["UF", "Estado"], required: false },
      { field: "municipality", aliases: ["Municipio", "Município", "Cidade"], required: false },
      { field: "product", aliases: ["Código do item", "Codigo Item", "Código do Item"], required: true },
      { field: "productName", aliases: ["Descrição do item", "Descricao do item"], required: false },
      { field: "group", aliases: ["Grupo Item", "Grupo do Item", "Categoria"], required: false },
      { field: "qty", aliases: ["Quantidade", "Qtd"], required: false },
      { field: "utilization", aliases: ["Utilização", "Utilizacao"], required: false },
      { field: "amount", aliases: ["Valor mercadorias", "Valor Mercadorias", "Faturamento Bruto"], required: true },
      { field: "accountingAmount", aliases: ["Valor contábil", "Valor contabil"], required: false },
      { field: "liters", aliases: ["Total Litros", "Litros"], required: false },
      { field: "regional", aliases: ["Regional", "Base Regionais.Regional"], required: false },
    ],
  },
  returns: {
    role: "returns",
    defaultFilename: "DEVOLUÇÃO.csv",
    grain: "Item de documento de devolução",
    fields: [
      { field: "date", aliases: ["Data do lanc.", "Data do lançamento", "Data"], required: true },
      { field: "docNo", aliases: ["Serial", "Nº Documento", "Nº documento", "Nº interno"], required: false },
      { field: "client", aliases: ["Cód. PN", "Código Cliente", "Codigo Cliente"], required: true },
      { field: "clientName", aliases: ["Nome PN", "Cliente"], required: false },
      { field: "state", aliases: ["UF", "Estado"], required: false },
      { field: "product", aliases: ["Código do item", "Codigo Item", "Código do Item"], required: false },
      { field: "group", aliases: ["Grupo Item", "Grupo do Item", "Categoria"], required: false },
      { field: "qty", aliases: ["Quantidade", "Qtd"], required: false },
      { field: "amount", aliases: ["Valor mercadorias", "Valor Mercadorias", "Devoluções"], required: true },
      { field: "liters", aliases: ["Total Litros", "Litros"], required: false },
    ],
  },
  customers: {
    role: "customers",
    defaultFilename: "Base Clientes.csv",
    grain: "Cliente único por Código Cliente (deduplicado na importação)",
    fields: [
      { field: "client", aliases: ["Código Cliente", "Codigo Cliente", "Cód. Cliente"], required: true },
      { field: "name", aliases: ["Cliente", "Razão Social", "Nome"], required: false },
      { field: "representative", aliases: ["Representantes", "Representante"], required: false },
      { field: "state", aliases: ["Estado", "UF"], required: false },
      { field: "regional", aliases: ["Região", "Regional"], required: false },
      { field: "segment", aliases: ["Segmento"], required: false },
      { field: "saleType", aliases: ["Tipo de Venda"], required: false },
    ],
  },
  products: {
    role: "products",
    defaultFilename: "Base Produtos.csv",
    grain: "Item cadastrado (Codigo Item único)",
    fields: [
      { field: "product", aliases: ["Codigo Item", "Código do item", "Código Item"], required: true },
      { field: "description", aliases: ["Descrição do item", "Descricao do item"], required: false },
      { field: "brand", aliases: ["Marca"], required: false },
      { field: "unitLiters", aliases: ["Litros por Unidade"], required: false },
      { field: "boxLiters", aliases: ["Litros por Caixa"], required: false },
      { field: "packQty", aliases: ["Quantidade por embalagem (vendas)"], required: false },
      { field: "unitMeasure", aliases: ["Unidade de medida de venda"], required: false },
      { field: "macroCategory", aliases: ["Macro Categoria"], required: true },
      { field: "abcClass", aliases: ["Classificacao_ABC_Frequencia_COL"], required: false },
    ],
  },
  regions: {
    role: "regions",
    defaultFilename: "Base Regionais.csv",
    grain: "Unidade federativa (Sigla única)",
    fields: [
      { field: "stateName", aliases: ["Unidade federativa"], required: false },
      { field: "state", aliases: ["Sigla", "UF"], required: true },
      { field: "regional", aliases: ["Regional"], required: true },
      { field: "manager", aliases: ["Gerente"], required: false },
      { field: "regionName", aliases: ["Região"], required: false },
    ],
  },
  calendar: {
    role: "calendar",
    defaultFilename: "dCalendario.csv",
    grain: "Data diária do modelo",
    fields: [
      { field: "date", aliases: ["Date", "Data"], required: true },
      { field: "month", aliases: ["MÊS", "Mes", "Mês"], required: false },
      { field: "year", aliases: ["Ano"], required: false },
      { field: "quarter", aliases: ["Trimestre"], required: false },
    ],
  },
  orders: {
    role: "orders",
    defaultFilename: "Base Pedidos.csv",
    grain: "Pedido de venda em aberto (carteira/backlog, separado do faturamento)",
    fields: [
      { field: "docNo", aliases: ["Nº do documento", "Nº Documento"], required: true },
      { field: "client", aliases: ["Código do cliente", "Codigo Cliente"], required: false },
      { field: "state", aliases: ["UF"], required: false },
      { field: "date", aliases: ["Data de lançamento", "Data"], required: false },
      { field: "openAmount", aliases: ["Valor em aberto"], required: false },
      { field: "originalAmount", aliases: ["Valor original"], required: false },
      { field: "utilization", aliases: ["Utilizacao", "Utilização"], required: false },
    ],
  },
  stock: {
    role: "stock",
    defaultFilename: "Estoque.csv",
    grain: "Posição de estoque atual por item",
    fields: [
      { field: "product", aliases: ["Nº do item", "Codigo Item"], required: true },
      { field: "description", aliases: ["Descrição do item"], required: false },
      { field: "available", aliases: ["Disponível", "Estoque disponível"], required: true },
    ],
  },
  targets: {
    role: "targets",
    defaultFilename: "Base Metas.csv",
    grain: "Meta mensal por regional",
    fields: [
      { field: "regional", aliases: ["Regional"], required: true },
      { field: "date", aliases: ["Data"], required: true },
      { field: "target", aliases: ["META", "Meta"], required: true },
    ],
  },
  budget: {
    role: "budget",
    defaultFilename: "Orcamento.csv",
    grain: "Orçamento em quantidade e litros por regional, item e mês",
    fields: [
      { field: "regional", aliases: ["Regional"], required: true },
      { field: "product", aliases: ["Código", "Codigo Item"], required: true },
      { field: "month", aliases: ["Mês", "Mes"], required: true },
      { field: "qty", aliases: ["QUANTIDADE", "Quantidade"], required: false },
      { field: "liters", aliases: ["LITROS", "Litros"], required: false },
    ],
  },
  rep_area: {
    role: "rep_area",
    defaultFilename: "Rep Area.csv",
    grain: "Área geográfica do representante",
    fields: [
      { field: "code", aliases: ["Código do PN", "Codigo PN"], required: true },
      { field: "name", aliases: ["Nome do PN", "Nome"], required: false },
      { field: "state", aliases: ["UF"], required: true },
    ],
  },
};

export function foldHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLocaleLowerCase("pt-BR");
}

export function normalizeCsvKey(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.normalize("NFC").trim();
  if (!trimmed) return null;
  return trimmed.toLocaleUpperCase("pt-BR");
}

export function cleanCsvDisplay(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.normalize("NFC").trim();
  return trimmed || null;
}

export function detectCsvDelimiter(sample: string): "," | ";" {
  const clean = sample.replace(/^\uFEFF/, "");
  let commas = 0;
  let semis = 0;
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '"') {
      if (inQuotes && clean[i + 1] === '"') {
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes) {
      if (ch === ",") commas++;
      else if (ch === ";") semis++;
      else if (ch === "\n" || ch === "\r") break;
    }
  }
  return semis > commas ? ";" : ",";
}

/**
 * Push-based RFC-4180 CSV record parser.
 * Preserves embedded newlines and escaped quotes inside quoted fields (essential for DEVOLUÇÃO.csv).
 */
export function createCsvRecordParser(explicitDelimiter?: "," | ";") {
  let delimiter = explicitDelimiter;
  let started = false;
  let inQuotes = false;
  let justClosedQuote = false;
  let field = "";
  let row: string[] = [];

  const pushChunk = (rawChunk: string): string[][] => {
    const out: string[][] = [];
    let chunk = rawChunk;
    if (!started) {
      chunk = chunk.replace(/^\uFEFF/, "");
      if (!chunk.length) return out;
      if (!delimiter) delimiter = detectCsvDelimiter(chunk);
      started = true;
    }

    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < chunk.length && chunk[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
            justClosedQuote = true;
          }
        } else {
          field += ch;
        }
        continue;
      }

      if (justClosedQuote) {
        justClosedQuote = false;
        if (ch === '"') {
          // Handle split `""` across chunk boundary: reopen quotes with literal `"`
          field += '"';
          inQuotes = true;
          continue;
        }
      }

      if (ch === '"' && field.length === 0) {
        inQuotes = true;
      } else if (ch === delimiter) {
        row.push(field);
        field = "";
      } else if (ch === "\r") {
        // Ignore CR; handle LF next or treat standalone CR if needed
      } else if (ch === "\n") {
        row.push(field);
        field = "";
        if (row.length > 1 || row[0] !== "") out.push(row);
        row = [];
      } else {
        field += ch;
      }
    }
    return out;
  };

  const finish = (): string[][] => {
    const out: string[][] = [];
    if (inQuotes || field.length > 0 || row.length > 0) {
      row.push(field);
      if (row.length > 1 || row[0] !== "") out.push(row);
      field = "";
      row = [];
      inQuotes = false;
      justClosedQuote = false;
    }
    return out;
  };

  return { push: pushChunk, finish };
}

export function parseCsvRecords(
  input: string,
  options?: { delimiter?: "," | ";" },
): { headers: string[]; rows: string[][] } {
  const parser = createCsvRecordParser(options?.delimiter);
  const records = [...parser.push(input), ...parser.finish()];
  if (!records.length) return { headers: [], rows: [] };
  const headers = records[0].map((h) => h.replace(/^\uFEFF/, "").trim());
  return { headers, rows: records.slice(1) };
}

export function resolveCsvColumnMap(
  role: CsvRole,
  headers: string[],
): { map: Record<string, number>; missingRequired: string[] } {
  const schema = CSV_SCHEMAS[role];
  const normalizedHeaders = headers.map((h) => foldHeader(h));
  const map: Record<string, number> = {};
  const missingRequired: string[] = [];

  for (const spec of schema.fields) {
    let found = -1;
    for (const alias of spec.aliases) {
      const target = foldHeader(alias);
      const idx = normalizedHeaders.indexOf(target);
      if (idx >= 0) {
        found = idx;
        break;
      }
    }
    if (found >= 0) map[spec.field] = found;
    else if (spec.required) missingRequired.push(`${spec.field} (${spec.aliases[0]})`);
  }
  return { map, missingRequired };
}

export function parseCsvDate(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;

  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const m = Number(isoMatch[2]);
    const d = Number(isoMatch[3]);
    const check = new Date(Date.UTC(y, m - 1, d));
    if (
      check.getUTCFullYear() === y &&
      check.getUTCMonth() + 1 === m &&
      check.getUTCDate() === d
    ) {
      return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    }
    return null;
  }

  const brMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s.*)?$/);
  if (brMatch) {
    const d = Number(brMatch[1]);
    const m = Number(brMatch[2]);
    const y = Number(brMatch[3]);
    const check = new Date(Date.UTC(y, m - 1, d));
    if (
      check.getUTCFullYear() === y &&
      check.getUTCMonth() + 1 === m &&
      check.getUTCDate() === d
    ) {
      return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  return null;
}

export function parseCsvDecimalString(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim().replace(/\s+/g, "");
  if (!trimmed) return null;

  let normalized: string;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    normalized = trimmed;
  } else {
    // Handle Brazilian formatting (e.g. "1.234,56") or US comma-grouped numbers ("1,234.56")
    const lastComma = trimmed.lastIndexOf(",");
    const lastDot = trimmed.lastIndexOf(".");
    if (lastComma > lastDot) {
      normalized = trimmed.replaceAll(".", "").replace(",", ".");
    } else if (lastDot > lastComma) {
      normalized = trimmed.replaceAll(",", "");
    } else {
      normalized = trimmed.replaceAll(",", ".");
    }
  }

  if (/^-?(?:\d+(?:\.\d+)?|\.\d+)[eE][+-]?\d+$/.test(normalized)) {
    const n = Number(normalized);
    if (!Number.isFinite(n)) return null;
    normalized = n.toFixed(6).replace(/\.?0+$/, "");
  }

  if (/^-?\.\d+$/.test(normalized)) {
    normalized = normalized.startsWith("-") ? "-0" + normalized.slice(1) : "0" + normalized;
  }
  const m = normalized.match(/^(-?)0*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return (m[1] ?? "") + m[2];
}

export function parseScaledCsvAmount(
  raw: string | null | undefined,
  scale = 4,
  allowPhysicalRound = false,
): number | null {
  const dec = parseCsvDecimalString(raw);
  if (dec === null) return null;
  if (allowPhysicalRound) {
    const n = Number(dec);
    if (!Number.isFinite(n)) return null;
    const scaled = Math.round(n * 10 ** scale);
    return Number.isSafeInteger(scaled) ? scaled : null;
  }
  return decimalInteger(dec, scale);
}

export type CustomerDedupRow = {
  clientKey: string;
  clientRaw: string;
  name: string | null;
  representativeKey: string | null;
  representativeRaw: string | null;
  stateKey: string | null;
  regionalRaw: string | null;
  segment: string | null;
  saleType: string | null;
  sourceRows: number;
};

export function deduplicateCustomers(
  records: {
    client: string | null | undefined;
    name?: string | null | undefined;
    representative?: string | null | undefined;
    state?: string | null | undefined;
    regional?: string | null | undefined;
    segment?: string | null | undefined;
    saleType?: string | null | undefined;
  }[],
): {
  rows: CustomerDedupRow[];
  rawCount: number;
  duplicateCount: number;
  rejectedCount: number;
  conflicts: string[];
} {
  const map = new Map<string, CustomerDedupRow>();
  const conflictSet = new Set<string>();
  let rawCount = 0;
  let duplicateCount = 0;
  let rejectedCount = 0;

  for (const rec of records) {
    rawCount++;
    const key = normalizeCsvKey(rec.client);
    const raw = cleanCsvDisplay(rec.client);
    if (!key || !raw) {
      rejectedCount++;
      continue;
    }
    const candidate: CustomerDedupRow = {
      clientKey: key,
      clientRaw: raw,
      name: cleanCsvDisplay(rec.name),
      representativeKey: normalizeCsvKey(rec.representative),
      representativeRaw: cleanCsvDisplay(rec.representative),
      stateKey: normalizeCsvKey(rec.state),
      regionalRaw: cleanCsvDisplay(rec.regional),
      segment: cleanCsvDisplay(rec.segment),
      saleType: cleanCsvDisplay(rec.saleType),
      sourceRows: 1,
    };
    const existing = map.get(key);
    if (!existing) {
      map.set(key, candidate);
      continue;
    }
    duplicateCount++;
    existing.sourceRows++;

    for (const field of ["name", "representativeKey", "stateKey", "regionalRaw", "segment"] as const) {
      const a = existing[field];
      const b = candidate[field];
      if (a && b && a !== b) {
        conflictSet.add(`${key}:${field}`);
      } else if (!a && b) {
        if (field === "representativeKey") {
          existing.representativeKey = candidate.representativeKey;
          existing.representativeRaw = candidate.representativeRaw;
        } else {
          existing[field] = b;
        }
      }
    }
  }

  return {
    rows: [...map.values()],
    rawCount,
    duplicateCount,
    rejectedCount,
    conflicts: [...conflictSet],
  };
}
