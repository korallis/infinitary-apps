---
source: a3a69a749c864ad8
title: Segredos
description: Guarde as senhas e chaves de que sua tripulação precisa, permita cada uso em um cartão e veja o que as usou.
---

Segredos guarda as senhas e chaves de que sua tripulação precisa para trabalhar, como a chave que publica seu site.
Um tripulante usa um segredo pelo nome, e só depois que você permite esse uso.
Cada valor vai direto para Segredos no seu computador: o Infinitary nunca o mostra de novo, e nem o imediato nem a tripulação o recebem.

<img class="picture-dark" src="/pictures/secrets-dark.webp" alt="Ajustes, seção Segredos: três segredos protegidos, a chave de e-mail da newsletter para Production, a senha do banco de dados da loja para Staging e a chave do serviço de clima para Personal, nenhum usado ainda, com Buscar segredos, Adicionar segredo, Trazer de outra ferramenta e Acesso, histórico e recuperação, e uma lista vazia de Sites com login abaixo." width="1164" height="582" />
<img class="picture-light" src="/pictures/secrets-light.webp" alt="Ajustes, seção Segredos: três segredos protegidos, a chave de e-mail da newsletter para Production, a senha do banco de dados da loja para Staging e a chave do serviço de clima para Personal, nenhum usado ainda, com Buscar segredos, Adicionar segredo, Trazer de outra ferramenta e Acesso, histórico e recuperação, e uma lista vazia de Sites com login abaixo." width="1164" height="582" />

## Onde seus segredos ficam {#where-your-secrets-live}

Abra **Ajustes** e depois **Segredos**, ou procure **Abrir Segredos** na busca de comandos.

**Segredos protegidos** lista cada segredo pelo nome e pelo lugar, e diz qual tarefa o usou por último, e quando.
**Buscar segredos** encontra um pelo nome, pelo lugar ou pela tarefa que o usou por último.

No Mac, a linha abaixo da lista diz “Guardados neste computador. Sua tripulação os usa, mas nunca os vê.”
No Linux e no Windows, ela diz que sua tripulação só os usa com a sua aprovação, mas que qualquer programa que você executa pode alcançá-los enquanto o cofre de segredos do seu sistema estiver desbloqueado.

Os segredos ficam no computador onde seu imediato mora.
Um computador que controla seu imediato de outro lugar não tem uma seção Segredos própria.

## Guardar um segredo {#keep-a-secret}

1. Escolha **Adicionar segredo**.
2. Dê a ele um **Nome**, como “Publicação do site”.
3. Cole o valor em **Valor do segredo**.
4. Se você guardar dois segredos com o mesmo nome, diferencie-os com **Lugar (opcional)**, como staging ou produção.
5. Escolha **Salvar segredo**.

O valor fica oculto depois de salvo, e só um uso que você permite pode recebê-lo.
Abra a linha de um segredo para **Substituir** o valor ou **Esquecer** o segredo.
Esquecer o remove deste computador, mas não desativa a chave no lugar onde ela foi criada.

### Quando um tripulante precisa de um que você não guardou {#when-a-crewmate-needs-one-you-have-not-kept}

Um tripulante que precisa de um segredo que você não guardou o pede pelo nome, nunca pelo valor.
O Infinitary então mostra um cartão próprio, como “Adicionar Publicação do site a Segredos?”, com o motivo do tripulante nas palavras dele.
Quando você precisa criar ou encontrar o segredo por conta própria, o cartão também mostra **Como obter**: os passos, nomes ou lugares que o tripulante organizou para este caso, e uma linha dizendo quem os escreveu.
Confira cada endereço que ele mostra antes de entrar nele.

Digite ou cole cada valor no campo oculto que o Infinitary desenha no cartão e escolha **Salvar segredo**.
**Não salvar** não salva nada.
O tripulante recebe o nome do segredo, nunca o valor, e cada uso continua pedindo sua permissão.

Digite um segredo só em um campo que o Infinitary desenha, nunca no campo de resposta de um cartão nem na sua caixa de mensagem.

## Permitir um uso {#allow-a-use}

Quando um tripulante quer usar um segredo, o Infinitary mostra um cartão, como “Dar o segredo Publicação do site a “Publicar o site”?”.
O cartão diz exatamente o que o receberia:

- **Segredo**: cada segredo, e o nome com que o programa o recebe.
- **Executa**: o comando exato.
- **Na pasta**: onde ele roda.
- **O motivo**: o motivo do tripulante, com as próprias palavras.

**Tudo o que foi verificado** lista o que o Infinitary verificou sobre o programa, e o que não conseguiu verificar.
Depois escolha:

- **Permitir uma vez** dá o segredo só para esta execução.
- **Sempre permitir** dá o segredo para esta execução e salva esta execução exata: o mesmo programa, os mesmos arquivos, argumentos e pasta.
  Qualquer coisa diferente pergunta de novo.
- **Não permitir** recusa, e a próxima execução pergunta de novo.

Cada permissão pede que você confirme antes: no Mac com Touch ID ou sua senha, no Linux com sua senha, e no Windows com o Windows Hello ou sua senha do Windows.
O que recebe um segredo pode guardá-lo.
Permitir nunca aprova uma ação separada, como implantar ou enviar algo.
O tripulante fica sabendo só se a execução terminou, não o que ela imprimiu.

Enquanto um pedido aguarda, Ajustes → Segredos o mostra no topo, com **Revisar pedido** para abrir o cartão dele.

## Decisões salvas {#saved-decisions}

Abra **Acesso, histórico e recuperação** abaixo da lista de segredos e depois **Decisões salvas**.
Cada decisão que você salvou com **Sempre permitir** aparece como uma frase.

Você só salva uma decisão no cartão de um pedido.
Aqui você pode **Remover** uma: seu computador pede que você confirme, e a tripulação pergunta de novo antes do próximo uso.

## Aprovar pelo celular {#approve-from-your-phone}

Você pode permitir um uso pelo seu iPhone ou iPad quando estiver longe do computador.

1. Em Ajustes → **Dispositivos**, ative **Aprova usos de segredos** na linha do seu celular.
2. Abra o Infinitary no celular, que então mostra o código dele.
3. Escolha **Comparar códigos** e verifique se o código no cartão do seu computador é igual ao dos Ajustes do celular.
4. Escolha **Confirmar e permitir** no seu computador, que pede que você confirme.

A partir daí, o cartão de um pedido no celular oferece **Permitir uma vez** e **Não permitir**.
Cada Permitir pede Face ID, Touch ID ou o código do celular.
Uma decisão que sempre permite uma execução fica salva só no seu computador.
Um Mac que controla seu imediato de outro lugar também pode aprovar usos, configurado do mesmo jeito pela linha dele.

Para parar, desative esse botão, ou escolha **Parar aprovações** em **Dispositivos que aprovam**, dentro de **Acesso, histórico e recuperação**.

## Trazer segredos de outra ferramenta {#move-secrets-from-another-tool}

Se você guarda segredos em outra ferramenta, como o Automic Vault, um arquivo .env ou as Chaves do seu Mac, um tripulante pode trazê-los para Segredos sem ver nenhum valor.

1. Escolha **Trazer de outra ferramenta** em Ajustes → Segredos, ou **Trazer segredos de outra ferramenta** na busca de comandos.
2. Sua caixa de mensagem começa o pedido ao seu imediato; diga o nome da ferramenta e envie.
3. O tripulante mostra um cartão, como “Trazer 3 segredos do Automic Vault?”, que diz o comando que ele executa ou o arquivo que ele lê, e por quê.
4. Marque cada segredo que deseja guardar e escolha **Trazer para Segredos**, ou **Não trazer**.

O Infinitary executa o comando ou lê o arquivo por conta própria, e guarda só o que você marcar.
Para um arquivo como um arquivo .env, **Ler** primeiro lista os nomes que ele contém.
O tripulante recebe nomes, nunca um valor, e a cópia na outra ferramenta continua como está.
Você escolhe os segredos na janela do Infinitary no computador onde seu imediato mora, não no celular.

## Chaves das suas integrações {#keys-for-your-integrations}

Quando você faz login no Google ou adiciona um servidor MCP com chaves em Ajustes → **Integrações**, o Infinitary guarda essas chaves em Segredos.
Segredos as lista com **Gerenciar em Integrações** no lugar de Substituir e Esquecer.
O Infinitary as usa sem perguntar, porque fazer login, ou adicionar o servidor com as chaves dele, foi o seu consentimento.
Sua tripulação não pode vê-las nem pedir para usá-las.
Saia da conta, ou remova o servidor, em Integrações para esquecê-las.
Veja [Integrações](/pt-br/integrations/).

## Histórico de uso e backups {#use-history-and-backups}

**Histórico de uso** lista cada uso: quais segredos, o motivo, o programa, como foi permitido e como terminou, nunca um valor.
Ele fica até você excluí-lo, com **Exportar histórico** e **Excluir histórico**.

**Backup e restauração** tem **Salvar backup criptografado**, que salva uma cópia criptografada e uma chave de recuperação separada.
Guarde as duas em lugares diferentes: quem tiver as duas pode ler os valores salvos, e não há como redefinir a chave.
**Restaurar do backup** substitui seus valores guardados e apaga as decisões salvas, as aprovações pelo celular e os acessos temporários.

## Quando Segredos não abre {#when-secrets-cannot-open}

Se o cofre de segredos do seu computador estiver bloqueado, Segredos mostra **Armazenamento bloqueado**, com **Desbloquear ou verificar de novo**.
Os pedidos continuam aguardando até ele abrir.

Se o Infinitary não conseguir mais ler o que guardou, Segredos mostra **Recuperação necessária** e não permite nenhum uso.
**Opções de recuperação** abre **Backup e restauração**, para restaurar de um backup.
**Começar do zero** apaga seus segredos guardados, as decisões salvas, as aprovações pelo celular e os acessos temporários, e não pode ser desfeito.

## Sites com login {#signed-in-sites}

O fim de Segredos lista **Sites com login**: os sites em que você fez login no navegador de uma tarefa.
Eles ficam no perfil do navegador daquele computador, não no armazenamento protegido.
Veja [O navegador da tripulação](/pt-br/the-crews-browser/#signed-in-sites).

## Quando seu imediato muda de computador {#when-your-first-mate-moves}

Quando seu imediato muda para outro computador, seus segredos ficam no computador que ele deixa, e você os adiciona de novo no novo.

Um computador que [mantém uma cópia do seu imediato](/pt-br/your-other-computers/#keep-a-copy-on-another-computer) também pode guardar seus segredos.
Escolha **Guardar os Segredos lá** na lista **Pronto para assumir** dele em Ajustes → **Dispositivos** e depois confirme nesse próprio computador.
Se seu imediato depois mudar para lá, ou [começar a partir dessa cópia](/pt-br/your-other-computers/#take-over), ele leva os valores junto.
Se esse computador já guardar segredos próprios, um cartão lá pergunta qual conjunto usar.
Ele não leva nenhuma decisão salva nem dispositivos que aprovam, então cada uso pede sua permissão de novo e cada celular é configurado de novo.

Veja também [Seus outros computadores](/pt-br/your-other-computers/#move-your-first-mate) e [O que sai do seu computador](/pt-br/what-leaves-your-computer/#secrets).
