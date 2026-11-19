# Correção do preparador 1.0.1 — 18/11/2026

Este é o registro histórico da versão 1.0.1. A versão 1.0.2 já implementa e concilia o contrato relacional dos dois fatos. Para instalar e atualizar a base, siga o [manual semanal vigente](MANUAL-ATUALIZACAO-SEMANAL.md).

## Causa comprovada no Power BI aberto

O detector anterior procurava `Batch`, `Alter`, `Create`, `Delete`, `Process` ou `Refresh` em todas as strings de `DISCOVER_COMMANDS`, sem considerar a coluna `COMMAND_END_TIME`. Essa DMV apresenta comandos atuais **ou o último comando** da sessão; `Batch` também é um contêiner para operações de leitura.

Foi realizada uma consulta local somente de leitura ao Desktop em execução, com **27 tabelas e 101 medidas**. A evidência sanitizada mostrou:

- Um `Batch/Discover` encerrado às 18:20:41, horário de São Paulo, interpretado pelo código antigo como alteração.
- Um `Batch` com operações de metadados linguísticos encerrado às 18:20:48, anterior à tentativa de preparação, também bloqueado indefinidamente pelo detector antigo.
- Uma leitura do próprio TOM gerou novamente `Batch/Discover`; o mesmo padrão voltaria a disparar o erro sem qualquer alteração de dados.

Portanto, houve reprodução do falso positivo no modelo real. Isso não significa que todas as mensagens futuras de concorrência sejam falsos positivos. Os testes mantêm o bloqueio para escrita em andamento, escrita concluída durante a extração, comandos ativos não reconhecidos e mudanças estruturais ou de processamento.

Referências Microsoft: [DMVs e estado do servidor](https://learn.microsoft.com/en-us/analysis-services/instances/use-dynamic-management-views-dmvs-to-monitor-analysis-services?view=power-bi-premium-current), [schema de DISCOVER_COMMANDS e COMMAND_END_TIME](https://learn.microsoft.com/en-us/openspecs/sql_server_protocols/ms-ssas/c36a7837-027d-49e0-9df8-bb1f5246a7c4).

## Correções entregues

- Comandos lidos por colunas nomeadas, com sessão, início e término. Comandos antigos concluídos não caracterizam concorrência atual.
- Análise estrutural de XMLA/TMSL diferencia um `Batch/Discover` de `Batch/Process`; texto de consultas não é interpretado como instrução de escrita.
- Estrutura e estado persistente dos dados têm fingerprints separados e ordenação canônica. Contadores transitórios de sessão não entram na comparação; timestamps de processamento e alterações reais continuam protegidos.
- Logs privados informam estágio, operação, horário, sessão e hash, sem salvar corpos de comandos, strings de conexão ou credenciais.
- Temporários exclusivos por tentativa, validação sequencial de todas as partes e publicação por substituição atômica. Em falha, o destino anterior é preservado; um temporário não é anunciado como pacote final.
- Busca por parte do nome, listas ordenadas, reutilização e edição do perfil salvo, erros por campo e botão **Reconectar ao modelo**. Não há repetição automática infinita.
- Botão **Validar pacote existente** confere manifesto, tipos, contagens e SHA-256 integralmente. Integridade do arquivo não equivale à conciliação com o modelo atual.
- Atualizador separado da instalação inicial, sem registro administrativo ou redefinição do mapeamento. Scripts com UTF-8 BOM corrigem o texto corrompido no registro pelo Windows PowerShell 5.1.

## Mapeamento Panizzon preservado e bloqueios reais

O arquivo existente foi somente lido. Seu SHA-256 permaneceu idêntico antes e depois do diagnóstico. Nenhuma tabela recebeu autorização para ficar vazia.

As expressões foram consultadas no TOM real:

| Medida | Expressão confirmada / resultado da análise |
| --- | --- |
| Fat. Bruto | `SUM(Faturamento[Valor mercadorias])` |
| Dev. Fat | `IF(ISBLANK(SUM('DEVOLUÇÃO'[Valor mercadorias])),0,SUM('DEVOLUÇÃO'[Valor mercadorias]))` |
| Fat. Liq. | `[Fat. Bruto]-[Dev. Fat]` |
| Clientes Atual (ano atual) | `DISTINCTCOUNT(Faturamento[Codigo Cliente])`: não há filtro de ano atual na expressão, apesar do nome |

O perfil salvo associa faturamento líquido e devoluções à mesma coluna de `Faturamento`. Isso não representa as expressões reais: devoluções vêm de outro fato e faturamento líquido exige a diferença entre dois fatos. Além disso, `Base Clientes[Representantes]` tem relacionamento muitos-para-muitos com `Faturamento`, que não permite escolher uma única linha por `RELATED`. As datas ativas também diferem: documento nas vendas e lançamento nas devoluções.

**A correção do detector foi comprovada, mas o perfil atual ainda não pode produzir um pacote analítico Panizzon válido com a projeção de um fato.** O preparador agora explica esses campos antes de criar arquivos. É necessária uma implementação explícita para os dois fatos e uma regra de dimensão/chave de representante conciliada. Não se deve mudar silenciosamente o faturamento para bruto, deduzir devoluções duas vezes ou escolher arbitrariamente um representante.

Não foram modificados PBIX, relacionamentos, fórmulas ou perfil salvo. Não foram exportadas linhas comerciais nem enviados dados à produção para contornar esse bloqueio.

## Verificações executadas

| Verificação | Evidência |
| --- | --- |
| Modelo real estável | TOM antes/depois + DAX constante + DMV: 27 tabelas, 101 medidas, fingerprints estáveis, sem o falso bloqueio |
| Alteração real simulada | Escrita ativa/recentes, mudança de estrutura e timestamp de processamento são rejeitados nos autotestes |
| Transientes | Consultas próprias, Batch/Discover, comandos concluídos e reordenação de metadados não invalidam |
| Falha de conexão | Diagnóstico estruturado de falha, sem anúncio de exportação |
| Pacote incompleto/corrompido | Validação .NET rejeita truncamento, hash incorreto e conteúdo além das partes declaradas |
| Compatibilidade | Fixture TypeScript do importador validada pelo executável .NET; formato `commercial-insight` versão 1 mantido, sem migrations |
| Arquivo anterior | Falha de validação preserva bytes do destino e não remove temporários de outras tentativas |
| Perfil e Unicode | Leitura/roundtrip/edição preservam identidade e campos; nove grupos PowerShell cobrem falhas, staging e UTF-8 no PS 5.1 |
| Receita/devoluções | Controle sintético aceita líquido 90/devoluções 10 separados e rejeita líquido 80 por dupla dedução |

Build .NET 10: sem erros/avisos. Lint e tipos aprovados; suíte de 28 testes aprovada, incluindo os nove grupos internos do instalador PowerShell. Os testes de escrita real são simulados; nenhuma alteração foi provocada no PBIX do usuário. A extração comercial completa e a publicação de Panizzon **não** foram atestadas. Os diagnósticos locais estão em `.wrangler/`, excluídos do Git.

## Arquivos da correção

| Arquivo | Alteração |
| --- | --- |
| `tools/preparador/Program.cs` | Integra detecção, pré-validação, logs, reconexão, validação de pacote e gravação protegida |
| `ConsistencyGuard.cs` | Classificação de comandos, sessões/horários e fingerprints de estrutura/dados |
| `SemanticPreflight.cs` | Diagnósticos por campo usando DAX e relacionamentos reais |
| `PackageIntegrity.cs`, `AtomicPackageFile.cs` | Validação integral e publicação atômica do arquivo |
| `MappingForm.cs`, `MappingSettings.cs`, `Diagnostics.cs` | Pesquisa, preservação/edição do perfil e diagnóstico privado |
| `Instalar.*`, `Atualizar.*`, `Preparador.Setup.ps1`, `Registrar.ps1`, `RepararRegistro.cmd` | Instalação/atualização protegida e correção de UTF-8 no Windows PowerShell |
| `ComercialInsight.Preparador.csproj`, `README.md` | Versão 1.0.1 e procedimentos |
| `scripts/package-preparer.mjs` | Inclui todos os componentes revisados e este relatório no ZIP local |
| `tests/preparer-runtime.test.ts`, `tests/preparer-installer.test.ts`, `tests/preparador-install.ps1` | Testes do executável, contrato de pacote e atualização |

Nenhum arquivo do Worker, esquema D1 ou migration foi alterado nesta correção.

## Como atualizar no Windows

1. Feche apenas a janela do preparador. O Power BI pode continuar aberto.
2. Extraia todos os arquivos do ZIP corrigido 1.0.1 em uma pasta local. Não execute dentro da visualização temporária do ZIP.
3. Execute **Atualizar.cmd**. O script compila em staging, executa autotestes e troca a instalação somente após aprovação. Guarda uma cópia da instalação anterior.
4. Abra novamente **Ferramentas externas > Preparar atualização Comercial Insight**. O perfil salvo será reutilizado; não refaça o mapeamento.
5. Se quiser corrigir o nome com acentos do botão, execute **RepararRegistro.cmd**, aceite a elevação específica do Windows e reinicie o Power BI. Essa etapa é opcional e não altera o perfil.

O agente não executou o atualizador, o reparo de registro ou outra instalação no computador. O executável instalado ainda precisa ser substituído pela ação acima. O pacote de download do site permanece na versão anterior, pois não foi autorizado deploy nesta correção.

## Como preparar e conferir o pacote

Após resolver e conciliar o contrato dos dois fatos/representantes, mantenha o modelo estável, clique em **Preparar atualização** e escolha um arquivo `.ci.ndjson`. Somente uma conclusão com sucesso publica o arquivo final. Use **Validar pacote existente** para conferir o arquivo; depois o upload no aplicativo deve passar suas próprias validações antes de ativar a base. Um arquivo de tentativa antiga não deve ser considerado válido apenas por existir.

O botão **Abrir log** acessa os detalhes privados da tentativa em `%LOCALAPPDATA%\ComercialInsight\logs`. A extensão efetivamente suportada continua `.ci.ndjson`.
