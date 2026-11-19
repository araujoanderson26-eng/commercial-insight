# Integração Comercial Insight + Power BI + D1

Estado técnico em **18/11/2026**. O preparador nativo foi validado localmente com consultas DAX reais e testes sintéticos. A implementação de Worker, a migração nativa e o processamento por Queue continuam como candidatos à implantação. A validação local não constitui homologação de desempenho ou carga em produção no D1 remoto.

A rotina do operador está no [manual de atualização semanal](MANUAL-ATUALIZACAO-SEMANAL.md). A [validação inicial](VALIDACAO-ATUALIZACAO-DADOS.md) permanece como registro histórico do formato v1. O relatório detalhado de medições fica somente no arquivo local privado `.wrangler/reports/INTEGRACAO-POWERBI-D1.md`, excluído da distribuição pública.

## Critérios e contrato semântico

O preparador identifica as receitas pelas expressões DAX e pelos relacionamentos ativos do modelo. Reutiliza o perfil salvo sem sobrescrevê-lo nem exigir novo mapeamento semanal. Uma coluna escolhida anteriormente no perfil não substitui a referência encontrada no DAX original. Ver [reconhecimento do contrato](../tools/preparador/NativeModel.cs), [exportação](../tools/preparador/NativeExport.cs) e [avaliação local](../tools/preparador/NativeEvaluation.cs).

| Indicador | Receita suportada |
| --- | --- |
| Faturamento bruto | Soma da coluna monetária de vendas identificada no DAX |
| Devoluções | Soma do fato próprio de devoluções, convertendo BLANK em zero conforme a expressão original |
| Faturamento líquido | Bruto menos devoluções, com uma única dedução |
| Clientes compradores | Contagem distinta da chave de cliente em vendas |

O rótulo de uma medida que menciona “ano atual” não acrescenta filtro temporal. Uma expressão composta apenas por `DISTINCTCOUNT` respeita o contexto solicitado, inclusive períodos históricos. BLANK e ausência de linhas seguem a receita reconhecida. A documentação de [DISTINCTCOUNT](https://learn.microsoft.com/en-us/dax/distinctcount-function-dax) explica sua contagem de BLANK e seus totais não aditivos.

Vendas e devoluções conservam tabelas e datas próprias. A escala de armazenamento monetário respeita a precisão original, sem arredondamento silencioso para a escala visual do perfil. Margem e outras medidas sem receita implementada permanecem indisponíveis; suas expressões continuam no inventário privado.

A semântica do contrato foi investigada com **84 consultas diagnósticas DAX** e conferida por **272 controles DAX do pacote validado**. Os valores e volumes do modelo não são publicados. As classes de comportamento verificadas incluem:

- Propagação de filtros por sua origem e pelo caminho ativo, sem transformar tabelas auxiliares sem filtro em junções que removem vendas.
- Calendário aplicado diretamente a cada fato, sem exigir venda no mês para toda devolução.
- Filtros explícitos de cliente, produto, categoria ou UF de vendas propagados pelo conjunto de clientes, considerando o contexto de vendas e seu período.
- Representante, regional e gerente aplicados aos atributos comprovados, sem ampliar o escopo de acesso cadastrado.
- Produto e categoria de vendas não reaplicados às colunas de produto devolvido.
- Agregação monetária sem multiplicação por duplicações na carteira; contagem de compradores independente do conjunto usado para filtrar devoluções.

Essas regras pertencem ao contrato reconhecido, não a um interpretador geral de DAX. A Microsoft documenta [contexto de filtro em CALCULATE](https://learn.microsoft.com/en-us/dax/calculate-function-dax/) e [propagação de relacionamentos](https://learn.microsoft.com/en-us/power-bi/transform-model/desktop-relationships-understand); os caminhos concretos foram conferidos nas consultas de diagnóstico.

**Totais são recalculados no próprio contexto.** Compradores e resultados por grupos muitos-para-muitos podem ser não aditivos. Grupos de representante, regional ou gerente podem apresentar devoluções sem vendas no mesmo mês. A [orientação oficial sobre muitos-para-muitos](https://learn.microsoft.com/en-us/power-bi/guidance/relationships-many-to-many) também descreve resultados não aditivos.

## Preservação, integridade e testes

O formato v2 conserva as linhas raw, o esquema, as medidas, as relações e as dependências disponíveis no inventário. Mantém os fatos separados, sem criar uma segunda cópia canônica deles. Uma tabela apenas de medidas confirmada com zero linhas físicas recebe `metadataOnly`; isso não autoriza tabelas de negócio vazias nem altera o perfil. Exclusões de campos internos do mecanismo e detalhes de conexão são justificadas.

Cada parte v2 admite até **1.000 linhas e 1 MiB**, respeitando ambos os limites. O v1 conserva o máximo de 100 linhas. A ampliação de lotes reduz o crescimento do manifesto sem remover registros ou controles. O preparador confere contagens antes/depois, checksums, precisão, consistência do modelo e DAX antes de publicar o arquivo de forma atômica. Ver [integridade do pacote](../tools/preparador/PackageIntegrity.cs), [reconciliação v2](../tools/preparador/NativePackageData.cs) e [regressões sintéticas](../tools/preparador/NativeSelfTests.cs).

O preparador 1.0.3 preserva UTC nos metadados TOM quando o provedor omite `DateTime.Kind`, mantendo a conversão correta para valores explicitamente locais. A validação do arquivo já confere ordem temporal, tolerância de relógio e data de referência antes de salvar. O validador SQL local reutiliza a própria função de validação do Worker, inclusive suas guardas temporais. Ver [política de horários](../tools/preparador/TimestampPolicy.cs) e [regressão da compatibilidade do manifesto](../tests/native-manifest.test.ts).

Uma verificação independente reproduziu as consultas do Worker em SQLite e aprovou os mesmos **272 controles**. O [validador local](../scripts/validate-native-package.ts) conserva os registros raw e utiliza as tabelas derivadas da [migração 0005](../migrations/0005_native_model.sql). Esse ensaio comprova conciliação local; não mede armazenamento faturado, latência, CPU ou concorrência do D1 remoto.

Os builds e self-tests do preparador foram aprovados, incluindo compatibilidade v1/v2, partes de 1.000 registros, preservação de chaves e precisão, devoluções sem vendas no mês, compradores sem cadastro correspondente e rejeição de corrupção. A revisão 1.0.3 aprovou **48 testes automatizados, sem falhas ou testes ignorados**, verificação de tipos, lint e build. O ensaio final do [compilador nativo](../worker/native-model.ts) conciliou todos os controles e executou os sete agrupamentos com comparativo e as opções dentro do orçamento local de consulta. Isso não substitui a homologação remota.

O teste visual em navegador passou em desktop e celular. O `Atualizar.cmd` da distribuição Windows x64 pronta foi executado em ambiente isolado com o binário real: autoteste, hashes das dependências, preservação do perfil e da versão anterior aprovados. Os testes também cobrem revogação de escopo durante consultas, limite de chamadas de opções e revogação da política de IA antes de novo envio ou persistência. Consulte os [testes nativos](../tests/native.test.ts), [de provedores](../tests/providers.test.ts), [do importador](../tests/manual.test.ts) e [do atualizador pronto](../tests/preparer-ready-smoke.ps1).

## Capacidade e processamento candidatos

O [wrangler.jsonc candidato](../wrangler.jsonc) prevê pacote máximo de **512 MiB**, recebido em multipart, e orçamento operacional de **9 GiB** no D1. O dimensionamento pressupõe plano e cotas compatíveis. A documentação atual informa máximo de 10 GB por banco D1 no Workers Paid, 100 parâmetros por instrução e 2 MB por linha/valor; os limites de cada instrução também se aplicam dentro de um batch. Ver [limites oficiais do D1](https://developers.cloudflare.com/d1/platform/limits/).

O [importador](../worker/manual.ts) estima armazenamento e coexistência de versões de forma conservadora, considerando índices, overhead e espaço para a carga recebida. O arquivo de upload, a estimativa lógica e o armazenamento físico são medidas diferentes. A quantidade de snapshots que cabe no orçamento depende do volume e do crescimento dos dados; não há promessa de retenção ilimitada.

A Queue candidata possui produtor/consumidor dedicado, concorrência unitária, checkpoints e retentativas, com cron de apoio. O processamento não depende de manter a página aberta. Sua criação, vinculação e implantação ainda precisam integrar o aceite de produção. Consulte a [configuração oficial de Queues](https://developers.cloudflare.com/queues/configuration/configure-queues/).

A política de retenção de snapshots está pendente. Não há poda automática para abrir espaço: ao exceder o orçamento, a carga deve falhar preservando a versão ativa. Retenção de conversas/auditoria não autoriza apagar snapshots comerciais. Qualquer exclusão ou alteração dessa política exige aprovação explícita e deve preservar a versão ativa e a anterior recuperável.

## Produção e aceite pendentes

| Etapa | Estado |
| --- | --- |
| Preparador e conciliação DAX | Validados localmente |
| Worker/interface nativos, migração `0005` e Queue | Candidatos; sem implantação remota nesta entrega |
| Carga real e ativação do snapshot em produção | Não realizadas |
| Desempenho no runtime D1 remoto | Pendente de homologação |
| Retenção e capacidade para cargas sucessivas | Política pendente, sem exclusões autorizadas |
| Atualização Windows e aceite pelo botão do Power BI | Pendentes no ambiente instalado do operador |
| Segredo `OPENAI_API_KEY` e aceite do chat | Pendência conhecida; não impede os relatórios manuais determinísticos |

A autorização final deve abranger o candidato revisado, migração aditiva com recuperação, recurso Queue, capacidade e primeira carga privada, seguida de conferência da versão ativa, restauração e escopos. Cadastros, senhas e permissões existentes devem permanecer preservados. Este relatório não autoriza executar essas etapas.

O [empacotador do preparador](../scripts/package-preparer.mjs) usa uma lista explícita de fontes e arquivos de runtime. A distribuição Windows x64 deve conter o runtime necessário e o manual semanal. Perfis, backups, credenciais, logs, pacotes e medições privadas do modelo não integram o ZIP nem o repositório. Os exemplos distribuídos são sintéticos. Veja o [README do preparador](../tools/preparador/README.md) e as [instruções de implantação](IMPLANTACAO.md).

A aceitação final distingue **arquivo preparado e conciliado**, **importação validada no servidor** e **versão efetivamente publicada em produção**.
