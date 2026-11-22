/**
 * Contratos de arquitetura evolutiva para o Commercial Insight 3.0 (BI Proprietário).
 * Define camadas, módulos futuros e adaptadores de fonte sem implementar módulos fora do escopo.
 */

export type BiArchitectureLayer =
  | "ingestion"
  | "validation"
  | "transformation"
  | "semantic_model"
  | "indicators"
  | "queries"
  | "visualization"
  | "ai";

export type BiModuleId =
  | "comercial"
  | "metas"
  | "financeiro"
  | "estoques"
  | "carteira_pedidos";

export type BiModuleStatus = "active" | "planned";

export type BiModuleContract = {
  id: BiModuleId;
  name: string;
  status: BiModuleStatus;
  capabilities: readonly string[];
  requiredFactTables: readonly string[];
  requiredDimensions: readonly string[];
};

export const BI_MODULES: Record<BiModuleId, BiModuleContract> = {
  comercial: {
    id: "comercial",
    name: "Módulo Comercial",
    status: "active",
    capabilities: [
      "Faturamento bruto, devoluções e faturamento líquido",
      "Clientes, produtos, representantes, regionais, UFs, categorias e canais",
      "Filtros inteligentes em cascata e consultas determinísticas + IA",
    ],
    requiredFactTables: ["ci_fact_sales", "ci_fact_returns", "ci_agg_monthly"],
    requiredDimensions: ["ci_dim_customers", "ci_dim_products", "ci_dim_regions", "ci_dim_calendar"],
  },
  metas: {
    id: "metas",
    name: "Módulo de Metas",
    status: "planned",
    capabilities: ["Metas comerciais", "Realizado vs. planejado", "Atingimento percentual", "Projeções"],
    requiredFactTables: ["ci_fact_targets"],
    requiredDimensions: ["ci_dim_regions", "ci_dim_customers", "ci_dim_products", "ci_dim_calendar"],
  },
  financeiro: {
    id: "financeiro",
    name: "Módulo Financeiro",
    status: "planned",
    capabilities: ["Margem", "Rentabilidade", "Custos", "Indicadores de resultado"],
    requiredFactTables: ["ci_fact_costs", "ci_fact_margin"],
    requiredDimensions: ["ci_dim_products", "ci_dim_customers", "ci_dim_calendar"],
  },
  estoques: {
    id: "estoques",
    name: "Módulo de Estoques",
    status: "planned",
    capabilities: ["Disponibilidade", "Rupturas", "Giro", "Cobertura", "Produtos críticos"],
    requiredFactTables: ["ci_fact_inventory_snapshot"],
    requiredDimensions: ["ci_dim_products", "ci_dim_calendar"],
  },
  carteira_pedidos: {
    id: "carteira_pedidos",
    name: "Módulo de Carteira de Pedidos",
    status: "planned",
    capabilities: ["Pedidos pendentes", "Pedidos faturados", "Pedidos cancelados", "Produtos em falta", "Previsão de atendimento"],
    requiredFactTables: ["ci_fact_orders_open", "ci_fact_order_events"],
    requiredDimensions: ["ci_dim_customers", "ci_dim_products", "ci_dim_regions", "ci_dim_calendar"],
  },
};

export type DataSourceAdapterKind = "csv_dax_studio" | "erp_sap_b1";

export type DataSourceAdapterContract = {
  kind: DataSourceAdapterKind;
  label: string;
  status: "active" | "planned";
  pipeline: readonly BiArchitectureLayer[];
  notes: string;
};

export const DATA_SOURCE_ADAPTERS: Record<DataSourceAdapterKind, DataSourceAdapterContract> = {
  csv_dax_studio: {
    kind: "csv_dax_studio",
    label: "Power BI / DAX Studio (20 CSVs oficiais)",
    status: "active",
    pipeline: [
      "ingestion",
      "validation",
      "transformation",
      "semantic_model",
      "indicators",
      "queries",
      "visualization",
      "ai",
    ],
    notes: "Operação atual em paralelo ao Power BI, com conciliação ao centavo no Cloudflare D1 + R2.",
  },
  erp_sap_b1: {
    kind: "erp_sap_b1",
    label: "SAP Business One (Integração autorizada futura)",
    status: "planned",
    pipeline: [
      "ingestion",
      "validation",
      "transformation",
      "semantic_model",
      "indicators",
      "queries",
      "visualization",
      "ai",
    ],
    notes: "Não conectado nesta etapa. Futura ingestão incremental em staging + reconciliação antes de ativar lote.",
  },
};
