# Correção pontual das narrativas

Escopo: resultado nacional, preparação de visita e continuidade por produtos, após o ensaio anterior. Sem nova geração paga, deploy, mudanças de métricas ou permissões.

O código anterior validava resumo e ações juntos: qualquer afirmação recusada substituía todo o conteúdo. As evidências históricas conservam as respostas factuais exibidas e o uso do provedor, mas não permitem afirmar qual frase original ou regra específica provocou cada um dos três bloqueios. Não se atribui retrospectivamente erro numérico, causal ou excesso de validação sem essa prova.

A revisão agora valida frases e ações separadamente e mantém uma segunda validação da resposta combinada. Partes comprovadas permanecem; as demais são omitidas com aviso. Sem conteúdo aproveitável, continuam os fatos calculados. Estrutura inválida, causas comerciais afirmadas sem prova, números sem sustentação e agrupamentos não aditivos conservam o tratamento seguro. Hipóteses podem aparecer como perguntas de verificação, sem se transformar em fatos.

Cada nova resposta revisada inclui metadados `validation` com estado, códigos de motivo e contagem de partes descartadas. Esses metadados são calculados pelo servidor e não incluem textos rejeitados, valores, SQL ou credenciais. Eles distinguem uma resposta parcial de um fallback e permitem diagnosticar futuras rejeições sem logs comerciais. Não reconstituem o texto histórico perdido nem representam uma taxonomia exaustiva de alucinações.

O prompt orienta valores completos, decomposição do líquido, identificação das quedas por produto e frases independentes. O limite de saída, os controles de orçamento e o esquema público de resumo/ações permanecem. A reabertura aplica a mesma revisão sem gravar sobre a resposta original e sem nova geração.

Validação focada: testes do assistente comercial e da reabertura de visitas; tipos do Worker e lint dos arquivos alterados. Há regressões para preservação parcial, causas não comprovadas, perguntas de verificação, valores com milhares/centavos, estrutura inválida, M:M, três cenários, uma única chamada simulada e histórico imutável.

Aceite generativo real continua pendente de autorização própria. Não houve revalidação paga das três narrativas. A suíte completa, auditorias amplas e verificações visuais foram deliberadamente adiadas conforme o escopo desta execução. O commit usa `[skip ci]` para não disparar automaticamente a suíte ampla; sua execução permanece necessária na homologação completa posterior. Nenhum teste ou workflow foi removido.
