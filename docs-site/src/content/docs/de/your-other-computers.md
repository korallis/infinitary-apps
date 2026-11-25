---
source: 3e0fd8cde41ac0cf
title: Deine anderen Computer
description: Füge deine anderen Computer hinzu, damit du deinen ersten Offizier von jedem aus steuern kannst, sie die Arbeit deiner Projekte ausführen lassen kannst und eine Kopie behältst, die übernehmen kann.
---

Dein erster Offizier lebt auf einem Computer.
Seine Aufgaben, Karten und Unterhaltung bleiben dort.
Von jedem Computer, den du hinzufügst, kannst du deinen ersten Offizier steuern, und jeder Computer, den du hinzufügst, kann die Arbeit eines Projekts ausführen.

Das alles findest du in den Einstellungen unter **Geräte**, bei **Deine Geräte**.
Öffne die Einstellungen mit ⌘, (Strg+, unter Linux und Windows).

## Der Computer, auf dem dein erster Offizier lebt {#the-computer-where-your-first-mate-lives}

Wähl einen Computer, der möglichst oft eingeschaltet bleibt.
Deine anderen Computer und dein Telefon brauchen ihn wach und mit geöffnetem Infinitary.

Solange er schläft oder außer Reichweite ist:

- Ein anderer Computer zeigt den letzten Stand, den er gesehen hat, und sagt „Änderungen sind aus“.
  Eine Nachricht, die du dort tippst, wird nicht gesendet, und deine Worte bleiben im Nachrichtenfeld, bis dieser Computer wieder da ist.
- Automatisierungen laufen nur, solange Infinitary dort geöffnet und der Computer wach ist.
  Ein Lauf, der in der Zwischenzeit ausfällt, wird einmal nachgeholt, wenn er zurückkommt.

## Einen Computer hinzufügen {#add-a-computer}

1. Öffne auf dem Computer, auf dem dein erster Offizier lebt, die Einstellungen → **Geräte**.
2. Drück **+ Einen Computer**.
3. Tipp die Adresse des anderen Computers ein und drück **Hinzufügen**.

Einen Computer über seine Adresse hinzuzufügen ist der Weg für den Anfang: Dieser Computer hält den anderen dann aktuell und erreicht ihn von selbst, ohne dass du nach der Einrichtung dorthin musst.
Tipp die Adresse ein, die du mit SSH für den anderen Computer benutzt, etwa `you@mini.local`.
Dort muss die „Entfernte Anmeldung“ aktiviert sein; unter Linux sein SSH-Server.
Computer im selben Netzwerk stehen unter **In diesem Netzwerk**, du kannst also einen auswählen.
Du kannst auch deinen ersten Offizier bitten, einen Computer hinzuzufügen, und er empfiehlt die Adresse.

Auf einem neuen Mac oder x64-Linux-Computer zeigt der erste Start von Infinitary die Adresse, die du eintippst: Wähl **Vom Computer deines ersten Offiziers einrichten**.
Es zeigt zuerst die Adresse dieses Computers im privaten Netzwerk, etwa die von Tailscale, dann seine Adresse im lokalen Netzwerk, jeweils mit **Kopieren**.
Sobald der Computer, auf dem dein erster Offizier lebt, ihn hinzufügt, öffnet jenes Fenster deinen ersten Offizier von selbst, solange darin noch nichts eingerichtet wurde.
Ein Fenster, in dem du dich schon angemeldet, ein Projekt hinzugefügt oder mit seinem ersten Offizier gesprochen hast, behält seinen eigenen ersten Offizier, und ebenso ein Fenster neben einem Infinitary, das du selbst im Terminal gestartet hast.
War Infinitary auf jenem Computer geschlossen, als er hinzugefügt wurde, öffnet es beim nächsten Start deinen ersten Offizier, egal was darin eingerichtet wurde.
Ein Windows-PC und ein Arm-Linux-Computer treten stattdessen mit **Link einfügen** bei.

Unter der Adresse bietet **Kannst du dort „Entfernte Anmeldung“ nicht aktivieren?** zwei andere Wege.
Jeder fügt dieselbe Art von Computer hinzu.

**Einen Link dort in Infinitary einfügen**, wenn du an jenem Computer bist oder er ein Windows-PC ist.
Kopier den Link und öffne dann Infinitary auf dem anderen Computer zum ersten Mal.
Wähl unter **Dein erster Offizier ist auf einem anderen Computer** die Option **Link einfügen**, füg den Link ein und drück **Weiter**.
Infinitary fragt einmal, ob du deinen ersten Offizier von dort aus steuern willst; drück **Von hier aus steuern**.

**Dort einen Befehl ausführen**, wenn du dort im Terminal tippen kannst, aber die „Entfernte Anmeldung“ aus ist.
Kopier den Befehl und führ ihn einmal im Terminal auf dem anderen Computer aus, als der Benutzer, der dessen Arbeit ausführen soll.
Er holt Infinitary von diesem Computer, daher brauchen beide dasselbe Netzwerk.

Wenn dein erster Offizier auf einem Windows-PC lebt, bietet **+ Einen Computer** nur den Link und den Befehl an.

Ein Link oder Befehl funktioniert einmal, zehn Minuten lang, und du kannst vorher **Stoppen** drücken.
Du kannst auch vom anderen Computer aus beitreten: Wähl beim ersten Start **Über die Adresse beitreten** und tipp die Adresse des Computers ein, auf dem dein erster Offizier lebt.

## Deinen ersten Offizier von einem anderen Computer steuern {#control-your-first-mate-from-another-computer}

Sobald ein Computer beigetreten ist, zeigt Infinitary dort deinen ersten Offizier.
Oben im Fenster steht „Du steuerst deinen ersten Offizier auf“ und der Name dieses Computers.
Deine Karten, Aufgaben und Unterhaltung bleiben auf dem Computer, auf dem dein erster Offizier lebt.

Jeder Computer behält sein eigenes Erscheinungsbild, seine eigene Tastatur und seine eigenen Panels.
Die anderen Bereiche der Einstellungen werden auf dem Computer gelesen und geändert, auf dem dein erster Offizier lebt.

Um aufzuhören, öffne auf diesem Computer die Einstellungen → **Geräte** und drück **Verlassen**.
Um einen Computer vom Computer deines ersten Offiziers abzutrennen, öffne sein Menü, die drei Punkte in seiner Zeile, und wähl **Entfernen**.
Ein Computer, der deinen ersten Offizier nur steuert, braucht einen neuen Link, um zurückzukommen.

## Ein Computer, der Arbeit ausführt {#a-computer-that-runs-work}

Jeder Computer, den du hinzufügst, kann die Arbeit eines Projekts ausführen, ohne dass dort ein Fenster offen ist.
Er meldet sich bei seinen eigenen Abos an, und eine Aufgabe, die dort läuft, nutzt nur diese.
Melde ihn in den Einstellungen → **Intelligenz** bei einem Abo an, wo die Anmeldungen jedes Computers unter seinem Namen stehen.
Gib ihm dann ein Projekt.

Öffne in den Einstellungen → **Projekte** ein Projekt und stell **Läuft auf** ein: **Automatisch**, **Dieser Computer** oder einen von **Deine Computer**.
Solange dieser Computer außer Reichweite ist, warten die Aufgaben des Projekts und laufen nie stattdessen auf diesem Computer.

Ein Computer kann auch als anderer Benutzer auf dem Computer Arbeit ausführen, auf dem dein erster Offizier lebt.
Drück **+ Als anderer Benutzer**, um seinen Befehl zu erstellen.

Wenn du einen Computer entfernst, der Arbeit ausführt, kommt seine nicht zusammengeführte Arbeit zuerst zurück.

## Eine Aufgabe auf einen anderen Computer verschieben {#move-a-task-to-another-computer}

Eine gestartete Aufgabe kann auf einen anderen Computer wechseln, der Arbeit ausführt.
Öffne ihr Protokoll und drück **Auf einen Computer verschieben**, dann wähl, wohin sie geht.
Sie behält ihr Kürzel, ihren Branch, ihre Dateien und ihr Protokoll.
Die Aufgabe zieht um, sobald ihr Crewmitglied beendet hat, was es gerade tut; bis dahin kannst du **Verschieben abbrechen** drücken.

## Dateien auf einem anderen Computer {#files-on-another-computer}

Ein Crewmitglied kann eine Datei von einem anderen deiner Computer in seine Aufgabe kopieren, um sie zu lesen.
Es liest nur: Auf einen anderen Computer wird nichts geschrieben.
Jede Kopie fügt der Aktivität der Aufgabe eine Zeile hinzu, die die Datei und den Computer nennt, von dem sie kam.

## Deinen ersten Offizier umziehen {#move-your-first-mate}

Im Menü eines Computers, der Arbeit ausführt, den drei Punkten in seiner Zeile, zieht **Deinen ersten Offizier hierher umziehen** deinen ersten Offizier dorthin um.
Eine Liste zeigt zuerst, was im Weg steht.
[Geheimnisse](/de/secrets/) bleiben auf dem Computer, den er verlässt, und du meldest dich dort erneut bei deinen Abos an.

## Eine Kopie auf einem anderen Computer behalten {#keep-a-copy-on-another-computer}

Ein Computer, der Arbeit ausführt, kann eine aktuelle Kopie des Protokolls deines ersten Offiziers behalten.
Wenn der Computer, auf dem dein erster Offizier lebt, dann verloren geht oder lange außer Reichweite ist, kann dieser Computer [übernehmen](#take-over).

1. Öffne auf dem Computer, auf dem dein erster Offizier lebt, die Einstellungen → **Geräte** und wähl den anderen Computer.
2. Öffne sein Menü, die drei Punkte in seiner Zeile, und wähl **Hier eine Kopie behalten**.

Er legt eine vollständige Kopie an, dann jede Änderung, die dein erster Offizier speichert.
Seine Zeile sagt, wo die Kopie steht, etwa **Kopie aktuell** oder **Kopie holt auf · 3 Änderungen**, und solange er außer Reichweite ist, **Kopie von** einer Uhrzeit.
Du kannst auf mehr als einem Computer eine Kopie behalten.

Die Kopie enthält die Aufgaben, Karten, Unterhaltung, das Wissen und die Automatisierungen deines ersten Offiziers.
Dieser Computer öffnet sie nie, bis er übernimmt.
Für sich genommen enthält die Kopie keine deiner Projekte, Anmeldungen oder Geheimnisse:

- Wenn er übernimmt, wird jedes Projekt von dort, wo es liegt, erneut geklont.
  Ein Projekt, das nur auf dem verlorenen Computer lag, beginnt dort leer.
- **Bereit zur Übernahme** in seinem Menü listet auf, was dieser Computer noch bräuchte, etwa eine eigene Anmeldung bei jedem Abo, das dein erster Offizier nutzt, und dort, wo deine Projekte liegen.
  Eine Schaltfläche für jeden Punkt, etwa **Dort bei GitHub anmelden**, startet diese Anmeldung aus diesem Fenster.
- **Geheimnisse dort behalten** in derselben Liste behält deine Geheimnisse bei der Kopie, sobald du auf diesem Computer selbst bestätigst.
  Siehe [Geheimnisse](/de/secrets/#when-your-first-mate-moves).

**Keine Kopie mehr behalten** in dieser Liste beendet es, und dieser Computer löscht seine Kopie, sobald er in Reichweite ist.

Vor einem Zusammenführen, einem Push oder der Nutzung eines Geheimnisses wartet dein erster Offizier, bis jede Kopie in Reichweite jede Änderung bis dahin hat.
Ein Computer, der dann übernimmt, weiß, was schon getan wurde, und tut es nicht noch einmal.

## Übernehmen {#take-over}

Solange der Computer, auf dem dein erster Offizier lebt, außer Reichweite ist, kann ein Computer, der eine Kopie behält, übernehmen: Dein erster Offizier startet dort aus seiner Kopie.
Nichts übernimmt von selbst, und kein Timer entscheidet: Nur dein Klick zählt.

Öffne Infinitary auf einem Computer, der eine Kopie behält, und öffne die Einstellungen → **Geräte**.
Unter **Steuerung** sagt **Übernehmen**, von wann diese Kopie ist und ob der Computer deines ersten Offiziers gesagt hat, dass er schlafen geht oder dass Infinitary dort beendet wurde.
Es listet auch jede andere Kopie auf, markiert mit **vielleicht neuer**, wenn sie mehr Änderungen enthalten könnte.
Wenn eine neuere Kopie in Reichweite ist, holt dieser Computer sie zuerst.

1. Drück **Übernehmen**.
2. Drück zur Bestätigung noch einmal **Übernehmen**, oder **Bleiben**, damit alles bleibt, wie es ist.
3. Bestätige auf einem Mac mit Touch ID oder deinem Passwort, auf einem Windows-PC mit Windows Hello oder deinem Windows-Passwort.

Dein erster Offizier startet dann auf diesem Computer, der zum Computer wird, auf dem dein erster Offizier lebt.
Deine anderen Computer und dein Telefon finden ihn dort von selbst, ohne neuen Link.
Eine Karte dort fragt nach jeder Anmeldung, die fehlt, und du fügst deine Geheimnisse erneut hinzu, außer er hat sie behalten.

Dein Telefon kann einen Computer ebenfalls bitten zu übernehmen.
Solange dein Computer außer Reichweite ist, tipp auf die Computer-Schaltfläche rechts in der oberen Leiste des Telefons.
Ihr Blatt bietet **Übernehmen** für jeden Computer an, der eine Kopie behält, und fragt dann nach Face ID oder deinem Code.

### Wenn der verlorene Computer zurückkommt {#if-the-lost-computer-comes-back}

Der Computer, der verloren war, ist nicht mehr der Computer deines ersten Offiziers, wenn er zurückkommt, und behält stattdessen eine Kopie.
Unter **Abgegeben** listen seine Einstellungen → **Geräte** auf, was er nach der Kopie gespeichert hat und was deinen ersten Offizier nie erreicht hat.
Er legt dieses Protokoll beiseite, und nichts öffnet es je wieder.

Wenn zwei Computer beide als dein erster Offizier antworten, fragt dich Einstellungen → **Geräte** unter **Zwei erste Offiziere**: **Diesen behalten** oder den anderen behalten.
Zusammenführungen, Pushes und Nutzungen eines Geheimnisses warten, bis du wählst, und der, den du nicht behältst, stoppt und behält eine Kopie des anderen.

## Wie Computer einander finden {#how-computers-find-each-other}

Einstellungen → **Geräte** zeigt **Wie andere Geräte diesen Computer finden**: **In diesem Netzwerk** und **In deinem privaten Netzwerk**.
**Über das Internet** lautet „Nie. Infinitary öffnet diesen Computer nicht zum Internet.“
Um deinen ersten Offizier von anderswo zu steuern, bring beide Computer in dasselbe private Netzwerk.

Siehe auch [iPhone und iPad](/de/iphone-and-ipad/) und [Fehlerbehebung](/de/troubleshooting/).
