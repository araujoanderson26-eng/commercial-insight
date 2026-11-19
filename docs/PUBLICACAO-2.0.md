# Publicação 2.0 — procedimento autorizado

O titular autorizou merge da PR #2 e publicação em 19/11/2026. A ativação contínua paga da OpenAI permanece fora desta autorização.

## Proteção e alvo

Usar `wrangler.jsonc`, Worker `commercial-insight`, D1 `5b333eba-7ace-4182-aa76-0d0f591a4ad6`, R2 `commercial-insight-arquivos` e Queue `commercial-insight-manual-jobs`. Não reutilizar recursos de homologação. Evidências operacionais e bookmark ficam em `.wrangler/prod-release-2`, fora do Git.

Preservar o bookmark D1 antes das migrações, a versão anterior do Worker e a configuração de domínio, R2, Queue, secrets e gatilhos. A configuração de builds conectada à `main` deve ser suspensa durante o merge e restaurada ao terminar, evitando deploy anterior às migrações.

A migração necessária é `0006_commercial_workspace.sql`: adiciona `update_only` com padrão zero e cria favoritos vazios. Não altera senhas, perfis existentes, fatos, snapshots ou mapeamentos. As migrações 0007–0009 são auxiliares de ensaios HML e não são necessárias ao runtime de produção sem suas flags. Para aplicar apenas 0006 com tracking do Wrangler, usar cópia operacional das migrações 0001–0006 e configuração derivada que mantenha o UUID de produção; o deploy usa o arquivo original `wrangler.jsonc`.

## Reversão

Em falha crítica de aplicação, retornar primeiro ao Worker anterior, que é compatível com a migração aditiva:

```powershell
node node_modules/wrangler/bin/wrangler.js rollback 79cfb2e8-294a-4778-8b33-f008176449a5 --config wrangler.jsonc --yes --message "Rollback da publicação 2.0"
```

Não apagar tabelas nem remover a coluna adicionada. O rollback de Worker não reverte o banco. O bookmark anterior permite recuperação D1 caso haja corrupção comprovada, mas uma restauração integral pode apagar gravações posteriores: preservar primeiro o estado corrente, suspender alterações e avaliar as gravações que precisam ser reconciliadas. Não usar restauração D1 para corrigir apenas uma falha visual.

## OpenAI e validação

Manter `allow_ai=0`. Não copiar chave HML. Se faltar o secret de produção, cadastrá-lo com entrada interativa segura, sem valor no chat ou em argumentos:

```powershell
node node_modules/wrangler/bin/wrangler.js secret put OPENAI_API_KEY --config wrangler.jsonc
```

O cadastro do secret publica uma nova versão; só executar em janela autorizada. Aprovar política de dados, modelo, teto de gasto, limites operacionais e primeiro teste finito antes de habilitar chamadas. O controle monetário HML não representa orçamento de produção. Não afirmar IA operacional apenas pela presença da chave.

Após o deploy, conferir domínio e versão, autenticação, indicadores reduzidos já conciliados, cliente/produto, visita, exportações, histórico, favoritos e ACL. Sessões de prova devem ser curtas, individuais e removidas pelo hash exato; não alterar senha nem excluir sessões existentes. Perfis ausentes em produção devem ser declarados como cobertura local, sem criar usuários apenas para essa prova. A limpeza diária HML de 20/11/2026 às 01h17 de Brasília permanece pendente até evidência real.
