# Validação da atualização manual — 18/11/2026

## Escopo entregue

Fonte manual separada do conector Microsoft, preparador externo Windows TOM/ADOMD, pacote versionado UTF-8, upload multipart privado R2, snapshots D1 e ativação atômica com geração. O plano de implementação foi: preservar autenticação e UI; entregar extração e contrato; importar com checkpoints; integrar consultas/IA; validar e publicar.

O catálogo executável inicial suporta soma de valores explicitamente mapeados e clientes distintos sobre um fato. O servidor admite receitas restritas de razão entre somas, mas o preparador não cria margem nem outras métricas sem implementação própria. Todo o inventário original permanece privado no pacote e no D1. O catálogo e os controles são versionados por importação.

## Evidências automatizadas

| Verificação | Resultado |
| --- | --- |
| `npm run lint` | Aprovado, sem avisos |
| `npm run typecheck` | Frontend e Worker aprovados |
| `npm test` | 24 testes aprovados |
| `npm run build` | Aprovado, inclui instruções e ZIP do preparador |
| Wrangler deploy dry run | Empacotamento e bindings conferidos |
| `npm run test:ui` | Edge: login próprio, rota administrativa, duas cargas, publicação, restauração, rejeição de KPI e layout 1440/390 px |
| Preparador Windows | Publish .NET 10 LTS x64 sem avisos; SDK 10.0.404 e runtime 10.0.15 |
| Self-test do preparador | Partes por tamanho/contagem, SHA-256, Unicode, nulos, zeros à esquerda, decimais e rejeição de perda de precisão |
| Scripts PowerShell | Análise sintática sem erros |

Os testes da API e do navegador usam SQLite e R2 controlado, com dados sintéticos identificados; não comprovam limites de CPU ou comportamento de uma carga grande no runtime remoto. As capturas locais ficam em `.wrangler/ui-desktop.png` e `.wrangler/ui-mobile.png`, excluídas do Git.

Os testes verificam checksum/KPI inválidos, arquivos incompletos, datas inválidas, chaves duplicadas, referências ausentes, capacidade antes de inserir linhas, substituição integral, reenvio e lotes repetidos, upload acima de 5 MiB, retomada, cancelamento, concorrência, restauração, isolamento por regional/carteira, papel para acesso nacional, versão fixada durante o chat, histórico com a versão original e autorização da IA. Não há acesso irrestrito da IA a SQL ou DAX.

## Ambiente confirmado e proteção dos dados

- Conta Cloudflare: `433083d760ae0e02f3962044e6f2152f`.
- Worker: `commercial-insight`; origem configurada: `https://commercial-insight.araujoempresarial.com.br`.
- D1: `comercial-insight-db`, UUID `5b333eba-7ace-4182-aa76-0d0f591a4ad6`.
- R2: `commercial-insight-arquivos`, r2.dev desativado e nenhum domínio público associado.
- Antes da migração: 1 usuário, 4 sessões, nenhuma conversa ou turno; backup SQL privado em `.wrangler/pre-manual-migration.sql` e ponto Time Travel registrados localmente.
- Migrations remotas aditivas `0003_manual_data.sql` e `0004_source_activation.sql` aplicadas. Cadastros, senhas e permissões não são substituídos.
- Correções existentes no Worker publicado para Meu workspace e diagnóstico seguro do OAuth foram preservadas ao integrar a cópia local.

O limite inicial é 128 MiB por pacote, manifesto de 1 MiB e estimativa conservadora de 450 MiB no D1, incluindo versões e índices. O Billing API não autorizou consultar o plano; não se declara Free/Paid confirmado. O processamento avança por checkpoints, inicialmente duas partes por minuto e doze controles por etapa de validação. O hash integral é sequencial e usa memória limitada, mas sua CPU com o volume real ainda requer homologação. A retenção atual conserva todos os snapshots; ao atingir o teto, exige manutenção administrativa sem apagar a versão ativa ou a anterior recuperável.

## Publicação e primeira carga

Implantação concluída no Worker `commercial-insight`, versão `7c6ad8a5-ecd3-4710-a68e-0a9124066c48`. Tela publicada: [Administração > Atualização de dados](https://commercial-insight.araujoempresarial.com.br/admin/atualizacao-dados). Ambos os agendamentos foram implantados: processamento por minuto e limpeza diária.

O comando `node scripts/verify-production.mjs --remote` verificou as APIs administrativas com uma sessão temporária de um administrador já existente, removeu essa sessão ao terminar e confirmou 401 para acessos anônimos. Instruções e ZIP do preparador responderam no domínio. Ele não comprova o login por senha do usuário em produção; esse fluxo foi testado localmente. A configuração final seleciona `manual`, sem versão ativa e sem importações reais; há 1 usuário e 4 sessões originais preservadas. Nenhum dado sintético foi publicado.

**Primeira carga real não realizada:** não foi fornecido PBIX no projeto ou no caminho de anexo autorizado. O Power BI Desktop também não estava ativo. Não foram descobertos os nomes, regras, chaves e DAX reais do Panizzon, nem reconciliados seus indicadores comerciais. Dados sintéticos não foram enviados à produção.

Faltam o PBIX atualizado em modo Import, o mapeamento inicial revisado, execução do preparador sobre o modelo real e comparação dos controles essenciais. Litros, quantidade, metas, orçamento, pedidos, estoque, margem e demais medidas especiais permanecem indisponíveis até implementação e validação específicas. Modelos DirectQuery/Dual/thin/live são interrompidos com explicação; não são tratados como tabelas vazias.

A chave OpenAI deve estar cadastrada no Worker e a autorização de IA habilitada na fonte antes de utilizar o chat. A configuração Microsoft permanece independente. Esta entrega não declara o escopo analítico real inteiramente homologado.

## Uso semanal e restauração

Abra o PBIX atualizado, use **Ferramentas externas > Preparar atualização Comercial Insight**, salve o único `.ci.ndjson`, abra **Administração > Atualização de dados**, selecione o pacote e clique em **Enviar e atualizar base**. Aguarde o estado **Publicada**. Para retornar, use **Restaurar esta versão** no histórico; isso troca o snapshot ativo e reaplica os filtros e permissões.

Instruções completas: [ATUALIZACAO-DADOS.md](ATUALIZACAO-DADOS.md).
