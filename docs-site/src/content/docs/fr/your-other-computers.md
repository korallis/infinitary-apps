---
source: 3e0fd8cde41ac0cf
title: Vos autres ordinateurs
description: Ajoutez vos autres ordinateurs pour piloter votre second depuis n’importe lequel d’entre eux, leur confier le travail de vos projets et garder une copie capable de prendre le relais.
---

Votre second vit sur un seul ordinateur.
Ses tâches, ses cartes et sa conversation y restent.
Depuis tout ordinateur que vous ajoutez, vous pouvez piloter votre second, et tout ordinateur que vous ajoutez peut exécuter le travail d’un projet.

Vous trouvez tout cela dans Réglages → **Appareils**, sous **Vos appareils**.
Ouvrez les Réglages avec ⌘, (Ctrl+, sous Linux et Windows).

## L’ordinateur où vit votre second {#the-computer-where-your-first-mate-lives}

Choisissez un ordinateur qui reste allumé le plus possible.
Vos autres ordinateurs et votre téléphone ont besoin qu’il soit éveillé, avec Infinitary ouvert.

Pendant qu’il est en veille ou hors de portée :

- Un autre ordinateur affiche ce qu’il a vu en dernier, et indique « Les modifications sont désactivées ».
  Un message que vous y tapez n’est pas envoyé, et vos mots restent dans la zone de message jusqu’au retour de cet ordinateur.
- Automatisation ne s’exécute que lorsqu’Infinitary y est ouvert et que l’ordinateur est éveillé.
  Une exécution manquée entre-temps a lieu une fois à son retour.

## Ajouter un ordinateur {#add-a-computer}

1. Sur l’ordinateur où vit votre second, ouvrez Réglages → **Appareils**.
2. Appuyez sur **+ Un ordinateur**.
3. Tapez l’adresse de l’autre ordinateur et appuyez sur **L’ajouter**.

Ajouter un ordinateur par son adresse est la façon de commencer : cet ordinateur tient ensuite l’autre à jour et le joint de lui-même, sans visite là-bas après la configuration.
Tapez l’adresse que vous utilisez avec SSH pour l’autre ordinateur, comme `you@mini.local`.
Session à distance doit y être activée ; sous Linux, son serveur SSH.
Les ordinateurs du même réseau sont listés sous **Sur ce réseau**, pour que vous puissiez en choisir un.
Vous pouvez aussi demander à votre second d’ajouter un ordinateur, et il recommande l’adresse.

Sur un nouveau Mac ou un nouvel ordinateur Linux x64, le premier lancement d’Infinitary affiche l’adresse à taper : choisissez **Configurer depuis l’ordinateur de votre second**.
Il affiche d’abord l’adresse de cet ordinateur sur le réseau privé, comme celle de Tailscale, puis son adresse sur le réseau local, chacune avec **Copier**.
Une fois que l’ordinateur où vit votre second l’a ajouté, cette fenêtre ouvre votre second d’elle-même, tant que rien n’y a encore été configuré.
Une fenêtre où vous vous êtes déjà connecté, avez ajouté un projet ou parlé à son second garde son propre second, tout comme une fenêtre à côté d’un Infinitary que vous avez lancé vous-même depuis Terminal.
Si Infinitary était fermé sur cet ordinateur quand il a été ajouté, il ouvre votre second au prochain lancement, quoi qu’on y ait configuré.
Un PC Windows et un ordinateur Linux Arm rejoignent plutôt avec **Coller son lien**.

Sous l’adresse, **Impossible d’y activer la Session à distance ?** propose deux autres façons.
Chacune ajoute le même type d’ordinateur.

**Coller un lien dans Infinitary là-bas**, quand vous êtes devant cet ordinateur, ou que c’est un PC Windows.
Copiez le lien, puis ouvrez Infinitary pour la première fois sur l’autre ordinateur.
Sous **Votre second est sur un autre ordinateur**, choisissez **Coller son lien**, collez-le et appuyez sur **Continuer**.
Infinitary demande une fois s’il faut piloter votre second depuis là ; appuyez sur **Le contrôler d’ici**.

**Exécuter une commande là-bas**, quand vous pouvez taper dans Terminal là-bas mais que Session à distance est désactivée.
Copiez la commande et exécutez-la une fois dans Terminal sur l’autre ordinateur, sous l’utilisateur qui doit exécuter son travail.
Elle récupère Infinitary depuis cet ordinateur, les deux doivent donc être sur le même réseau.

Quand votre second vit sur un PC Windows, **+ Un ordinateur** ne propose que le lien et la commande.

Un lien ou une commande fonctionne une fois, pendant dix minutes, et vous pouvez appuyer sur **L’arrêter** avant.
Vous pouvez aussi rejoindre depuis l’autre ordinateur : à son premier lancement, choisissez **Rejoindre par son adresse** et tapez l’adresse de l’ordinateur où vit votre second.

## Piloter votre second depuis un autre ordinateur {#control-your-first-mate-from-another-computer}

Une fois qu’un ordinateur a rejoint, ouvrir Infinitary dessus affiche votre second.
Le haut de la fenêtre indique « Contrôle de votre second sur » suivi du nom de cet ordinateur.
Vos cartes, vos tâches et votre conversation restent sur l’ordinateur où vit votre second.

Chaque ordinateur garde ses propres Apparence, Clavier et Panneaux.
Les autres sections des Réglages se lisent et se changent sur l’ordinateur où vit votre second.

Pour arrêter, ouvrez Réglages → **Appareils** sur cet ordinateur et appuyez sur **Quitter**.
Pour couper un ordinateur de l’ordinateur où vit votre second, ouvrez son menu, les trois points sur sa ligne, et choisissez **Retirer**.
Un ordinateur qui ne fait que piloter votre second a besoin d’un nouveau lien pour revenir.

## Un ordinateur qui exécute le travail {#a-computer-that-runs-work}

Tout ordinateur que vous ajoutez peut exécuter le travail d’un projet, sans fenêtre ouverte.
Il se connecte à ses propres abonnements, et une tâche qui s’y exécute n’utilise que ceux-là.
Connectez-le à un abonnement dans Réglages → **Intelligence**, où les connexions de chaque ordinateur sont listées sous son nom.
Confiez-lui ensuite un projet.

Dans Réglages → **Projets**, ouvrez un projet et réglez **S’exécute sur** : **Automatiquement**, **Cet ordinateur** ou l’un de **Vos ordinateurs**.
Tant que cet ordinateur est hors de portée, les tâches du projet attendent, et ne s’exécutent jamais sur cet ordinateur-ci à la place.

Un ordinateur peut aussi exécuter le travail sous un autre utilisateur de l’ordinateur où vit votre second.
Appuyez sur **+ Sous un autre utilisateur** pour créer sa commande.

Retirer un ordinateur qui exécute le travail ramène d’abord son travail non fusionné.

## Déplacer une tâche vers un autre ordinateur {#move-a-task-to-another-computer}

Une tâche démarrée peut passer sur un autre ordinateur qui exécute le travail.
Ouvrez sa fiche et appuyez sur **Déplacer vers un ordinateur**, puis choisissez sa destination.
Elle garde sa clé, sa branche, ses fichiers et sa fiche.
La tâche se déplace une fois que son équipier a fini ce qu’il fait ; d’ici là, vous pouvez appuyer sur **Annuler le déplacement**.

## Les fichiers sur un autre ordinateur {#files-on-another-computer}

Un équipier peut copier un fichier d’un autre de vos ordinateurs dans sa tâche, pour le lire.
Il ne fait que lire : rien n’est écrit sur un autre ordinateur.
Chaque copie ajoute une ligne à l’Activité de la tâche, qui nomme le fichier et l’ordinateur d’où il vient.

## Déplacer votre second {#move-your-first-mate}

Dans le menu d’un ordinateur qui exécute le travail, les trois points sur sa ligne, **Déplacer votre second ici** y déplace votre second.
Une liste montre d’abord tout ce qui fait obstacle.
Les [Secrets](/fr/secrets/) restent sur l’ordinateur qu’il quitte, et vous vous reconnectez là-bas à vos abonnements.

## Garder une copie sur un autre ordinateur {#keep-a-copy-on-another-computer}

Un ordinateur qui exécute le travail peut garder une copie à jour de la fiche de votre second.
Si l’ordinateur où vit votre second est alors perdu, ou longtemps hors de portée, cet ordinateur peut [prendre le relais](#take-over).

1. Sur l’ordinateur où vit votre second, ouvrez Réglages → **Appareils** et choisissez l’autre ordinateur.
2. Ouvrez son menu, les trois points sur sa ligne, et choisissez **Garder une copie ici**.

Il prend une copie complète, puis chaque changement qu’enregistre votre second.
Sa ligne indique où en est la copie, comme **Copie à jour** ou **Copie en rattrapage · 3 modifications**, et, tant qu’il est hors de portée, **Copie de** suivi d’une heure.
Vous pouvez garder une copie sur plusieurs ordinateurs.

La copie contient les tâches, les cartes, la conversation, les connaissances et les automatisations de votre second.
Cet ordinateur ne l’ouvre jamais tant qu’il ne prend pas le relais.
À elle seule, la copie ne contient aucun de vos projets, aucune connexion ni aucun Secret :

- Quand il prend le relais, chaque projet est de nouveau cloné depuis l’endroit où il est hébergé.
  Un projet gardé uniquement sur l’ordinateur perdu y démarre vide.
- **Prêt à prendre le relais**, dans son menu, liste ce dont cet ordinateur aurait encore besoin, comme sa propre connexion à chaque abonnement qu’utilise votre second, et à l’endroit où vos projets sont hébergés.
  Un bouton pour chacun, comme **Se connecter à GitHub là-bas**, lance cette connexion depuis cette fenêtre.
- **Y garder les Secrets**, dans la même liste, garde vos Secrets avec la copie une fois que vous confirmez sur cet ordinateur lui-même.
  Voir [Secrets](/fr/secrets/#when-your-first-mate-moves).

**Ne plus garder de copie**, dans cette liste, y met fin, et cet ordinateur supprime sa copie dès qu’il est à portée.

Avant une fusion, un envoi ou une utilisation de secret, votre second attend que chaque copie à portée ait reçu tous les changements jusque-là.
Un ordinateur qui prend le relais sait alors ce qui a déjà été fait, et ne le refait pas.

## Prendre le relais {#take-over}

Pendant que l’ordinateur où vit votre second est hors de portée, un ordinateur qui garde une copie peut prendre le relais : votre second y démarre à partir de sa copie.
Rien ne prend le relais de soi-même, et aucun minuteur n’en décide : seul votre clic le fait.

Ouvrez Infinitary sur un ordinateur qui garde une copie, et ouvrez Réglages → **Appareils**.
Sous **Contrôle**, **Prendre le relais** indique de quand date cette copie, et si l’ordinateur de votre second a signalé qu’il allait se mettre en veille ou qu’Infinitary y avait quitté.
Il liste aussi chaque autre copie, marquée **peut-être plus récente** quand elle peut contenir plus de changements.
Si une copie plus récente est à portée, cet ordinateur la récupère d’abord.

1. Appuyez sur **Prendre le relais**.
2. Appuyez de nouveau sur **Prendre le relais** pour confirmer, ou sur **Rester** pour laisser les choses en l’état.
3. Sur un Mac, confirmez avec Touch ID ou votre mot de passe ; sur un PC Windows, avec Windows Hello ou votre mot de passe Windows.

Votre second démarre alors sur cet ordinateur, qui devient l’ordinateur où vit votre second.
Vos autres ordinateurs et votre téléphone l’y trouvent d’eux-mêmes, sans nouveau lien.
Une carte y demande chaque connexion qui lui manque, et vous ajoutez de nouveau vos Secrets, sauf s’il les a gardés.

Votre téléphone peut aussi demander à un ordinateur de prendre le relais.
Pendant que votre ordinateur est hors de portée, touchez le bouton de l’ordinateur à droite de la barre du haut du téléphone.
Sa feuille propose **Prendre le relais** pour chaque ordinateur qui garde une copie, puis demande Face ID ou votre code.

### Si l’ordinateur perdu revient {#if-the-lost-computer-comes-back}

L’ordinateur perdu cesse d’être l’ordinateur de votre second quand il revient, et garde une copie à la place.
Sous **Relayé**, ses Réglages → **Appareils** listent ce qu’il a enregistré après la copie, qui n’a jamais atteint votre second.
Il garde cette fiche de côté, et rien ne l’ouvre de nouveau.

Si deux ordinateurs répondent tous deux comme votre second, Réglages → **Appareils** demande sous **Deux seconds** : **Garder celui-ci**, ou garder l’autre.
Les fusions, les envois et les utilisations de secret attendent votre choix, et celui que vous ne gardez pas s’arrête et garde une copie de l’autre.

## Comment les ordinateurs se trouvent {#how-computers-find-each-other}

Réglages → **Appareils** affiche **Comment les autres appareils trouvent cet ordinateur** : **Sur ce réseau** et **Sur votre réseau privé**.
**Par Internet** indique « Jamais. Infinitary n’ouvre pas cet ordinateur à Internet. »
Pour piloter votre second depuis ailleurs, placez les deux ordinateurs sur le même réseau privé.

Voir aussi [iPhone et iPad](/fr/iphone-and-ipad/) et [Dépannage](/fr/troubleshooting/).
