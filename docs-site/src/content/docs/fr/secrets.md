---
source: a3a69a749c864ad8
title: Secrets
description: Gardez les mots de passe et les clés dont votre équipage a besoin, autorisez chaque utilisation sur une carte et voyez ce qui les a utilisés.
---

Secrets garde les mots de passe et les clés dont votre équipage a besoin pour son travail, comme la clé qui publie votre site web.
Un équipier utilise un secret par son nom, et seulement une fois que vous autorisez cette utilisation.
Chaque valeur va directement dans Secrets sur votre ordinateur : Infinitary ne l’affiche plus jamais, et ni le second ni l’équipage ne la reçoivent.

<img class="picture-dark" src="/pictures/secrets-dark.webp" alt="Réglages, section Secrets : trois secrets protégés, la clé de messagerie de la newsletter pour Production, le mot de passe de la base de données de la boutique pour Staging et la clé du service météo pour Personnel, aucun encore utilisé, avec Rechercher des secrets, Ajouter un secret, Importer d’un autre outil et Accès, historique et récupération, et une liste Sites connectés vide en dessous." width="1164" height="582" />
<img class="picture-light" src="/pictures/secrets-light.webp" alt="Réglages, section Secrets : trois secrets protégés, la clé de messagerie de la newsletter pour Production, le mot de passe de la base de données de la boutique pour Staging et la clé du service météo pour Personnel, aucun encore utilisé, avec Rechercher des secrets, Ajouter un secret, Importer d’un autre outil et Accès, historique et récupération, et une liste Sites connectés vide en dessous." width="1164" height="582" />

## Où se trouvent vos secrets {#where-your-secrets-live}

Ouvrez **Réglages**, puis **Secrets**, ou cherchez **Ouvrir Secrets** dans la recherche de commandes.

**Secrets protégés** liste chaque secret par son nom et son emplacement, et indique quelle tâche l’a utilisé en dernier, et quand.
**Rechercher des secrets** en trouve un par son nom, son emplacement ou la tâche qui l’a utilisé en dernier.

Sur un Mac, la ligne sous la liste indique « Gardés sur cet ordinateur. Votre équipage les utilise mais ne les voit jamais. »
Sous Linux et Windows, elle indique que votre équipage ne les utilise qu’avec votre approbation, mais que tout programme que vous exécutez peut y accéder tant que le stockage de secrets de votre système est déverrouillé.

Les secrets restent sur l’ordinateur où vit votre second.
Un ordinateur qui contrôle votre second depuis ailleurs n’a pas de section Secrets à lui.

## Garder un secret {#keep-a-secret}

1. Choisissez **Ajouter un secret**.
2. Donnez-lui un **Nom**, comme « Déploiement du site web ».
3. Collez la valeur dans **Valeur du secret**.
4. Si vous gardez deux secrets du même nom, distinguez-les avec **Emplacement (facultatif)**, comme staging ou production.
5. Choisissez **Enregistrer le secret**.

La valeur reste masquée après l’enregistrement, et seule une utilisation que vous autorisez peut la recevoir.
Ouvrez la ligne d’un secret pour **Remplacer** sa valeur ou l’**Oublier**.
Oublier le retire de cet ordinateur, mais ne désactive pas la clé là où elle a été créée.

### Quand un équipier en a besoin d’un que vous n’avez pas gardé {#when-a-crewmate-needs-one-you-have-not-kept}

Un équipier qui a besoin d’un secret que vous n’avez pas gardé le demande par son nom, jamais par sa valeur.
Infinitary affiche alors sa propre carte, comme « Ajouter Déploiement du site web à Secrets ? », avec la raison de l’équipier dans ses propres mots.
Quand vous devez créer ou trouver le secret vous-même, la carte affiche aussi **Comment l’obtenir** : les étapes, noms ou endroits que l’équipier a indiqués pour ce cas, et une ligne qui dit qui les a écrits.
Vérifiez chaque adresse qu’elle affiche avant de vous y connecter.

Tapez ou collez chaque valeur dans le champ masqué qu’Infinitary dessine sur la carte, puis choisissez **Enregistrer le secret**.
**Ne pas enregistrer** n’enregistre rien.
L’équipier reçoit le nom du secret, jamais sa valeur, et chaque utilisation vous demande toujours.

Ne tapez un secret que dans un champ dessiné par Infinitary, jamais dans le champ de réponse d’une carte ni dans votre zone de message.

## Autoriser une utilisation {#allow-a-use}

Quand un équipier veut utiliser un secret, Infinitary affiche une carte, comme « Donner le secret Déploiement du site web à « Publier le site » ? ».
La carte indique exactement ce qui le recevrait :

- **Secret** : chaque secret, et le nom sous lequel le programme le reçoit.
- **Exécute** : la commande exacte.
- **Dans le dossier** : où elle s’exécute.
- **Sa raison** : la raison de l’équipier, dans ses propres mots.

**Tout ce qui a été vérifié** liste ce qu’Infinitary a vérifié sur le programme, et ce qu’il n’a pas pu vérifier.
Choisissez ensuite :

- **Autoriser une fois** donne le secret à cette exécution seulement.
- **Toujours autoriser** le donne à cette exécution et enregistre cette exécution exacte : le même programme, les mêmes fichiers, arguments et dossier.
  Tout ce qui diffère demande de nouveau.
- **Ne pas autoriser** refuse, et la prochaine exécution demande de nouveau.

Chaque autorisation vous demande d’abord de confirmer : sur un Mac avec Touch ID ou votre mot de passe, sous Linux avec votre mot de passe, et sous Windows avec Windows Hello ou votre mot de passe Windows.
Ce qui reçoit un secret peut le garder.
Autoriser n’approuve jamais une action distincte, comme déployer ou envoyer quelque chose.
L’équipier apprend seulement si l’exécution s’est terminée, pas ce qu’elle a affiché.

Pendant qu’une demande attend, Réglages → Secrets l’affiche en haut, avec **Examiner la demande** pour ouvrir sa carte.

## Décisions enregistrées {#saved-decisions}

Ouvrez **Accès, historique et récupération** sous la liste des secrets, puis **Décisions enregistrées**.
Chaque décision que vous avez enregistrée avec **Toujours autoriser** est listée en une phrase.

Vous n’enregistrez une décision que sur la carte d’une demande.
Ici, vous pouvez en **Retirer** une : votre ordinateur vous demande de confirmer, et l’équipage vous redemande avant sa prochaine utilisation.

## Approuver depuis votre téléphone {#approve-from-your-phone}

Vous pouvez autoriser une utilisation depuis votre iPhone ou votre iPad quand vous êtes loin de votre ordinateur.

1. Dans Réglages → **Appareils**, activez **Approuve l’utilisation des secrets** sur la ligne de votre téléphone.
2. Ouvrez Infinitary sur le téléphone, qui affiche alors son code.
3. Choisissez **Comparer les codes**, et vérifiez que le code de la carte sur votre ordinateur correspond à celui des Réglages du téléphone.
4. Choisissez **Confirmer et autoriser** sur votre ordinateur, qui vous demande de confirmer.

Dès lors, la carte d’une demande sur le téléphone propose **Autoriser une fois** et **Ne pas autoriser**.
Chaque autorisation demande Face ID, Touch ID ou le code du téléphone.
Une décision qui autorise toujours une exécution n’est enregistrée que sur votre ordinateur.
Un Mac qui contrôle votre second depuis ailleurs peut aussi approuver des utilisations, configuré de la même façon depuis sa ligne.

Pour arrêter, désactivez l’interrupteur, ou choisissez **Arrêter les approbations** sous **Appareils qui approuvent** dans **Accès, historique et récupération**.

## Importer des secrets d’un autre outil {#move-secrets-from-another-tool}

Si vous gardez des secrets dans un autre outil, comme Automic Vault, un fichier .env ou le Trousseau de votre Mac, un équipier peut les importer dans Secrets sans voir aucune valeur.

1. Choisissez **Importer d’un autre outil** dans Réglages → Secrets, ou **Importer des secrets d’un autre outil** dans la recherche de commandes.
2. Votre zone de message commence la demande à votre second ; nommez l’outil et envoyez.
3. L’équipier affiche une carte, comme « Importer 3 secrets depuis Automic Vault ? », qui nomme la commande qu’il exécute ou le fichier qu’il lit, et pourquoi.
4. Cochez chaque secret à garder, puis choisissez **Importer dans Secrets**, ou **Ne pas importer**.

Infinitary exécute la commande ou lit le fichier lui-même, et ne garde que ce que vous cochez.
Pour un fichier comme un fichier .env, **Le lire** liste d’abord les noms qu’il contient.
L’équipier reçoit des noms, jamais une valeur, et la copie dans l’autre outil reste telle quelle.
Vous choisissez les secrets dans la fenêtre d’Infinitary sur l’ordinateur où vit votre second, pas sur votre téléphone.

## Les clés de vos intégrations {#keys-for-your-integrations}

Quand vous vous connectez à Google ou ajoutez un serveur MCP avec des clés dans Réglages → **Intégrations**, Infinitary garde ces clés dans Secrets.
Secrets les liste avec **Gérer dans Intégrations** à la place de Remplacer et Oublier.
Infinitary les utilise sans demander, car vous connecter, ou ajouter le serveur avec ses clés, valait votre accord.
Votre équipage ne peut ni les voir ni demander à les utiliser.
Déconnectez-vous, ou retirez le serveur, dans Intégrations pour les oublier.
Voir [Intégrations](/fr/integrations/).

## Historique d’utilisation et sauvegardes {#use-history-and-backups}

**Historique d’utilisation** liste chaque utilisation : quels secrets, la raison, le programme, comment elle a été autorisée et comment elle s’est terminée, jamais une valeur.
Il reste jusqu’à ce que vous le supprimiez, avec **Exporter l’historique** et **Supprimer l’historique**.

**Sauvegarde et restauration** propose **Enregistrer une sauvegarde chiffrée**, qui enregistre une copie chiffrée et une clé de récupération séparée.
Conservez-les à l’écart l’une de l’autre : quiconque a les deux peut lire les valeurs enregistrées, et il n’existe aucune réinitialisation de la clé.
**Restaurer depuis une sauvegarde** remplace vos valeurs stockées, et efface les décisions enregistrées, les approbations par téléphone et les accès temporaires.

## Quand Secrets ne peut pas s’ouvrir {#when-secrets-cannot-open}

Si le stockage de secrets de votre ordinateur est verrouillé, Secrets affiche **Stockage verrouillé**, avec **Déverrouiller ou revérifier**.
Les demandes attendent jusqu’à son ouverture.

Si Infinitary ne peut plus lire ce qu’il a gardé, Secrets affiche **Récupération nécessaire** et n’autorise aucune utilisation.
**Options de récupération** ouvre **Sauvegarde et restauration**, pour restaurer depuis une sauvegarde.
**Tout recommencer** efface vos secrets stockés, vos décisions enregistrées, vos approbations par téléphone et vos accès temporaires, et ne peut pas être annulé.

## Sites connectés {#signed-in-sites}

Le pied de Secrets liste les **Sites connectés** : les sites auxquels vous vous êtes connecté dans le navigateur d’une tâche.
Ils restent dans le profil de navigateur de cet ordinateur, pas dans le stockage protégé.
Voir [Le navigateur de l’équipage](/fr/the-crews-browser/#signed-in-sites).

## Quand votre second déménage {#when-your-first-mate-moves}

Quand votre second déménage sur un autre ordinateur, vos secrets restent sur l’ordinateur qu’il quitte, et vous les ajoutez de nouveau sur le nouveau.

Un ordinateur qui [garde une copie de votre second](/fr/your-other-computers/#keep-a-copy-on-another-computer) peut aussi garder vos secrets.
Choisissez **Y garder les Secrets** dans sa liste **Prêt à prendre le relais** dans Réglages → **Appareils**, puis confirmez sur cet ordinateur lui-même.
Si votre second déménage ensuite là-bas, ou [démarre depuis cette copie](/fr/your-other-computers/#take-over), il emporte les valeurs.
Si cet ordinateur garde déjà ses propres secrets, une carte sur place demande quel ensemble utiliser.
Il n’emporte ni les décisions enregistrées ni les appareils qui approuvent, donc chaque utilisation vous redemande et chaque téléphone est configuré de nouveau.

Voir aussi [Vos autres ordinateurs](/fr/your-other-computers/#move-your-first-mate) et [Ce qui quitte votre ordinateur](/fr/what-leaves-your-computer/#secrets).
