# Commercial Insight 2.0 — Manual de uso

Desenvolvido por Anderson de Araujo.

## Consultar seu resultado

Em **Relatórios**, escolha indicador e agrupamento. Abra **Filtros** para selecionar período, representantes autorizados, regional, UF, gerente, cliente, produto e categoria disponíveis na fonte. A aplicação respeita a carteira autorizada mesmo quando um filtro fica vazio.

Os cards separam faturamento bruto, devoluções e líquido. Líquido corresponde a bruto menos devoluções uma única vez. Clientes compradores é uma contagem distinta. O ticket apresentado é o faturamento líquido por cliente comprador, sem equivaler ao valor médio por pedido.

Confira as datas efetivas, a extração e a versão da base. Períodos incompletos são comparados até o mesmo dia do ano anterior. Base anterior negativa ou zero não gera um percentual convencional de crescimento. Campos indisponíveis aparecem sem valor. As cores consideram o significado do indicador: aumento de devoluções exige atenção.

As linhas de um ranking podem se sobrepor por relações comerciais muitos-para-muitos; o total é calculado separadamente. Atribuição atual de carteira não prova que o responsável era o mesmo no ano anterior.

## Explorar clientes e produtos

Clientes e produtos apresentam **código — descrição** quando existe um cadastro único comprovado. O código é preservado, incluindo zeros à esquerda. Clique em um item para detalhar sua evolução usando esse código. Descrições conflitantes não são escolhidas automaticamente.

A pesquisa no ranking filtra os resultados exibidos. A pesquisa de cadastro nos filtros e em **Preparar visita** consulta os registros autorizados, incluindo cadastros fora dos primeiros resultados. Quando houver nomes semelhantes, selecione o código correto. Rankings sinalizam quando o resultado está limitado aos primeiros 30 registros.

## Preparar uma visita

1. Abra **Preparar visita** e pesquise o nome ou código do cliente.
2. Escolha o cadastro correto. Ajuste o período nos filtros.
3. Clique em **Preparar visita**.
4. Confira a identificação disponível, indicadores, evolução, mix, riscos observados, perguntas e próximos passos.
5. Use **Excel** para baixar as tabelas ou **PDF / Imprimir** e escolha **Salvar como PDF** no navegador.

O briefing funciona sem OpenAI: usa consultas e regras comerciais controladas. Sem movimento no período, informa essa limitação e não inventa compras. A frequência disponível é mensal; última compra diária e município podem estar indisponíveis. Estoque, preços, reclamações e negociações não são inferidos.

## Conversar e pedir análises

O chat requer autorização da fonte e uma credencial OpenAI válida. Se estiver indisponível, a tela indica as pendências. Relatórios e visitas determinísticas continuam disponíveis quando a base está publicada.

Exemplos para uma fonte e período autorizados:

- “Como está meu resultado comercial?”
- “Como está São Paulo?” e depois “Quais produtos explicam a maior queda?”
- “Prepare um relatório dos clientes que mais perderam faturamento.”
- “Vou visitar o cliente [código real]. Prepare minha reunião.”
- “Compare setembro de 2025 com setembro de 2026.”

Confira os filtros e datas retornados em cada resposta. A conversa considera os planos anteriores; pedidos ambíguos ou fora das capacidades disponíveis pedem uma seleção mais específica. Produtos ou categorias semelhantes exigem desambiguação. Uma resposta não comprova causas de perda: hipóteses e recomendações precisam ser confirmadas com o cliente.

## Salvar e exportar

Em **Relatórios**, dê um título e salve a consulta. Os favoritos preservam indicador, agrupamento, ordem e filtros. Ao reabrir, os resultados são consultados novamente com suas permissões atuais. A consulta salva não é uma cópia congelada dos números. Uma mudança de permissão pode tornar itens antigos indisponíveis.

O arquivo Excel é `.xlsx`, com códigos tratados como texto, tabelas e contexto da fonte. Valores indisponíveis ficam em branco. **PDF / Imprimir** usa a impressão do navegador. O histórico de conversas manuais reabre a versão original e reaplica as permissões atuais; briefings são recalculados antes da exibição.

## Quando precisar de ajuda

Envie ao administrador a tela, período, filtros, indicador e versão da base. Esses dados permitem reproduzir uma diferença. Sem o recorte original, dois números isolados não identificam a causa. Não envie credenciais nem pacotes comerciais em canais públicos.
