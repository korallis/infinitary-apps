---
source: 2633a75241365106
title: Installieren
description: Lade die stabile Version von Infinitary für Mac, Linux oder Windows herunter oder frag eine private TestFlight-Einladung für iPhone und iPad an.
---

Lade die stabile Version von Infinitary für [Mac](https://getinfinitary.com/downloads/#macos), [Linux](https://getinfinitary.com/downloads/#linux) oder [Windows](https://getinfinitary.com/downloads/#windows) herunter.
Willst du einen Download überprüfen, vergleiche seine SHA-256-Prüfsumme mit der, die auf der Download-Seite neben dieser Datei steht.

## Auf einem Mac {#on-a-mac}

Lade das **Disk-Image (.dmg)** für einen Mac mit Apple-Chip oder einen Intel-Mac herunter.
Öffne es und zieh Infinitary in **Programme**.
Wählst du stattdessen das **ZIP**, öffne es und verschieb die entpackte Infinitary-App in **Programme**.

## Auf Linux {#on-linux}

Wähl das **.deb**-Paket für Ubuntu oder Debian oder das **.rpm**-Paket für Fedora und öffne es mit der Software-Installation deines Systems.
Für Arch oder Omarchy nutz das Arch-Paketrezept; für NixOS das Nix-Rezept.
Auf anderen x64-Linux-Systemen lade das **AppImage** herunter, erlaube ihm in den Dateieigenschaften, als Programm zu laufen, und öffne es dann.

## Auf Windows {#on-windows}

Infinitary für Windows ist experimentell.
Lade den **Installer (.exe)** für einen Windows-11-PC mit einem 64-Bit-Prozessor von Intel oder AMD herunter.
Der Installer ist noch nicht mit einem Zertifikat signiert, das Microsoft überprüft, daher kennt Windows seinen Herausgeber nicht und warnt vor der Installation zweimal:

1. Wenn dein Browser sagt, dass die Datei nicht häufig heruntergeladen wird, wähl **Beibehalten** und dann **Trotzdem beibehalten**.
2. Wenn du ihn öffnest, meldet Windows „Der Computer wurde durch Windows geschützt“ mit einem unbekannten Herausgeber.
   Wähl **Weitere Informationen** und dann **Trotzdem ausführen**.

Wenn die intelligente App-Steuerung aktiviert ist, blockiert Windows diesen Build und bietet keinen Weg, ihn auszuführen.
Lass die intelligente App-Steuerung bitte aktiviert und warte auf den signierten Build.

Der Installer installiert Infinitary nur für dich, fügt es dem Startmenü hinzu und öffnet es.
Hat dein PC kein Git for Windows, bietet Infinitary beim ersten Start an, es zu installieren, denn deine Crew braucht es.

## Auf iPhone und iPad {#on-iphone-and-ipad}

Infinitary für iPhone und iPad ist im privaten TestFlight.
[Schreib eine E-Mail an help@getinfinitary.com, um eine Einladung anzufragen](mailto:help@getinfinitary.com?subject=Infinitary%20TestFlight%20request).
Unter [iPhone und iPad](/de/iphone-and-ipad/) steht, wie du dich mit deinem Computer verbindest.

## Was du brauchst {#what-you-need}

- **Einen Computer.**
  Einen Mac mit macOS 12 oder neuer, einen Linux-Computer mit x64-Prozessor oder einen Windows-11-PC mit x64-Prozessor (experimentell).
- **Ein KI-Abo.**
  Dein erster Offizier braucht mindestens ein Abo, das antworten kann: Codex, Grok, Claude, Kimi Code, Copilot, OpenRouter mit einem API-Schlüssel oder Amazon Bedrock mit deiner AWS-Anmeldung.
- **Claude Code, für Claude.**
  Wenn du ein Claude-Abo nutzt, installier zuerst Claude Code auf diesem Computer.
  Infinitary nutzt das Claude Code, das du installiert hast.

## Dein erster Start {#your-first-launch}

1. Öffne Infinitary.
   Das Fenster begrüßt dich und zeigt für jeden Anbieter eine Schaltfläche.
2. Wähl deinen Anbieter und melde dich so an, wie er es verlangt: in deinem Browser, mit einem Code oder mit einem Schlüssel, den du einfügst.
3. Sobald ein Abo antworten kann, öffnet sich das Nachrichtenfeld, und dein erster Offizier ist bereit.

Richte deinen ersten Offizier auf einem Computer ein, der möglichst oft eingeschaltet bleibt.
Deine anderen Geräte brauchen deinen ersten Offizier wach.

Wie du Infinitary später aktualisierst oder entfernst, steht unter [Infinitary aktualisieren und entfernen](/de/update-and-remove/).
Wenn etwas nicht funktioniert, siehe [Hilfe bekommen](/de/get-help/).
