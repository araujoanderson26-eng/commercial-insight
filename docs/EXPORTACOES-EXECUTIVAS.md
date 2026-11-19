# Exportações executivas

O Excel e o PDF usam exclusivamente o relatório já recebido e autorizado na interface. A exportação não consulta APIs, não amplia o recorte comercial e não recalcula os totais oficiais pela soma do ranking. Não há alteração de D1, PBIX, Preparador ou dependências de produção.

## Excel

`src/exports.ts` mantém o empacotador ZIP/Open XML do aplicativo. `src/export-model.ts` organiza os valores e o contexto; `src/xlsx-layout.ts` produz estilos, planilhas, relacionamentos e gráficos nativos editáveis.

- Resumo Executivo com indicadores disponíveis, períodos efetivos, filtros, extração, geração em Brasília, versão da base e índice com links internos.
- Abas existentes preservadas, incluindo Histórico, Mix, Perdas de mix e Pauta. Títulos, cabeçalhos agrupados, filtros automáticos, congelamento e configuração de impressão.
- Moedas e quantidades continuam numéricas e sem arredondamento dos valores armazenados. Percentuais de variação usam a representação fracionária do Excel; margem e sua diferença permanecem em percentual e pontos percentuais, respectivamente. Dados ausentes ficam vazios; base anterior não positiva recebe “Não comparável”.
- Cores das diferenças respeitam o sentido comercial do indicador: redução de devoluções é favorável. Totais oficiais são destacados separadamente.
- Gráficos de evolução mensal ou primeiros dez registros da ordenação recebida usam referências às células das abas detalhadas, com cache dos mesmos valores e lacunas nos dados ausentes. Não há imagens externas ou valores fabricados.
- Códigos e textos são células de texto explícitas, inclusive nomes iniciados por `=`, `+` ou `@`. Nomes de abas e XML são sanitizados. Não há fórmulas fornecidas pelo usuário nem vínculos externos.
- Impressão A4 paisagem dividida por bloco de indicador, com repetição dos códigos, descrições e cabeçalhos. Os limites do ranking e as ressalvas da consulta aparecem no contexto.

## PDF

`src/print-report.ts` cria uma janela de impressão dedicada ao relatório selecionado. Os botões de relatórios, conversa e visitas usam essa saída, sem menus ou controles do aplicativo. Para salvar o arquivo, selecionar **Salvar como PDF**, papel A4 e escala de 100% no diálogo do navegador; desativar os cabeçalhos e rodapés adicionais do navegador para evitar duplicação.

A capa e os gráficos vetoriais usam retrato; os detalhes são divididos em blocos por indicador em paisagem, com cabeçalhos repetidos. Há numeração, contexto da origem, identificação dos períodos, descrição integral nas tabelas e indicação explícita de dados indisponíveis. Gráficos apresentam apenas os registros recebidos e indicam seu limite. A janela deve estar permitida no navegador.

Validado no Microsoft Edge/Chromium instalado no Windows. Outros motores de impressão podem interpretar de forma diferente páginas nomeadas e caixas de margem CSS; revisar a prévia nesses navegadores antes de distribuir. O diálogo de impressão permite ao usuário alterar as configurações do documento.

## Verificação focada

```powershell
node --import tsx --test tests/export-premium.test.ts tests/executive-ui.test.ts
node --import tsx tests/export-popup.ts
npm run typecheck
npm run lint
npm run build
node --import tsx scripts/review-exports.ts
powershell -NoProfile -File scripts/verify-exports-excel.ps1 -Directory "$PWD/outputs/executive-exports"
python scripts/validate-export-artifacts.py
```

Os dois scripts de navegador usam o Microsoft Edge instalado no caminho padrão do Windows e o Playwright existente. A verificação nativa é opcional para reprodução e exige Excel para Windows: abre apenas os arquivos de amostra, em modo somente leitura, com macros desabilitadas e sem atualizar vínculos, e fecha a instância criada pelo script. O validador Python requer `openpyxl`, `pdfplumber` e seu suporte de renderização via `pypdfium2`; são ferramentas de revisão, sem inclusão no aplicativo.

Resultados de 19/11/2026:

- 10 testes focados aprovados, além da interação de abertura da janela de impressão sob CSP; typecheck, lint e build aprovados. A suíte geral não foi repetida.
- Três arquivos XLSX íntegros, XML válido, sem reparo na abertura nativa do Excel; cinco gráficos editáveis no conjunto. Conferência de 2.416 células contra os valores originais, preservando códigos, textos e ausências.
- Cenários com dois e quarenta registros, nomes e descrições extensos, cinco indicadores, negativos, bases zero/negativas, ausências, visita e perdas de mix. Todos os dados são sintéticos.
- PDFs do aplicativo: 5, 29 e 46 páginas. Provas de impressão pelo Excel: 7, 37 e 56 páginas. Todas as 180 páginas renderizadas; verificação automatizada de conteúdo e inspeção visual de páginas representativas. PDFs do aplicativo também verificados quanto a margens, sobreposição de texto, numeração e repetição dos cabeçalhos; elementos HTML sem estouro de largura.
- Arquivos XLSX entre 38.740 e 149.200 bytes; geração observada de 5 a 32 ms nas amostras nesta máquina. Medição local ilustrativa, sem garantia para outros volumes ou dispositivos. Nenhuma biblioteca nova em produção.

## Amostras e publicação

Arquivos disponíveis localmente em `outputs/executive-exports/`, ignorados pelo Git:

| Amostra | Excel | PDF do aplicativo |
| --- | --- | --- |
| Poucos registros | `relatorio-curto.xlsx` | `relatorio-curto.pdf` |
| Muitos produtos e nomes longos | `relatorio-produtos.xlsx` | `relatorio-produtos.pdf` |
| Visita, histórico, mix, perdas e pauta | `visita-comercial.xlsx` | `visita-comercial.pdf` |

`generation.json`, `excel-validation.json` e `validation.json` registram a verificação. `pages/` contém a renderização de todas as páginas. PDFs com sufixo `-excel.pdf` são provas da impressão nativa das planilhas, distintas da exportação PDF do aplicativo.

A branch `feat/executive-exports` deriva de `feat/category-selection` (PR #5); a PR de exportações usa essa base para mostrar somente esta melhoria. Após a aprovação da base, atualizar o destino da PR para `main` e resolver eventual necessidade de rebase antes da revisão final. Publicação depende de aprovação explícita, seguida do processo de release existente para Worker e assets. Esta alteração não exige migrações e não foi implantada em produção.
