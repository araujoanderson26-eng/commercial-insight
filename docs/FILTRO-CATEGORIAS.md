# Filtro avançado de categorias

Branch de revisão, sem deploy, migração ou chamadas pagas OpenAI.

## Classificações oficiais

Investigação somente leitura do manifesto Panizzon 1.0.3 e da cópia local D1 já conciliada. O vínculo existente é `Faturamento[Grupo Item]` → `ci_native_sales.category`; há grupos próprios `PA - GRANEL` e `PA - SUCO CONCENTRADO GRANEL`. Não existe um único valor universal “Granel” nesse campo.

Também existe `Base Produtos[Macro Categoria]`, com SUCO, VINHO, ESPUMANTE, VINHO IMPORTADO, VINHO GRANEL, VINAGRE GRANEL e classificações específicas de concentrados, entre outros valores reais. `Faturamento[Código do item]` e `DEVOLUÇÃO[Código do item]` têm relações ativas unidirecionais com `Base Produtos[Codigo Item]`. A implementação consulta esse cadastro raw já importado, sem mudar o Preparador, a projeção, o PBIX ou os mapeamentos existentes. Não se classificam produtos por descrição.

No seletor, macros aparecem qualificadas como `Macro Categoria: SUCO`; os outros valores são os grupos de item. Para sucos/vinhos sem granel: incluir as macros desejadas e excluir os grupos de Granel. É possível selecionar apenas os grupos Granel, combinar listas, pesquisar, marcar todas ou limpar cada modo. As exclusões prevalecem. Seleção vazia significa todas, sem restrição adicional; o filtro antigo de categoria permanece compatível com favoritos/histórico.

SUCO não é automaticamente sinônimo de todas as classificações de suco concentrado; VINHO não inclui implicitamente VINHO IMPORTADO ou VINHO GRANEL. O catálogo mostra os valores reais para seleção explícita. Não há booleano universal de granel nem hierarquia oficial única cobrindo esses dois campos: uma família comercial mais ampla precisa de classificação aprovada por código de produto, incluindo vínculo de família e flag de apresentação a granel. Não foi inventada essa hierarquia.

## Consultas e segurança

Campos opcionais `categoriesInclude` / `categoriesExclude` no plano tipado. Dentro da inclusão vale OU; exclusões subtraem do conjunto; período, representante, regional, cliente, produto e ACL continuam cumulativos. Grupos de item seguem o caminho original de filtro pelo fato de vendas e clientes para devoluções; Macro Categoria filtra os dois fatos pelo cadastro de produto, preservando também a propagação por clientes existente. Valores nulos de produto permanecem fora de listas de exclusão de macros conhecidas. O mapeamento de macros é materializado por consulta para evitar pesquisar o cadastro por cada fato.

O mesmo plano é usado em cards, dashboard, gráficos, rankings, relatórios, visitas e favoritos/histórico. Excel registra o plano completo; Excel da visita e contexto impresso/PDF exibem as categorias. O relatório devolvido pelo backend inclui as listas efetivamente aplicadas.

O assistente recebe os novos campos no schema estruturado e preserva listas ativas e contexto. Termos sucos/vinhos/espumantes são resolvidos contra valores oficiais de macro dentro do catálogo autorizado; Granel expande somente para grupos oficiais encontrados, sem pesquisa em nomes de produto. Nomes inexistentes ou ambíguos são recusados. Nenhuma chamada paga foi necessária para testar isso.

A fonte Power BI direta e o pacote legado suportam listas no campo category já mapeado. Macros qualificadas são recusadas nessas fontes, que não têm vínculo de macro no contrato configurado; nunca são ignoradas silenciosamente. O seletor de catálogo usa as opções D1 existentes; a fonte direta sem catálogo não oferece descoberta de novas categorias. Para macros nessa fonte, é necessário aprovar um vínculo explícito de Macro Categoria no contrato, sem inferir ou substituir o campo category atual.

## Validação e publicação

Testes específicos: inclusão, exclusão, sobreposição, filtro composto com ACL/produto, macros em ambos os fatos, catálogo por escopo e resolução de termos sem invenção. Regressões focadas das consultas nativas, assistência, API comercial e DAX. Interface testada isoladamente em desktop/celular para pesquisa, seleção, alternância de modos, limpar e marcar todas; sem dados comerciais reais no navegador de teste. Typecheck e lint executados.

Antes de publicar: revisar a PR e homologar os grupos/macros reais com o responsável comercial, especialmente os concentrados e a definição abrangente de Granel. Após autorização de deploy, executar um build e publicar Worker/assets em janela controlada. Não há migrações. Validar consultas com e sem listas, comparação homóloga e exports no ambiente autorizado. Não remover guardas de IA, reservas ou permissões. Nenhum dado comercial ou credencial foi incluído na PR.
