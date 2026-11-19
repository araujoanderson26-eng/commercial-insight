# Commercial Insight 2.0 — Homologação isolada

Estado em 19/11/2026. O titular conferiu manualmente **Workers Paid**, **R2 Paid** e **US$ 0 de consumo faturável adicional no período consultado**, dispensou repetir a checagem por Billing Read e autorizou criar os três recursos e implantar somente o Worker de homologação. Essa é a origem da conferência financeira; não é uma atestação de Billing API nem garantia de franquias ilimitadas.

## Ambiente efetivamente criado

URL: **https://commercial-insight-hml.araujo-anderson26.workers.dev**

| Recurso | Identificação e estado |
| --- | --- |
| Conta Cloudflare | `433083d760ae0e02f3962044e6f2152f`, conferida antes das operações. |
| Worker | `commercial-insight-hml`, versão inicial `495610c1-76c4-4c76-92ce-3af80a189b13`, implantação em 19/11/2026 às 07:40, horário de Brasília. |
| D1 | `commercial-insight-hml-db`, UUID `9717c220-a4b4-4fad-8183-f2b733787b61`, região ENAM, replicação desativada. |
| R2 | `commercial-insight-hml-arquivos`, Standard, região ENAM; r2.dev desabilitado e nenhum domínio público. |
| Queue | `commercial-insight-hml-jobs`, ID `c7b810c2c15d4e91b6eeb8af23e0cda8`; produtor e consumidor exclusivos do Worker de homologação. |
| Migrações | As seis migrações, até `0006_commercial_workspace.sql`, aplicadas somente no D1 acima. |
| Credenciais | Administrador e perfis de teste novos e sintéticos; nenhum secret OpenAI/Microsoft/e-mail herdado. |

O rótulo `version: production` retornado pelo serviço D1 identifica a geração do mecanismo; não significa que o banco da aplicação de produção foi usado. Nome e UUID acima são próprios da homologação.

`wrangler.hml.jsonc` fixa a conta e os vínculos separados. A checagem recusa nomes fora da lista e reutilização do UUID D1, bucket ou Queue de produção. A versão de produção permaneceu `79cfb2e8-294a-4778-8b33-f008176449a5`, com deployment `ff760e8f-9cef-42d9-bf76-2b923d990a58`. Não houve merge da PR #2, implantação em produção, cópia de seus usuários/sessões/credenciais ou transferência de informações comerciais reais.

## Acesso e demonstração

Entre com o administrador sintético indicado no arquivo privado **`.wrangler/hml/access.json`**. A senha aleatória não está no Git, no relatório público ou nos logs de teste. Altere-a em Meu perfil ao iniciar o uso humano.

Para ver a demonstração, escolha **janeiro de 2026 até janeiro de 2026** nos filtros. A fonte é explicitamente sintética e cobre 2025-01-01 a 2026-02-01; o período padrão recente pode aparecer sem cobertura. Isso não representa zeros nem dados reais ausentes da empresa.

O pacote possui dez tabelas, 32 linhas raw e 36 controles. Exemplos de conferência sintética:

| Recorte janeiro/2026 | Bruto | Devoluções | Líquido | Compradores |
| --- | ---: | ---: | ---: | ---: |
| Nacional sintético | R$ 350,00 | R$ 1.034,00 | −R$ 684,00 | 2 |
| Cliente sintético `0001` | R$ 150,00 | R$ 15,00 | R$ 135,00 | 1 |

Para `0001`, o líquido anterior é R$ 90,00, a última compra no recorte é 02/01/2026 e há dois dias com compra. Esses valores foram gerados para testar a semântica e não pertencem a um cliente real.

## Testes e evidência

O aceite HTTPS `scripts/hml-verify.ts` passou **12 verificações**, com **87 requisições**, 39.980 bytes de upload e nenhuma falha. Conferiu:

- API anônima recusada, login próprio, cookie Secure/HttpOnly e respostas privadas no-store.
- Importação válida e 36/36 controles aprovados; pacote com KPI divergente reprovado, sem substituir a versão ativa.
- Oito agrupamentos de relatórios, métricas financeiras e identificação por código/descrição.
- Escopo de vendedor/gerente, diretoria nacional, ausência de carteira e pesquisa autorizada.
- Briefing de visita com números, mix e atividade diária conferidos.
- Favoritos por proprietário e restrições do operador de atualização.
- OpenAI desabilitada, ausência de credencial e nenhuma chamada ao modelo.
- Encerramento das sete sessões automatizadas no término.

Evidência privada: `.wrangler/hml/api-verification.json`. Contas sintéticas e duas importações foram conservadas para revisão. Os testes locais continuam aprovados: **82 testes, zero falhas e zero skips**, build, typecheck e lint; tipos de homologação gerados pelo Wrangler.

O aceite no navegador real passou **10 verificações**, sem erros de JavaScript: login, fonte sintética, métricas, código/descrição, Excel, favorito reaberto, preparação de visita, atividade diária, impressão/PDF, apresentação das pendências de IA e logout. Desktop de 1440 pixels e celular de 390 pixels não apresentaram transbordamento horizontal. Os arquivos exportados, capturas e relatório estão em `.wrangler/hml/browser-2026-11-19T10-49-51-741Z/`. Os ajustes necessários foram nos seletores e expectativas do script de teste; não exigiram alteração do Worker publicado.

A conferência final do D1 retornou **zero sessões automatizadas e zero favoritos temporários**, mantendo apenas os sete usuários sintéticos e os pacotes de demonstração. A fila e as execuções agendadas são acompanhadas em [Custos e monitoramento](HOMOLOGACAO-CUSTOS.md); um agendamento cadastrado não é tratado como prova de execução.

## Limites e consumo

- CPU máxima: 10 segundos por invocação; pacote máximo: 16 MiB; orçamento interno estimado D1: 128 MiB.
- Pacotes sem `synthetic=true` recusados antes da ingestão; os dados enviados foram gerados pelo fixture sintético.
- Queue: concorrência um, lote um, duas retentativas, atraso de 30 segundos e retenção de mensagens de um dia.
- Cron de recuperação: `*/15 * * * *`; limpeza administrativa: `17 4 * * *` em UTC, correspondente a 01:17 em Brasília.
- Retenção administrativa: sete dias. Não é exclusão automática de snapshots.
- Logs sem eventos completos de invocação, traces com amostragem de 1%, nenhum Logpush, e-mail ou exportador adicional.

Os limites operacionais não são um teto financeiro global. Não houve contratação de plano ou serviço adicional nem configuração de bloqueios globais. Custos, franquias compartilhadas e limpeza futura estão em [Custos de homologação](HOMOLOGACAO-CUSTOS.md). A evidência financeira de US$ 0 é anterior aos testes; o faturamento final continua no painel da conta.

## Próxima etapa: OpenAI

O ambiente está preparado com `OPENAI_MODEL=gpt-4.1-mini`, mas **sem `OPENAI_API_KEY` e com IA desautorizada na fonte**. Os relatórios e as visitas determinísticas já funcionam sem o modelo.

Na consulta de 19/11/2026, o [catálogo oficial do modelo](https://developers.openai.com/api/docs/models/gpt-4.1-mini) marca GPT-4.1 mini como descontinuado (`Deprecated`). Isso exige conferir a disponibilidade na conta e, se necessário, validar um modelo substituto compatível antes de ativar chamadas. Nenhuma disponibilidade foi presumida ou troca de modelo foi implantada nesta etapa.

O administrador deve usar uma chave própria da homologação e cadastrá-la no prompt protegido do terminal:

```powershell
npx wrangler secret put OPENAI_API_KEY --config wrangler.hml.jsonc
```

Não colocar a chave no comando, no Git ou na conversa. O comando cria uma versão e **a implanta imediatamente**, exclusivamente no Worker de homologação indicado. Nenhuma chave ou projeto OpenAI foi criado automaticamente. Confirmar modelo acessível, orçamento e limites do projeto antes das chamadas reais; depois habilitar IA somente na fonte de homologação. O procedimento financeiro da OpenAI é independente do plano Cloudflare.

No projeto OpenAI exclusivo da homologação, restringir a chave às permissões necessárias à API Responses e configurar modelos, taxas e orçamento em Settings → projeto → Limits. Alertas de gasto apenas notificam; quando disponível e aprovado, `Enforce a hard limit` interrompe o tráfego desse projeto após atingir o gasto acompanhado, com possível atraso de aplicação. Não alterar limites globais ou de projetos usados por outros aplicativos. [Procedimento oficial de projetos, chaves e limites](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform).

O roteiro inicial será: “Como está meu resultado comercial?”, “Quais clientes mais perderam faturamento?”, “Vou visitar o cliente 0001. Prepare minha reunião.” e “Quais produtos explicam a queda?”. Conferir valores, datas, cliente, versão, continuidade e recusa de carteira alheia contra as consultas determinísticas. Chamadas reais geram consumo OpenAI; o custo previsto deve ser informado antes de executá-las.

Inicialmente, perguntas comerciais reais serão executadas sobre a base sintética. Para consultar números reais da empresa, obter autorização específica de dados, escopo e envio à OpenAI e revisar explicitamente o bloqueio de pacotes sintéticos. Não reutilizar automaticamente a base ou a chave de produção.
