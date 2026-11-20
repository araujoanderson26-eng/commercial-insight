# Modernização Estrutural — Commercial Insight 2.0

Branch: `feat/modernizacao-estrutural-2.0` (baseada em `main` `57a46e8`, preservando integralmente os PRs #1, #2, #5 e #6, Preparador 1.0.3, usuários/senhas, ACL e política de orçamento OpenAI de US\$ 20/mês).

> [!WARNING]
> **Produção e PBIX preservados:** Nenhuma publicação em produção (`main` / `wrangler deploy`) foi executada. Todos os componentes novos são aditivos, paralelos e reversíveis.

---

## 1. Visão Arquitetural da Entrega

### 1.1 Performance Frontend & Híbrido Web + Mobile
- **Cache SWR em 2 níveis (`src/lib/cache.ts`) + Projeção 0 ms (`src/lib/analytics.ts`):** cache em RAM + IndexedDB escopado por `(userId | policyVersion | source | activeVersionId)` com revalidação silenciosa em segundo plano e alternância instantânea de métricas/ordenação em séries mensais ou rankings completos.
- **Skeletons & Debounce (`src/components/Skeletons.tsx`, `src/components/FilterBar.tsx`):** skeletons durante o carregamento inicial sem bloquear a UI; debounce de `300 ms` e `AbortController` preservados nas consultas de opções e busca rápida.
- **Worker Edge Cache & Paralelismo (`worker/index.ts`, `worker/native-model.ts`, `worker/manual.ts`):** consultas de totais/grupos e labels paralelas via `Promise.all`; `caches.default` para `/api/report` e `/api/data/options` (sempre após `checkAccess()`), retornando `X-Cache` (`HIT`/`MISS`/`BYPASS`) e `Server-Timing`, preservando `Cache-Control: private, no-store` no cliente.
- **Web + PWA + Capacitor (`capacitor.config.ts`, `public/manifest.webmanifest`, `public/offline.html`, `scripts/sw.mjs`, `src/lib/runtime.ts`):** suporte instalável offline-ready para ativos estáticos (nunca cacheando `/api/*`), CSS com safe-areas (`--sat/--sab/--sal/--sar`) e suporte opcional a autenticação Bearer para origens Capacitor quando `MOBILE_ORIGINS` estiver configurado.

### 1.2 Camada Estruturada CSV no D1 (`migrations/0011_structured_csv_layer.sql`)
- Tabelas **100% aditivas e isoladas** de `0001..0010`: `ci_csv_batches`, `ci_csv_files`, `ci_dim_customers` (deduplicada por `client_key`), `ci_dim_products`, `ci_dim_regions`, `ci_dim_calendar`, `ci_fact_sales`, `ci_fact_returns`, `ci_fact_orders_open` (backlog separado), `ci_agg_monthly` (tabela agregada mensal pré-computada), `ci_dim_catalog` e `ci_csv_active` (modo padrão `'shadow'`).
- **Importador CSV Batch (`shared/csv.ts`, `worker/csv-importer.ts`):**
  - Endpoints `/api/admin/csv/*` (operador pode criar lote, enviar para R2, processar e validar; apenas administrador pode ativar ou executar `/api/admin/csv/rollback`).
  - Parser streaming RFC-4180, detecção automática de delimitador, validação de datas/decimais, deduplicação rastreada de clientes, cálculo de `diff` (novos/removidos vs lote ativo anterior) e validação de conciliação automática.

### 1.3 Filtros Multi-Seleção, Faixas e Alerta de Conflitos
- **Schema estendido (`shared/domain.ts`):** compatível retroativamente com filtros legados; adiciona arrays `regions[]`, `regionals[]`, `states[]`, `managers[]`, `clients[]`, `products[]`, `channels[]`, `segments[]`, `brands[]`, `revenueMin/Max`, `ticketMin/Max`, `variationDirection` (`all | growth | decline`) e `detectFilterConflicts()`.
- **Enforce no Backend (`worker/native-model.ts`, `worker/manual.ts`, `worker/analysis.ts`):**
  - Lógica `OU` dentro da mesma dimensão e `E` entre dimensões; exclusão prevalece sobre inclusão; interseção obrigatória com a ACL de `regions` e `clients` do usuário (HTTP 403 em qualquer tentativa fora do escopo).
  - Filtros de faixa/direção desativam `LIMIT 31` antes da filtragem para não truncar resultados válidos.
- **UI Mobile-First (`src/components/FilterBar.tsx`, `src/lib/filter-state.ts`, `src/export-model.ts`):**
  - Barra superior desktop + botão flutuante e *Bottom Sheet* mobile; chips removíveis, presets (`3M`, `6M`, `12M`, `Ano`, `2026`, `2025`), persistência em URL + `localStorage`, seleção múltipla por tags, alerta visual de conflito e espelhamento completo no cabeçalho das exportações Excel/PDF (`filterLabel`).

### 1.4 Motor Determinístico de IA em 3 Camadas (`worker/intent-router.ts`, `worker/deterministic-qa.ts`)
- **Camada 1 — Roteador Síncrono (< 2 ms):** identifica as 15 perguntas comerciais essenciais, extrai períodos (`2025`, `2026`, mês/ano), UFs, categorias (`SUCO`, `VINHO`, `ESPUMANTE`, `GRANEL`) e preparo de visita sem custos de OpenAI. Perguntas abertas/analíticas, acompanhamento conversacional com pronomes, HML restrito e fonte `PowerBIProvider` continuam seguindo exatamente o fluxo OpenAI existente.
- **Camada 2 — Consultas SQL Parametrizadas com ACL:** responde contagens de cadastrados vs compradores/ativos, cálculo exato de *churn* (`QueryChurnedClients`: comprou no período homólogo anterior e zero vendas positivas no atual), participação percentual e rankings sem depender de geração de SQL pelo LLM.
- **Camada 3 — Formatação Ancorada & Orçamento Preservado:** preserva integralmente `checkAccess()`, `assertAssistantAccess()`, `allow_ai` e o ledger de orçamento `0010_production_ai_budget.sql` (limite de US\$ 20/mês, `store: false`, modelo fixo e acesso administrativo). Respostas determinísticas consomem **0 chamadas à OpenAI**.

### 1.5 Dashboards Executivos & Exportações (Etapas 6–7)
- **Gráficos ECharts SVG (`src/components/SmartChart.tsx`, `src/ui.tsx`):** renderização SVG nítida para desktop, mobile e impressão/PDF; modos **Comparativo / Linha**, **Variação Δ / Colunas** e **Participação %**, com *cross-filtering* ao toque/clique e *zoom/scroll* para rankings.
- **KPIs & Visões Rápidas (`src/ui.tsx`, `src/WorkspaceViews.tsx`):** exibição clara de *Ticket por comprador* + *Ticket médio por NF (`Serial`)* e *Representantes ativos* quando disponíveis; atalhos executivos sincronizados aos filtros ativos; exportações premium Excel e PDF executivo do PR #6 100% preservadas.

---

## 2. Resultado da Homologação Local com os CSVs Reais (SQLite `.wrangler/csv-homologation.sqlite`)

Executado via [`scripts/import-csv-local.ts`](../scripts/import-csv-local.ts) sobre os 20 CSVs reais exportados do Power BI (`2023-07-01` a `2026-11-17`):

| Indicador / Recorte (2026 até 17/11/2026 vs 2025 homólogo) | Valor Conciliado (Reais / Qtd) |
| --- | --- |
| Linhas de faturamento / Devoluções estruturadas | `404.728` vendas / `19.430` devoluções |
| Clientes distintos na base / Duplicatas removidas | `11.097` distintos / `11.138` duplicatas (`0` conflitos) |
| Clientes compradores em 2026 | `3.538` |
| Clientes que compraram em 2025 e zeraram em 2026 | `1.351` |
| Representantes cadastrados / com vendas em 2026 | `150` cadastrados / `98` ativos |
| Faturamento Bruto 2026 | R\$ 266.288.149,10 |
| Devoluções 2026 | R\$ 9.525.848,54 |
| Faturamento Líquido 2026 (vs 2025 homólogo) | R\$ 256.762.300,56 (ante R\$ 291.854.722,41 · `-12,02%`) |
| NFs distintas em 2026 (`Serial`) | `18.881` |
| Ticket por Comprador 2026 | R\$ 72.572,72 |
| Ticket Médio por NF 2026 (Líquido / Bruto) | R\$ 13.598,98 / R\$ 14.103,50 |
| **Exemplo A:** `SUCO` + `VINHO` excluindo `Granel` (2026) | R\$ 137.914.999,19 bruto · R\$ 5.844.282,04 dev. · **R\$ 132.070.717,15 líq.** |
| **Exemplo B:** Somente `Granel` (2026) | R\$ 39.439.570,79 bruto |
| **Exemplo C:** `SUCO` + `ESPUMANTE` + `SP` (2026) | R\$ 17.571.883,81 bruto |

---

## 3. Benchmarks Reais das 15 Perguntas Obrigatórias

| # | Pergunta / Consulta | Antes (OpenAI 2x + scan) | Depois (Roteador + SQL indexado / `ci_agg_monthly`) | Chamadas OpenAI |
| --- | --- | --- | --- | --- |
| 1 | Quantos clientes distintos existem na base? | > 3.000 ms (ou impreciso por duplicatas) | **3,16 ms** (`11.097`) | **0** |
| 2 | Quantos clientes compraram em 2026? | ~2.500–6.000 ms | **271,92 ms** (`3.538`) | **0** |
| 3 | Quantos representantes existem cadastrados? | Indisponível sem consulta dedicada | **2,36 ms** (`150`) | **0** |
| 4 | Quantos representantes tiveram vendas? | Indisponível / LLM | **458,56 ms** (`98`) | **0** |
| 5 | Qual foi o faturamento bruto em 2026? | ~2.500–6.000 ms | **6,24 ms** (R\$ 266.288.149,10) | **0** |
| 6 | Qual foi o faturamento líquido? | ~2.500–6.000 ms | **8,56 ms** (R\$ 256.762.300,56) | **0** |
| 7 | Quais foram as devoluções? | ~2.500–6.000 ms | **5,74 ms** (R\$ 9.525.848,54) | **0** |
| 8 | Qual foi o crescimento em relação a 2025? | ~2.500–6.000 ms | **78,37 ms** (`-12,02%` YTD) | **0** |
| 9 | Quais clientes tiveram maior queda de faturamento? | ~2.500–6.000 ms | **2.071,94 ms** (`2.714` em queda)* | **0** |
| 10 | Quais produtos tiveram maior crescimento? | ~2.500–6.000 ms | **675,61 ms** (`227` em alta) | **0** |
| 11 | Quanto faturamos em Suco e Vinho excluindo Granel? | ~2.500–6.000 ms | **7,25 ms** (R\$ 132.070.717,15 líq.) | **0** |
| 12 | Qual a participação de cada categoria? | ~2.500–6.000 ms | **21,29 ms** (`13` macro categorias) | **0** |
| 13 | Quais representantes mais cresceram? | ~2.500–6.000 ms | **1.463,75 ms** (`43` em crescimento) | **0** |
| 14 | Quais clientes deixaram de comprar? | Indisponível / LLM | **4.164,93 ms** (`1.351` clientes)* | **0** |
| 15 | Prepare um resumo comercial para visita ao cliente | ~3.000–7.000 ms | **0,80 ms** busca por índice cliente | **0** |

*\*Nota:* Após o benchmark acima, o índice `ci_fact_sales_client` em `migrations/0011_structured_csv_layer.sql` recebeu `gross_amount` como *covering index* `(batch_id, client_key, date, gross_amount)` para acelerar Q9 e Q14 em cargas subsequentes.

---

## 4. Plano de Migração Gradual e Rollback

1. **Fase Sombra (Padrão atual da `0011`):** aplicar `migrations/0011_structured_csv_layer.sql` em HML/D1 mantém `ci_csv_active.mode = 'shadow'`. Produção continua operando sobre `ci_sources`/`ci_native_*` sem qualquer alteração para os usuários.
2. **Carga e Validação em Lote:** administrador/operador envia o conjunto de CSVs via `/api/admin/csv/batches`, executa `process` e `validate`, revisando os números conciliados e o relatório de diff (`added`/`removed`) contra o lote anterior.
3. **Ativação Controlada (Admin):** após homologação formal em HML, o administrador executa `POST /api/admin/csv/batches/:id/activate`.
4. **Rollback Instantâneo (< 1 s):** em caso de anomalia, `POST /api/admin/csv/rollback` restaura `previous_batch_id` (ou retorna para `'shadow'`) atomicamente no D1 sem perda de dados das tabelas `0001..0010` nem da versão anterior.

---

## 5. Decisão Comercial Definitiva e Pendências

1. **Definição comercial de categorias (APROVADA E IMPLEMENTADA):** *Sucos Concentrados* (`SUCO CONCENTRADO DE UVA`, `MAÇÃ`, `LARANJA`, `TANGERINA` e grupos oficiais), *Granel* (`VINHO GRANEL`, `VINAGRE GRANEL`, `PA - GRANEL`, `PA - SUCO CONCENTRADO GRANEL`), *Sucos Importados* e *Vinho Importado* são tratados estritamente como **categorias independentes**. Nunca são agrupados automaticamente em `SUCO`, `VINHO` ou `VINAGRE`, preservando os códigos oficiais e permitindo inclusão/exclusão individual nos filtros e na IA determinística.
2. **Ativação em Produção:** segue bloqueada até aprovação explícita após conclusão da homologação em HML e revisão da PR (ver `docs/PLANO-PUBLICACAO-PRODUCAO-2.0.md`).
3. **Publicação Mobile (Capacitor / Android / iOS):** definir as origens permitidas para `MOBILE_ORIGINS` no Worker caso deseje compilar e distribuir o app nativo híbrido com `npm run mobile:sync`.
4. **Visões extras de Carteira em Aberto (`Base Pedidos.csv`) e Metas (`Base Metas.csv`):** como ambas já possuem mapeamento isolado definido no inventário (`ci_fact_orders_open`), confirmar em uma etapa futura se deseja um painel dedicado de carteira em aberto x realizado sem misturar com o faturamento oficial.
