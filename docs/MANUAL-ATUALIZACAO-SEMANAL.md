# Atualização semanal — Comercial Insight

Preparador Windows x64 1.0.2 · Desenvolvido por Anderson de Araujo.

## Toda semana

1. Abra no Power BI Desktop o **PBIX atualizado com dados**. Espere a atualização terminar.
2. Em **Ferramentas externas**, clique em **Preparar atualização Comercial Insight**.
3. Aguarde a **extração e validação automáticas**, que usam o perfil já salvo. Não altere nem atualize o modelo durante a preparação.
4. Quando a janela **Salvar** abrir, escolha onde guardar o arquivo **`.ci.ndjson`**, confirme e aguarde a mensagem de conclusão. Use o arquivo final gerado nessa tentativa; um arquivo antigo ou temporário não comprova sucesso.
5. Entre no Comercial Insight como administrador. Abra **Administração > Atualização de dados**, selecione o arquivo e clique em **Enviar e atualizar base**.
6. Aguarde **Base atualizada com sucesso**. Confira responsável, data de publicação, período coberto, quantidade de tabelas e linhas e versão. A área **Base em uso** deve mostrar essa mesma versão.

O envio completo ainda não é a publicação. Depois que o servidor aceitar todas as partes, o processamento continua mesmo com a página fechada. Reabra a tela para acompanhar. Durante a carga, as consultas continuam usando a base anterior.

O perfil já salvo é reutilizado. Não é necessário refazer o mapeamento a cada semana. Se o Desktop for fechado e aberto novamente, inicie o preparador pelo botão do Power BI para receber os parâmetros da sessão atual.

O botão **Preparar atualização** na janela do preparador permite iniciar uma nova tentativa quando necessário.

## Instalar ou atualizar uma vez

Extraia **todo** o ZIP em uma pasta local. Não execute arquivos dentro da visualização do ZIP.

- Se o pacote tiver a pasta **`runtime`**, ele já contém o executável, o .NET e as dependências Microsoft. A instalação confere os arquivos e executa o autoteste; não baixa SDK nem compila no computador do operador.
- Se não houver `runtime`, o pacote contém fontes para desenvolvimento. Ele precisa de internet para baixar o SDK oficial e compilar. Solicite o pacote **Windows x64 pronto** quando não quiser esse procedimento.

Na primeira instalação, execute **Instalar.cmd**. O Windows pede elevação somente para registrar o botão do Power BI. Reinicie o Power BI depois do registro.

Se o preparador já estiver instalado, feche apenas sua janela e execute **Atualizar.cmd**. O PBIX pode continuar aberto. O atualizador prepara a nova versão separadamente, faz o autoteste e guarda a versão anterior. O mapeamento existente é preservado. O botão já registrado continua funcionando.

Use **RepararRegistro.cmd** somente se o botão estiver ausente ou com o nome incorreto. Essa opção pede elevação para reparar o registro e requer reiniciar o Power BI.

## Se aparecer um erro

Não envie um arquivo incompleto para tentar concluir a atualização. Leia a etapa informada e use **Abrir log** no preparador. Os logs ficam em `%LOCALAPPDATA%\ComercialInsight\logs`.

Se o modelo estiver sendo atualizado, espere terminar e tente novamente. Se a mensagem indicar divergência de indicador, relacionamento ou precisão, encaminhe o diagnóstico ao responsável pela integração. Não troque líquido por bruto nem desconte devoluções manualmente.

Uma importação reprovada não substitui a base ativa. O administrador pode consultar os detalhes do histórico ou restaurar uma versão anterior validada em **Atualização de dados**.

## Indicadores e permissões

No contrato nativo Panizzon, **Faturamento bruto**, **Devoluções** e **Faturamento líquido** são indicadores separados; o líquido corresponde à diferença entre os dois fatos. Clientes compradores usa contagem distinta. Os filtros e agrupamentos aparecem conforme os campos comprovados no modelo. Uma métrica ainda não implementada não deve ser interpretada como zero.

O campo **Representantes** de **Equipe e permissões** mantém o escopo de acesso cadastrado. Para um gerente, o administrador informa os representantes autorizados da equipe. Regional, gerente e UF nos relatórios refinam a consulta e não ampliam esse acesso. Use os nomes exatos da origem.

O arquivo `.ci.ndjson` contém dados comerciais. Guarde-o em local privado e envie somente pela área administrativa autorizada. Não use os exemplos sintéticos na base da empresa.
