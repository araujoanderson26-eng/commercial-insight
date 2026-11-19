# Autorização da IA em produção — 19/11/2026

O titular autorizou até **US$ 20,00 por mês**, inicialmente para sua própria conta administrativa e somente com créditos OpenAI existentes. Esta autorização substitui a ausência de orçamento de produção; não altera o ledger nem libera novas tentativas HML. Não autoriza compra, recarga automática, saldo negativo ou cobrança além dos créditos disponíveis.

## Controles da aplicação

A migração aditiva `0010_production_ai_budget.sql` é independente das migrações HML 0007–0009. Cria política, ledger e alertas, sem modificar dados comerciais, usuários, senhas, mapeamentos, PBIX ou Preparador. O padrão é **desabilitado**, créditos não verificados e teto mensal de US$ 20. A identidade do único administrador autorizado é configurada operacionalmente, sem publicar seu identificador neste documento. Outro administrador também fica bloqueado.

Antes de **cada** chamada paga (interpretação ou narrativa), um único `INSERT ... SELECT` verifica usuário ativo/admin, política vigente, projeto/organização, preço/modelo, validade dos créditos, somatório do mês e somatório vitalício, e adquire a única vaga de execução. A reserva considera todos os bytes UTF-8 do corpo, mais 8.192 tokens de margem, saída máxima de 1.200 tokens e fator de segurança 2. Não há ferramentas pagas, background, retry automático ou modelo alternativo. O modelo deve ser o snapshot precificado `gpt-4.1-mini-2025-04-14`; sua disponibilidade com a chave de produção ainda precisa ser comprovada. A documentação o marca deprecated; indisponibilidade exige revisão explícita, nunca troca automática.

Preços de referência de texto padrão: US$ 0,40/milhão de tokens de entrada e US$ 1,60/milhão de saída, conferidos em 19/11/2026. [Modelo e preços oficiais](https://developers.openai.com/api/docs/models/gpt-4.1-mini). Uma data de validade de preço deve ser registrada após revisão; zero ou vencida bloqueia chamadas.

O mês é o calendário **UTC**. Reservas nunca são devolvidas nem apagadas; consumo com tokens conhecidos fica separado e é estimado sem desconto de cache. Falhas de rede, leitura, uso ausente ou modelo/tokens inesperados mantêm também a trava até conciliação. Não há liberação automática por timeout. Um erro de créditos ou limite do provedor desabilita a política. Deploy, retry, expiração de sessão ou virada de mês não eliminam reservas. Não confundir reserva conservadora com fatura.

Alertas persistentes em **US$ 10, US$ 16 e US$ 20**, calculados sobre o valor comprometido, são gravados na mesma transação da reserva, uma vez por mês/limiar. A recusa por saldo residual insuficiente também gera evento distinto de bloqueio, sem afirmar que houve consumo de US$ 20. O administrador os vê no assistente; não são alertas por e-mail. O status é atualizado após cada pergunta. Nenhum dado financeiro é mostrado aos demais usuários.

## Verificação dos créditos e bloqueio de ativação

Não há nesta sessão conexão de faturamento OpenAI nem ferramenta disponível para assumir a aba do navegador aberta no computador. Não presumir créditos, organização, projeto, validade ou estado da recarga. Sem comprovação, manter `enabled=0`, `allow_ai=0`, teto de créditos zero e não executar chamadas pagas.

Antes de ativar, verificar no painel da organização correta: saldo utilizável e validade; recarga automática desativada; projeto exclusivo do Commercial Insight; chave exclusiva desse projeto; ausência de compras ou contratação; e parcela de créditos efetivamente disponível e reservada a esta aplicação. Créditos compartilhados com outros projetos podem ser consumidos externamente: um saldo observado e um orçamento do projeto, isoladamente, não garantem a condição de não exceder créditos. Se não for possível comprovar uma alocação protegida ou controlar esse risco sem afetar outros aplicativos, manter a ativação interrompida.

Registrar em evidência privada a origem/data da verificação, organização/projeto e validade. O teto vitalício `credit_ceiling_nano_usd` é **reservas vitalícias já existentes + parcela de créditos disponíveis exclusivamente alocada**, sem duplicar créditos de verificações anteriores. Não renovar esse teto na virada do mês. Limitar `credit_valid_until` à validade real dos créditos; verificações com mais de 24 horas ficam bloqueadas até nova conferência. `verification_reference` aponta para a evidência privada, sem conter a chave ou dados de pagamento. Atualização financeira deve manter o histórico e incrementar a revisão da política.

Quando disponível, configurar em **Project settings → Limits → Spend** o limite de US$ 20 com **Enforce a hard limit** somente no projeto exclusivo, preservando os outros aplicativos. Alertas de provedor são adicionais. A OpenAI documenta atraso tanto na imposição de limites quanto na interrupção por créditos esgotados; por isso, o ledger local é necessário. [Limites oficiais](https://developers.openai.com/api/docs/guides/spend-limits), [saldo pré-pago e atraso](https://help.openai.com/en/articles/8264644-setting-up-and-managing-prepaid-api-billing). Não alterar limites globais da organização para compensar esta pendência.

## Chave e liberação

Não copiar o secret HML, ler secrets existentes nem enviar a chave por chat. O responsável deve cadastrar uma chave exclusiva do projeto verificado por entrada interativa:

```powershell
node node_modules/wrangler/bin/wrangler.js secret put OPENAI_API_KEY --config wrangler.jsonc
```

O comando publica uma nova versão. Nunca colocar a chave em argumentos, `.env` versionado, logs, SQL ou arquivo de evidência. A presença do secret não habilita a IA: a política financeira e a fonte continuam bloqueadas. Antes de habilitar ambas, confirmar a disponibilidade do snapshot por metadados do modelo, conferir os limites do projeto e a alocação de créditos, e executar um ensaio finito com todas as reservas contabilizadas. A condição de segurança financeira continua obrigatória, mesmo com o orçamento de US$ 20 autorizado.

As consultas continuam compiladas no backend e limitadas pelo escopo existente do usuário; a IA não recebe SQL executável, cadastro completo, senha ou sessões. Interpretação recebe a pergunta e até três planos/contextos anteriores. Narrativa recebe somente indicadores agregados, contexto temporal e até 12 linhas do recorte autorizado, sem cópia integral da base. `store:false`, guardas de números, causas e períodos e revalidação de permissões permanecem ativas.

## Operação e recuperação

Consultar `/api/assistant/status` autenticado para ver reservas, consumo conhecido, créditos alocados restantes, bloqueios e alertas. Manter evidências de testes comerciais somente em arquivos privados. Uma operação com resposta desconhecida exige conciliar seu request ID/usage no provedor antes de mudar seu status; não zerar ledger, não apagar linhas, não reduzir reservas e não destravar chamadas por horário aproximado.

Para desabilitar, definir `enabled=0` e incrementar revisão em `ai_production_policy`. Fonte `allow_ai=0` e ausência de chave também bloqueiam. Para rollback, usar somente versão que já exija o controle financeiro; o Worker antigo anterior a esta proteção não implementa o teto. Se for necessário voltar ao Worker antigo, primeiro desabilitar IA na fonte e remover a credencial de produção de forma controlada. Preservar tabelas e ledger.
