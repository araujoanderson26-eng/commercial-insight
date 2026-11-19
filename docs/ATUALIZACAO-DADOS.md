# Atualização manual de dados — Comercial Insight

Desenvolvido por Anderson de Araujo.

## Rotina semanal

1. Obtenha e abra no Power BI Desktop o PBIX atualizado **com dados**. Aguarde a atualização terminar.
2. Em **Ferramentas externas**, clique em **Preparar atualização Comercial Insight**. Com o perfil já salvo, aguarde a extração e validação automáticas. Quando a janela **Salvar** abrir, salve o pacote `.ci.ndjson` e aguarde a conclusão.
3. Entre com o login próprio do Comercial Insight e abra **Administração > Atualização de dados** (`/admin/atualizacao-dados`). Selecione **Arquivo manual**.
4. Selecione ou arraste o pacote e clique em **Enviar e atualizar base**. Esse clique autoriza a publicação automática quando todas as validações obrigatórias passarem.
5. Aguarde **Base atualizada com sucesso** e confira data, responsável, tabelas, linhas, período e versão. Arquivo enviado, importação em andamento e versão publicada são estados diferentes. Somente a publicação troca a base consultada. O [manual semanal](MANUAL-ATUALIZACAO-SEMANAL.md) apresenta a rotina completa do operador.

Após o servidor aceitar o envio completo, a importação continua pelo processamento persistente mesmo com a página fechada. Reabra a tela para acompanhar os checkpoints. Uma interrupção durante o envio ainda exige concluir ou reenviar o arquivo; os dados ativos continuam disponíveis.

O vínculo Microsoft não é necessário para consultar a fonte manual. **Power BI online** permanece como fonte alternativa explícita; uma métrica ausente no modo manual não aciona a Microsoft silenciosamente.

## Preparador: instalação e primeira configuração

Extraia todo o ZIP e execute `Instalar.cmd` na primeira instalação ou `Atualizar.cmd` para preservar uma instalação existente. O pacote Windows x64 pronto inclui `runtime/`, com executável selfcontained e dependências Microsoft TOM/ADOMD; não baixa SDK no computador do operador. O ZIP de fontes não inclui `runtime/` e compila com o SDK oficial, exigindo internet. A primeira instalação registra o botão do Power BI; a elevação serve apenas para esse registro. Reinicie o Desktop depois de registrar ou reparar o botão.

A primeira execução solicita a identidade da fonte, fato, dimensões, medida DAX de faturamento e coluna aditiva equivalente. Os nomes são selecionados do modelo real; não se deduzem fórmulas por nomes ou capturas de tela. Documente quem revisou a granularidade e a propagação de filtros. O perfil é salvo localmente para uso recorrente. Guarde uma cópia privada do mapeamento se reinstalar o computador: ele contém o GUID estável da fonte.

O preparador lê todas as tabelas e colunas de negócio, inclusive ocultas, sem amostragem ou deduplicação. Faz contagem de origem/exportação, controles DAX e conciliação com as linhas extraídas. Invalida o pacote em alteração concorrente de esquema/processamento, precisão monetária incompatível ou divergência de controle. Não atualiza fontes, não escreve no PBIX e não guarda credenciais corporativas. Strings de conexão, fontes M, roles e RowNumber interno são excluídos explicitamente; nomes de colunas que indiquem credenciais exigem revisão.

Esta primeira versão aceita **Import** autocontido. DirectQuery, Dual, DirectLake e relatórios thin/live interrompem com explicação. Não foi implementado parser direto de PBIX. Obtenha um modelo com os dados incorporados ou uma exportação integral autorizada quando o arquivo depender de conexões externas.

Veja os detalhes técnicos e a configuração reproduzível em [tools/preparador/README.md](../tools/preparador/README.md).

## Publicação, segurança e restauração

Cada envio cria um snapshot independente. O pacote fica em R2 privado e a carga em D1 recebe um identificador de versão. Não são removidos usuários, senhas, sessões, permissões, configurações ou conversas. A tabela Acessos exportada não cria usuários ou administradores.

A versão anterior permanece ativa durante a carga. Cada parte tem contagem, tamanho e SHA-256. Os checkpoints e lotes idempotentes permitem retomada. Ao final são verificados todos os registros, contagens, referências e controles essenciais. Um ponteiro no mesmo D1 é trocado atomicamente, com controle de concorrência. Uma carga obsoleta ou incompatível não substitui a ativa.

Na área administrativa, use **Restaurar** sobre uma versão anterior validada e ainda mantida no D1. A restauração troca o ponteiro da versão; não soma snapshots. Se uma versão tiver sido retirada do D1 no futuro, será necessária recarga do pacote privado, e isso deve ser informado antes de restaurar.

As consultas aplicam no backend o escopo e a carteira do cadastro. No contrato nativo Panizzon, o escopo salvo em `user.regions` continua vinculado ao campo comprovado `Base Clientes[Representantes]`, exibido como **Representantes** na administração. Para gerentes, cadastre os representantes autorizados da equipe. Os filtros adicionais de regional, gerente e UF não ampliam esse acesso. Quando as listas de escopo e clientes existem, aplica-se sua interseção. Cada resposta usa uma versão única e identifica fonte, extração, período e filtros. A base semanal não representa informação em tempo real. O envio à IA respeita a autorização da fonte e contém resultados agregados do escopo permitido.

O aviso de desatualização começa em sete dias e pode ser alterado pelo administrador. Data de extração/atualização da origem é diferente da data de upload/publicação. Sem versão válida, o aplicativo deve informar a ausência de base.

## Catálogo semântico e relatório de conciliação

| Indicador | Implementação disponível no preparador v1 | Critério de validação |
| --- | --- | --- |
| Faturamento | Soma exata da coluna aditiva explicitamente mapeada | Medida DAX real deve coincidir no total, em todos os meses e nos recortes representativos |
| Devoluções | Soma de coluna explicitamente mapeada, quando configurada | Mesmos controles; nenhum sinal é inferido pelo nome ou valor negativo |
| Clientes compradores | Distinct count da chave do cliente no fato, quando configurado | Medida DAX real deve coincidir nos controles; contagens não são somadas |
| Margem | Indisponível | Exige definição, dados e implementação próprios; não é inventada |
| Litros, quantidade, metas, orçamento, pedidos, estoque e medidas especiais | Metadados e dados originais preservados; indicadores ainda indisponíveis no app | Exigem mapeamento semântico, granularidade e reconciliação específicos |

Os controles têm filtros exatos, consulta DAX, data de referência, resultado esperado e tolerância zero. Qualquer ajuste futuro de tolerância exige justificativa de precisão; não serve para ocultar divergências. BLANK, zero, códigos com zeros à esquerda e valores monetários com escala explícita são preservados. Razões, metas mensais, estoque pontual e relações muitos-para-muitos não podem ser tratados como somas simples.

Os recortes conciliados são evidência dos contextos registrados no pacote e no relatório de importação. Não provam equivalência de toda combinação DAX possível. Conversas antigas conservam a referência à versão usada.

O contrato nativo v2 acrescenta dois fatos e a propagação de filtros comprovada nos metadados, preservando a compatibilidade v1. Bruto usa as mercadorias de `Faturamento`, devoluções usa `DEVOLUÇÃO` e líquido usa a diferença; clientes usa contagem distinta. A versão exata deve passar nos controles DAX antes de gerar e antes de publicar o pacote. O relatório de integração da entrega registra o estado do aceite com o modelo real. O exemplo `exemplo-sintetico.ci.ndjson` é exclusivo de desenvolvimento e deve ser rejeitado em produção. Compilação, self-test e testes sintéticos não substituem esse aceite.

Uma fonte que já tenha snapshot v1 ativo exige migração revisada para adotar o contrato v2: a publicação semanal bloqueia automaticamente a troca de formato. Esse bloqueio não exige remapeamento nas atualizações seguintes de uma fonte v2 compatível.

## Capacidade e recuperação operacional

O arquivo é UTF-8 NDJSON sem compressão: um manifesto versionado e partes limitadas a 100 linhas no formato v1 ou 1.000 no formato nativo v2, sempre com no máximo 1 MiB. O manifesto admite 1 MiB. Cada parte contém contagem, tamanho e checksum; não há extração ZIP ou caminhos de arquivo para executar no servidor. O upload usa partes R2 em vez de pressupor um POST de tamanho arbitrário.

O limite configurado nesta entrega é **512 MiB por pacote** e deve respeitar o tamanho atual do D1, os índices e a coexistência de versões. O plano **Workers Paid existente** foi confirmado no Dashboard Cloudflare, em **Workers > Plans**, em 18/11/2026. A consulta por Billing continua sem autorização na conexão disponível (HTTP 403); esse endpoint não substitui a confirmação feita no painel.

O teto operacional configurado é **9 GiB (9.663.676.416 bytes)**. Esse teto não comprova que a base e as versões retidas cabem: o tamanho real do SQLite, das tabelas normalizadas e dos índices ainda precisa ser medido. A estimativa de dados multiplicada por dois e o tamanho compactado do PBIX não comprovam o espaço efetivo. Cargas acima do teto devem ser bloqueadas para dimensionamento, sem truncar histórico. A retenção deve manter pelo menos uma versão anterior recuperável e pacotes privados de rastreabilidade; a medição e a quantidade efetivamente suportada de snapshots ficam registradas no [relatório de integração](INTEGRACAO-POWERBI-D1.md).

O processamento avança em até dez partes por invocação, dentro de uma janela de 45 segundos; cada parte contém até 100 registros no v1 ou 1.000 no v2, respeitado o limite de bytes. Dados brutos, normalização e checkpoint são gravados atomicamente. A conciliação avança em até doze controles por invocação, reutilizando os contextos e calculando as quatro métricas nativas na mesma consulta. Quando a Queue estiver provisionada e vinculada, ela continua os trabalhos até a conclusão; o cron de um minuto é a alternativa persistente. A existência da configuração não comprova o provisionamento remoto da Queue. Sem ela, uma base grande pode levar horas. A interface mostra o progresso e o tempo real depende de volume, D1, fila e validações; não há promessa de duração fixa.

O checksum integral do pacote usa leitura sequencial em uma etapa e precisa ser homologado com o volume real e a CPU do plano antes da primeira carga. O modelo de produção não deve ser considerado homologado apenas porque um pacote pequeno passou. Se o tempo semanal ou o volume excederem essa capacidade, amplie o processamento durável e valide os limites efetivos antes de usar em produção.

Antes de migrations remotas, confirme conta, Worker, ambiente e UUID do D1 em `wrangler.jsonc`, exporte backup/registre o ponto de recuperação e aplique somente migrations aditivas. O fluxo e os comandos de implantação ficam em [IMPLANTACAO.md](IMPLANTACAO.md). O aceite remoto deve verificar autenticação, autorização por API, tela administrativa, bindings, processamento de tarefas e a versão efetivamente ativa no D1.

Referências oficiais: [ferramentas externas do Power BI](https://learn.microsoft.com/en-us/power-bi/transform-model/desktop-external-tools), [registro `%server%` / `%database%`](https://learn.microsoft.com/en-us/power-bi/transform-model/desktop-external-tools-register), [bibliotecas Microsoft](https://learn.microsoft.com/en-us/analysis-services/client-libraries), [limites D1](https://developers.cloudflare.com/d1/platform/limits/), [limites Workers](https://developers.cloudflare.com/workers/platform/limits/).
