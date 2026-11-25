---
source: 3e0fd8cde41ac0cf
title: Seus outros computadores
description: Adicione seus outros computadores para controlar seu imediato de qualquer um deles, deixar que eles rodem o trabalho dos seus projetos e manter uma cópia que possa assumir.
---

Seu imediato mora em um computador.
As tarefas, os cartões e a conversa dele ficam lá.
De qualquer computador que você adicionar, você pode controlar seu imediato, e qualquer computador que você adicionar pode rodar o trabalho de um projeto.

Você encontra tudo isso em Ajustes → **Dispositivos**, em **Seus dispositivos**.
Abra os Ajustes com ⌘, (Ctrl+, no Linux e no Windows).

## O computador onde seu imediato mora {#the-computer-where-your-first-mate-lives}

Escolha um computador que fique ligado o máximo possível.
Seus outros computadores e seu celular precisam dele acordado, com o Infinitary aberto.

Enquanto ele estiver em repouso ou fora de alcance:

- Outro computador mostra a última coisa que viu e diz “As alterações estão desativadas”.
  Uma mensagem que você digita lá não é enviada, e suas palavras ficam na caixa de mensagem até aquele computador voltar.
- As automações só rodam enquanto o Infinitary estiver aberto lá e o computador estiver acordado.
  Uma execução perdida nesse meio-tempo acontece uma vez quando ele volta.

## Adicionar um computador {#add-a-computer}

1. No computador onde seu imediato mora, abra Ajustes → **Dispositivos**.
2. Pressione **+ Um computador**.
3. Digite o endereço do outro computador e pressione **Adicionar**.

Adicionar um computador pelo endereço é o jeito de começar: este computador depois mantém o outro atualizado e chega até ele sozinho, sem precisar ir até lá depois da configuração.
Digite o endereço que você usa com SSH para o outro computador, como `you@mini.local`.
O Login Remoto precisa estar ativado lá; no Linux, o servidor SSH dele.
Os computadores da mesma rede aparecem em **Nesta rede**, para você escolher um.
Você também pode pedir ao seu imediato para adicionar um computador, e ele recomenda o endereço.

Em um Mac novo ou em um computador Linux x64 novo, a primeira abertura do Infinitary mostra o endereço a digitar: escolha **Configurar pelo computador do seu imediato**.
Ela mostra primeiro o endereço deste computador na rede privada, como o do Tailscale, e depois o endereço dele na rede local, cada um com **Copiar**.
Assim que o computador onde seu imediato mora adicioná-lo, essa janela abre seu imediato sozinha, desde que nada tenha sido configurado nela ainda.
Uma janela em que você já fez login, adicionou um projeto ou conversou com o imediato dela mantém o próprio imediato, e o mesmo vale para uma janela ao lado de um Infinitary que você mesmo iniciou pelo Terminal.
Se o Infinitary estava fechado naquele computador quando ele foi adicionado, ele abre seu imediato na próxima vez que iniciar, seja o que for que tenha sido configurado nele.
Um PC com Windows e um computador Linux Arm entram com **Colar o link dele**.

Abaixo do endereço, **Não dá para ativar o Login Remoto lá?** oferece outros dois jeitos.
Cada um adiciona o mesmo tipo de computador.

**Colar um link no Infinitary de lá**, quando você está naquele computador, ou quando ele é um PC com Windows.
Copie o link e abra o Infinitary no outro computador pela primeira vez.
Em **Seu imediato está em outro computador**, escolha **Colar o link dele**, cole-o e pressione **Continuar**.
O Infinitary pergunta uma vez se você quer controlar seu imediato de lá; pressione **Controlar daqui**.

**Executar um comando lá**, quando você consegue digitar no Terminal de lá, mas o Login Remoto está desativado.
Copie o comando e rode-o uma vez no Terminal do outro computador, como o usuário que deve rodar o trabalho dele.
Ele baixa o Infinitary deste computador, então os dois precisam estar na mesma rede.

Quando seu imediato mora em um PC com Windows, **+ Um computador** oferece só o link e o comando.

Um link ou comando funciona uma vez, por dez minutos, e você pode pressionar **Parar** antes disso.
Você também pode entrar a partir do outro computador: na primeira abertura dele, escolha **Entrar pelo endereço** e digite o endereço do computador onde seu imediato mora.

## Controlar seu imediato de outro computador {#control-your-first-mate-from-another-computer}

Depois que um computador entra, abrir o Infinitary nele mostra seu imediato.
O topo da janela diz “Controlando seu imediato em” e o nome daquele computador.
Seus cartões, tarefas e conversa ficam no computador onde seu imediato mora.

Cada computador mantém sua própria Aparência, seu Teclado e seus Painéis.
As outras seções dos Ajustes são lidas e alteradas no computador onde seu imediato mora.

Para parar, abra Ajustes → **Dispositivos** nesse computador e pressione **Sair**.
Para desligar um computador do computador onde seu imediato mora, abra o menu dele, os três pontos na linha dele, e escolha **Remover**.
Um computador que só controla seu imediato precisa de um novo link para voltar.

## Um computador que roda trabalho {#a-computer-that-runs-work}

Qualquer computador que você adicionar pode rodar o trabalho de um projeto, sem nenhuma janela aberta lá.
Ele faz login nas próprias assinaturas, e uma tarefa que roda lá usa só essas.
Faça login dele em uma assinatura em Ajustes → **Inteligência**, onde os logins de cada computador aparecem sob o nome dele.
Depois dê um projeto a ele.

Em Ajustes → **Projetos**, abra um projeto e defina **Roda em**: **Automático**, **Este computador** ou um de **Seus computadores**.
Enquanto aquele computador estiver fora de alcance, as tarefas do projeto esperam, e nunca rodam neste computador no lugar dele.

Um computador também pode rodar trabalho como outro usuário no computador onde seu imediato mora.
Pressione **+ Rodando como outro usuário** para criar o comando dele.

Remover um computador que roda trabalho traz de volta primeiro o trabalho não mesclado dele.

## Mover uma tarefa para outro computador {#move-a-task-to-another-computer}

Uma tarefa iniciada pode ir para outro computador que roda trabalho.
Abra o registro dela, pressione **Mover para um computador** e escolha para onde ela vai.
Ela mantém a chave, o branch, os arquivos e o registro.
A tarefa muda assim que o tripulante dela termina o que está fazendo; até lá, você pode pressionar **Cancelar mudança**.

## Arquivos em outro computador {#files-on-another-computer}

Um tripulante pode copiar um arquivo de outro dos seus computadores para a tarefa dele, para lê-lo.
Ele só lê: nada é escrito em outro computador.
Cada cópia acrescenta uma linha à Atividade da tarefa, com o nome do arquivo e o computador de onde ele veio.

## Mudar seu imediato de computador {#move-your-first-mate}

No menu de um computador que roda trabalho, os três pontos na linha dele, **Mudar seu imediato para cá** leva seu imediato para lá.
Uma lista mostra antes qualquer coisa que esteja no caminho.
Os [Segredos](/pt-br/secrets/) ficam no computador que ele deixa, e você faz login de novo nas suas assinaturas lá.

## Manter uma cópia em outro computador {#keep-a-copy-on-another-computer}

Um computador que roda trabalho pode manter uma cópia ao vivo do registro do seu imediato.
Se o computador onde seu imediato mora se perder, ou ficar fora de alcance por muito tempo, esse computador pode [assumir](#take-over).

1. No computador onde seu imediato mora, abra Ajustes → **Dispositivos** e escolha o outro computador.
2. Abra o menu dele, os três pontos na linha dele, e escolha **Manter uma cópia aqui**.

Ele faz uma cópia completa e depois recebe cada mudança que seu imediato salva.
A linha dele diz em que ponto a cópia está, como **Cópia em dia** ou **Cópia se atualizando · 3 mudanças**, e, enquanto ele estiver fora de alcance, **Cópia das** e um horário.
Você pode manter uma cópia em mais de um computador.

A cópia guarda as tarefas, os cartões, a conversa, o conhecimento e as automações do seu imediato.
Esse computador nunca a abre até assumir.
Sozinha, a cópia não guarda nenhum dos seus projetos, logins ou Segredos:

- Quando ele assume, cada projeto é clonado de novo de onde o projeto fica.
  Um projeto guardado só no computador que se perdeu começa vazio lá.
- **Pronto para assumir**, no menu dele, lista o que esse computador ainda precisaria, como um login próprio em cada assinatura que seu imediato usa e onde seus projetos ficam.
  Um botão para cada um, como **Fazer login em GitHub lá**, começa esse login a partir desta janela.
- **Guardar os Segredos lá**, na mesma lista, mantém seus Segredos com a cópia assim que você confirma nesse próprio computador.
  Veja [Segredos](/pt-br/secrets/#when-your-first-mate-moves).

**Parar de manter uma cópia**, nessa lista, encerra a cópia, e esse computador a exclui assim que estiver ao alcance.

Antes de uma mesclagem, de um push ou do uso de um segredo, seu imediato espera até que cada cópia ao alcance tenha todas as mudanças até ali.
Um computador que assume sabe então o que já foi feito, e não faz de novo.

## Assumir {#take-over}

Enquanto o computador onde seu imediato mora estiver fora de alcance, um computador que mantém uma cópia pode assumir: seu imediato começa lá a partir da cópia.
Nada assume sozinho, e nenhum cronômetro decide: só o seu clique.

Abra o Infinitary em um computador que mantém uma cópia e abra Ajustes → **Dispositivos**.
Em **Controlando**, **Assumir** diz de quando é esta cópia, e se o computador do seu imediato avisou que ia entrar em repouso ou que o Infinitary foi encerrado lá.
Ele lista também cada outra cópia, marcada com **pode ser mais recente** quando ela pode ter mais mudanças.
Se uma cópia mais recente estiver ao alcance, este computador a traz primeiro.

1. Pressione **Assumir**.
2. Pressione **Assumir** de novo para confirmar, ou **Ficar** para deixar tudo como está.
3. No Mac, confirme com Touch ID ou sua senha; em um PC com Windows, com o Windows Hello ou sua senha do Windows.

Seu imediato então começa neste computador, que passa a ser o computador onde seu imediato mora.
Seus outros computadores e seu celular o encontram lá sozinhos, sem um novo link.
Um cartão lá pede cada login que falta, e você adiciona seus Segredos de novo, a menos que ele os tenha guardado.

Seu celular também pode pedir que um computador assuma.
Enquanto seu computador estiver fora de alcance, toque no botão do computador à direita da barra superior do celular.
A tela dele oferece **Assumir** para cada computador que mantém uma cópia, e depois pede Face ID ou o código.

### Se o computador perdido voltar {#if-the-lost-computer-comes-back}

O computador que se perdeu deixa de ser o computador do seu imediato quando volta, e passa a manter uma cópia.
Em **Passou o posto**, os Ajustes → **Dispositivos** dele listam o que ele salvou depois da cópia, que nunca chegou ao seu imediato.
Ele guarda esse registro à parte, e nada o abre de novo.

Se dois computadores responderem como seu imediato, Ajustes → **Dispositivos** pergunta em **Dois imediatos**: **Manter este**, ou manter o outro.
Mesclagens, pushes e usos de um segredo esperam até você escolher, e aquele que você não mantém para e passa a manter uma cópia do outro.

## Como os computadores se encontram {#how-computers-find-each-other}

Ajustes → **Dispositivos** mostra **Como outros dispositivos encontram este computador**: **Nesta rede** e **Na sua rede privada**.
**Pela internet** diz “Nunca. O Infinitary não abre este computador para a internet.”
Para controlar seu imediato de outro lugar, coloque os dois computadores na mesma rede privada.

Veja também [iPhone e iPad](/pt-br/iphone-and-ipad/) e [Solução de problemas](/pt-br/troubleshooting/).
