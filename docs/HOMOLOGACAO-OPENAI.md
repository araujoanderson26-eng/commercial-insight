# OpenAI — ensaio autorizado de homologação

Em 19/11/2026, o titular definiu **US$ 0,10** como orçamento inicial e informou ter cadastrado `OPENAI_API_KEY` exclusivamente em `commercial-insight-hml`. A conexão confirmou somente o nome do secret; seu conteúdo não foi lido, copiado ou incluído em arquivos. A implantação e os dados de produção permanecem fora deste ensaio.

## Estimativa anterior às chamadas

O modelo configurado é `gpt-4.1-mini`. O catálogo oficial publica US$ 0,40 por milhão de tokens de entrada e US$ 1,60 por milhão de saída, e marca o modelo como `Deprecated`. A primeira requisição estruturada deve confirmar sua disponibilidade e compatibilidade na conta; não há troca automática por outro modelo. [Modelo, preços e recursos](https://developers.openai.com/api/docs/models/gpt-4.1-mini).

Quatro perguntas podem gerar duas chamadas cada: interpretação e comentário. Com 10.000 tokens de entrada hipotéticos e o máximo de 1.200 tokens de saída por chamada, oito chamadas representam **US$ 0,04736**. Trata-se de uma estimativa, sem descontos de cache, e não de uma leitura da fatura.

O controle exclusivo da homologação usa `HML_OPENAI_BUDGET_USD=0.10`, exige a origem de homologação e `HML_SYNTHETIC_ONLY=true`, e reserva o custo conservador de cada tentativa antes do envio. Considera os bytes UTF-8 do corpo completo mais margem de enquadramento para a entrada, o máximo de saída e os preços do modelo permitido. O D1 serializa a reserva condicional e limita o ensaio a oito tentativas. Erros mantêm a reserva; não há retentativa automática ou aumento do orçamento. O mecanismo não configura limites globais Cloudflare/OpenAI e não é uma atestação financeira do provedor.

## Roteiro e validação

Usar somente o snapshot sintético publicado e os filtros janeiro/2026 até janeiro/2026:

1. “Como está meu resultado comercial?” — reconciliar o relatório com a consulta determinística equivalente.
2. “Quais clientes mais perderam faturamento?” — conferir agrupamento, ordenação, códigos e escopo.
3. “Vou visitar o cliente 0001. Prepare minha reunião.” — conferir cliente, líquido atual/anterior de R$ 135/R$ 90 e atividade diária.
4. “Quais produtos explicam a queda?” — conferir continuidade da conversa e os filtros herdados do cliente.

O aceite deve distinguir HTTP 200 com comentário determinístico de uma resposta bem-sucedida da OpenAI. O registro privado de tentativas conserva estado HTTP, modelo retornado, identificador da requisição e tokens de uso quando disponibilizados. Não conserva chave, cabeçalhos de autenticação ou corpos de requisição/resposta nessa tabela.

As recusas de usuário sem escopo, operador e histórico de outro proprietário devem ocorrer sem novas chamadas ao modelo. No encerramento, restaurar a política de IA anterior e encerrar as sessões automatizadas. Conversas sintéticas podem permanecer para revisão.

## Evidência e resultado

A proteção foi implantada somente no Worker de homologação, versão `55c6aaae-e87d-466b-878a-b9cb48a82d2d`, com a migração aditiva `0007_hml_openai_budget.sql` aplicada apenas ao D1 isolado. **93 testes locais passaram, sem falhas ou skips**, incluindo concorrência de reserva, falhas de transporte, limite de tentativas, privacidade, configuração inválida e ausência de efeito em produção sem a flag. Typecheck, lint, build e dry run também passaram.

O ensaio HTTPS de 19/11/2026 às 08:51–08:52, horário de Brasília, confirmou a versão sintética ativa, a presença da credencial, o relatório determinístico e as recusas de acesso. Habilitou IA somente durante o ensaio. A primeira chamada Responses foi recusada com **HTTP 401 e código `invalid_api_key`**; não houve retentativa automática. As outras três perguntas não foram enviadas. O script restaurou `allowAI=false` e encerrou suas cinco sessões; a conferência independente retornou zero sessões ativas.

O ledger conserva uma tentativa e a reserva de **US$ 0,0040928**, calculada antes do envio com 5.432 tokens de entrada estimados conservadoramente e até 1.200 de saída. Essa reserva **não é uma cobrança confirmada**. Não houve retorno de `usage` ou identificação de modelo executado; portanto, não se declara consumo de tokens medido, custo zero na fatura ou disponibilidade do modelo validada. O restante do orçamento não foi consumido por novas tentativas.

Evidência privada: `.wrangler/hml/openai-test-budget.json`, `.wrangler/hml/openai-api-verification.json` e o ledger `hml_openai_attempts` no D1 de homologação. O relatório de API separa seus checks da comprovação de sucesso da OpenAI. A execução está pendente de recadastro seguro de uma credencial válida; a chave não deve ser enviada à conversa nem copiada da produção.

A amostra Cloudflare de 08:54:19, horário de Brasília, registrou mais 26 invocações, 1.487,448 CPU-ms, 279 linhas D1 lidas e 79 escritas desde o baseline anterior ao ensaio. O D1 tinha 434.176 bytes e a fila estava vazia. Os datasets não apresentavam erros de execução do Worker; isso não transforma a recusa de autenticação da OpenAI em sucesso. Os arquivos privados `openai-cost-baseline.json` e `openai-cost-after-attempt.json` conservam as janelas da telemetria, que não mede faturamento OpenAI. A leitura do deployment de produção confirmou a mesma versão anterior.

Os próximos testes com informações comerciais reais exigem autorização específica para os dados e seu envio à OpenAI. Não remover o bloqueio de dados sintéticos nem reutilizar credenciais de produção como parte deste ensaio.
