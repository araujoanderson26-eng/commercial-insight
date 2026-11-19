# Comercial Insight — Inteligência Comercial com IA

**Desenvolvido por Anderson de Araujo**

A evolução 2.0 está documentada em [Entrega e limites de homologação](docs/ENTREGA-2.0.md), [Manual do usuário](docs/MANUAL-USUARIO-2.0.md) e [Administração](docs/ADMINISTRACAO-2.0.md). A publicação de produção exige aprovação; a configuração isolada está em `wrangler.hml.jsonc`.

Aplicativo web instalável para consultar snapshots comerciais no D1 ou um modelo semântico no Power BI Service e interpretar seus resultados em português. O projeto reúne frontend React, API Cloudflare Workers, banco D1 e arquivos privados R2 no mesmo domínio. Login, consultas e conversas precisam do Worker e do banco.

A rotina do operador está no [Manual de atualização semanal](docs/MANUAL-ATUALIZACAO-SEMANAL.md). Instalação do preparador Windows, restauração e limites semânticos estão em [Atualização de dados](docs/ATUALIZACAO-DADOS.md). A tela administrativa usa `/admin/atualizacao-dados`. O modo manual usa o login próprio e só publica depois de validar integralmente o pacote. Os resultados do aceite real devem ser conferidos no relatório de integração da entrega.

## Primeira execução no computador

Use o terminal do VS Code dentro da pasta que contém `package.json`. Os comandos funcionam no Git Bash do Windows, macOS e Linux. Use Node.js 22.13 ou superior e npm.

**1. Instale as versões registradas no projeto.**

```bash
npm ci
```

**2. Crie as tabelas na instância local do D1.**

```bash
npm run db:local
```

**3. Cadastre o primeiro administrador na base local vazia.** Troque o e-mail de exemplo pelo seu. O comando gera uma senha aleatória e a apresenta uma única vez. Guarde-a para o primeiro acesso.

```bash
npm run admin -- anderson@example.com "Anderson de Araujo" --local
```

**4. Compile o aplicativo e inicie o Worker local.** A opção `--local` usa o banco desta máquina.

```bash
npm run dev
```

Acesse **http://localhost:8787** no mesmo computador. Para que o navegador envie os formulários, use exatamente a origem definida em `APP_ORIGIN`. Entre com o usuário criado e altere a senha em **Meu perfil**. O aplicativo abre com os atalhos comerciais e o estado real da integração. Para consultar o Power BI localmente, copie `.dev.vars.example` para `.dev.vars`, preencha as credenciais na sua máquina e reinicie o Worker. O frontend recompila ao executar `npm run dev` novamente.

## Como usar

| Área | Operação |
| --- | --- |
| Início | Saudação em horário de Brasília, campo de pergunta, seis atalhos e indicadores do recorte ativo. |
| Filtros | Selecione o primeiro e o último mês, regional, cliente ou produto. Os nomes devem corresponder à dimensão publicada. O padrão utiliza os seis meses completos anteriores. |
| Conversas | Faça perguntas como “Quais clientes mais perderam faturamento?”. A resposta combina totais calculados pelo modelo, gráfico, interpretação e ações. Perguntas subsequentes podem referenciar as três últimas consultas. |
| Histórico | No modo manual, reabra os valores da versão original. O servidor reaplica as permissões atuais. A fonte online reconsulta o modelo e reutiliza a interpretação apenas quando os valores coincidem. |
| Relatórios | Alterne indicador, agrupamento, gráfico e tabela. A evolução mensal compara períodos homólogos. Rankings exibem até 30 resultados. |
| Carteira e produtos | Consulte rankings e clique no cliente, produto ou regional para analisar sua evolução mensal. |
| Preparar visita | Selecione um cliente e obtenha uma pauta baseada no histórico disponível. |
| Alertas e ações | Veja quedas, avanços e variações de margem. Clique em um sinal para discutir o recorte com a IA. Os alertas são calculados ao consultar a tela. |
| Equipe e permissões | O administrador cria usuários, define papel e escopo, ajusta o vínculo Microsoft, altera a senha ou desativa a conta. |
| Integrações | Informe IDs e nomes exatos do modelo. A tela informa quais segredos já foram cadastrados, sem exibir seus valores. |
| Atualização de dados | Selecione a fonte, envie o pacote completo, acompanhe validações e restaure uma versão anterior. Exclusivo de administradores. |
| Auditoria | Eventos recentes de acesso, consulta, alteração de usuário e configuração. |

Os indicadores e dimensões disponíveis dependem da fonte. O contrato nativo Panizzon separa faturamento bruto, devoluções e faturamento líquido e calcula clientes distintos; representante, regional, gerente e UF dependem dos campos comprovados. No modo online, os valores vêm das medidas do modelo. No modo manual, apenas implementações explicitamente mapeadas e reconciliadas são calculadas no D1. O formato legado de um fato continua aceito. Margem, estoque, litros, metas e medidas especiais exigem implementação e aceite específicos. A variação da margem aparece em pontos percentuais; rankings por ganho ou queda usam diferença absoluta.

## Publicação e integrações

O roteiro em [docs/IMPLANTACAO.md](docs/IMPLANTACAO.md) cobre Cloudflare, domínio, D1, cadastro administrativo, Microsoft Entra, Power BI, OpenAI, e-mail, permissões e testes de aceite com dados reais.

## Arquitetura do projeto

| Local | Conteúdo |
| --- | --- |
| `src/` | Interface React e TypeScript, Inter local, gráficos Recharts, Tailwind CSS e ícones Lucide. |
| `shared/` | Contratos, papéis, métricas, filtros e implementação de hash de senha utilizada pelo servidor e pelo cadastro inicial. |
| `worker/` | API REST, sessões, recuperação, controle de escopo, Microsoft OAuth, compilação DAX, OpenAI e retenção. |
| `migrations/` | Migrações incrementais do D1. |
| `public/`, `scripts/` | Identidade visual, vinhedo, telas de abertura, manifesto, cabeçalhos e geração do service worker. |
| `tests/` | Testes de períodos, permissões, respostas, contrato DAX, fluxo OAuth e API integrada com SQLite e provedores controlados. |
| `wrangler.jsonc` | Configuração do Worker, assets, vínculo D1 e limpeza agendada. |

**Execute os testes automatizados com Node.**

```bash
npm test
```

**Valide os tipos e compile o frontend de produção, incluindo o service worker.**

```bash
npm run build
```

## Instalação como aplicativo

No Android e nos navegadores desktop compatíveis, abra o endereço HTTPS publicado e use a opção do navegador para instalar o aplicativo. No iPhone ou iPad, abra o endereço no Safari, toque em Compartilhar e em **Adicionar à Tela de Início**. A atualização da interface aparece como **Atualizar agora** quando houver uma nova versão pronta. Sem internet, a abertura exibe o estado desconectado. As consultas comerciais exigem conexão.

## Validação da entrega

O estado de testes, implantação e pendências da atualização manual está em [Relatório de validação](docs/VALIDACAO-ATUALIZACAO-DADOS.md). Execute `npm test`, `npm run typecheck`, `npm run build` e `npm run test:ui` (Edge Windows ou `UI_SMOKE_BROWSER` com o executável Chromium). Nenhum teste sintético comprova a equivalência do modelo Panizzon real.

O login independente, as migrações e o cadastro inicial foram executados em D1 local com Wrangler. Os testes de contrato usam respostas controladas de Microsoft, Power BI, OpenAI e e-mail. A conferência contábil de uma medida, a validação de RLS com usuários da empresa, a entrega de e-mail pelo remetente real e a instalação em aparelhos físicos fazem parte da homologação da empresa.
