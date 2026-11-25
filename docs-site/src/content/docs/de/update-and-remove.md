---
source: 8949d6275dea6548
title: Infinitary aktualisieren und entfernen
description: Wie jede Art von Installation eine neue stabile Version bekommt und wie du Infinitary entfernst, ohne deine gespeicherte Arbeit zu verlieren.
---

Infinitary sucht alle paar Stunden nach einer neuen stabilen Version.
Das Suchen lädt nichts herunter, und nichts wird installiert, bevor du es willst.
Ein Update behält deine gespeicherte Arbeit.

## Wenn eine neue Version da ist {#when-a-new-version-is-out}

Oben rechts im Fenster erscheint eine runde Schaltfläche mit einem Pfeil nach unten.
Halte den Zeiger darauf, um „Update verfügbar“ und die Nummer der neuen Version zu lesen, und drück darauf, um zu sehen, was als Nächstes zu tun ist.
Einstellungen → **Allgemein** zeigt dasselbe unter **Version**.

Um selbst zu suchen, nimm eines davon:

- **Nach Updates suchen** unter **Version** in Einstellungen → **Allgemein**.
- **Nach Updates suchen** in der Befehlssuche.
- Auf einem Mac **Nach Updates suchen …** im Infinitary-Menü.

Was als Nächstes zu tun ist, hängt davon ab, wie du Infinitary installiert hast.

## Eine Mac-Kopie von der Download-Seite {#a-mac-copy-from-the-downloads-page}

1. Drück **Aktualisieren und neu starten**.
2. Infinitary lädt die neue Version herunter und prüft ihre Prüfsumme und ihre Apple-Signatur.
3. Es sichert die Arbeit deiner Crew.
   Laufende Arbeit beendet zuerst, was sie gerade tut, damit nichts verloren geht.
4. Infinitary startet mit der neuen Version neu und setzt die Arbeit fort, die das Update angehalten hat.

Solange es auf laufende Arbeit wartet, lässt dich **Später aktualisieren** das Update verschieben, bis du es wieder wählst.
Deine Arbeit läuft weiter.

Wenn Infinitary den Neustart nicht abschließen konnte, heißt die Schaltfläche **Neu starten**.
Drück sie noch einmal, sobald deine laufende Arbeit stoppt.

Infinitary aktualisiert sich nur aus dem Ordner „Programme“ heraus.
Wenn es vom Disk-Image läuft, zieh es in „Programme“, wirf das Disk-Image aus und öffne die Kopie in „Programme“.

## Eine Mac-Kopie von Homebrew {#a-mac-copy-from-homebrew}

Eine Kopie, die du mit Homebrew installiert hast, wird über Homebrew aktualisiert.
Der Hinweis zeigt den Befehl, mit **Befehl kopieren**:

```sh wrap
brew update && brew upgrade --cask infinitary-labs/tap/infinitary
```

Führ ihn im Terminal aus.
Homebrew beendet Infinitary, während es es ersetzt, öffne Infinitary also wieder, wenn es fertig ist.

## Linux {#linux}

- **Ubuntu, Debian und Fedora**, aus dem .deb- oder .rpm-Paket: Drück **Installieren**.
  Infinitary lädt die neue Version herunter, prüft sie, sichert die Arbeit deiner Crew und fragt nach deinem Passwort, dann startet es wieder.
- **Ein AppImage**: Drück **Installieren**.
  Infinitary ersetzt die AppImage-Datei durch die neue Version und startet wieder, ohne Passwort.
  Es muss den Ordner ändern können, in dem das AppImage liegt.
- **Arch, Omarchy und NixOS** werden über ihre eigene Paketverwaltung aktualisiert.
  Der Hinweis zeigt den Befehl, mit **Befehl kopieren**; führ ihn in einem Terminal aus.

Wenn das Installieren nicht abgeschlossen werden kann, ändert sich nichts, und die Arbeit deiner Crew läuft weiter.
Der Hinweis zeigt dann einen Befehl, der dieselbe Version von Hand installiert.

## Windows {#windows}

1. Drück **Aktualisieren und neu starten**.
2. Infinitary lädt den neuen Installer herunter, prüft seine Prüfsumme und sichert die Arbeit deiner Crew.
3. Infinitary schließt sich, der Installer ersetzt es, und Infinitary öffnet sich wieder mit der neuen Version.

Wenn das Installieren nicht abgeschlossen werden kann, ändert sich nichts, und die Arbeit deiner Crew läuft weiter.

## Deine anderen Computer und dein Telefon {#your-other-computers-and-your-phone}

Ein Computer, den du hinzugefügt hast, wird von dem Computer aus aktualisiert, auf dem dein erster Offizier lebt.
In Einstellungen → **Geräte** zeigt ein Computer mit einer anderen Version in seiner Zeile **Aktualisieren**.
Er bekommt die Version dieses Computers, seine laufende Arbeit stoppt kurz und geht danach weiter.

Auf einem Computer, der deinen ersten Offizier steuert, hat Einstellungen → **Allgemein** eine Zeile für Infinitary auf dem Computer, auf dem dein erster Offizier lebt.
Wenn dieser Computer ein Update bereit hat, drück **Aktualisieren** gefolgt von seinem Namen, um das Update von dort aus zu starten, wo du bist.
Auch dein Telefon kann dieses Update starten, nachdem es dich zuerst gefragt hat.
Siehe [Deine anderen Computer](/de/your-other-computers/) und [iPhone und iPad](/de/iphone-and-ipad/).

## Infinitary entfernen {#remove-infinitary}

Wenn du die App entfernst, bleibt deine gespeicherte Arbeit erhalten, sodass du beim erneuten Installieren von Infinitary dort weitermachst, wo du aufgehört hast.
Wenn dieser Computer Arbeit für einen anderen ausführt, drück vorher **Verlassen** in Einstellungen → **Geräte**.

- **Eine Mac-Kopie von der Download-Seite**: Beende Infinitary und zieh es aus „Programme“ in den Papierkorb.
- **Eine Mac-Kopie von Homebrew**: Führ `brew uninstall --cask infinitary` im Terminal aus.
  Häng nie `--zap` an: Es löscht deine gespeicherte Arbeit.
- **Linux**: Entfern das Paket mit dem Software-Installer oder der Paketverwaltung, mit dem du es installiert hast.
  Bei einem AppImage lösch die Datei.
- **Windows**: Wähl in den Windows-Einstellungen → **Apps** → **Installierte Apps** im Menü von Infinitary **Deinstallieren**.

Deine gespeicherte Arbeit liegt auf einem Mac in `~/Library/Application Support/infinitary`, unter Linux in `~/.config/infinitary` und unter Windows in `%APPDATA%\infinitary`.

### Was deine gespeicherte Arbeit löscht {#what-deletes-your-saved-work}

Diese Schritte löschen diesen Ordner, und was Infinitary dort aufbewahrt hat, geht mit:

- `brew uninstall --zap`.
- Ein Deinstallationsprogramm, das auch die Hilfsdateien einer App entfernt.
- Den Ordner selbst in den Papierkorb zu legen oder ihn zu löschen.

Auf einem Computer, der Arbeit für einen anderen ausführt, enthält dieser Ordner den eigenen Schlüssel des Computers, seine Arbeitskopien und die Dateien seiner Aufgaben.
Ohne ihn verbindet sich der Computer erneut als neuer Eintrag, und Arbeit, die er noch nicht zurückgebracht hatte, bleibt verloren.
Siehe [Ein Computer steht zweimal in der Liste](/de/troubleshooting/#a-computer-is-listed-twice).
