---
source: 6bc810f8c25a2b9e
title: Was deinen Computer verlässt
description: Was Infinitary sendet, wohin es geht und der eine Schalter, der überhaupt etwas an uns sendet.
---

Infinitary läuft auf deinem Computer, über die Abos, die du schon hast.
Es braucht kein Konto bei uns, und deine Arbeit läuft nicht über uns.
Diese Seite listet auf, was die App sendet und wohin.

## Deine Arbeit geht an den Anbieter, den du gewählt hast {#your-work-goes-to-the-provider-you-chose}

Dein erster Offizier und deine Crew denken über die KI-Abos, bei denen du dich angemeldet hast.
Deine Nachrichten und das, was ein Crewmitglied von deinem Projekt liest, um seine Aufgabe zu erledigen, gehen über dein Abo an diesen Anbieter.
Bei Claude nutzt Infinitary das Claude Code, das du installiert hast, angemeldet bei deinem eigenen Konto.
Bei einem eigenen Anbieter geht es an die Adresse, die du eingegeben hast.

Deine Anmeldungen bleiben auf deinem Computer.

## Deine Projekte gehen dorthin, wo sie liegen {#your-projects-go-where-they-live}

Ein Crewmitglied arbeitet in einer Arbeitskopie deines Projekts auf deinem Computer.
Wenn eine Aufgabe als Pull Request angeboten wird, wird ihr Branch dorthin gepusht, wo dein Projekt liegt, etwa GitHub, GitLab oder Bitbucket, und der Pull Request wird dort geöffnet.
Ein Projekt, das auf diesem Computer bleibt, bleibt nur auf diesem Computer.

Wenn ein Crewmitglied eine Arbeitskopie vorbereitet oder seine Aufgabe erledigt, kann es holen, was dein Projekt braucht, so wie du es von Hand tun würdest.

## Deine anderen Computer und dein Telefon {#your-other-computers-and-your-phone}

Die Computer und Telefone, die du hinzufügst, sprechen mit dem Computer, auf dem dein erster Offizier lebt.
Einstellungen → **Geräte** sagt, wie sie ihn finden.
**Über das Internet** steht auf „Nie. Infinitary öffnet diesen Computer nicht für das Internet.“

Eine Anmeldung, die du für einen anderen Computer eintippst, geht einmal an diesen Computer.
Der Computer, auf dem dein erster Offizier lebt, behält keine Kopie.
Siehe [Deine anderen Computer](/de/your-other-computers/).

## Integrationen, die du verbindest {#integrations-you-connect}

Eine Integration, die du in Einstellungen → **Integrationen** verbindest, etwa Google, wird mit ihrer eigenen Anmeldung erreicht, die auf dem Computer bleibt, auf dem du dich angemeldet hast.
Dein erster Offizier und deine Crew lesen sie erst, wenn du sie verbindest.
Siehe [Integrationen](/de/integrations/).

## Die Nutzungsberichte deiner Firma {#your-companys-usage-reporting}

Wenn deine Claude-Code-Einstellungsdatei oder deine Shell Nutzungsberichte für deine Firma einrichtet, wie es die Anleitung von Claude Code beschreibt, schickt Infinitary die Nutzung aller Arbeit hier an dieselbe Stelle.
Claudes Arbeit geht als die Einträge, die Claude Code selbst dorthin schicken würde.
Die Arbeit jedes anderen Modells geht unter denselben Namen, mit Modell, Anbieter, Tokens, geschätzten Kosten, ob dein erster Offizier oder ein Crewmitglied sie getan hat, der Art der Arbeit und der E-Mail-Adresse deiner Claude-Code-Anmeldung, nie mit deinen Worten, Aufgabentiteln oder Projektnamen.
Einstellungen → **Nutzung** nennt, wohin sie geht.
Weist diese Stelle Claudes Arbeit immer wieder ab oder ist sie nicht erreichbar, sagt diese Zeile das stattdessen.
Eine Einrichtung, die der Administrator deiner Firma für den ganzen Computer verwaltet, erreicht Claude Code direkt, wie bisher, und Infinitary schickt die Arbeit jedes anderen Modells ebenfalls dorthin, auf dieselbe Weise.
Beide Arten von Einrichtung bekommen nur Claudes Arbeit, wenn sie ihre Nutzung über gRPC schicken, und Einstellungen → **Nutzung** sagt das dann.

## Suche nach Updates {#update-checks}

Infinitary sucht alle paar Stunden nach einer neueren Version, an der Stelle, an der seine Versionen veröffentlicht werden.
Diese Suche sendet keinen Inhalt von dir und keine ID.
Die erste Suche jedes Tages und die erste jedes Monats sagt außerdem, dass sie die erste ist, damit Infinitary Labs zählen kann, wie viele Computer Infinitary nutzen.
Das geschieht, was auch immer der Schalter **Diagnose** sagt, und eine mit Homebrew installierte Kopie sendet es nicht.
Eine neue Version lädt es nur herunter, wenn du dich zum Aktualisieren entscheidest.
Du kannst auch selbst **Nach Updates suchen** drücken.
Siehe [Infinitary aktualisieren und entfernen](/de/update-and-remove/).

## Diktat {#dictation}

Das Diktat verwandelt deine Stimme auf deinem Computer in Worte.
Bei der ersten Nutzung fragt es, bevor es einmalig sein Sprachmodell herunterlädt.

## Diagnose, der eine Schalter, der etwas an uns sendet {#diagnostics-the-one-switch-that-sends-to-us}

Einstellungen → **Allgemein** → **Teilen** hat den Schalter **Diagnose**.
Er ist der einzige Schalter, der etwas an uns sendet; das Einzige, was uns ohne ihn erreicht, ist der Hinweis zum ersten Tag und ersten Monat bei der Suche nach Updates oben, den **Teilen** ebenfalls beschreibt.
Er ist eingeschaltet, solange du ihn nicht ausschaltest, und nichts in der App hängt von ihm ab.

Beim ersten Start sagt ein Hinweis unter dem Nachrichtenfeld, was er sendet, mit **Ausschalten** und **OK**.
Nichts wird gesendet, bevor du antwortest.

Die Diagnose sendet anonyme Nutzungsereignisse:

- dass die App geöffnet wurde,
- dass dein erster Offizier einen Zug beendet hat oder daran gescheitert ist, mit nur der Art des Fehlers,
- wie weit die Ersteinrichtung gekommen ist,
- und von einem iPhone oder iPad, das du hinzugefügt hast, dass die App geöffnet wurde, dass sie eingerichtet wurde, dass eine Nachricht gesendet und eine Karte beantwortet wurde.

Jedes Ereignis trägt die App-Version und eine zufällige Installations-ID.
Die ID ist mit nichts über dich oder deinen Computer verbunden und wird ersetzt, sobald die Diagnose aus- und wieder eingeschaltet wird.
Es werden keine Texte von dir, keine Namen und keine Pfade gesendet: nie eine Unterhaltung, Code oder eine Karte.
Dein Telefon sendet selbst nichts; dein Computer sendet seine Ereignisse unter demselben Schalter.

Um genau zu sehen, was gehen würde, öffne unter **Teilen** den Eintrag **Was dieser Computer verlassen würde**.
Er zeigt die Installations-ID, was auf das Senden wartet, was gesendet wurde und jedes Ereignis, das die Diagnose senden kann.
Schalte **Diagnose** aus, und nichts wird mehr aufgezeichnet oder gesendet.

## Geheimnisse {#secrets}

Werte, die du in Einstellungen → **Geheimnisse** aufbewahrst, bleiben auf deinem Computer.
Jeder Wert geht direkt in die Geheimnisse: Infinitary zeigt ihn nie wieder, und weder der erste Offizier noch die Crew bekommt ihn.
Siehe [Geheimnisse](/de/secrets/).
