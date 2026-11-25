---
source: 8949d6275dea6548
title: Atualizar e remover o Infinitary
description: Como cada tipo de instalação recebe uma nova versão estável e como remover o Infinitary mantendo seu trabalho salvo.
---

O Infinitary procura uma nova versão estável a cada poucas horas.
Procurar não baixa nada, e nada é instalado até você escolher.
Uma atualização mantém seu trabalho salvo.

## Quando sai uma nova versão {#when-a-new-version-is-out}

Um botão redondo com uma seta para baixo aparece no canto superior direito da janela.
Pare o ponteiro sobre ele para ler “Atualização disponível” e o número da nova versão, e aperte-o para ver o que fazer em seguida.
Ajustes → **Geral** mostra o mesmo, em **Versão**.

Para verificar você mesmo, use qualquer uma destas opções:

- **Verificar atualizações** em **Versão**, em Ajustes → **Geral**.
- **Verificar atualizações** na busca de comandos.
- No Mac, **Verificar Atualizações…** no menu Infinitary.

O que fazer em seguida depende de como você instalou o Infinitary.

## Uma cópia para Mac da página de downloads {#a-mac-copy-from-the-downloads-page}

1. Aperte **Atualizar e reiniciar**.
2. O Infinitary baixa a nova versão e verifica o checksum e a assinatura da Apple dela.
3. Ele salva o trabalho da sua tripulação.
   O trabalho em andamento termina primeiro o que está rodando, então nada se perde.
4. O Infinitary reinicia na nova versão e retoma o trabalho que a atualização pausou.

Enquanto ele espera pelo trabalho em andamento, **Atualizar mais tarde** deixa a atualização para quando você a escolher de novo.
Seu trabalho continua.

Se o Infinitary não conseguir terminar de reiniciar, o botão mostra **Reiniciar**.
Aperte-o de novo quando o trabalho em andamento parar.

O Infinitary só se atualiza a partir de Aplicativos.
Se ele estiver rodando a partir da imagem de disco, arraste-o para Aplicativos, ejete a imagem de disco e abra a cópia em Aplicativos.

## Uma cópia para Mac do Homebrew {#a-mac-copy-from-homebrew}

Uma cópia que você instalou com o Homebrew é atualizada pelo Homebrew.
O aviso mostra o comando, com **Copiar comando**:

```sh wrap
brew update && brew upgrade --cask infinitary-labs/tap/infinitary
```

Execute-o no Terminal.
O Homebrew fecha o Infinitary enquanto o substitui, então abra o Infinitary de novo quando ele terminar.

## Linux {#linux}

- **Ubuntu, Debian e Fedora**, a partir do pacote .deb ou .rpm: aperte **Instalar**.
  O Infinitary baixa a nova versão, verifica-a, salva o trabalho da sua tripulação e pede sua senha, depois inicia de novo.
- **Um AppImage**: aperte **Instalar**.
  O Infinitary substitui o arquivo AppImage pela nova versão e inicia de novo, sem senha.
  Ele precisa poder alterar a pasta em que o AppImage está.
- **Arch, Omarchy e NixOS** são atualizados pelo próprio gerenciador de pacotes.
  O aviso mostra o comando, com **Copiar comando**; execute-o em um terminal.

Se a instalação não puder terminar, nada muda e o trabalho da sua tripulação continua.
O aviso então mostra um comando que instala a mesma versão manualmente.

## Windows {#windows}

1. Aperte **Atualizar e reiniciar**.
2. O Infinitary baixa o novo instalador, verifica o checksum dele e salva o trabalho da sua tripulação.
3. O Infinitary fecha, o instalador o substitui e o Infinitary abre de novo na nova versão.

Se a instalação não puder terminar, nada muda e o trabalho da sua tripulação continua.

## Seus outros computadores e seu celular {#your-other-computers-and-your-phone}

Um computador que você adicionou é atualizado a partir do computador onde fica o seu imediato.
Em Ajustes → **Dispositivos**, um computador em outra versão mostra **Atualizar** na linha dele.
Ele recebe a versão deste computador, e o trabalho em andamento dele para por um momento e continua depois.

Em um computador que controla o seu imediato, Ajustes → **Geral** tem uma linha para o Infinitary no computador onde fica o seu imediato.
Quando esse computador tiver uma atualização pronta, aperte **Atualizar** seguido do nome dele para iniciar a atualização de onde você está.
Seu celular também pode iniciar essa atualização, depois de perguntar a você primeiro.
Veja [Seus outros computadores](/pt-br/your-other-computers/) e [iPhone e iPad](/pt-br/iphone-and-ipad/).

## Remover o Infinitary {#remove-infinitary}

Remover o app deixa seu trabalho salvo no lugar, então instalar o Infinitary de novo retoma de onde você parou.
Se este computador roda trabalho para outro, aperte **Sair** em Ajustes → **Dispositivos** primeiro.

- **Uma cópia para Mac da página de downloads**: feche o Infinitary e mova-o de Aplicativos para o Lixo.
- **Uma cópia para Mac do Homebrew**: execute `brew uninstall --cask infinitary` no Terminal.
  Nunca acrescente `--zap`: isso exclui seu trabalho salvo.
- **Linux**: remova o pacote com o instalador de programas ou o gerenciador de pacotes que você usou para instalá-lo.
  Para um AppImage, exclua o arquivo.
- **Windows**: em Configurações do Windows → **Aplicativos** → **Aplicativos instalados**, escolha **Desinstalar** no menu do Infinitary.

Seu trabalho salvo fica em `~/Library/Application Support/infinitary` no Mac, em `~/.config/infinitary` no Linux e em `%APPDATA%\infinitary` no Windows.

### O que exclui seu trabalho salvo {#what-deletes-your-saved-work}

Estes excluem essa pasta, e o que o Infinitary guardava nela vai junto:

- `brew uninstall --zap`.
- Um app desinstalador que também remove os arquivos de suporte de um app.
- Mover a própria pasta para o Lixo, ou excluí-la.

Em um computador que roda trabalho para outro, essa pasta guarda a chave do próprio computador, as cópias de trabalho dele e os arquivos das tarefas dele.
Sem ela, o computador entra de novo como uma entrada nova, e o trabalho que ele ainda não tinha trazido fica perdido.
Veja [Um computador aparece duas vezes](/pt-br/troubleshooting/#a-computer-is-listed-twice).
