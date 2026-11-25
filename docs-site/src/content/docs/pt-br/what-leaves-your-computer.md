---
source: 6bc810f8c25a2b9e
title: O que sai do seu computador
description: O que o Infinitary envia, para onde vai e o único botão que envia algo para nós.
---

O Infinitary roda no seu computador, com as assinaturas que você já tem.
Ele não precisa de uma conta conosco, e seu trabalho não passa por nós.
Esta página lista o que o app envia, e para onde.

## Seu trabalho vai para o provedor que você escolheu {#your-work-goes-to-the-provider-you-chose}

Seu imediato e sua tripulação pensam por meio das assinaturas de IA em que você fez login.
Suas mensagens, e o que um tripulante lê do seu projeto para fazer a tarefa dele, vão para esse provedor pela sua assinatura.
Com o Claude, o Infinitary usa o Claude Code que você instalou, com login na sua própria conta.
Com um provedor personalizado, tudo vai para o endereço que você digitou.

Seus logins ficam no seu computador.

## Seus projetos vão para onde eles ficam {#your-projects-go-where-they-live}

Um tripulante trabalha em uma cópia de trabalho do seu projeto no seu computador.
Quando uma tarefa é oferecida como solicitação de pull, o branch dela recebe um push para onde seu projeto fica, como o GitHub, o GitLab ou o Bitbucket, e a solicitação de pull é aberta lá.
Um projeto guardado só neste computador fica só neste computador.

Quando um tripulante prepara uma cópia de trabalho ou faz a tarefa dele, ele pode buscar o que seu projeto precisa, como você faria à mão.

## Seus outros computadores e seu celular {#your-other-computers-and-your-phone}

Os computadores e celulares que você adiciona conversam com o computador onde seu imediato mora.
Ajustes → **Dispositivos** diz como eles o encontram.
**Pela internet** diz “Nunca. O Infinitary não abre este computador para a internet.”

Um login que você digita para outro computador vai para esse computador uma vez.
O computador onde seu imediato mora não guarda nenhuma cópia.
Veja [Seus outros computadores](/pt-br/your-other-computers/).

## Integrações que você conecta {#integrations-you-connect}

Uma integração que você conecta em Ajustes → **Integrações**, como o Google, é alcançada com o próprio login, que fica no computador em que você fez login.
Seu imediato e sua tripulação só a leem depois que você a conecta.
Veja [Integrações](/pt-br/integrations/).

## Os relatórios de uso da sua empresa {#your-companys-usage-reporting}

Se o seu arquivo de ajustes do Claude Code ou o seu shell configura relatórios de uso para a sua empresa, como o guia do Claude Code descreve, o Infinitary envia o uso de todo o trabalho feito aqui para o mesmo lugar.
O trabalho do Claude vai como os registros que o próprio Claude Code enviaria para lá.
O trabalho de qualquer outro modelo vai com os mesmos nomes, com o modelo, o provedor, os tokens, o custo estimado, se o seu imediato ou um tripulante o fez, o tipo de trabalho e o e-mail do seu login do Claude Code, nunca as suas palavras, os títulos das tarefas nem os nomes dos projetos.
Ajustes → **Uso** diz para onde ele vai.
Se esse lugar continuar recusando o trabalho do Claude, ou não puder ser alcançado, essa linha diz isso no lugar.
Uma configuração que o administrador da sua empresa gerencia para o computador inteiro chega ao Claude Code diretamente, como sempre, e o Infinitary também envia para lá o trabalho de qualquer outro modelo, do mesmo jeito.
Qualquer um dos dois tipos de configuração recebe só o trabalho do Claude se enviar seu uso por gRPC, e Ajustes → **Uso** então diz isso.

## Verificações de atualização {#update-checks}

O Infinitary verifica se há uma versão mais nova a cada poucas horas, no lugar onde as versões dele são publicadas.
Essa verificação não envia nenhum conteúdo seu e nenhum ID.
A primeira verificação de cada dia, e a primeira de cada mês, também diz que é a primeira, para que a Infinitary Labs possa contar quantos computadores usam o Infinitary.
Isso acontece seja qual for a posição do botão **Diagnóstico**, e uma cópia instalada com o Homebrew não envia esse aviso.
Ele só baixa uma nova versão quando você escolhe atualizar.
Você também pode pressionar **Verificar atualizações** por conta própria.
Veja [Atualizar e remover o Infinitary](/pt-br/update-and-remove/).

## Ditado {#dictation}

O Ditado transforma sua voz em palavras no seu computador.
Na primeira vez que você o usa, ele pergunta antes de baixar, uma única vez, o modelo de fala dele.

## Diagnóstico, o único botão que envia para nós {#diagnostics-the-one-switch-that-sends-to-us}

Ajustes → **Geral** → **Compartilhamento** tem o botão **Diagnóstico**.
É o único botão que envia algo para nós; a única coisa que chega até nós sem ele é o aviso de primeira do dia e primeira do mês da verificação de atualização, descrito acima, que **Compartilhamento** também explica.
Ele fica ligado a menos que você o desligue, e nada no app depende dele.

Na sua primeira abertura, um aviso abaixo da caixa de mensagem diz o que ele envia, com **Desativar** e **OK**.
Nada é enviado até você responder.

O Diagnóstico envia eventos de uso anônimos:

- o app sendo aberto,
- seu imediato terminando ou falhando uma rodada, com apenas o tipo de falha,
- até onde chegou a configuração da primeira vez,
- e, de um iPhone ou iPad que você adicionou, o app sendo aberto, sendo configurado, uma mensagem enviada e um cartão respondido.

Cada evento leva a versão do app e um ID de instalação aleatório.
O ID não está ligado a nada sobre você nem sobre seu computador, e é trocado sempre que o Diagnóstico é desligado e ligado de novo.
Nenhum texto que você escreveu, nenhum nome e nenhum caminho são enviados: nunca uma conversa, código ou cartão.
Seu celular não envia nada por conta própria; seu computador envia os eventos dele sob o mesmo botão.

Para ver exatamente o que sairia, abra **O que sairia deste computador** em **Compartilhamento**.
Ele mostra o ID de instalação, o que aguarda envio, o que foi enviado e todos os eventos que o Diagnóstico pode enviar.
Desligue o **Diagnóstico**, e nada mais é registrado nem enviado.

## Segredos {#secrets}

Os valores que você guarda em Ajustes → **Segredos** ficam no seu computador.
Cada valor vai direto para Segredos: o Infinitary nunca o mostra de novo, e nem o imediato nem a tripulação o recebem.
Veja [Segredos](/pt-br/secrets/).
