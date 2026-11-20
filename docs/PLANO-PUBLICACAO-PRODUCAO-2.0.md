# Plano de Publicação em Produção — Commercial Insight 2.0

> [!IMPORTANT]
> **Escopo e trava de segurança:** Este documento define o procedimento operacional para publicar a versão `2.0` (`feat/modernizacao-estrutural-2.0` / PR #7) em produção somente após aprovação explícita do proprietário. **Nenhuma etapa abaixo foi executada nesta rodada de homologação.**

---

## 1. Alvo de Produção e Isolamento

| Recurso | Identificação Oficial (`wrangler.jsonc`) | Observação |
| --- | --- | --- |
| Worker | `commercial-insight` | Domínio `https://commercial-insight.araujoempresarial.com.br` · versão ativa em 20/11/2026: `0f5b8776-73e1-437d-b71b-d58042f5317b` |
| D1 Database | `comercial-insight-db` (`5b333eba-7ace-4182-aa76-0d0f591a4ad6`) | Binding `DB` (nome exato com um `m` em `wrangler.jsonc`) |
| R2 Bucket | `commercial-insight-arquivos` | Binding `BUCKET` |
| Queue | `commercial-insight-manual-jobs` | Producer/Consumer exclusivos |
| OpenAI Budget | `0010_production_ai_budget.sql` | Limite máximo US$ 20,00/mês · `allow_ai = 0` por padrão |

Nunca apontar comandos de publicação produtiva para `wrangler.hml.jsonc` ou `9717c220-a4b4-4fad-8183-f2b733787b61`.

---

## 2. Pré-Requisitos e Backups Obrigatórios (Antes do Merge)

1. **Conferência do repositório e PR #7:**
   - Garantir que `npm run typecheck`, `npm run lint`, `npm run build` e `node scripts/check-release.mjs` estão verdes.
   - Confirmar que a homologação em `commercial-insight-hml` permanece íntegra e com conciliação 100% aprovada.
2. **Pausar deploys automáticos de `Production` (Cloudflare Workers Builds):**
   - A configuração não-produtiva **Previews Base** foi ajustada para `npx wrangler deploy --dry-run` (eliminando falhas de `npx wrangler preview` em PRs sem alterar `Production`).
   - No painel da Cloudflare (Workers & Pages → `commercial-insight` → Settings → Builds → `Production`), pausar temporariamente o gatilho automático conectado à branch `main` (`Disable builds` ou `production_settings.path_excludes: ["*"]`) durante a janela de merge + migração, evitando publicar o Worker novo antes da aplicação isolada da `0011`.
3. **Registrar versão atual do Worker para rollback imediato:**
   ```powershell
   npx wrangler deployments list --config wrangler.jsonc
   ```
   Anotar o `Version ID` e `Deployment ID` correntes em `.wrangler/prod-release-2.0/pre-release.json` (fora do Git). Referência verificada em 20/11/2026: `0f5b8776-73e1-437d-b71b-d58042f5317b` (`PRs #5/#6 integrated; main 57a46e87fce2736c3cb6a8802bab12ec254515cb`).
4. **Capturar Backup Lógico (D1 Time Travel Bookmark):**
   ```powershell
   npx wrangler d1 time-travel info comercial-insight-db --config wrangler.jsonc
   ```
   Registrar o `bookmark` exato retornado **imediatamente antes** de qualquer escrita (referência observada em leitura prévia em 20/11/2026: `00000044-00000000-00005129-7a3652702aec8559dd6db2b46f221bd4`). No plano Paid, o D1 Time Travel mantém recuperação contínua por até 30 dias sem custo adicional.
5. **Confirmar estado inicial do D1 de produção:**
   ```powershell
   npx wrangler d1 execute DB --remote --config wrangler.jsonc --command "SELECT source, active_version_id, allow_ai FROM ci_sources; SELECT COUNT(*) AS users_n FROM users WHERE active=1;"
   ```
   Confirmar também que `allow_ai = 0` (ou somente será ativado conforme política explícita de orçamento em `0010` e conferência de créditos OpenAI).

---

## 3. Execução da Publicação em Produção (Sem Downtime)

### Fase A — Migração Aditiva Isolada (`0011`) em Modo Sombra (`shadow`)
A migração `migrations/0011_structured_csv_layer.sql` cria apenas tabelas e índices novos (`ci_csv_batches`, `ci_csv_files`, `ci_dim_*`, `ci_fact_*`, `ci_agg_monthly`, `ci_dim_catalog`, `ci_csv_active` iniciado em `mode = 'shadow'`). Não altera `users`, `sessions`, `ci_sources`, `ci_imports`, `ci_native_*`, `ai_production_*` ou `saved_reports`.

> [!WARNING]
> **Por que não usar `d1 migrations apply` direto:** Em produção, `wrangler d1 migrations list` reporta como pendentes `0007_hml_openai_budget.sql`, `0008_hml_real_authorization.sql` e `0009_hml_openai_cache_usage.sql` (exclusivas de HML; produção aplicou `0010_production_ai_budget.sql` diretamente) além de `0011_structured_csv_layer.sql`. Executar `d1 migrations apply` aplicaria tabelas de HML em produção.

Aplicar **exclusivamente** a `0011`:
```powershell
npx wrangler d1 migrations list DB --remote --config wrangler.jsonc
npx wrangler d1 execute DB --remote --config wrangler.jsonc --command "PRAGMA table_info(d1_migrations); SELECT id, name FROM d1_migrations ORDER BY id;"
npx wrangler d1 execute DB --remote --config wrangler.jsonc --file migrations/0011_structured_csv_layer.sql
npx wrangler d1 execute DB --remote --config wrangler.jsonc --command "INSERT INTO d1_migrations(name) SELECT '0011_structured_csv_layer.sql' WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name='0011_structured_csv_layer.sql');"
```

Validar imediatamente após aplicar:
```powershell
npx wrangler d1 execute DB --remote --config wrangler.jsonc --command "SELECT * FROM ci_csv_active; SELECT source, active_version_id, allow_ai FROM ci_sources;"
```
Esperado: `mode = 'shadow'`, `active_batch_id = NULL`, `ci_sources` preservado.

### Fase B — Merge na `main` e Deploy Controlado
1. Realizar merge aprovado da PR #7 (`feat/modernizacao-estrutural-2.0` → `main`).
2. Atualizar a `main` local e validar o pacote final:
   ```powershell
   git checkout main
   git pull origin main
   node scripts/check-release.mjs
   npm run build
   npx wrangler deploy --config wrangler.jsonc
   ```
3. Reabilitar o Cloudflare Workers Builds na `main`.
4. Executar smoke check inicial:
   ```powershell
   node scripts/verify-production.mjs --remote
   ```

### Fase C — Carga dos 20 CSVs em Modo Sombra e Conciliação em Produção
Com o aplicativo operando normalmente sobre a fonte atual (`mode = 'shadow'`), realizar a carga do lote inicial dos 20 CSVs oficiais para `comercial-insight-db` em lote `'staging'`/`'processing'` (sem ativar!) e validar remotamente:
1. Executar `POST /api/admin/csv/batches/:batchId/validate` e `GET /api/admin/csv/batches/:batchId/reconcile`.
2. Conferir paridade exata de:
   - Volume de linhas (`404.728` vendas, `19.430` devoluções, `11.097` clientes deduplicados com `0` conflitos, `660` produtos, `993` pedidos em aberto).
   - Bruto, Devoluções, Líquido, YTD vs ano anterior, compradores, NFs (`Serial`), representantes cadastrados/ativos e exemplos A/B/C.
   - Consistência `ci_agg_monthly` vs `ci_fact_sales`/`ci_fact_returns` com delta `0`.
   - Categorias independentes (`SUCO`, `SUCO CONCENTRADO DE UVA/MAÇÃ/LARANJA/TANGERINA`, `VINHO`, `VINHO IMPORTADO`, `VINHO GRANEL`, `VINAGRE`, `VINAGRE GRANEL`, `ESPUMANTE`, `BEBIDA QUENTE`, `VENDA VAREJO` e grupos oficiais).

---

## 4. Ativação Controlada (Admin Only)

Somente após conferência 100% positiva da conciliação em modo sombra na Fase C:
1. O administrador executa (via painel administrativo ou chamada autenticada):
   ```http
   POST /api/admin/csv/batches/:batchId/activate
   ```
   Isso atualiza atomicamente `ci_csv_active` para `mode = 'active'` e registra trilha de auditoria (`csv_lote_ativado`).
2. Conferência pós-ativação (produção ao vivo):
   - Login e bloqueio anônimo (`401`).
   - Indicadores YTD, gráficos ECharts SVG (desktop + mobile) e modo *Participação %*.
   - Filtros multi-seleção e categorias independentes (inclusão e exclusão individual de `SUCO`, `SUCO CONCENTRADO*`, `Granel`, `VINHO IMPORTADO`).
   - Consultas determinísticas (`/api/chat` com `0` chamadas externas à OpenAI) e preservação integral dos limites de orçamento OpenAI (`0010`) e ACL por representante/carteira.
   - Exportações Excel premium e PDF executivo.

---

## 5. Plano de Rollback em 3 Níveis

### Nível 1 — Rollback Instantâneo da Camada CSV (< 1 segundo, sem downtime)
Caso qualquer divergência de dado ou filtro apareça após ativar o lote CSV:
```http
POST /api/admin/csv/rollback
```
- Se existir lote anterior validado (`previous_batch_id`), retorna para ele imediatamente.
- Se for a primeira ativação, retorna `ci_csv_active` para `mode = 'shadow'` (`active_batch_id = NULL`), restaurando o comportamento anterior sem perda de sessões, históricos, favoritos ou usuários.

### Nível 2 — Rollback do Worker de Aplicação
Caso exista regressão de runtime no Worker ou frontend (compatível com a migração aditiva `0011`):
```powershell
npx wrangler rollback <PREVIOUS_VERSION_ID> --config wrangler.jsonc --yes --message "Rollback preventivo Commercial Insight 2.0"
```
**Não** remover tabelas `0011` manualmente durante rollback de aplicação.

### Nível 3 — Restauração de Banco (Somente Desastre Comprovado)
Em caso extremo de corrupção lógica no D1 que exija retorno pontual ao estado pré-migração:
```powershell
npx wrangler d1 time-travel restore comercial-insight-db --bookmark=<BOOKMARK_PRE_MIGRACAO> --config wrangler.jsonc
```
Executar somente após suspender gravações administrativas e avaliar eventuais conversas/auditorias criadas após o bookmark. Não usar Time Travel para mitigar falhas visuais ou de filtro corrigíveis via Nível 1/Nível 2.
