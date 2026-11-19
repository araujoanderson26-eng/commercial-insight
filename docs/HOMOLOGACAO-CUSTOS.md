# Homologação — custos, consumo e limpeza

Preços oficiais consultados em **19/11/2026**, em dólares americanos. Esta análise não contrata produtos nem altera o plano da conta. Tributos, conversão cambial e condições contratuais podem mudar a fatura. O relatório de provisionamento deve registrar separadamente a conta, o plano efetivamente constatado e as medições antes/depois.

## Franquias e tarifas verificadas

As franquias são compartilhadas na conta; criar um recurso de homologação não cria uma nova franquia isolada.

Na pré-checagem desta sessão, as consultas de Billing/subscriptions/usage retornaram **403 por falta de Billing Read** no conector. `default_usage_model=standard` identifica o modelo de uso, mas não comprova assinatura Paid vigente, ciclo ou saldo. A API GraphQL Analytics permitiu consultar consumo agregado e armazenamento, porém suas configurações não expõem a franquia contratual restante.

O titular confirmou manualmente **Workers Paid**, **R2 Paid** e **consumo adicional de US$ 0 no período consultado**, dispensou a permissão Billing Read e autorizou prosseguir com os três recursos isolados e o Worker de homologação. Essa declaração fornece a confirmação financeira prévia aceita para o provisionamento; não é uma resposta de Billing API, não informa franquia ilimitada e não atesta uma fatura após os testes. Nenhum plano novo, serviço adicional ou aumento de orçamento foi autorizado.

| Produto | Incluído no plano indicado | Excedente publicado |
| --- | --- | --- |
| Workers Paid Standard | Assinatura mínima de US$ 5/mês por conta; 10 milhões de requisições e 30 milhões de CPU-ms/mês | US$ 0,30/milhão de requisições e US$ 0,02/milhão de CPU-ms. Assets estáticos servidos diretamente não são cobrados como requisições dinâmicas. |
| D1 no Workers Paid | 25 bilhões de linhas lidas, 50 milhões escritas e 5 GB de armazenamento por mês; primeiros 100.000 bancos | US$ 0,001/milhão de leituras; US$ 1/milhão de escritas; US$ 0,75/GB-mês; US$ 0,10/banco-mês acima da franquia de bancos. |
| R2 Standard | 10 GB-mês, 1 milhão de operações Classe A e 10 milhões Classe B por mês; primeiros 100.000 buckets | US$ 0,015/GB-mês, US$ 4,50/milhão Classe A e US$ 0,36/milhão Classe B; US$ 0,10/bucket-mês acima da franquia de buckets. |
| Queues no Workers Paid | 1 milhão de operações/mês; primeiras 10.000 filas | US$ 0,40/milhão de operações; US$ 0,10/fila-mês acima da franquia de filas. |

Fontes primárias: [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/) e [Queues](https://developers.cloudflare.com/queues/platform/pricing/).

Um Worker adicional dentro de uma assinatura Workers Paid existente não implica outra assinatura mínima de US$ 5. Isso depende da confirmação de que o plano já estava ativo; não é autorização para ativá-lo. Os nomes autorizados são exclusivamente `commercial-insight-hml-db`, `commercial-insight-hml-arquivos` e `commercial-insight-hml-jobs`, associados ao Worker `commercial-insight-hml`.

Em R2, a Cloudflare arredonda o consumo cobrável para a próxima unidade. Cruzar a franquia de operações por uma pequena quantidade pode abrir um bloco cobrável de um milhão, conforme o consumo total já registrado. Não se deve multiplicar poucas operações pela tarifa e prometer uma cobrança fracionária sem considerar esse arredondamento. Operações de exclusão/aborto de multipart são gratuitas. Usar Standard evita a permanência mínima e a tarifa de recuperação da classe Infrequent Access. [Regras de cobrança R2](https://developers.cloudflare.com/r2/pricing/)

Uma mensagem pequena entregue normalmente consome uma escrita, uma leitura e uma exclusão: aproximadamente três operações. Cada nova tentativa acrescenta leituras; mensagens acima de 64 KB e metadados também afetam a contagem. Invocações do consumidor e sua CPU pertencem ainda ao consumo Workers. O payload do importador contém somente o identificador do trabalho. [Cobrança Queues](https://developers.cloudflare.com/queues/platform/pricing/)

## Agendamentos e proteções de consumo

O Cron é uma invocação do Worker, com consumo de requisições/CPU e das consultas executadas. A fila deve realizar o avanço imediato da importação; o Cron é a recuperação de trabalhos persistidos e a limpeza administrativa. [Exemplo oficial de cobrança Cron](https://developers.cloudflare.com/workers/platform/pricing/#example-3)

Para um mês de 30 dias:

- Recuperação a cada minuto mais limpeza diária: 43.230 invocações agendadas.
- Recuperação a cada 15 minutos mais limpeza diária: 2.910 invocações agendadas.
- Redução prevista de aproximadamente 93,3% nas invocações ociosas, mantendo recuperação em até 15 minutos quando a fila não avançar.

Essas são contagens de agenda, não medições de CPU. O relatório deve registrar a configuração realmente implantada. Alterar somente `wrangler.hml.jsonc`; os agendamentos de produção não fazem parte desta autorização.

A configuração de homologação implantada usa recuperação `*/15 * * * *` e limpeza `17 4 * * *` (01:17 no horário de Brasília), limite de 10.000 CPU-ms por invocação, pacote máximo de 16 MiB e orçamento interno D1 de 128 MiB. O consumidor fica com concorrência/lote unitários, duas retentativas e retenção de mensagem de 24 horas. A retenção de conversas/auditoria em homologação é de sete dias. Esses valores limitam trabalho e armazenamento; não são um spending limit financeiro. A execução efetivamente observada fica no relatório de monitoramento, sem presumir que a limpeza diária já ocorreu.

Recomendações para a homologação sintética:

- Concorrência unitária no consumidor, lote de um trabalho e retentativas finitas. Não usar testes de carga ou polling contínuo para acompanhar o estado.
- Pacotes pequenos e orçamento D1 reduzido em homologação; rejeitar crescimento antes de chegar à capacidade. Esses limites da aplicação não são um teto financeiro de toda a conta.
- Manter um limite de CPU por invocação que preserve login/importação; conferir consumo real antes de reduzi-lo. O valor configurado é um máximo, não a CPU efetivamente gasta.
- Sem OpenAI, e-mail, Logpush, Log Explorer ou exportadores externos durante o primeiro aceite. Nenhuma assinatura adicional está autorizada.
- Não configurar um Workers spending limit global para controlar apenas esta homologação: o mecanismo pode bloquear todos os Workers da conta, inclusive produção. [Escopo dos limites de gastos](https://developers.cloudflare.com/workers/platform/pricing/#control-usage-costs)

## Cenário estimado, não compromisso de fatura

Exemplo de orçamento mensal para uso interno sintético, sem tráfego público abusivo: 15.000 invocações dinâmicas totais, 10 milhões de CPU-ms, 50 milhões de linhas D1 lidas, 100.000 escritas (incluindo índices), 20 MB D1, 10 MB R2, 1.000 operações Classe A, 10.000 Classe B e 30.000 operações de fila. Os totais Workers incluem a agenda reduzida, acessos de teste e consumidores; não somar a agenda outra vez.

**Se houver saldo em todas as franquias compartilhadas**, esse cenário cabe nas inclusões e o custo incremental previsto desses quatro produtos é **US$ 0**, sem nova mensalidade contratada. A afirmação é condicional. A confirmação manual prévia do titular não dispensa monitorar o crescimento nem transforma estimativa em garantia de cobrança futura.

**Se todas as franquias de uso já estiverem esgotadas**, a mesma hipótese representa aproximadamente US$ 0,20 de CPU, US$ 0,0045 de requisições, US$ 0,05 de leituras D1, US$ 0,10 de escritas D1, US$ 0,015 de armazenamento D1 e US$ 0,012 de operações da fila. Considerando conservadoramente que R2 abra novos blocos cobráveis de 1 GB, 1 milhão Classe A e 1 milhão Classe B, acrescenta até US$ 4,875 nesse cenário. Soma aproximada: **US$ 5,26**, antes de logs, tributos e câmbio. Se o consumo da conta já estiver dentro de blocos pagos, o acréscimo R2 pode ser menor. Não é um limite de cobrança nem autorização para exceder o orçamento com carga adicional.

Novas importações, retries, índices, loops, varreduras sem índice, consultas repetidas e visitas com várias consultas aumentam consumo. O custo não depende apenas da quantidade de linhas retornadas. OpenAI terá custo e autorização próprios em uma etapa posterior.

Se o consumo medido indicar previsão de cobrança incremental além do orçamento aceito, interromper novos testes e pedir decisão ao titular antes de ampliar a carga. A projeção adversa acima explica o risco; não aprova cobrança adicional.

## Observabilidade e mudança anunciada

Até 30/11/2026, Workers Logs Paid inclui 20 milhões de eventos/mês, excedente de US$ 0,60/milhão e retenção de sete dias. Traces também têm retenção de sete dias. Manter traces com amostragem baixa e logs sem payloads ou segredos. [Preço atual de Workers Logs](https://developers.cloudflare.com/workers/platform/pricing/#workers-logs), [retenção e amostragem de Traces](https://developers.cloudflare.com/workers/observability/traces/#limits-and-pricing).

A documentação anuncia que, em **01/12/2026**, logs/traces passam a franquias de Observability compartilhadas por conta: no Paid, 50 GB de ingestão e 10 GB-mês armazenados por ciclo, excedentes US$ 0,25/GB e US$ 0,10/GB-mês. Portanto, reavaliar a estimativa e o saldo antes dessa data; não prometer custo indefinidamente nulo. Não foi contratado plano de observabilidade nesta tarefa. [Mudança oficial de preços](https://developers.cloudflare.com/observability/pricing/)

## Monitoramento mínimo

Guardar as medições antes da criação, após os testes e após a primeira execução agendada. Usar filtros exclusivos do Worker e dos IDs de homologação. As franquias restantes da conta devem ser calculadas no ciclo de cobrança correto; um painel de últimas 24 horas não equivale à fatura mensal.

A evidência agregada obtida antes de provisionar fica somente no arquivo privado `.wrangler/hml/cost-preflight-graphql.json`. Sua janela usa o mês calendário, não um ciclo de cobrança confirmado. Nenhum nome de cliente, produto, usuário, sessão ou credencial de produção integra essa medição.

Após o provisionamento e os primeiros testes sintéticos, a amostra exclusiva da homologação em **19/11/2026, 07:47:48 (Brasília)** registrou 141 invocações Workers, 7.128,109 CPU-ms agregados e zero erros de execução no dataset; D1 com 7.981 linhas lidas e 893 escritas; Queue com 58 operações observadas. O tamanho D1 consultado diretamente foi **417.792 bytes**, ante **344.064 bytes** na leitura após migrações, e a fila estava vazia. R2 registrou sete operações Classe A e 26 Classe B; o dataset de armazenamento R2 ainda não havia retornado uma medição. Os arquivos privados `cost-hml-baseline.json` e `cost-hml-after-tests.json` preservam janelas e respostas.

Essas medições são telemetria acumulada até o horário indicado, não uma fatura ou a medição final de toda a sessão. O armazenamento D1 do GraphQL ainda mostrava uma amostra anterior à migração; por isso o tamanho direto foi usado como estado físico corrente. Backlog médio histórico positivo corresponde ao processamento anterior; o endpoint direto da fila confirmou zero mensagens pendentes.

O agendamento estava configurado, mas o dataset de execuções scheduled ainda estava vazio nessa amostra. Uma nova configuração pode levar até 15 minutos para propagar e perder horários intermediários; a ausência inicial não é prova de falha nem de execução. Verificar a próxima janela após a propagação. A limpeza diária das 01:17 em Brasília não foi observada nessa amostra. [Propagação oficial de Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/#2-update-configuration)

Na última leitura de **19/11/2026, 08:01:28 (Brasília)**, a homologação acumulava **197 invocações**, **8.221,647 CPU-ms** e **zero erros de execução**; D1 registrava **17.971 linhas lidas** e **1.047 escritas**. O tamanho físico direto era **425.984 bytes**; o snapshot de armazenamento Analytics ainda mostrava 417.792 bytes, reforçando o atraso entre fontes. A fila continuava vazia, com 58 operações acumuladas observadas. R2 permanecia com sete operações A e 26 B, sem medição de armazenamento retornada pelo Analytics. A evidência final está em `.wrangler/hml/cost-hml-final.json`.

Mesmo nessa última leitura, o dataset scheduled ainda não retornou evento: **Cron de recuperação configurado, primeira execução não observada nesta sessão**. A limpeza diária também permanece somente configurada. Isso exige conferência posterior no próximo horário e após ingestão das métricas; não foi usado um disparo artificial ou uma alteração temporária de agenda para produzir evidência. O baixo volume observado é compatível com a estimativa condicional dentro das franquias, mas **não comprova cobrança adicional de US$ 0 após os testes**, pois a Billing API continua indisponível e a declaração do titular refere-se ao momento prévio.

| Alvo | Verificação |
| --- | --- |
| Worker `commercial-insight-hml` | Requisições, erros, CPU e eventos `scheduled`/`queue`. Separar agenda de tráfego HTTP e observar erros por excesso de CPU. |
| D1 `commercial-insight-hml-db` | Tamanho físico, linhas lidas/escritas e latência. O `meta` de cada execução ajuda a medir o trabalho efetivo; bytes do pacote não equivalem ao tamanho do banco. |
| R2 `commercial-insight-hml-arquivos` | Bytes e objetos, operações A/B e uploads multipart incompletos. Manter acesso público desabilitado. |
| Queue `commercial-insight-hml-jobs` | Backlog de mensagens/bytes, idade da mais antiga, tentativas e execução do consumidor; após o aceite a fila deve voltar a vazia. |

Datasets documentados: `workersInvocationsAdaptive`, `d1AnalyticsAdaptiveGroups`, `d1StorageAdaptiveGroups`, `r2OperationsAdaptiveGroups`, `r2StorageAdaptiveGroups` e datasets de filas. A disponibilidade de campos deve ser confirmada por introspecção; o schema real pode diferir dos exemplos. Métricas são para monitoramento, e a fatura continua sendo a fonte final de cobrança. [Workers GraphQL](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/), [D1 métricas](https://developers.cloudflare.com/d1/observability/metrics-analytics/), [filas](https://developers.cloudflare.com/queues/observability/metrics/).

A fila também expõe backlog por `GET /accounts/{account_id}/queues/{queue_id}/metrics`. Esse endpoint permite medir quantas mensagens continuam pendentes sem consumi-las. Consultas ao D1 devem usar `SELECT` e o ID exclusivo da homologação. Se uma permissão de Analytics ou Billing estiver ausente, registrar a lacuna; não fabricar consumo zero ou saldo disponível.

Limiares operacionais propostos, sem configurar alertas pagos: rever backlog que permanece positivo por mais de cinco minutos, qualquer repetição de falhas de importação, crescimento de armazenamento sem novo teste e projeção mensal superior ao cenário acima. Ao alcançar 80% do orçamento interno de armazenamento, interromper novos envios e revisar. Esses limiares orientam a revisão, não eliminam a cobrança do consumo já ocorrido.

## Limpeza futura, não executada automaticamente

O usuário autorizou preparar o procedimento. A remoção dos recursos e dados exige uma decisão de encerramento. Nunca substituir nomes ou IDs por equivalentes de produção.

1. Confirmar conta e inventariar os quatro alvos de homologação: Worker, D1, R2 e Queue. Guardar o relatório sintético necessário para o aceite, sem exportar dados da produção.
2. Interromper novos testes e importações. Remover os Cron Triggers somente de `commercial-insight-hml` ou excluir esse Worker no encerramento. Pausar/remover seu consumidor antes de excluir a fila.
3. Confirmar backlog zero. Excluir somente `commercial-insight-hml-jobs` quando os trabalhos de teste não forem mais necessários.
4. No R2, listar somente o bucket `commercial-insight-hml-arquivos`, remover seus objetos sintéticos e abortar multipart pendente. Então excluir esse bucket vazio.
5. Conferir novamente UUID/nome e excluir apenas `commercial-insight-hml-db`. Essa operação destrói também os usuários/sessões sintéticos da homologação.
6. Remover credenciais de teste dos arquivos privados locais quando não forem mais necessárias. Confirmar que o hostname de homologação deixou de servir a aplicação, que não há Cron/consumer e que os recursos de produção continuam presentes.

Nenhuma regra automática de expiração ou exclusão foi aplicada ao D1/R2 de produção. Não apagar snapshots comerciais para financiar espaço de homologação. O relatório final deve registrar quais itens foram efetivamente criados, não tratar estes nomes planejados como prova de criação.
