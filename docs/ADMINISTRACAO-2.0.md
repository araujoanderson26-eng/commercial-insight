# Commercial Insight 2.0 — Administração e homologação

Esta versão é candidata à homologação. Não autoriza merge ou publicação de produção. Dados, PBIX e perfil do Preparador existentes devem ser preservados.

## Permissões

| Perfil | Acesso |
| --- | --- |
| Administrador | Usuários, fonte, política de IA, importações, restauração e análises. |
| Diretoria | Nacional apenas quando autorizado; demais acessos seguem o escopo cadastrado. |
| Gerente | Interseção entre representantes e clientes autorizados; filtros adicionais refinam esse escopo. |
| Usuário comercial | Carteira/representantes autorizados. |
| Operador de atualização | Envia, acompanha, cancela e retoma seus próprios pacotes; sem análises, IA, usuários, configuração, restauração ou download raw. |

A migração `0006_commercial_workspace.sql` acrescenta `users.update_only` e `saved_reports`. Não substitui a tabela de usuários nem os dados comerciais. O perfil de operador usa o papel de armazenamento já existente e uma marca de restrição adicional. Alterações de usuário invalidam sessões/vínculos e versões de escopo como antes.

## Ativar IA com segurança

Há duas condições independentes: **autorizar IA na fonte** e cadastrar `OPENAI_API_KEY`. A tela de conversas mostra ambas. A presença da chave não comprova saldo, acesso ao modelo ou conectividade; confirme com uma pergunta e confira a evidência retornada.

Para homologação, use somente o Worker e a configuração isolados. Cadastre a chave no prompt do terminal, sem colocar o valor no comando, arquivo versionado ou conversa:

```powershell
npx wrangler secret put OPENAI_API_KEY --config wrangler.hml.jsonc
```

Esse comando pressupõe o Worker de homologação já provisionado e cria uma implantação nesse Worker. Em produção, preparar um secret sem implantar usa o fluxo de versões:

```powershell
npx wrangler versions secret put OPENAI_API_KEY --config wrangler.jsonc
```

Não execute a publicação dessa versão sem aprovação de produção. `wrangler secret put` simples implanta imediatamente; veja a [documentação de secrets e versões](https://developers.cloudflare.com/workers/wrangler/commands/workers/#versions-secret-put).

Depois, o administrador autoriza o envio de perguntas, filtros e resultados agregados em **Atualização de dados**. O backend revalida essa política antes de novos envios e da persistência. `OPENAI_MODEL` deve indicar um modelo acessível à conta e compatível com Responses e saída estruturada. Nenhuma chave foi criada ou inventada nesta entrega.

## Homologação isolada

`wrangler.hml.jsonc` aponta a um Worker, D1, R2, fila e origem próprios. O UUID D1 é um marcador que impede implantação por `npm run deploy:hml` até ser preenchido com o banco isolado. `scripts/check-hml.mjs` rejeita uso dos vínculos de produção. A criação dos recursos remotos depende de aprovação explícita após a recusa da revisão automática por persistência e possível cobrança.

Após aprovação de provisionamento, criar **somente**:

```powershell
npx wrangler d1 create commercial-insight-hml-db
npx wrangler r2 bucket create commercial-insight-hml-arquivos
npx wrangler queues create commercial-insight-hml-jobs
```

Preencha o UUID retornado em `wrangler.hml.jsonc`. Confira a conta autenticada, o nome do Worker e a origem. Aplique as migrações apenas no banco de homologação:

```powershell
npm run check:hml
npx wrangler d1 migrations apply DB --remote --config wrangler.hml.jsonc
npm run deploy:hml
```

O aplicativo exige login e todas as APIs comerciais autenticadas. O hostname workers.dev e os assets da interface são públicos; proteção adicional do site pode ser configurada com Cloudflare Access antes de compartilhar dados reais. Não copie usuários, senhas, sessions ou snapshots de produção por conveniência. Crie um administrador próprio pelo procedimento de bootstrap apontando explicitamente à configuração de homologação.

```powershell
npm run admin -- SEU-EMAIL "Seu nome" --remote --config wrangler.hml.jsonc
```

O bootstrap só insere na base vazia e exibe uma senha aleatória uma única vez. Altere-a no primeiro acesso. Não inclua essa saída em tickets ou relatórios públicos.

Foi escolhido um Worker persistente separado porque o importador usa consumidores de Queue e Cron. Previews de branch não isolam D1/R2 automaticamente e não registram esses consumidores/agendamentos; veja [recursos e limitações dos Previews](https://developers.cloudflare.com/workers/previews/resources/). A configuração de produção continua sem URL de versão habilitada.

## Conferir a base sem alterá-la

O script abaixo usa `SQLite readOnly:true`, os controles DAX preservados no manifesto e o compilador atual. O relatório deve ficar em `.wrangler`, fora do Git:

```powershell
node --import tsx scripts/reconcile-snapshot.ts CAMINHO-PACOTE.ci.ndjson CAMINHO-SNAPSHOT.sqlite ID-DA-VERSAO .wrangler/reconciliation/resultado.json
```

Ele confere contagens raw/nativas e todos os controles, sem imprimir nomes, filtros ou montantes comerciais. Não substitui os dados para ajustar resultados. Para preparar um novo oracle a partir do pacote completo, use `scripts/validate-native-package.ts`, sempre com arquivos novos em `.wrangler`.

Uma conciliação vale para o snapshot, fórmulas e contextos registrados. Nova atualização do PBIX, relacionamentos ou medida exige novo aceite. Divergências devem registrar período, filtros combinados, versão, bruto, devoluções, líquido e regra de atribuição comercial.

## Aprovar a publicação

Antes do aceite: executar build, tipos, lint, testes, navegador desktop/mobile, auditorias npm/NuGet e scan de secrets; validar exemplos com usuários reais de cada perfil; testar a chave OpenAI em homologação; confirmar restauração e retenção. A migração é aditiva, mas deve seguir backup e procedimento de mudança. Não execute merge da PR nem deploy de produção sem aprovação explícita.

A rotina semanal permanece Power BI → Preparador 1.0.3 → pacote validado → aplicação → D1. O perfil salvo não precisa ser refeito. Não há exclusão automática de snapshots para abrir espaço; a política de retenção comercial continua pendente.
