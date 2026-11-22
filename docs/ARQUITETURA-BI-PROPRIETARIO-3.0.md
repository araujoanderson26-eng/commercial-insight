# Arquitetura Evolutiva — Commercial Insight 3.0 (BI Proprietário + IA)

**Versão de referência:** `main` (`be6ff1d`) → branch `feat/commercial-insight-3.0-ai-bi`  
**Escopo:** Evolução gradual sobre a arquitetura existente (React + TypeScript + Cloudflare Workers + D1 + R2 + OpenAI API), mantendo operação paralela e conciliada com o Power BI.

---

## 1. Separação de Camadas (8 Camadas)

| Camada | Responsabilidade | Módulos atuais |
|---|---|---|
| **1. Ingestão** | Recebimento autenticado de fontes autorizadas (hoje: 20 CSVs do DAX Studio via R2 + Queue; futuro: extrator autorizado SAP Business One). | `worker/csv-importer.ts`, `worker/manual.ts`, `shared/bi-modules.ts` |
| **2. Validação** | Checagem de schema, integridade referencial, deduplicação de clientes/produtos e regras de negócio antes da ativação (`staging` → `validated` → `active`). | `worker/csv-importer.ts`, `shared/reconciliation.ts` |
| **3. Transformação** | Normalização de chaves, preservação das 13 macrocategorias e 49 grupos oficiais do Power BI, construção do cubo mensal (`ci_agg_monthly`). | `worker/csv-importer.ts`, `shared/domain.ts` |
| **4. Modelo de Dados** | Modelo estrela no D1 (`ci_fact_sales`, `ci_fact_returns`, `ci_fact_orders_open`, `ci_dim_customers`, `ci_dim_products`, `ci_dim_regions`, `ci_dim_calendar`, `ci_dim_catalog`). | `migrations/0011_structured_csv_layer.sql` |
| **5. Indicadores** | Definição única e reutilizável de fórmulas comerciais e financeiras (bruto, devoluções, líquido, YoY, ticket por comprador, participação %). | `shared/metrics.ts`, `shared/domain.ts` |
| **6. Consultas** | Motor SQL tipado, ACL no backend, cascata nas 12 dimensões e contrato único de contexto de filtros. | `worker/csv-query.ts`, `shared/filter-context.ts` |
| **7. Visualização** | Dashboard, Gráficos, Relatórios, filtros compactos (drawer desktop / bottom sheet Android), Excel e PDF. | `src/components/FilterBar.tsx`, `src/components/DimensionMultiFilter.tsx`, `src/WorkspaceViews.tsx`, `src/exports.ts` |
| **8. Inteligência Artificial** | Modo A determinístico (D1, custo zero OpenAI) + Modo B analítico (OpenAI fundamentada em dados agregados do D1, com separação de fatos, indicadores, hipóteses e recomendações). | `worker/intent-router.ts`, `worker/deterministic-qa.ts`, `worker/assistant.ts`, `worker/production-ai-budget.ts`, `src/Chat.tsx` |

---

## 2. Governança e Política da Inteligência Artificial

- **Modo A (Determinístico — D1):** responde diretamente sem consumir créditos OpenAI para consultas objetivas (faturamento bruto/líquido, devoluções, evolução mensal, crescimento YoY, rankings de clientes/produtos/representantes, faturamento por regional/UF/categoria, clientes inativos).
- **Modo B (Avançado — OpenAI `gpt-4.1-mini-2025-04-14`):** reservado para análises abertas, diagnóstico de quedas, oportunidades, priorização e tendências, sempre alimentado apenas por agregações e top 12 linhas autorizadas no D1 (sem envio de PII/e-mails ou base completa).
- **Controle financeiro (US$ 20/mês):**
  - Teto mensal rígido de `US$ 20,00` (`20.000.000.000` nano USD) com reserva atômica single-flight e ledger imutável (`ai_production_attempts`).
  - Sem simulação de consulta automática de saldo OpenAI e sem exigência artificial de revalidação manual a cada 24h: exige registro administrativo válido (`administrator_id` ativo, `organization_id`, `project_id`, `verification_reference`), validade explícita (`credit_valid_until`, `pricing_valid_until`) e desabilita automaticamente em caso de erro real de saldo/cota (`insufficient_quota`, `credit_balance_exhausted`, `billing_hard_limit_reached`).
  - Liberação controlada para toda a equipe comercial autenticada (`admin`, `diretoria`, `gerente`, `comercial`), bloqueando `operador` (`update_only=1`) e contas inativas, mantendo a pré-checagem de metadados restrita ao administrador.
  - Em caso de indisponibilidade ou saldo esgotado na OpenAI, o erro é reportado claramente sem mascarar a causa e o BI + Modo A determinístico permanecem 100% operacionais.

---

## 3. Avaliação Objetiva do Cloudflare D1

- **Estado atual em produção:** ~1,09 GB de banco total (`404.728` linhas em `ci_fact_sales`, `19.430` em `ci_fact_returns`, `11.097` clientes, `660` produtos), bem abaixo do limite de 10 GB por banco D1, com latência sub-segundo graças ao cubo `ci_agg_monthly` e índices compostos (`batch_id, month_key, state_key`).
- **Recomendação imediata:** **manter o Cloudflare D1** como mecanismo principal durante toda a fase de consolidação comercial e primeiros módulos adicionais (Metas e Carteira de Pedidos), evitando migração prematura e custos operacionais desnecessários.
- **Gatilhos objetivos para avaliar motor analítico complementar (ex.: Parquet em R2 + DuckDB/ClickHouse):**
  1. Volume de fatos superior a ~5 milhões de linhas ou banco D1 acima de 6–7 GB (60–70% do teto de 10 GB).
  2. Necessidade de consultas ad-hoc multi-ano no grão SKU × cliente × dia fora dos cubos agregados com latência recorrente acima de 3–5s.
  3. Ingestão quase em tempo real (múltiplas atualizações por hora) vinda do ERP que gere contenção de escrita com leituras analíticas.

---

## 4. Diretrizes de Expansão Modular e Futura Integração SAP Business One

Os contratos de expansão estão definidos em `shared/bi-modules.ts` (sem implementação prematura de módulos):

1. **Módulo Comercial (ativo):** faturamento, devoluções, clientes, produtos, representantes, regionais, categorias e canais.
2. **Módulo de Metas (planejado):** tabela `ci_fact_targets` (mês × regional/representante/categoria), realizado vs. planejado e projeções.
3. **Módulo Financeiro (planejado):** `ci_fact_costs` / `ci_fact_margin` (margem, custos, rentabilidade — mantendo regra estrita de nunca rotular faturamento bruto como margem).
4. **Módulo de Estoques (planejado):** `ci_fact_inventory_snapshot` (disponibilidade, rupturas, giro, cobertura).
5. **Módulo de Carteira de Pedidos (planejado):** evolução da tabela existente `ci_fact_orders_open` + eventos de pedidos (`ci_fact_order_events`).

### Requisitos para a futura transição Power BI → SAP Business One (não conectado nesta etapa)
- **Fase 1 (atual):** operação paralela Power BI / DAX Studio → 20 CSVs → Commercial Insight D1, validada a cada ciclo com `shared/reconciliation.ts` (tolerância R$ 0,00 e mesma `referenceDate`).
- **Fase 2 (preparação ERP):** extrator somente leitura autorizado (Service Layer / views homologadas do SAP B1) gravando em staging no R2 com o mesmo contrato de validação e deduplicação.
- **Fase 3 (ativação progressiva):** conciliação paralela SAP B1 vs. Power BI durante ciclos fechados antes de aposentar qualquer relatório legado.
