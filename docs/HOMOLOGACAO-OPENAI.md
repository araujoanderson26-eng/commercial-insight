# OpenAI — ensaio autorizado de homologação

Este documento conserva a etapa sintética. A etapa posterior com autorização específica para dados reais, o consumo cumulativo atualizado e as limitações de aceite estão em [Homologação real](HOMOLOGACAO-REAL.md).

Em 19/11/2026, o titular definiu **US$ 0,10** como orçamento inicial e informou ter cadastrado `OPENAI_API_KEY` exclusivamente em `commercial-insight-hml`. A conexão confirmou somente o nome do secret; seu conteúdo não foi lido, copiado ou incluído em arquivos. A implantação e os dados de produção permanecem fora deste ensaio.

## Estimativa anterior às chamadas

O modelo configurado é `gpt-4.1-mini`. O catálogo oficial publica US$ 0,40 por milhão de tokens de entrada e US$ 1,60 por milhão de saída, e marca o modelo como `Deprecated`. O ensaio real confirmou resposta estruturada de `gpt-4.1-mini-2025-04-14`; não houve troca por outro modelo. Essa validação vale para a conta e a data do ensaio. [Modelo, preços e recursos](https://developers.openai.com/api/docs/models/gpt-4.1-mini).

Quatro perguntas podem gerar duas chamadas cada: interpretação e comentário. Com 10.000 tokens de entrada hipotéticos e o máximo de 1.200 tokens de saída por chamada, oito chamadas representam **US$ 0,04736**. Trata-se de uma estimativa, sem descontos de cache, e não de uma leitura da fatura.

O controle exclusivo da homologação usa `HML_OPENAI_BUDGET_USD=0.10`, exige a origem de homologação e `HML_SYNTHETIC_ONLY=true`, e reserva o custo conservador de cada tentativa antes do envio. Considera os bytes UTF-8 do corpo completo mais margem de enquadramento para a entrada, o máximo de saída e os preços do modelo permitido. O D1 serializa a reserva condicional. O limite operacional final é de onze tentativas cumulativas: uma autenticação inicial recusada, seis chamadas da primeira rodada e até quatro para verificar as correções. O teto financeiro não foi aumentado; nenhum registro ou reserva anterior foi apagado. Erros mantêm a reserva, não há retentativa automática nem bloqueio global da conta.

## Roteiro e validação

Usar somente o snapshot sintético publicado e os filtros janeiro/2026 até janeiro/2026:

1. “Como está meu resultado comercial?” — reconciliar o relatório com a consulta determinística equivalente.
2. “Quais clientes mais perderam faturamento?” — conferir agrupamento, ordenação, códigos e escopo.
3. “Vou visitar o cliente 0001. Prepare minha reunião.” — conferir cliente, líquido atual/anterior de R$ 135/R$ 90 e atividade diária.
4. “Quais produtos explicam a queda?” — conferir continuidade da conversa e os filtros herdados do cliente.

O aceite deve distinguir HTTP 200 com comentário determinístico de uma resposta bem-sucedida da OpenAI. O registro privado de tentativas conserva estado HTTP, modelo retornado, identificador da requisição e tokens de uso quando disponibilizados. Não conserva chave, cabeçalhos de autenticação ou corpos de requisição/resposta nessa tabela.

As recusas de usuário sem escopo, operador e histórico de outro proprietário devem ocorrer sem novas chamadas ao modelo. No encerramento, restaurar a política de IA anterior e encerrar as sessões automatizadas. Conversas sintéticas podem permanecer para revisão.

## Evidência e resultado

A versão final de homologação é **`cfa16957-ebcd-425d-8159-8fafee03be15`**, com a migração aditiva `0007_hml_openai_budget.sql` aplicada apenas ao D1 isolado. **97 testes locais passaram, sem falhas ou skips**, incluindo concorrência de reserva, falhas de transporte, limite de tentativas, privacidade, configuração inválida e ausência de efeito em produção sem a flag. Typecheck, lint, build e dry run também passaram.

O ensaio HTTPS de 19/11/2026 às 08:51–08:52, horário de Brasília, confirmou a versão sintética ativa, a presença da credencial, o relatório determinístico e as recusas de acesso. Habilitou IA somente durante o ensaio. A primeira chamada Responses foi recusada com **HTTP 401 e código `invalid_api_key`**; não houve retentativa automática. As outras três perguntas não foram enviadas. O script restaurou `allowAI=false` e encerrou suas cinco sessões; a conferência independente retornou zero sessões ativas.

Essa tentativa inicial e sua reserva de **US$ 0,0040928** continuam preservadas. Após o titular recadastrar a chave, seis chamadas retornaram HTTP 200, modelo e `usage`. A primeira rodada passou nas consultas nacional e de clientes, mas identificou ampliação de período não solicitada na visita e narrativas sem sustentação semântica. O servidor passou a preservar o período ativo quando a pergunta não pede outra data; o glossário e as guardas distinguem bruto, margem, compradores, compras e totais não aditivos. Quando um agrupamento M:M diverge do total, o comentário factual é calculado antes de chamar a OpenAI, evitando pagar por prosa que seria rejeitada.

Na retomada final, em 19/11/2026 às 09:17–09:18, horário de Brasília, o modo `--resume-visit-followup` reabriu e conciliou os dois resultados financeiros anteriores sem OpenAI, rejeitou suas narrativas antigas e aplicou fatos calculados. Depois executou apenas visita e continuação por produtos, com **seis verificações aprovadas, 36 requisições HTTPS, duas perguntas e três chamadas novas à OpenAI**. Não repetiu as consultas pagas já reconciliadas. Também confirmou propriedade do histórico, recusa de outro usuário e reabertura no mesmo snapshot.

| Cenário | Resultado final |
| --- | --- |
| Resultado nacional | Bruto R$ 350, devoluções R$ 1.034, líquido −R$ 684, anterior R$ 90 e dois compradores; narrativa antiga substituída pela guarda atual. |
| Queda por cliente | Plano tipado por cliente/queda, códigos e descrições conciliados; discrepância não aditiva não atribuída a clientes ocultos. |
| Visita do cliente `0001` | Janeiro/2026 preservado; líquido R$ 135/R$ 90, última compra em 02/01/2026 e dois dias com compra. |
| Continuação por produtos | Mesma conversa, cliente `0001` e janeiro/2026 preservados; ranking conciliado e comentário factual sem nova geração de prosa. |

O ledger final registrou **dez tentativas: nove concluídas e o 401 anterior**, com 6.416 tokens de entrada e 969 de saída informados nas chamadas concluídas. O custo calculado, sem desconto de cache, é **US$ 0,0041168**. As reservas conservadoras acumuladas são **US$ 0,0413548**, incluindo a tentativa de autenticação sem `usage`. Ambos permanecem abaixo de US$ 0,10. Reserva não é cobrança; o cálculo por tokens não equivale a uma fatura verificada.

Evidência privada: `.wrangler/hml/openai-test-budget.json`, `.wrangler/hml/openai-api-verification.json`, arquivos anteriores preservados em `archive/`, `openai-resume-first-batch-ledger.json` e o ledger `hml_openai_attempts` no D1 isolado. O relatório final separa checks da API, revalidação de narrativas salvas e comprovação de modelo/uso. O script restaurou **`allowAI=false`**, encerrou suas cinco sessões e a conferência independente retornou **zero sessões**. Os relatórios e o histórico continuam disponíveis sem novas chamadas. Uma nova rodada exige revisar roteiro e saldo do limite cumulativo, preservando os registros existentes.

A amostra Cloudflare de 08:54:19, horário de Brasília, registrou mais 26 invocações, 1.487,448 CPU-ms, 279 linhas D1 lidas e 79 escritas desde o baseline anterior ao ensaio. O D1 tinha 434.176 bytes e a fila estava vazia. Os datasets não apresentavam erros de execução do Worker; isso não transforma a recusa de autenticação da OpenAI em sucesso. Os arquivos privados `openai-cost-baseline.json` e `openai-cost-after-attempt.json` conservam as janelas da telemetria, que não mede faturamento OpenAI. A leitura do deployment de produção confirmou a mesma versão anterior.

Os próximos testes com informações comerciais reais exigem autorização específica para os dados e seu envio à OpenAI. Não remover o bloqueio de dados sintéticos nem reutilizar credenciais de produção como parte deste ensaio.
