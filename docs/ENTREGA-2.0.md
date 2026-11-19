# Commercial Insight 2.0 — Entrega para revisão

Desenvolvido por Anderson de Araujo. Estado em 19/11/2026. Branch `feat/commercial-insight-2`, baseada no merge do PR #1. **Produção e PBIX original não foram alterados nesta evolução.**

## Diagnóstico e correções

| Problema | Evidência e resultado |
| --- | --- |
| IA indisponível | Leitura da fonte publicada confirmou autorização de IA desabilitada; a listagem de secrets confirmou ausência de `OPENAI_API_KEY`. A interface agora mostra as duas condições e o backend trata erros de credencial, cota e resposta incompleta. |
| Crescimento enganoso | O denominador anterior usava valor absoluto. Base anterior negativa ou zero agora retorna condição explícita, sem percentual convencional. Diferença absoluta continua disponível. |
| Períodos parciais | Comparação mensal podia usar o ano anterior completo contra uma base parcial. O D1 agora usa o mesmo dia final homólogo, limitado à referência/cobertura do snapshot, com tratamento de ano bissexto. |
| Devoluções sem vendas | O conector online ocultava medidas financeiras quando o fato de vendas não tinha linhas. Medidas financeiras oficiais agora são avaliadas diretamente no próprio contexto. |
| Códigos sem descrição | Os cadastros já estavam no inventário raw. Rankings, filtros, buscas, briefing e exportações resolvem descrições por chave/versão, sem modificar o Preparador ou multiplicar os fatos. |
| Histórico de IA | Respostas antigas não são aceitas apenas porque os totais coincidem. A evidência inclui revisão semântica, datas e avisos; comentários passam novamente pelas guardas atuais. |
| Relatórios/visitas insuficientes | Briefing com consultas tipadas, histórico, mix, observações, pauta e exportação; planos favoritos por usuário; visitas também integradas ao chat. |

O faturamento líquido continua **bruto menos devoluções uma única vez**. Fatos, DAX e caminhos muitos-para-muitos existentes foram preservados. Produto/categoria podem propagar devoluções pelo conjunto de clientes conforme o modelo oficial. Por isso, rankings podem ser não aditivos; somar suas linhas não reconstrói necessariamente o total.

No período confirmado de janeiro a outubro de 2026, a linha do representante no ranking nacional coincide com a consulta filtrada individualmente no snapshot local. Os dois montantes específicos do exemplo fornecido não foram reproduzidos. Faltam os demais filtros, o usuário/escopo e a versão originais para afirmar sua origem. Foram observados valores negativos explicáveis pela fórmula e pela atribuição comercial; não se declarou erro de extração com base apenas no sinal. Detalhes comerciais e exemplos reais estão apenas no relatório privado local.

## Implementação

- Semântica: períodos equivalentes, identificação por código/descrição, categoria, UF, comparação válida, limites de cobertura e alerta M:M.
- IA: Responses estruturada, plano Zod, nomes resolvidos no catálogo autorizado, contexto conversacional, política revalidada e limite de respostas; sem execução de SQL gerado pelo modelo.
- Visitas: página própria, seleção/desambiguação, consultas no mesmo snapshot, fatos e recomendações separados, exportação e reabertura autorizada.
- Relatórios: favoritos por proprietário/escopo/revisão, ordenação, pesquisa, gráficos de tendência e rankings, arquivo `.xlsx` e impressão/PDF.
- Segurança: operador de atualização sem acesso analítico ou administrativo, propriedade de importações, revogação de escopo e proteção de histórico/downloads.
- Interface: navegação de visitas, contexto de cards, neutralidade de base inválida, cores comerciais, filtros identificados, layout responsivo e impressão.
- Operação: Preparador 1.0.3 e mapeamento preservados, migração aditiva `0006`, configuração de homologação separada e script de conciliação somente leitura.

Arquivos principais: `shared/domain.ts`, `shared/commercial.ts`; `worker/{analysis,assistant,auth,commercial,core,index,manual,native-model,providers}.ts`; `src/{Admin,Chat,DataUpdates,Visits,WorkspaceViews,main,ui}.tsx`, `src/exports.ts`, `src/style.css`; migração `0006`; scripts de bootstrap, homologação, pacote e conciliação; testes comerciais, de API, visita e interface. Os novos manuais estão ligados ao README e à rotina semanal.

## Evidência de dados

O compilador atualizado foi executado novamente sobre o snapshot real local, em SQLite somente leitura: **272/272 controles DAX aprovados**, contagens raw/nativas corretas. O script reproduzível está em `scripts/reconcile-snapshot.ts`. A evidência sanitizada fica em `.wrangler/reconciliation/commercial-2.json`; os pacotes, valores e diagnósticos detalhados permanecem fora do repositório público.

A leitura do D1 publicado confirmou a mesma versão ativa e 272 controles aprovados no relatório de importação. Isso confirma o snapshot anterior; não comprova a execução remota desta nova versão. O código 2.0 não foi implantado em produção.

O Power BI Desktop não estava ativo nesta auditoria. As expressões e relações oficiais analisadas são as preservadas no pacote validado e no inventário privado da extração anterior. Não se alega ter reconsultado um PBIX aberto nesta sessão.

Também foi produzido um briefing com dados reais locais sem OpenAI e sem escrita no banco. O líquido atual/anterior e a última compra/dias de compra foram conferidos por consultas independentes. A demonstração está em `.wrangler/reports/demo-visit-2.json`, fora do Git por conter identidade e resultados comerciais.

## Verificações executadas

| Verificação | Resultado |
| --- | --- |
| Suíte automatizada | **82 testes aprovados, zero falhas e zero skips** após os novos bloqueios de homologação; inclui cálculos, importação, escopo, OpenAI mock, contexto, visitas, histórico, Excel e recusa de pacotes não sintéticos na homologação. |
| Typecheck, lint e build | Aprovados. Build remove duas anotações não interpretáveis de comentários da dependência Zod; sem falha de compilação. |
| Interface Edge desktop/celular | Três suítes aprovadas: atualização/restauração, contratos nativos e fluxo executivo com visita, histórico, favorito, YTD, Excel e impressão/PDF. |
| Conciliação real local | **272/272 controles**, contagens raw/nativas conferidas em SQLite somente leitura. |
| Briefing real local | Identidade financeira e atividade diária conferidas independentemente; nenhuma chamada OpenAI. |
| npm audit | Zero vulnerabilidades reportadas. |
| NuGet | Nenhuma dependência vulnerável reportada pela consulta de vulnerabilidades. |
| Gitleaks | Histórico sem secrets encontrados; artefatos privados excluídos do Git. |
| Homologação remota | Worker isolado publicado com os três vínculos próprios e seis migrações; **12 verificações API e 10 de navegador aprovadas**, apenas dados sintéticos, 36/36 controles. [Ambiente, evidências e limites](HOMOLOGACAO-EXECUCAO.md). |

O primeiro ensaio de testes encontrou restrições de leitura do sandbox e depois referências ao cache NuGet com caminho longo após a auditoria. O restore em modo locked no cache original resolveu o ambiente, e a suíte completa foi repetida com todos os testes habilitados. Nenhum teste foi removido ou marcado como ignorado para obter o resultado.

## Limitações e aceite pendente

1. **OpenAI real:** a chave foi cadastrada pelo titular e o primeiro ensaio real recebeu HTTP 401 `invalid_api_key`. A execução parou, restaurou a política de IA e manteve a reserva conservadora do orçamento de US$ 0,10. Faltam recadastro seguro de uma chave válida e teste bem-sucedido de modelo/uso. [Protocolo e evidência](HOMOLOGACAO-OPENAI.md).
2. **Operação de homologação:** [ambiente isolado publicado](https://commercial-insight-hml.araujo-anderson26.workers.dev), após conferência financeira manual e autorização do titular; somente dados sintéticos. Resultados, acesso, limites, consumo observado e execução dos agendamentos estão em [Homologação](HOMOLOGACAO-EXECUCAO.md) e [Custos](HOMOLOGACAO-CUSTOS.md). A observação da limpeza diária e o aceite com dados reais continuam separados desta validação sintética.
3. **Exemplo financeiro original:** janeiro–outubro de 2026 já foi conferido; ainda requer os demais filtros combinados, usuário/escopo e versão da tela observada. O diagnóstico privado registra exatamente os recortes reproduzidos.
4. **Narrativa de IA:** guardas rejeitam números não sustentados e percentuais inválidos; não constituem prova formal de todas as associações e causas descritas pelo modelo. Gráficos/tabelas permanecem a evidência verificável; causas comerciais exigem confirmação.
5. **Métricas especiais:** margem, estoque, metas, litros e quantidade continuam indisponíveis sem receita e conciliação específicas. O ticket derivado é por comprador, não por pedido.
6. **Recorte temporal:** seleção operacional por meses, até 24; o corte diário é o homólogo do snapshot. Não se declara um relatório por dias arbitrários ou semana calendário completa.
7. **Conectores:** busca por descrição requer pacote nativo v2; o conector online não possui todos os campos comerciais do contrato manual. Atribuição histórica de carteira não foi inventada.
8. **Exportações:** PDF usa impressão do navegador; Excel exporta os resultados retornados e o contexto. Rankings têm limite explícito; não constituem dump integral da base.
9. **Operação:** retenção de snapshots e aceite físico de dispositivos/botão externo do Power BI continuam exigindo homologação da empresa.

Não se declara o produto integralmente homologado enquanto essas dependências externas permanecerem abertas. O procedimento de aceite e publicação está em [Administração 2.0](ADMINISTRACAO-2.0.md); o roteiro comercial está no [Manual do usuário](MANUAL-USUARIO-2.0.md).

## Revisão no GitHub

[PR #2](https://github.com/araujoanderson26-eng/commercial-insight/pull/2), mantida como draft, branch `feat/commercial-insight-2`. A implementação foi publicada no commit `f7b9ebf`; documentação complementar permanece na mesma branch. Não há merge ou implantação de produção autorizados nesta entrega.
