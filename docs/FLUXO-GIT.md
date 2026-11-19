# Git, validação e publicação

`main` é a branch consolidada. Alterações entram por Pull Request, com histórico preservado e revisão dos resultados antes do merge. A branch `feat/manual-powerbi-d1` registra a integração manual e o Preparador 1.0.3; a tag `preparador-v1.0.3` e os arquivos da release são preservados.

O workflow **Validate project** verifica build e tipos, lint, testes da API e do Preparador no Windows, interface desktop/mobile com dados sintéticos, vulnerabilidades npm/NuGet e segredos no histórico Git. As Actions e o scanner têm versões fixadas. O workflow tem somente leitura do repositório e não faz deploy, migrações ou consultas ao D1 remoto.

Os pacotes comerciais, modelos Power BI, configurações secretas, relatórios privados e artefatos de compilação ficam fora do Git. O único pacote de exemplo versionado é explicitamente sintético. Revisar o conteúdo de cada arquivo novo antes de publicar; o scanner de segredos não detecta todos os tipos de dado comercial.

## Atenção ao merge em `main`

O Worker possui integração externa **Cloudflare Workers Builds**, configurada para executar `npm run build` e `npx wrangler deploy` após pushes em `main`. O workflow GitHub de validação não controla esse gatilho.

Quando uma consolidação Git não autorizar deploy, registrar a configuração atual, excluir temporariamente `main` do gatilho externo, verificar a exclusão antes do merge, confirmar que nenhum build foi iniciado e restaurar a configuração original. Conferir também que a versão ativa do Worker permaneceu igual. Não aplicar migrações nem modificar D1/R2 durante essa operação. Nas próximas alterações, o gatilho restaurado volta a publicar automaticamente; considerar esse efeito antes de cada merge.

Instalações e atualizações do Preparador seguem o [manual operacional](MANUAL-ATUALIZACAO-SEMANAL.md). A consolidação Git não altera a instalação local, seu mapeamento ou os dados de produção.
