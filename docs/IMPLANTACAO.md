# Implantação do Comercial Insight

## 1. Prepare o destino

Use um repositório dedicado no GitHub e um Worker e D1 exclusivos deste aplicativo. O pacote pode ser desenvolvido e publicado diretamente com Wrangler. Os arquivos de ambiente e o estado local estão excluídos pelo `.gitignore`.

O projeto está configurado para **commercial-insight.araujoempresarial.com.br**, Worker `commercial-insight`, D1 `comercial-insight-db` (binding `DB`) e bucket privado `commercial-insight-arquivos` (binding `BUCKET`). Confirme UUIDs em `wrangler.jsonc` e a conta autenticada antes de operar. Os demais portais comerciais utilizam recursos próprios.

A atualização manual e o preparo do PBIX estão em [ATUALIZACAO-DADOS.md](ATUALIZACAO-DADOS.md). A migração é aditiva; registre um ponto de recuperação e mantenha backup privado antes de aplicá-la em produção. O cron de minuto processa checkpoints e o cron diário mantém a limpeza existente.

**Autentique o Wrangler na sua conta.**

```bash
npx wrangler login
```

**Confira a conta e as permissões selecionadas.**

```bash
npx wrangler whoami
```

**Crie o banco dedicado.** Se já existir um banco criado especificamente para este projeto, use o seu identificador.

```bash
npx wrangler d1 create comercial-insight-db
```

Em `wrangler.jsonc`, substitua o UUID de exemplo em `d1_databases[0].database_id`. Mantenha o binding `DB` e o diretório `migrations`. Se a CLI oferecer escrita automática, confira que há apenas um binding `DB`.

Defina `vars.APP_ORIGIN` com a origem HTTPS final sem barra no fim. Acrescente a propriedade abaixo no objeto principal para o domínio escolhido. O modo local exige que `APP_ORIGIN` seja `http://localhost:8787`. Após configurar o arquivo para produção, esse valor local também pode ser definido em `.dev.vars`.

```json
"routes": [
  { "pattern": "commercial-insight.araujoempresarial.com.br", "custom_domain": true }
]
```

**Aplique as migrações no novo banco remoto.** Confira o nome e o UUID exibidos pela CLI antes de confirmar a operação.

```bash
npm run db:remote
```

**Crie o primeiro administrador no banco remoto vazio.** Use um e-mail corporativo real e armazene a senha exibida em local privado.

```bash
npm run admin -- anderson@example.com "Anderson de Araujo" --remote
```

## 2. Prepare as credenciais

| Nome | Valor | Uso |
| --- | --- | --- |
| `MS_CLIENT_SECRET` | Valor do segredo do registro empresarial no Microsoft Entra | Troca e renovação de tokens Microsoft. |
| `TOKEN_ENCRYPTION_KEY` | 32 bytes aleatórios em Base64 | Proteção AES-GCM dos tokens Microsoft no modo delegado. A troca desta chave requer novos vínculos. |
| `OPENAI_API_KEY` | Chave de projeto da OpenAI | Interpretação das perguntas e dos resultados. |
| `OPENAI_MODEL` | Identificador do modelo habilitado na conta | Variável pública de configuração do Worker. O modelo deve aceitar Responses API e Structured Outputs. |
| `RESEND_API_KEY` | Chave do provedor de e-mail Resend | Envio do link de recuperação. |
| `MAIL_FROM` | Remetente do domínio verificado no Resend | Endereço usado na recuperação de senha. |

**Gere a chave de criptografia em seu terminal privado.** Mantenha o valor no gerenciador de segredos da empresa.

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

**Cadastre cada segredo usando o prompt protegido do Wrangler.** Os comandos abaixo enviam os valores para o Worker `commercial-insight`. Na primeira implantação, a CLI pode pedir para criar o Worker com esse nome. O segredo deve ser digitado no prompt, sem integrar o comando ou o Git.

```bash
npx wrangler secret put MS_CLIENT_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MAIL_FROM
```

O hashing de senhas utiliza scrypt com N=32768, r=8, p=3 e salt aleatório. Dimensione o plano de Workers com CPU suficiente para os logins. Homologue o consumo no plano de produção e as cotas de D1, Microsoft e OpenAI sob a concorrência esperada. [Limites do Cloudflare Workers](https://developers.cloudflare.com/workers/platform/limits/)

## 3. Publique

**Compile e faça um ensaio da publicação.** O dry run empacota o Worker e os assets no seu computador.

```bash
npm run build
npx wrangler deploy --dry-run
```

**Publique o Worker e a interface no domínio configurado.** O script verifica o UUID do banco e a origem HTTPS e recompila o projeto.

```bash
npm run deploy
```

Entre no domínio com o administrador criado na base remota. Altere sua senha em **Meu perfil**. Use **Equipe e permissões** para incluir os demais usuários.

## 4. Autorize o modelo semântico

No Entra, crie ou selecione um registro de aplicativo empresarial de locatário único. Guarde o **Directory (tenant) ID** e o **Application (client) ID**. No Power BI Service, identifique o **workspace ID** e o **semantic model ID**. O identificador de um relatório visual pode ser diferente do identificador do modelo.

Habilite a configuração de locatário **Dataset Execute Queries REST API** para o grupo pertinente. A identidade utilizada para a consulta precisa ter acesso ao modelo e permissões de leitura e Build. Escolha o modo conforme a segurança do modelo. [Execute Queries In Group](https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/execute-queries-in-group)

| Modo | Configuração empresarial |
| --- | --- |
| Delegado, indicado para modelos com RLS/SSO | Adicione a permissão delegada Power BI Service `Dataset.Read.All`. Registre como URI de redirecionamento do tipo **Web** a origem seguida de `/api/microsoft/callback`. Conceda o consentimento exigido pela política empresarial. Cadastre o **Object ID do usuário no tenant** no perfil do Comercial Insight. Cada usuário entra por e-mail e senha e vincula a própria identidade em **Meu perfil**. |
| Aplicativo, para modelo compatível sem RLS e sem SSO | Habilite o uso das APIs por service principals na configuração de tenant pertinente. Autorize o principal/grupo no workspace e no modelo com as permissões necessárias à consulta. O Worker solicita token por `client_credentials`. |

No modo delegado, associe usuários de negócio aos papéis de RLS corretos e teste com a identidade de um visualizador. Papéis administrativos, de membro ou de contribuidor do workspace podem possuir acesso mais amplo. Para desenvolvimento delegado, registre também `http://localhost:8787/api/microsoft/callback`. Políticas de consentimento, MFA e acesso condicional continuam a cargo do tenant. O token de renovação é cifrado no D1 e o usuário pode desconectar a conta. [Fluxo de autorização Microsoft](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) · [Segurança em nível de linha no Power BI](https://learn.microsoft.com/en-us/fabric/security/service-admin-row-level-security)

### Mapeamento em Administração → Integrações

1. Informe os quatro IDs, a forma de autorização e a tabela fato de vendas utilizada para identificar movimentos.
2. Para cada dimensão, informe o nome simples da tabela e da coluna publicada. A data deve ser diária, tipada como data, com relacionamento ativo com o fato. Use uma chave textual única para o cliente, como código e razão social. As listas de escopo dos usuários devem usar exatamente a mesma chave. A regional, o produto e a categoria também devem filtrar a tabela fato.
3. Informe o nome da medida publicada de faturamento. Margem, compradores e devoluções são opcionais. Informe apenas o nome da medida, sem colchetes. Faturamento e devoluções monetárias são apresentados em reais. O indicador de devoluções pressupõe montantes positivos cuja redução é favorável.
4. Escolha a escala da margem. Uma medida que retorna `0,2072` e aparece no relatório como 20,72% utiliza **fração**. Uma medida que retorna `20,72` utiliza **percentual**.
5. Confira a propagação de filtros para as medidas, inclusive medidas com `ALL`, `REMOVEFILTERS`, tabelas agregadas ou relacionamentos inativos. Comprove que clientes homônimos, chaves ausentes e totais devolvem apenas os movimentos autorizados. Só então habilite a confirmação de medidas revisadas para liberar contas restritas.
6. A autorização empresarial do envio de dados à OpenAI é controlada em campo próprio. A API usa `store:false`. Revise as condições contratuais de tratamento e retenção do fornecedor, a finalidade e os dados incluídos nas perguntas. [Documentação oficial da OpenAI](https://developers.openai.com/api/reference/resources/responses/methods/create)
7. Salve e consulte **Relatórios**. Replique o mesmo mês, regional e cliente no relatório original e compare as medidas. Os totais consideram a lógica do modelo, inclusive descontos ou devoluções somente quando incluídos na medida mapeada.

A configuração tem revisão. Ao salvar uma nova revisão, as consultas e os vínculos antigos ficam segregados. Contas delegadas precisam se vincular novamente. O horário de consulta na interface identifica a execução da consulta. A atualização dos dados no modelo continua seguindo a rotina de refresh do Power BI.

## 5. Escopo, histórico e retenção

| Papel | Escopo aplicado no servidor |
| --- | --- |
| Administrador | Nacional e administrativo. |
| Diretoria | Regional e/ou carteira autorizada, ou nacional quando o administrador habilita essa opção. |
| Gerente Regional | Exige uma ou mais regionais. Se também houver clientes autorizados, aplicam-se ambas as condições. |
| Usuário Comercial | Exige clientes ou regionais autorizados. Quando há duas listas, elas são cumulativas. |

O Worker valida o plano estruturado da IA e compila DAX a partir do catálogo autorizado. Texto livre do usuário ou da IA não é executado como consulta. A tabela de fatos verifica a existência de movimentos no período antes de exibir as medidas. Os filtros de segurança envolvem o total e os detalhes, incluindo o ano anterior. A integração solicita apenas uma tabela e verifica erros inclusive quando o Power BI retorna HTTP 200 com resultado parcial.

As sessões usam cookie HttpOnly, SameSite=Lax e Secure em produção, expiram após oito horas e após uma hora sem uso da API. O servidor verifica a origem das mutações. As senhas são armazenadas por derivação criptográfica. Tokens de recuperação têm uso único e prazo de 20 minutos. Alterar senha invalida sessões. Alterar o cadastro de acesso revoga sessões e o vínculo Microsoft e segrega o histórico anterior.

O D1 guarda perguntas, plano de consulta, interpretação e uma impressão digital dos resultados. Ao reabrir uma resposta, o usuário consulta o modelo novamente. Se os dados mudaram, a interface mostra os valores atuais e permite solicitar nova interpretação. O navegador mantém dados comerciais apenas em memória. O cache da PWA contém recursos públicos de interface.

A rotina diária remove conversas inativas e registros de auditoria conforme `RETENTION_DAYS` (padrão de 90 dias, ajustável de 1 a 365). Também elimina sessões, vínculos de autorização temporários e tokens de recuperação expirados. A equipe responsável define finalidade, base aplicável, prazos, acesso administrativo e atendimento a solicitações de titulares conforme o contexto da empresa. A automação n8n e o armazenamento de arquivos em R2 ficam disponíveis como evoluções de arquitetura.

## 6. Aceite no ambiente da empresa

| Conferência | Evidência esperada |
| --- | --- |
| Login, logout e recuperação | Usuário entra por senha, recebe a mensagem no remetente autorizado, redefine a senha e o link não funciona uma segunda vez. |
| Modelo e totais | Uma regional e um cliente conferem com o Power BI em dois períodos homólogos. Margem e compradores conferem também no total. |
| Isolamento | Dois usuários de escopos diferentes consultam seus dados. Pedir uma entidade fora do escopo gera bloqueio ou conjunto vazio conforme a política aplicada. |
| RLS/SSO | Login delegado de conta real, conforme as permissões do workspace. Compare o resultado com o do mesmo usuário diretamente no Power BI Service. |
| Chat e histórico | Pergunta sobre cliente gera resultado, gráfico e ações. Ao alterar um escopo, sessões e acesso ao histórico anterior são revogados. |
| PWA e atualização | Instalação no Android, Safari iOS e computador. Verifique abertura, atualização, rolagem e modo offline em aparelho físico. |
| Domínio | HTTPS válido, certificado ativo, login funcionando no hostname configurado e nenhum segredo no repositório. |

### Diagnóstico rápido

| Sintoma | Verificação |
| --- | --- |
| “Origem da solicitação não autorizada” | Confirme esquema, hostname e porta em `APP_ORIGIN`. |
| Power BI recusou o acesso | Confira Execute Queries, identidade do modo escolhido, leitura/Build e políticas do workspace. |
| O vínculo com a Microsoft falhou | Confira URI de redirecionamento, Object ID do usuário no tenant, segredo e consentimento. |
| Falha na consulta ao modelo | Confira nomes de tabelas, campos, medidas, tipo das medidas e compatibilidade do modelo com Execute Queries. |
| Sem base comparável | Confirme existência de dados nos dois períodos, filtros e indicador. Uma base anterior zero impede variação relativa. |
| Quedas após alterar o cadastro | Confira as listas regionais e de clientes. O resultado usa sua interseção. |
| Recuperação solicitada, e-mail ausente | Confira o domínio e remetente no Resend, a caixa de spam e o evento de auditoria `email_falhou`. |
