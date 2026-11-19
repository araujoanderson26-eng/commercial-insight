# Preparar atualização Comercial Insight

Ferramenta externa do Power BI Desktop para Windows x64. Usa Microsoft TOM e ADOMD.NET, em modo de leitura, para consultar o modelo local realmente carregado pelo Desktop. Não interpreta PBIX como ZIP, não modifica o modelo e não executa atualização de fontes.

## Versão 1.0.2

O detector agora distingue comandos antigos concluídos, consultas `Batch/Discover` do próprio TOM e alterações reais. A correção foi verificada em leitura no Desktop aberto, com 27 tabelas e 101 medidas. Logs privados explicam os bloqueios sem guardar corpos de comandos ou credenciais. A gravação usa temporários exclusivos e só publica o arquivo após validar todas as partes.

O contrato nativo Panizzon separa `Faturamento` e `DEVOLUÇÃO`, preserva as datas de cada fato e trata os relacionamentos conforme os metadados comprovados. `Fat. Liq.` usa a diferença entre bruto e devoluções; clientes compradores usa distinct count sem inferir um filtro de ano pelo nome da medida. O perfil salvo é lido sem substituir seus campos. Divergências nos controles impedem a emissão do pacote.

Consulte `MANUAL-ATUALIZACAO-SEMANAL.md` para a rotina do operador. `CORRECAO-PREPARADOR.md` registra a correção anterior 1.0.1; os resultados do aceite nativo real são registrados no relatório de integração da entrega.

## Instalação única

1. Extraia todo o ZIP do preparador em uma pasta local. Execute `Instalar.cmd`.
2. O pacote **Windows x64 pronto** inclui `runtime/`, com executável .NET selfcontained e dependências TOM/ADOMD. O instalador confere os hashes e executa o autoteste sem baixar SDK nem compilar. O pacote **de fontes**, sem `runtime/`, mantém a opção para desenvolvedores: baixa o SDK oficial 10.0.404 e compila os pacotes fixados no lockfile. Ambos instalam em `%LOCALAPPDATA%\ComercialInsight\Preparador`.
3. Aceite a elevação do Windows para registrar o botão em `Program Files (x86)\Common Files\Microsoft Shared\Power BI Desktop\External Tools`. Reinicie o Power BI Desktop.
4. Abra o PBIX com dados e clique em **Ferramentas externas > Preparar atualização Comercial Insight**. A primeira execução abre o formulário de mapeamento. Selecione o fato, as dimensões reais, a medida DAX e sua coluna aditiva equivalente; documente a revisão. Não são inferidas fórmulas pelos nomes.

O registro entrega `%server%` e `%database%` ao executável. Somente endpoints locais `localhost:porta`, `127.0.0.1:porta` ou `[::1]:porta` são aceitos. Não guarde senhas nem tokens no mapeamento. O arquivo local de configuração contém apenas nomes de objetos, identidade estável da fonte e evidência da revisão. O GUID do perfil identifica a mesma fonte entre sessões; os GUIDs temporários do Desktop ficam nos metadados para rastreabilidade. Confira o nome do perfil visível antes de preparar e mantenha cópia privada de `%LOCALAPPDATA%\ComercialInsight\mapeamento.json` para reinstalações. Outra fonte exige um perfil/identidade próprios e configuração de fonte correspondente no aplicativo.

## Atualizar uma instalação existente

1. Feche a janela do preparador. O PBIX pode permanecer aberto e estável no Power BI Desktop.
2. Extraia **todo** o pacote corrigido em uma pasta local; não execute arquivos diretamente da visualização temporária do ZIP.
3. Execute `Atualizar.cmd`. Ele prepara o executável em uma pasta separada, executa o autoteste e confere o checksum antes de trocar a instalação. No ZIP pronto, copia as dependências verificadas de `runtime/`; no ZIP de fontes, compila. A versão antiga permanece como `Preparador.backup-<identificador>` para recuperação.
4. A atualização não solicita elevação, não registra novamente o botão e não escreve em `%LOCALAPPDATA%\ComercialInsight\mapeamento.json`. O botão existente usa o mesmo caminho e passa a abrir a versão corrigida. Não refaça o mapeamento.
5. Se o nome do botão tiver acentos incorretos, execute opcionalmente `RepararRegistro.cmd` e aceite a elevação **somente para reparar o registro**. Reinicie o Power BI Desktop depois dessa reparação. O executável e o mapeamento não são recompilados nem alterados por essa opção.

Os scripts PowerShell são UTF-8 com BOM e a leitura/escrita do JSON especifica UTF-8. Isso evita a interpretação como ANSI no Windows PowerShell 5.1 que corrompia `atualização` no registro. Referência: [Microsoft — codificação de caracteres no PowerShell](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding?view=powershell-5.1).

Se compilação, conexão com o NuGet ou autoteste falhar, a instalação anterior é mantida e a atualização informa o motivo. Bloqueios de compartilhamento de diretório do Windows recebem até seis tentativas com espera curta; falhas persistentes exibem a etapa e o código nativo e restauram a versão anterior quando a nova ainda não foi ativada. Feche o preparador e tente novamente após corrigir a causa; não há repetição automática infinita. As pastas de staging/backup são mantidas para diagnóstico, sem remoção automática de diretórios.

## Toda semana

Obtenha e abra o PBIX atualizado. Aguarde a atualização terminar; mantenha o modelo sem alterações. Em **Ferramentas externas**, clique em **Preparar atualização Comercial Insight**. Com o perfil já salvo, a extração e validação começam automaticamente. Somente depois dessas etapas a janela **Salvar** permite escolher o arquivo `.ci.ndjson`; confirme e aguarde a conclusão. O botão **Preparar atualização** na janela serve para iniciar outra tentativa quando necessário. Entre no Comercial Insight em **Administração > Atualização de dados**, selecione esse único pacote e clique em **Enviar e atualizar base**. Aguarde **Base atualizada com sucesso**.

## Suporte semântico e limites reais

Esta versão exige tabelas/partições em modo **Import**. Interrompe em DirectQuery, Dual, DirectLake, partições incompletas ou relatório thin/live; não transforma falta de acesso em tabela vazia. Nesses casos obtenha um modelo autocontido ou uma exportação completa autorizada com consistência demonstrada.

Todas as tabelas de negócio e colunas, inclusive ocultas, são exportadas integralmente. `SELECTCOLUMNS` mantém linhas de fatos coincidentes. RowNumber interno, strings de conexão, fontes M e roles de acesso não são serializados. O inventário contém medidas, formatos, colunas calculadas, relacionamentos ativos/inativos, cardinalidades, direções e dependências. Colunas com nomes que indiquem credenciais interrompem a exportação para revisão.

A projeção comercial v1 mantém a granularidade de um fato e dimensões na própria tabela ou acessadas por `RELATED`, que exige relação válida muitos para um. Faturamento e devoluções usam somas de colunas explicitamente mapeadas; clientes usa chaves distintas. Uma medida que não equivaler a essa implementação falha nos controles. Margem, metas, estoque, litros e medidas especiais ficam indisponíveis até implementação e conciliação próprias; os respectivos metadados originais continuam no inventário. A tabela Acessos não concede permissões no aplicativo.

São executados DAX real para total, todos os meses extraídos e recortes representativos de regional, cliente, produto e UF. As linhas extraídas são reconciliadas localmente antes da emissão e novamente no D1 antes da ativação. BLANK é diferente de zero, valores monetários preservam escala e precisão; precisão maior que a configurada bloqueia a preparação. Não se afirma equivalência para toda combinação DAX possível.

TOM e as contagens de origem são lidos antes/depois. Mudanças de esquema, horários de processamento ou comandos concorrentes de processamento invalidam o pacote. Não edite nem atualize o modelo durante a extração. Modelos sem timestamps confiáveis ou dados externos dinâmicos precisam de revisão adicional.

## Formato

`.ci.ndjson` é UTF-8 sem BOM, com LF e um objeto JSON por linha. O primeiro objeto é o manifesto `commercial-insight`, fonte `commercial-main`. O formato v1 mantém a projeção de um fato; o v2 registra o contrato nativo e consulta os dados originais dos dois fatos e dimensões, sem escolher arbitrariamente uma linha em relações muitos-para-muitos. Cada parte contém até 100 registros no v1 ou 1.000 no v2, sempre limitada a 1 MiB, e declara índice, quantidade, bytes e SHA-256 dos bytes exatos da linha, incluindo o LF. Unicode, códigos textuais com zeros à esquerda e nulos são preservados. Não há compressão ou extração de caminhos ZIP no pacote de dados. O manifesto admite até 1 MiB; limites acima interrompem com explicação e exigem dimensionamento, sem truncamento.

`exemplo-sintetico.ci.ndjson` é exclusivamente para testes locais. Não enviar para produção.

## Verificação de desenvolvimento

Use o SDK .NET 10 LTS: `dotnet restore --locked-mode`, `dotnet build -c Release`, `dotnet run -- --self-test`. O teste verifica divisão de partes, checksums, Unicode, nulos, zeros à esquerda e rejeição de arredondamento implícito. O aceite do modelo real requer o PBIX aberto no Power BI Desktop; compilação e teste sintético não comprovam o modelo Panizzon.

Para diagnóstico técnico somente de leitura, use `ComercialInsight.Preparador.exe --check-model --server "localhost:PORTA" --database "MODELO" --report "diagnostico.json"`. Acrescente `--mapping "CAMINHO-DO-MAPEAMENTO"` para verificar a configuração sem alterá-la. A porta e o modelo são os parâmetros atuais entregues pelo Desktop; não reutilize valores de outra sessão. `--validate-package "arquivo.ci.ndjson" --report "validacao.json"` verifica a integridade sem importar dados. Essas opções são de diagnóstico; a rotina semanal continua pela interface.

Para gerar o ZIP pronto, publique em uma pasta exclusiva com `dotnet publish -c Release --self-contained true -o CAMINHO` e execute `node scripts/package-preparer.mjs --runtime CAMINHO --output CAMINHO-DO-ZIP`. O script exige as dependências Windows e inclui manifesto SHA-256 e o manual semanal. Sem `--runtime` ou `CI_PREPARER_RUNTIME_DIR`, ele gera explicitamente o ZIP de fontes. A distribuição binária deve ser congelada após o aceite da mesma revisão do preparador.

Referências: [Microsoft — ferramentas externas](https://learn.microsoft.com/en-us/power-bi/transform-model/desktop-external-tools), [registro e parâmetros](https://learn.microsoft.com/en-us/power-bi/transform-model/desktop-external-tools-register), [bibliotecas TOM/ADOMD](https://learn.microsoft.com/en-us/analysis-services/client-libraries).
