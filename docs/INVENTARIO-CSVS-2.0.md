# Inventário dos CSVs Exportados do Power BI (DAX Studio)

Auditoria técnica realizada sobre os 20 arquivos CSV exportados via DAX Studio em diretório local externo ao repositório (`C:\Users\Anderson de Araujo\OneDrive\Área de Trabalho\Dax`), **sem inclusão de dados comerciais privados, nomes de clientes ou credenciais no Git**.

---

## 1. Resumo de Cobertura e Qualidade

- **Período coberto pelos fatos e calendário:** `2023-07-01` a `2026-11-17` (`1.236` dias em `dCalendario.csv`).
- **Integridade de datas e valores:** 100% dos registros de `Faturamento.csv` (`404.728` linhas) e `DEVOLUÇÃO.csv` (`19.430` registros RFC-4180) possuem `Data do lanc.` e `Valor mercadorias` preenchidos e presentes em `dCalendario`.
- **Anomalia crítica corrigida na ingestão:**
  1. **`DEVOLUÇÃO.csv` com quebras de linha embutidas:** divisão simples por `\n` fragmentava `19.430` registros em `29.973` linhas corrompidas por quebras dentro de campos cotados (`ObservacaoComplementar`). Resolvido com parser streaming estrito **RFC-4180** (`shared/csv.ts`).
  2. **`Base Clientes.csv` duplicada na origem:** `22.235` linhas brutas colapsam para **`11.097` clientes distintos** por `Código Cliente` após deduplicação exata das **`11.138` linhas repetidas**, com **`0` conflitos de atributos**.
  3. **Cabeçalhos DAX Studio com espaços finais:** colunas como `"Região "`, `"Segmento "` e `"Regional "` são normalizadas por `.trim()` no mapeamento de esquema.
  4. **Escala de litragem/quantidade física:** colunas de volume (`Litros por Caixa`, `Total Litros`) possuem mais de 4 casas decimais no Power BI (`double`) e usam arredondamento explícito exclusivo para medidas físicas, mantendo conversão inteira exata sem arredondamento (`decimalInteger`, escala 4) para todos os valores financeiros (`Valor mercadorias`, `Valor contábil`).

---

## 2. Inventário das 20 Tabelas

| Arquivo CSV | Papel no Modelo 2.0 | Grão | Linhas Reais | Colunas | Observações de Qualidade / Uso |
| --- | --- | --- | --- | --- | --- |
| `Faturamento.csv` | Fato Vendas (`ci_fact_sales`) | Item de NF emitida (`Serial`) | 404.728 | 31 | `76.865` NFs distintas no histórico (`18.881` em 2026); `6.622` compradores (`3.538` em 2026); 13 códigos ausentes em `Base Clientes` preservados (M:M). |
| `DEVOLUÇÃO.csv` | Fato Devoluções (`ci_fact_returns`) | Item de documento de devolução | 19.430 | 248 | Exige parser RFC-4180 devido a campos multilinhas em observações; `1.732` clientes distintos. |
| `Base Clientes.csv` | Dimensão Clientes (`ci_dim_customers`) | `Código Cliente` (único após dedup) | 11.097 únicos (22.235 brutos) | 7 | `150` representantes cadastrados (`98` ativos em 2026); 6 segmentos (`Varejo`, `Cash`, `Distribuidor`, `Atacado`, `B2B`, `KA`). |
| `Base Produtos.csv` | Dimensão Produtos (`ci_dim_products`) | `Codigo Item` (único) | 660 | 10 | `55` marcas; `13` valores oficiais de `Macro Categoria`; `4` classes ABC. |
| `Base Regionais.csv` | Dimensão Regionais (`ci_dim_regions`) | `Sigla` (UF) | 28 | 5 | `10` regionais comerciais; `7` gerentes regionais. |
| `dCalendario.csv` | Dimensão Calendário (`ci_dim_calendar`) | Data diária (`Date`) | 1.236 | 6 | Cobertura contínua `2023-07-01..2026-11-17`. |
| `Base Pedidos.csv` | Carteira em Aberto (`ci_fact_orders_open`) | Pedido (`Nº do documento`) | 993 | 13 | Backlog em aberto; mantida **estritamente separada** do faturamento realizado. |
| `Estoque.csv` | Snapshot de Estoque (catálogo/referência) | `Nº do item` | 391 | 6 | Posição pontual de estoque disponível; não usada como série histórica. |
| `Base Metas.csv` | Referência de Metas (planejamento) | Regional × Mês | 207 | 5 | Cobertura `2025-01-01..2026-11-01`. |
| `Orcamento.csv` | Referência Orçamentária (volume) | Regional × Produto × Mês | 3.024 | 9 | Quantidade e litros orçados. |
| `Base Municipios.csv` | Apoio Geográfico | Município/UF | 5.470 | 7 | Coordenadas IBGE. |
| `Latitudes.csv` | Apoio Geográfico | Município/UF | 5.470 | 7 | Coordenadas geográficas. |
| `Rep Area.csv` | Área Geográfica de Representantes | PN × UF | 108 | 5 | Mapeamento territorial auxiliar. |
| `Acessos.csv` | Referência legada RLS Power BI | Usuário × Região | 101 | 3 | **Não utilizada**: usuários, senhas e ACL permanecem no D1 do Commercial Insight. |
| `Medida*.csv` (6 arquivos) | Metadados de medidas dinâmicas Power BI | Seletor de medida | 0–10 | 3 | Confirmam medidas oficiais (`Fat. Liq.`, `Litros Liq.`, `Quant. Liq.`, `Clientes Atual`, `Qtd Representantes`). |

---

## 3. Relacionamentos Oficiais Preservados (Sem Invenções)

1. `Faturamento[Data do lanc.]` e `DEVOLUÇÃO[Data do lanc.]` **(*:1 Unidirecional)** → `dCalendario[Date]`.
2. `Base Clientes[Código Cliente]` **(*:* Bidirecional)** ↔ `Faturamento[Codigo Cliente]`.
3. `DEVOLUÇÃO[Cód. PN]` **(*:* Unidirecional)** → `Base Clientes[Código Cliente]` (propaga filtro de representante e cliente para devoluções sem descarte de órfãos).
4. `Faturamento[UF]`, `DEVOLUÇÃO[UF]`, `Base Clientes[Estado]` **(*:1 Unidirecional)** → `Base Regionais[Sigla]`.
5. `Faturamento[Código do item]` e `DEVOLUÇÃO[Código do item]` **(*:1 Unidirecional)** → `Base Produtos[Codigo Item]` (fonte exclusiva da `Macro Categoria`).

> [!IMPORTANT]
> Nenhuma relação adicional entre vendas e pedidos em aberto, estoque ou metas foi inventada. Códigos de itens ou clientes ausentes nas dimensões são preservados nos totais oficiais de faturamento bruto/devoluções, mantendo fidelidade 1:1 com o Power BI.

---

## 4. Definições Oficiais de Indicadores Derivados

- **Faturamento Bruto:** `SUM(Faturamento[Valor mercadorias])`.
- **Devoluções:** `COALESCE(SUM(DEVOLUÇÃO[Valor mercadorias]), 0)`.
- **Faturamento Líquido:** `Faturamento Bruto - Devoluções` (calculado uma única vez por contexto).
- **Clientes Distintos na Base vs Compradores Ativos:**
  - *Clientes cadastrados na base:* `COUNT(DISTINCT client_key)` na dimensão `ci_dim_customers` deduplicada (`11.097` no escopo global).
  - *Clientes compradores no período:* `COUNT(DISTINCT client_key)` no fato `Faturamento` filtrado (`3.538` em 2026 até `17/11`).
- **Representantes Cadastrados vs Com Vendas:**
  - *Representantes cadastrados:* `COUNT(DISTINCT representative_key)` na dimensão clientes (`150` globalmente).
  - *Representantes ativos (com vendas):* `COUNT(DISTINCT representative_key)` vinculados ao fato `Faturamento` no período (`98` em 2026 até `17/11`).
- **Ticket Médio — Separação Obrigatória de Conceitos:**
  - **Ticket por Comprador:** `Faturamento Líquido ÷ Clientes Compradores Distintos` (**R\$ 72.572,72** em 2026 até `17/11`).
  - **Ticket Médio por NF (`Serial`):** `Faturamento Líquido ÷ COUNT(DISTINCT Serial)` (**R\$ 13.598,98** líq. / **R\$ 14.103,50** bruto nas **18.881 NFs** de 2026 até `17/11`), habilitado pela camada estruturada CSV.
