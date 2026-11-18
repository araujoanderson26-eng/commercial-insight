# Preparar atualização Comercial Insight

Ferramenta externa do Power BI Desktop para Windows x64. Usa Microsoft TOM e ADOMD.NET, em modo de leitura, para consultar o modelo local realmente carregado pelo Desktop. Não interpreta PBIX como ZIP, não modifica o modelo e não executa atualização de fontes.

## Instalação única

1. Extraia o pacote de código do preparador em uma pasta local. Execute `Instalar.cmd`.
2. A instalação baixa o SDK .NET 10 LTS oficial (10.0.404) em uma pasta temporária e compila as dependências Microsoft fixadas no projeto e no lockfile. Acesso à internet é necessário apenas na instalação. O executável é instalado em `%LOCALAPPDATA%\ComercialInsight\Preparador`.
3. Aceite a elevação do Windows para registrar o botão em `Program Files (x86)\Common Files\Microsoft Shared\Power BI Desktop\External Tools`. Reinicie o Power BI Desktop.
4. Abra o PBIX com dados e clique em **Ferramentas externas > Preparar atualização Comercial Insight**. A primeira execução abre o formulário de mapeamento. Selecione o fato, as dimensões reais, a medida DAX e sua coluna aditiva equivalente; documente a revisão. Não são inferidas fórmulas pelos nomes.

O registro entrega `%server%` e `%database%` ao executável. Somente endpoints locais `localhost:porta`, `127.0.0.1:porta` ou `[::1]:porta` são aceitos. Não guarde senhas nem tokens no mapeamento. O arquivo local de configuração contém apenas nomes de objetos, identidade estável da fonte e evidência da revisão. O GUID do perfil identifica a mesma fonte entre sessões; os GUIDs temporários do Desktop ficam nos metadados para rastreabilidade. Confira o nome do perfil visível antes de preparar e mantenha cópia privada de `%LOCALAPPDATA%\ComercialInsight\mapeamento.json` para reinstalações. Outra fonte exige um perfil/identidade próprios e configuração de fonte correspondente no aplicativo.

## Toda semana

Obtenha e abra o PBIX atualizado. Aguarde a atualização terminar; mantenha o modelo sem alterações. Clique no botão do preparador, depois em **Preparar atualização**, e salve o arquivo `.ci.ndjson`. Entre no Comercial Insight em **Administração > Atualização de dados**, selecione esse único pacote e clique em **Enviar e atualizar base**. Aguarde a confirmação de publicação do servidor.

## Suporte semântico e limites reais

Esta versão exige tabelas/partições em modo **Import**. Interrompe em DirectQuery, Dual, DirectLake, partições incompletas ou relatório thin/live; não transforma falta de acesso em tabela vazia. Nesses casos obtenha um modelo autocontido ou uma exportação completa autorizada com consistência demonstrada.

Todas as tabelas de negócio e colunas, inclusive ocultas, são exportadas integralmente. `SELECTCOLUMNS` mantém linhas de fatos coincidentes. RowNumber interno, strings de conexão, fontes M e roles de acesso não são serializados. O inventário contém medidas, formatos, colunas calculadas, relacionamentos ativos/inativos, cardinalidades, direções e dependências. Colunas com nomes que indiquem credenciais interrompem a exportação para revisão.

A projeção comercial v1 mantém a granularidade de um fato e dimensões na própria tabela ou acessadas por `RELATED`, que exige relação válida muitos para um. Faturamento e devoluções usam somas de colunas explicitamente mapeadas; clientes usa chaves distintas. Uma medida que não equivaler a essa implementação falha nos controles. Margem, metas, estoque, litros e medidas especiais ficam indisponíveis até implementação e conciliação próprias; os respectivos metadados originais continuam no inventário. A tabela Acessos não concede permissões no aplicativo.

São executados DAX real para total, todos os meses extraídos e recortes representativos de regional, cliente, produto e UF. As linhas extraídas são reconciliadas localmente antes da emissão e novamente no D1 antes da ativação. BLANK é diferente de zero, valores monetários preservam escala e precisão; precisão maior que a configurada bloqueia a preparação. Não se afirma equivalência para toda combinação DAX possível.

TOM e as contagens de origem são lidos antes/depois. Mudanças de esquema, horários de processamento ou comandos concorrentes de processamento invalidam o pacote. Não edite nem atualize o modelo durante a extração. Modelos sem timestamps confiáveis ou dados externos dinâmicos precisam de revisão adicional.

## Formato

`.ci.ndjson` é UTF-8 sem BOM, com LF e um objeto JSON por linha. O primeiro objeto é o manifesto `commercial-insight`, versão 1, fonte `commercial-main`. As linhas seguintes são envelopes `rows` e `facts`, cada um com até 100 registros e 1 MiB. O manifesto contém contagens de origem/exportação e cada parte declara índice, quantidade, bytes e SHA-256 dos bytes exatos da linha, incluindo o LF. Unicode, códigos textuais com zeros à esquerda e nulos são preservados. Não há compressão ou extração de caminhos ZIP. O manifesto admite até 1 MiB; limites acima interrompem com explicação e exigem dimensionamento, sem truncamento.

`exemplo-sintetico.ci.ndjson` é exclusivamente para testes locais. Não enviar para produção.

## Verificação de desenvolvimento

Use o SDK .NET 10 LTS: `dotnet restore --locked-mode`, `dotnet build -c Release`, `dotnet run -- --self-test`. O teste verifica divisão de partes, checksums, Unicode, nulos, zeros à esquerda e rejeição de arredondamento implícito. O aceite do modelo real requer o PBIX aberto no Power BI Desktop; compilação e teste sintético não comprovam o modelo Panizzon.

Referências: [Microsoft — ferramentas externas](https://learn.microsoft.com/en-us/power-bi/transform-model/desktop-external-tools), [registro e parâmetros](https://learn.microsoft.com/en-us/power-bi/transform-model/desktop-external-tools-register), [bibliotecas TOM/ADOMD](https://learn.microsoft.com/en-us/analysis-services/client-libraries).
