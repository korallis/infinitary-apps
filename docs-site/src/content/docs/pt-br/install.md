---
source: 2633a75241365106
title: Instalar
description: Baixe a versão estável do Infinitary para Mac, Linux ou Windows, ou peça um convite privado do TestFlight para iPhone e iPad.
---

Baixe a versão estável do Infinitary para [Mac](https://getinfinitary.com/downloads/#macos), [Linux](https://getinfinitary.com/downloads/#linux) ou [Windows](https://getinfinitary.com/downloads/#windows).
Se quiser verificar um download, compare o checksum SHA-256 dele com o que aparece ao lado desse arquivo na página de downloads.

## No Mac {#on-a-mac}

Baixe a **imagem de disco (.dmg)** para Mac com Apple silicon ou com Intel.
Abra-a e arraste o Infinitary para **Aplicativos**.
Se preferir o **ZIP**, abra-o e mova o app Infinitary extraído para **Aplicativos**.

## No Linux {#on-linux}

Escolha o pacote **.deb** para Ubuntu ou Debian, ou o pacote **.rpm** para Fedora, e abra-o com o instalador de programas do seu sistema.
Para Arch ou Omarchy, use a receita de pacote do Arch; para NixOS, use a receita do Nix.
Em outros sistemas Linux x64, baixe o **AppImage**, permita que ele seja executado como programa nas propriedades do arquivo e depois abra-o.

## No Windows {#on-windows}

O Infinitary para Windows é experimental.
Baixe o **instalador (.exe)** para um PC com Windows 11 e processador Intel ou AMD de 64 bits.
O instalador ainda não é assinado com um certificado que a Microsoft verifica, então o Windows não conhece o editor dele e avisa duas vezes antes de instalar:

1. Se o seu navegador disser que o arquivo não é baixado com frequência, escolha **Manter** e depois **Manter assim mesmo**.
2. Quando você o abre, o Windows diz “O Windows protegeu o computador” com um editor desconhecido.
   Escolha **Mais informações** e depois **Executar assim mesmo**.

Se o Controle Inteligente de Aplicativos estiver ativado, o Windows bloqueia esta versão e não oferece como executá-la.
Mantenha o Controle Inteligente de Aplicativos ativado e espere a versão assinada.

O instalador instala o Infinitary só para você, adiciona-o ao menu Iniciar e o abre.
Se o seu PC não tiver o Git for Windows, o Infinitary oferece instalá-lo na primeira abertura, porque sua tripulação precisa dele.

## No iPhone e no iPad {#on-iphone-and-ipad}

O Infinitary para iPhone e iPad está no TestFlight privado.
[Envie um e-mail para help@getinfinitary.com para pedir um convite](mailto:help@getinfinitary.com?subject=Infinitary%20TestFlight%20request).
Veja [iPhone e iPad](/pt-br/iphone-and-ipad/) para saber como conectar-se ao seu computador.

## Do que você precisa {#what-you-need}

- **Um computador.**
  Um Mac com macOS 12 ou posterior, um computador Linux com processador x64, ou um PC com Windows 11 e processador x64 (experimental).
- **Uma assinatura de IA.**
  Seu imediato precisa de pelo menos uma assinatura que consiga responder: Codex, Grok, Claude, Kimi Code, Copilot, OpenRouter com uma chave de API, ou Amazon Bedrock com seu login da AWS.
- **Claude Code, para o Claude.**
  Se você usa uma assinatura do Claude, instale primeiro o Claude Code nesse computador.
  O Infinitary usa o Claude Code que você instalou.

## Sua primeira abertura {#your-first-launch}

1. Abra o Infinitary.
   A janela dá as boas-vindas e mostra um botão para cada provedor.
2. Escolha seu provedor e faça login do jeito que ele pedir: no navegador, com um código ou com uma chave que você cola.
3. Quando uma assinatura consegue responder, a caixa de mensagem se abre e seu imediato está pronto.

Configure seu imediato em um computador que fique ligado o máximo possível.
Seus outros dispositivos precisam do seu imediato acordado.

Para atualizar ou remover o Infinitary depois, veja [Atualizar e remover o Infinitary](/pt-br/update-and-remove/).
Se algo não funcionar, veja [Obter ajuda](/pt-br/get-help/).
