# Homologação controlada com dados reais — 19/11/2026

Este registro contém apenas resultados técnicos e custos. Identidades comerciais, valores, perguntas respondidas, capturas e exportações ficam na evidência privada local, fora do Git e dos arquivos publicados pelo Worker.

Ambiente: <https://commercial-insight-hml.araujo-anderson26.workers.dev>. A PR #2 permanece em draft. Nenhum merge, deploy, migração ou alteração de usuário em produção faz parte desta validação.

## Autorização e método

O titular autorizou quatro cenários reais, um recorte de carteira e o teto OpenAI cumulativo de US$ 0,10, incluindo as reservas anteriores. A confirmação manual de Workers Paid/R2 Paid substituiu a leitura de Billing; nenhum plano foi contratado. A previsão marginal Cloudflare foi US$ 0 com base nas franquias existentes, armazenamento e janela de consumo da conta. Telemetria e cálculo por tokens não equivalem à fatura.

O pacote original local foi conferido por SHA-256 contra os metadados do snapshot publicado em produção. A extração derivada contém somente os meses comparáveis e as colunas necessárias; preserva as relações e o universo necessário ao total nacional. Não contém cópia dos usuários, credenciais ou sessões de produção. O PBIX original não foi aberto para edição.

Há três verificações distintas: 88 controles mensais originais do Power BI, 32 controles derivados declarados como tal e 320 verificações de métricas em 80 contextos calculadas por SQL independente sobre os dados brutos originais. Os 120 controles do pacote passaram na importação remota. A atividade diária do cliente também tem conferência independente. Isso não representa nova execução do Power BI conectado nem aceite de toda a base histórica.

## Contenção

O arquivo versionado `wrangler.hml.jsonc` continua aceitando somente dados sintéticos. A etapa real usou configuração privada temporária, manifesto e pacote fixados por hash, expiração, dois participantes e quatro perguntas exatas. O gerente temporário recebeu uma restrição adicional de consulta sem alteração dos sete cadastros existentes.

O modelo recebeu códigos e resultados agregados necessários, sem razão social, contatos ou documento fiscal. Cada tentativa reservou custo antes do envio; não houve retentativa automática. A chave OpenAI permaneceu como secret do Worker e não foi lida pelo processo local. As chamadas usaram `store: false`.

As recusas remotas de participante externo, UF, representante, cliente e período não autorizados foram conferidas sem chamar o modelo. Não foram criados limites globais da conta.

## Execução e custo OpenAI

O GET de metadados confirmou `gpt-4.1-mini` antes da geração. As quatro perguntas geraram oito chamadas concluídas, com o modelo retornado `gpt-4.1-mini-2025-04-14`. Visita e continuidade foram enviadas pelo formulário real, na mesma conversa; a inspeção posterior bloqueou qualquer novo POST de chat.

| Medida | Etapa real | Cumulativo com ensaios anteriores |
| --- | ---: | ---: |
| Tentativas | 8 | 18 |
| Entrada com uso informado | 6.592 | 13.008 |
| Saída com uso informado | 959 | 1.928 |
| Custo calculado | US$ 0,0041712 | US$ 0,008288 |
| Reservas mantidas | US$ 0,0342964 | US$ 0,0756512 |

As oito novas chamadas informaram zero tokens em cache. A chamada antiga com HTTP 401 não informou uso e mantém sua reserva integral; o cache das chamadas antigas não era observado, e seu custo foi calculado sem desconto. O saldo financeiro conservador é US$ 0,0243488, mas os 18 slots autorizados estão esgotados. Nenhuma nova chamada está autorizada apenas por haver saldo.

Preços usados: US$ 0,40/milhão de entrada, US$ 0,10/milhão de entrada em cache e US$ 1,60/milhão de saída. O catálogo marca este modelo como depreciado; a migração exige escolha, orçamento e validação próprios. [Catálogo oficial](https://developers.openai.com/api/docs/models/gpt-4.1-mini).

## Problemas identificados

A importação inicialmente rejeitou um período cujo primeiro dia era feriado sem movimento. O contrato v2 foi corrigido para aceitar essa situação somente quando o calendário comprova todos os dias declarados, mantendo contagem, contenção dos fatos e a regra estrita do formato legado. A mesma importação foi retomada sem reenviar ou modificar o pacote. Testes cobrem calendário incompleto e fatos fora dos limites.

O primeiro roteiro de navegador não localizava o filtro devido ao nome acessível concatenar título, opções e ajuda. A falha ocorreu antes de enviar uma pergunta; a correção teve reprodução local sem HTTP. A retomada executou somente as perguntas ainda não enviadas. A narrativa nacional foi substituída pela resposta factual de segurança; sucesso HTTP do provedor não foi contado como aprovação da narrativa.

Na revisão completa, três narrativas originais usaram o resumo factual de segurança. O resumo nacional não detalhava todos os componentes e a continuidade não nomeava os produtos em queda. O formatador calculado passou a mostrar bruto, devoluções, líquido, diferença absoluta, percentual válido ou motivo de indisponibilidade e até três quedas identificadas. A reabertura reconstrói esse texto, mantendo a resposta salva imutável. Quatro reaberturas remotas comprovaram o reparo, sem nova geração OpenAI ou mudança nos números, filtros, origem e extração; apenas o horário da nova consulta é atualizado.

A inspeção visual também encontrou gráficos cortados e paginação inadequada nos PDFs. A largura de impressão foi ajustada ao A4 e o navegador aguarda o redimensionamento dos gráficos antes de exportar. A regressão sintética verifica largura da página e gráficos visíveis, sem colapso. Os arquivos anteriores foram preservados para comparação.

O ensaio concorrente revelou HTTP 500 na consulta de opções e, em seguida, em outras operações. Um diagnóstico restrito à HML real confirmou a categoria `d1_rate_limit`, sem expor SQL ou dados. CPU e memória do Worker estavam normais. A consulta de opções passou a usar conjuntos distintos de chaves e nomes, mantendo o grafo de datas e ACL; a consulta financeira permanece independente. São 112 comparações sintéticas e 21 comparações reais de opções exatamente iguais, ordem incluída. O frontend aguarda 300 ms antes da consulta e cancela solicitações de períodos intermediários ou de filtros fechados. A mesma sequência remota, incluindo opções e reabertura simultâneas, passou com HTTP 200 após o reparo, logout 200 e sessão encerrada 401. Não foram aumentados limites ou contratados serviços. [Sobrecarga operacional do D1](https://developers.cloudflare.com/d1/observability/debug-d1/).

## Resultado e alcance do aceite

| Cenário | Dados e fluxo | Evidência conversacional |
| --- | --- | --- |
| Resultado nacional | Bruto, devoluções, líquido e períodos equivalentes conciliados. | Narrativa original substituída pela guarda; resumo calculado ampliado e reaberto sem IA. |
| Maiores quedas por cliente | Ranking, identificação e carteira autorizada conciliados. | Narrativa OpenAI original aproveitada e conferida. |
| Preparação da visita | Identificação, histórico, mix e atividade diária conciliados; lacunas explícitas. | Briefing útil, enviado pelo formulário real; resumo factual. |
| Continuidade por produtos | Mesma conversa, cliente e período; produtos e ordenação conciliados. | Texto original incompleto; resumo calculado passou a identificar as quedas. |

Os quatro resultados têm dados aprovados no recorte testado. Isso não equivale a aprovação integral da prosa OpenAI: não houve uma segunda rodada paga após os reparos. O payload da continuidade também continha os filtros ativos, portanto o ensaio prova sua preservação no fluxo completo, sem isolar inferência baseada apenas no histórico.

Validação final local: **127 testes aprovados, sem falhas ou skips**, tipos frontend/Worker, tipos dos runners, lint e build. No navegador HTTPS, **16 verificações finais aprovadas**, zero erros de página e nenhum HTTP 500 na última rodada. Excel teve **992 campos conferidos em seis abas financeiras**, incluindo nulos, variações, identificação e contexto. As evidências comerciais e visuais permanecem privadas.

As métricas adaptativas por `eventType=cron` comprovaram pelo menos 15 execuções bem-sucedidas da recuperação agendada, embora o dataset dedicado de eventos scheduled estivesse vazio. A primeira limpeza diária desde a criação do ambiente ocorrerá em 20/11/2026 às 04h17 UTC, 01h17 em Brasília; sua execução ainda precisa ser observada. Não foi alterada a agenda para fabricar evidência.

**Parecer: apto a piloto controlado; substituição da versão atual ainda não aprovada.** Antes de produção, concluir o aceite das narrativas com um modelo de ciclo de vida adequado e nova autorização finita de chamadas, observar a limpeza diária e obter aceite dos usuários comerciais sobre carteira, atribuição M:M, retenção e fluxo de atualização. Preservar os registros de consumo, sem reset.

## Limpeza e retenção

Ao encerrar, restaurar o snapshot sintético anterior com conferência do identificador ativo, manter `allowAI=false`, remover somente as conversas, o participante e a versão real desta rodada, excluir o objeto R2 exato e remover o secret temporário de autorização. Preservar o ledger financeiro e os sete usuários existentes. Implantar somente o Worker de homologação com a configuração sintética versionada.

Excluir os arquivos locais derivados com dados brutos e as credenciais temporárias depois de produzir o relatório privado. Manter os agregados, capturas e exportações privados como evidência entregue ao titular, sem adicioná-los ao Git ou aos assets.

Excluir registros ativos do D1 não apaga imediatamente seu histórico gerenciado. No plano Paid, o Time Travel é sempre ativo e permite recuperação por até 30 dias, sem custo adicional. Não foi executada restauração destrutiva do banco inteiro nem prometida eliminação física imediata dos backups. [Retenção do D1](https://developers.cloudflare.com/d1/reference/time-travel/).

`store: false` também não comprova Zero Data Retention na OpenAI. A política padrão prevê registros de monitoramento de abuso por até 30 dias, com exceções descritas pelo provedor; os controles da organização OpenAI não foram inspecionados ou alterados. A limpeza local não elimina esses registros. [Controles de dados da API](https://developers.openai.com/api/docs/guides/your-data).

O relatório privado de encerramento registra os resultados comerciais, a confirmação efetiva da limpeza, a experiência de uso e o parecer de prontidão. Esta evidência não autoriza produção nem uso contínuo da IA.

### Encerramento verificado

Worker final de homologação: `9b9c4852-8626-46ac-89ee-575a96fae066`. A configuração sintética voltou aos limites de 16 MiB por pacote e 128 MiB de capacidade lógica da aplicação. O snapshot sintético anterior está ativo e `allowAI=false`; o secret temporário de autorização foi excluído e o nome do secret OpenAI permanece cadastrado, sem leitura do valor.

O objeto R2 exato foi excluído. Todas as onze tabelas versionadas retornaram zero linhas para a amostra real; importação, partes de upload, três conversas e seus quatro turnos foram removidos, assim como o único usuário temporário. O D1 conserva os sete perfis originais com os mesmos hashes de seus dados públicos. O ledger conserva 18 tentativas e as mesmas reservas. O arquivo físico D1 pode manter páginas livres e histórico gerenciado; zero linhas da versão não significa eliminação física imediata.

A conferência final retornou zero sessões ativas. Foi revogado somente o hash de sessão rastreado ainda presente. A revisão automática recusou uma exclusão por timestamps porque o horário não comprova propriedade; a alternativa segura preservou dois registros de sessões já inativas. Não foi executada a exclusão por horário, nem alteradas sessões de produção.

Os hashes dos 16 PBIX e dos dois arquivos originais permanecem iguais. A implantação e o snapshot ativo de produção também correspondem aos identificadores e hash anteriores. A limpeza local dos arquivos derivados e a medição financeira de encerramento constam no relatório privado final; nenhum desses artefatos comerciais integra esta PR.

### Consumo Cloudflare observado

A captura de encerramento foi feita às 16h08 UTC. Na janela real de homologação, houve 431 invocações, 22,492 segundos de CPU, 226.060.367 linhas D1 lidas e 2.600.904 escritas, incluindo limpeza. A fila estava vazia; 11 execuções Cron tiveram sucesso nessa janela. A telemetria histórica conserva 19 respostas HTTP 500 anteriores aos reparos; zero erros de execução da plataforma não significa ausência dessas respostas. A última rodada de navegador foi verificada separadamente e não teve falhas HTTP.

O D1 de homologação tinha 503.808 bytes na leitura de metadata após a limpeza, contra pico de aproximadamente 240 MB. Na janela conservadora da conta, leituras D1 ficaram em 483.628.852/25 bilhões e escritas em 7.078.313/50 milhões. R2 registrou 91 operações A/1 milhão e 4.449 B/10 milhões; Queues, 473/1 milhão. Os limites conservadores de armazenamento da conta ficaram em 1,042 GB/5 GB D1 e 0,619 GB/10 GB R2; os máximos R2 incluem a cópia já removida e não representam estoque atual de objetos.

A previsão de custo marginal Cloudflare permanece **US$ 0**, condicionada às franquias compartilhadas. Nenhum plano foi alterado ou contratado. Essa medição não substitui a fatura nem a conferência manual de Billing realizada pelo titular.
