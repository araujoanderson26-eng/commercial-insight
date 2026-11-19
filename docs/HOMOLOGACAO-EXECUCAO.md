# Commercial Insight 2.0 — Estado da homologação

Estado em 19/11/2026. O usuário autorizou exclusivamente os três recursos abaixo e a implantação do Worker de homologação, mantendo a PR #2 em draft. A autorização exige conferir conta, plano, franquias e custos **antes de criar os recursos**.

## Estado efetivamente observado

| Item | Estado |
| --- | --- |
| Conta | `433083d760ae0e02f3962044e6f2152f`, identidade do conector e conta do projeto conferidas. |
| Modelo Workers informado pela API | `default_usage_model=standard`; isso isoladamente não comprova assinatura ativa, preço contratual ou saldo de franquias. |
| Assinatura/ciclo/franquias | APIs `subscriptions`, `billing/usage` e `billable-usage` retornaram HTTP 403. A conexão OAuth não possui Billing Read para esses endpoints. |
| Analytics | Consultas GraphQL agregadas somente leitura funcionaram. O retrato em `.wrangler/hml/cost-preflight-graphql.json` usa uma janela de calendário; não equivale ao ciclo ou saldo faturável. |
| D1 `commercial-insight-hml-db` | Não existia no inventário consultado; não criado. UUID da configuração continua como marcador. |
| R2 `commercial-insight-hml-arquivos` | Não existia no inventário consultado; não criado. |
| Queue `commercial-insight-hml-jobs` | Não existia no inventário consultado; não criada. |
| Worker `commercial-insight-hml` | Não implantado nesta etapa. Nenhuma URL operacional é declarada. |
| Migrações/usuários/sessões de homologação | Não criados remotamente. |
| Produção | Nenhuma criação, migração, deploy, cópia de usuário, sessão, credencial ou dado comercial. |

O acesso ausente é uma dependência de informação financeira, não uma nova solicitação de autorização para os nomes já aprovados. Pode ser resolvido com uma conexão de leitura adequada ou com os números do painel **Billing → Billable Usage**: plano ativo, ciclo e consumo/saldo de Workers, D1, R2 e Queues. Não enviar tokens, chaves ou dados de pagamento pelo chat. Não se inferiu saldo disponível a partir das tarifas públicas ou de métricas parciais.

## Configuração preparada

O arquivo `wrangler.hml.jsonc` fixa a conta, Worker e nomes isolados. Não tem rotas ou domínio de produção. O verificador também recusa reutilizar o UUID D1, bucket ou Queue de produção.

- CPU máxima por invocação: 10 segundos; limite operacional, não teto financeiro da conta.
- Pacote máximo: 16 MiB; orçamento interno estimado D1: 128 MiB.
- Pacotes sem `synthetic=true` são recusados antes da ingestão. Os testes preparados usam somente fatos gerados, sem extração da base real.
- Queue: concorrência um, lote um, duas retentativas e atraso de 30 segundos.
- Cron de recuperação: `*/15 * * * *`; limpeza administrativa: `17 4 * * *` em UTC.
- Retenção administrativa de sessões/conversas/auditoria: sete dias. Isso não apaga automaticamente snapshots comerciais.
- Logs sem invocações completas e traces com amostragem de 1%. Sem Logpush, e-mail ou segredo OpenAI.

Nenhuma alteração de plano, limite global de gastos ou serviço adicional está autorizada. As tarifas, cenários condicionais e procedimento de limpeza estão em [Custos de homologação](HOMOLOGACAO-CUSTOS.md).

## Testes preparados e o que comprovam

`scripts/hml-fixture.ts` gera dez tabelas, 32 linhas raw e 36 controles sintéticos. O teste local valida a importação integral, as descrições por código e a rejeição de um controle financeiro adulterado, preservando a base válida. Não é conciliação com o Power BI real.

`scripts/hml-verify.ts` prepara o aceite HTTPS de login próprio, importação válida/inválida, oito agrupamentos, valores financeiros esperados, briefing, favoritos, escopos comerciais, operador de atualização, ausência de credenciais herdadas e encerramento das sessões automatizadas.

`scripts/hml-browser.ts` prepara o aceite no Edge em desktop/celular, com indicadores, nomes, filtros, favoritos, visita, Excel, impressão/PDF e diagnóstico da IA. Ambos os scripts recusam qualquer origem diferente da URL isolada esperada e arquivos de acesso fora de `.wrangler/hml`.

Esses testes HTTPS e as tarefas agendadas **não foram executados remotamente**, pois o pré-requisito de faturamento ainda não foi resolvido. Os testes locais não são apresentados como prova de uma implantação.

Verificação local após os novos bloqueios: **82 testes aprovados, zero falhas e zero skips**, build, typecheck e lint aprovados. Tipos da configuração de homologação gerados pelo Wrangler em `.wrangler/hml/bindings.d.ts`. Não houve alteração de dependências ou instalação de plano.

## Continuação após a conferência financeira

1. Guardar evidência privada do plano/ciclo/saldo e estimativa incremental; confirmar que não haverá contratação de plano.
2. Criar somente os três nomes autorizados e registrar os IDs retornados. Preencher apenas o UUID D1 isolado na configuração.
3. Executar `npm run check:hml`, aplicar as migrações com `--config wrangler.hml.jsonc` e conferir o esquema no D1 de homologação.
4. Implantar apenas `commercial-insight-hml`. Verificar vínculos, ausência de secrets herdados, bucket privado, produtor/consumidor isolados e agendas.
5. Criar um administrador **sintético novo**, com senha aleatória própria. Guardar o arquivo privado `.wrangler/hml/access.json` no formato `{origin,admin:{email,password}}`; não copiar credenciais da produção nem publicar a senha.
6. Executar os comandos abaixo, medir armazenamento/consumo e verificar uma execução real da agenda e o esvaziamento da fila.

```powershell
node --import tsx scripts/hml-verify.ts .wrangler/hml/access.json
node --import tsx scripts/hml-browser.ts .wrangler/hml/access.json
```

A URL esperada, ainda não publicada, é `https://commercial-insight-hml.araujo-anderson26.workers.dev`. Somente a implantação bem-sucedida e os testes HTTP permitem entregá-la como operacional. O hostname e os assets serão públicos; os dados exigem login próprio. Não há dados reais autorizados nesse ambiente inicial.

## Aceite futuro do assistente OpenAI

O aceite inicial mantém `allowAI=false` e nenhum secret OpenAI. Relatórios e visitas determinísticas poderão ser testados sem chamar o modelo.

Em etapa posterior e autorizada, o administrador cadastra uma chave própria da homologação no prompt seguro do terminal:

```powershell
npx wrangler secret put OPENAI_API_KEY --config wrangler.hml.jsonc
```

Esse comando implanta uma versão somente do Worker indicado e deve ser usado depois de existir a homologação. Não colocar a chave no comando, Git ou conversa. Confirmar projeto/modelo e orçamento da OpenAI e então autorizar IA na fonte de homologação.

Perguntas para o roteiro de aceite: “Como está meu resultado comercial?”, “Quais clientes mais perderam faturamento?”, “Vou visitar o cliente 0001. Prepare minha reunião.” e, em seguida, “Quais produtos explicam a queda?”. Conferir valores, datas, cliente, versão, continuidade e recusa de carteira alheia contra consultas determinísticas.

Hoje essas perguntas usam somente o pacote sintético. Para perguntas sobre números comerciais reais, obter autorização específica de dados, escopo e envio à OpenAI, além da revisão explícita do bloqueio de pacotes sintéticos. Não reutilizar automaticamente a base ou a chave de produção. Registrar chamadas e consumo sem payloads sensíveis; ao terminar, desautorizar a fonte e encerrar as sessões de teste.
