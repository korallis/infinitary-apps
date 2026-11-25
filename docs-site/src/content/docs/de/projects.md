---
source: 8639808a6f4bc6d7
title: Projekte
description: Wie du ein Projekt zu Infinitary hinzufügst, das Fenster auf eines konzentrierst, wählst, wie seine Änderungen zusammengeführt werden, und es entfernst.
---

Ein Projekt ist das, woran deine Crew arbeitet: ein Ordner von dir, der mit git verwaltet wird.
Jede Aufgabe gehört zu einem Projekt, und jedes Aufgabenkürzel beginnt mit dem Kürzel seines Projekts, etwa `WEB-12`.
Deine Projekte stehen unter **Einstellungen → Projekte**.

## Ein Projekt hinzufügen {#add-a-project}

Du kannst ein Projekt auf zwei Wegen hinzufügen.

- **Bitte deinen ersten Offizier.**
  Sag, an welchem Projekt gearbeitet werden soll, zum Beispiel „Klone das Projekt unter“ und dann seinen Link.
  Dein erster Offizier bringt dir eine Karte, die das Projekt und seine Einstellungen nennt.
  Es wird nichts hinzugefügt, bis du auf dieser Karte **Projekt hinzufügen** drückst.
- **Füg es selbst hinzu.**
  Öffne **Einstellungen → Projekte** und nutze die Zeile **Projekt hinzufügen** am Ende der Liste.

Die Zeile **Projekt hinzufügen** hat drei Schaltflächen:

1. **Ordner auf diesem Computer** fügt einen Ordner hinzu, den du schon hast.
   Wenn der Ordner noch kein git nutzt, startet Infinitary dort git mit einem leeren ersten Commit.
2. **Projekt auf GitHub**, **Projekt auf GitLab** oder **Projekt auf Bitbucket** klont ein Projekt von dort, wo es liegt.
   Wähl es unter **Deine Projekte auf GitHub**, such es mit **Projekt suchen** oder füg seinen Link ein.
   Bei vielen Projekten sind vielleicht nicht alle geprüft, und die Liste sagt das; füg den Link ein, um ein fehlendes Projekt hinzuzufügen.
3. **Neues Projekt** startet ein leeres Projekt mit dem Namen, den du eintippst.

Ein geklontes oder neues Projekt kommt in deinen Projektordner.
Die Zeile **Neue Projekte kommen in** zeigt diesen Ordner, und **Ordner wählen** ändert ihn.
Projekte, die du schon hinzugefügt hast, wandern dabei nie um.

Das **Aufgabenkürzel** ist optional.
Gib bis zu vier Buchstaben oder Ziffern ein, und die Aufgaben des nächsten Projekts werden damit nummeriert.
Lass es leer, und Infinitary bildet ein Kürzel aus dem Namen des Projekts.

Für ein Projekt bei einem anderen Host frag deinen ersten Offizier.

## Deine Anmeldung bei GitHub, GitLab oder Bitbucket {#your-github-gitlab-or-bitbucket-sign-in}

Um ein Projekt zu klonen und seine Änderungen anzubieten, nutzt Infinitary deine Anmeldung bei GitHub, GitLab oder Bitbucket.

Bist du nicht angemeldet, wenn du auf **Projekt auf GitHub**, **Projekt auf GitLab** oder **Projekt auf Bitbucket** drückst, zeigt die Zeile statt deiner Projekte **Bei GitHub anmelden**, **Bei GitLab anmelden** oder **Bei Bitbucket anmelden**.
Diese Schaltfläche öffnet **Einstellungen → Integrationen**, wo deine Anmeldungen liegen; siehe [Integrationen](/de/integrations/).
Bei GitHub gibst du einen Code auf der Seite von GitHub in deinem Browser ein.
Bei GitLab kannst du dich in deinem Browser anmelden oder einen Schlüssel einfügen, auf gitlab.com oder auf deinem eigenen GitLab-Server.
Bei Bitbucket erstellst du in deinem Atlassian-Konto ein API-Token und fügst es ein, für Projekte auf bitbucket.org.
Das Schlüsselformular nennt die Berechtigungen, die du auf der Seite von Atlassian ankreuzen musst.
Für deinen eigenen Bitbucket-Data-Center-Server ab Version 8.19 gibst du seine Adresse ein und fügst ein HTTP-Zugriffstoken mit den Berechtigungen Project read und Repository write ein.
Die Änderungen eines Data-Center-Projekts werden als Pull Requests angeboten, und zusammengeführt wird nur die Version, die du freigegeben hast: Wenn in der Zwischenzeit jemand pusht, wird nichts zusammengeführt, und die Aufgabe sagt das.
Ein Data-Center-Projekt kann auch gebündelte Pull Requests wählen, und deine Crew kann auf dem Server lesen und schreiben, über deinen Fork beitragen und bei neuen Kommentaren zu ihrem Pull Request und bei einer fehlgeschlagenen Überprüfung auf dem Hauptbranch aufwachen.
Ein Data-Center-Server hat keine eigenen Prüfprotokolle, Läufe oder Release-Dateien: Seine Überprüfungen kommen von einem anderen Dienst, und jede verlinkt, wo ihr Protokoll steht.
Deine Bitbucket-Projekte werden aus den Arbeitsbereichen aufgelistet, zu denen du gehörst; bei vielen sind vielleicht nicht alle geprüft, und die Liste sagt das.
Die Änderungen eines Bitbucket-Projekts werden als Pull Requests angeboten, wie bei GitHub und GitLab; ein Projekt, das du vorher hinzugefügt hast, funktioniert ab seiner nächsten Aufgabe genauso.
Die Beschreibung eines Bitbucket-Pull-Requests enthält die Geschichte als Text, und ihre Bilder bleiben auf der Karte.
Ein Bitbucket-Projekt kann auch gebündelte Pull Requests wählen, und sein Zusammenführen folgt den Strategien und der Merge-Warteschlange, die sein Hauptbranch auf bitbucket.org hat.
Bei einem Bitbucket-Projekt kann deine Crew außerdem die Pipelines des Projekts und das Log eines Schritts lesen, eine Release-Datei in seine Downloads legen und bei neuen Kommentaren zu seinem Pull Request aufwachen, wie bei GitHub und GitLab; Bitbucket bietet keinen Download der Artefakte einer Pipeline.
Deine Anmeldung bleibt auf diesem Computer.

Wenn eine Anmeldung nicht mehr funktioniert, bittet dich eine Karte, dich erneut anzumelden.
Arbeit, die sie braucht, wartet, bis du das getan hast.

## Arbeitskopien {#working-copies}

Deine Crew arbeitet nie direkt im Ordner deines Projekts.
Jedes Crewmitglied arbeitet in seiner eigenen Arbeitskopie deines Projekts, auf seinem eigenen Branch.
Deine Dateien bleiben unverändert, bis du eine Änderung zusammenführst.

## Auf ein Projekt konzentrieren {#focus-on-one-project}

Bei zwei oder mehr Projekten zeigt die obere Leiste eine Projektauswahl.
Drück darauf oder drück ⇧⌘P (Ctrl+Shift+P unter Linux und Windows), um eine Reihe deiner Projekte zu öffnen.
Jede Auswahl zählt die Aufgaben, die auf dich warten, und die Aufgaben, die gerade in Arbeit sind.
Wähl ein Projekt, um das Fenster darauf zu konzentrieren.

Solange ein Projekt im Fokus ist:

- Das Panel „Aufgaben“ und die Aufgabenboard zeigen nur die Aufgaben dieses Projekts.
- Aktivität zeigt nur die Zeilen zu diesem Projekt und die Zeilen, die zu keiner Aufgabe gehören.
- Karten zu anderen Projekten warten, bis der Fokus wechselt.
  Nichts wird geschlossen, und jedes Projekt sendet weiterhin Mitteilungen.
- Eine kurze Zeile neben der Auswahl sagt, wie viele Aufgaben anderswo auf dich warten, etwa „2 warten woanders“.
- Dein erster Offizier legt neue Arbeit, um die du bittest, in diesem Projekt an, es sei denn, du nennst ein anderes.

Drück auf das **×** neben der Auswahl (**Alle Projekte anzeigen**) oder wähl **Alle Projekte** in der Reihe, um wieder alles zu sehen.
Infinitary merkt sich deinen Fokus, wenn du es neu startest.

## Wie Änderungen in dein Projekt kommen {#how-changes-reach-your-project}

Öffne ein Projekt unter **Einstellungen → Projekte**, um zu wählen, wie seine fertige Arbeit zusammengeführt wird.
**Wohin Änderungen gehen** bietet:

- **Pull Requests**: Jede Änderung wird als Pull Request auf GitHub, GitLab oder Bitbucket angeboten.
- **Gebündelte Pull Requests**: Deine bestätigten Änderungen werden zu einem Bündel-Pull-Request zusammengefasst, mit einem Commit je Änderung, und zusammengeführt, sobald seine Überprüfungen erfolgreich sind.
- **Lokal zusammenführen**: Die Änderung wird auf diesem Computer in das Projekt zusammengeführt, ohne Pull Request.

Ein Projekt, das nur auf diesem Computer liegt, bietet allein **Lokal zusammenführen**.

Wenn eine Änderung bereit ist, bringt dir ihr Crewmitglied eine Karte zum Zusammenführen.
Die Schaltfläche der Karte sagt, was sie tut, etwa **Pull Request zusammenführen**, **Branch zusammenführen** oder **Im nächsten Bündel zusammenführen**.
Laufen die Überprüfungen noch, steht auf der Schaltfläche **Zusammenführen, sobald die Überprüfungen erfolgreich sind**, und Infinitary führt zusammen, sobald sie erfolgreich waren.

**Vor dem Zusammenführen fragen** entscheidet, wer zusammenführt.
Bei einem neuen Projekt ist es an, damit fertige Arbeit auf dein Wort wartet.
Schalte es aus, und Arbeit, die die Überprüfungen besteht, darf ohne Rückfrage zusammengeführt werden.

**Sorgfalt** legt fest, wie gründlich Arbeit geprüft wird: **Schnell**, **Standard** oder **Sorgfältig**.

## Ein Projekt entfernen {#remove-a-project}

1. Öffne das Projekt unter **Einstellungen → Projekte**.
2. Drück in seiner letzten Zeile auf **Entfernen**.
3. Drück zur Bestätigung noch einmal auf **Entfernen**.

Beim Entfernen verschwindet das Projekt aus der Liste.
Sein Ordner und seine fertigen Aufgaben bleiben.
Hat das Projekt noch Aufgaben, nennt Infinitary sie, und du schließt sie zuerst ab oder gibst sie auf.

## Weiter {#next}

- [Aufgaben und Crewmitglieder](/de/tasks-and-crewmates/)
- [Karten und Entscheidungen](/de/cards-and-decisions/)
