---
source: d80bcd26e6bed993
title: Projets
description: Comment ajouter un projet à Infinitary, concentrer la fenêtre sur l’un d’eux, choisir comment ses changements sont fusionnés et le retirer.
---

Un projet est ce sur quoi travaille votre équipage : un dossier à vous, géré avec git.
Chaque tâche appartient à un projet, et chaque clé de tâche commence par la clé de son projet, comme `WEB-12`.
Vos projets sont listés dans **Réglages → Projets**.

## Ajouter un projet {#add-a-project}

Vous pouvez ajouter un projet de deux façons.

- **Demandez à votre second.**
  Dites sur quel projet travailler, par exemple « Cloner le projet à l’adresse » suivi de son lien.
  Votre second vous apporte une carte qui nomme le projet et ses réglages.
  Rien n’est ajouté tant que vous n’appuyez pas sur **Ajouter un projet** sur cette carte.
- **Ajoutez-le vous-même.**
  Ouvrez **Réglages → Projets** et utilisez la ligne **Ajouter un projet** au pied de la liste.

La ligne **Ajouter un projet** a trois boutons :

1. **Dossier sur cet ordinateur** ajoute un dossier que vous avez déjà.
   Si le dossier n’utilise pas encore git, Infinitary y initialise git avec un premier commit vide.
2. **Dépôt GitHub**, **Dépôt GitLab** ou **Dépôt Bitbucket** clone un projet depuis l’endroit où il est hébergé.
   Choisissez-le dans **Vos dépôts GitHub**, utilisez **Trouver un dépôt** pour chercher, ou collez son lien.
   Avec beaucoup de dépôts, certains peuvent ne pas avoir été vérifiés, et la liste le signale ; collez un lien pour en ajouter un qui manque.
3. **Nouveau projet** démarre un projet vide avec le nom que vous tapez.

Un projet cloné ou nouveau va dans votre dossier de projets.
La ligne **Les nouveaux projets vont dans** affiche ce dossier, et **Choisir un dossier** le change.
Les projets déjà ajoutés ne bougent jamais quand vous le changez.

**Clé des tâches** est facultative.
Tapez jusqu’à quatre lettres ou chiffres, et les tâches du prochain projet sont numérotées avec.
Laissez-la vide, et Infinitary fabrique une clé à partir du nom du projet.

Pour un projet chez un autre hébergeur, demandez à votre second.

## Votre connexion GitHub, GitLab ou Bitbucket {#your-github-gitlab-or-bitbucket-sign-in}

Pour cloner un projet et proposer ses changements, Infinitary utilise votre connexion à GitHub, GitLab ou Bitbucket.

Si vous n’êtes pas connecté quand vous appuyez sur **Dépôt GitHub**, **Dépôt GitLab** ou **Dépôt Bitbucket**, la ligne affiche **Se connecter à GitHub**, **Se connecter à GitLab** ou **Se connecter à Bitbucket** au lieu de vos projets.
Ce bouton ouvre **Réglages → Intégrations**, où se trouvent vos connexions ; voir [Intégrations](/fr/integrations/).
Pour GitHub, vous saisissez un code sur la page de GitHub dans votre navigateur.
Pour GitLab, vous pouvez vous connecter dans votre navigateur ou coller une clé, sur gitlab.com ou sur votre propre serveur GitLab.
Pour Bitbucket, vous créez un jeton d’API sur votre compte Atlassian et vous le collez, pour les projets sur bitbucket.org.
Le formulaire de clé nomme les autorisations à cocher sur la page d’Atlassian.
Pour votre propre serveur Bitbucket Data Center, en version 8.19 ou plus récente, vous saisissez son adresse et collez un jeton d’accès HTTP avec les autorisations Project read et Repository write.
Les changements d’un projet Data Center sont proposés en demandes de tirage, et la fusion ne se fait qu’à la version que vous avez approuvée : si quelqu’un pousse entre-temps, rien n’est fusionné et la tâche le signale.
Un projet Data Center peut aussi choisir les demandes de tirage groupées, et votre équipage peut lire et écrire sur le serveur, contribuer par votre fork, et se réveiller sur les nouveaux commentaires de sa demande de tirage et sur une vérification échouée sur sa branche principale.
Un serveur Data Center ne conserve ni journaux de vérification, ni exécutions, ni fichiers de version qui lui soient propres : ses vérifications viennent d’un autre service, et chacune renvoie à l’endroit où se trouve son journal.
Vos projets Bitbucket sont listés à partir des espaces de travail dont vous faites partie ; s’il y en a beaucoup, certains peuvent ne pas avoir été vérifiés, et la liste le signale.
Les changements d’un projet Bitbucket sont proposés en demandes de tirage, comme sur GitHub et GitLab ; un projet ajouté avant cela fonctionne de la même façon dès sa prochaine tâche.
La description d’une demande de tirage Bitbucket porte le récit sous forme de texte, et ses images restent sur la carte.
Un projet Bitbucket peut aussi choisir les demandes de tirage groupées, et ses fusions suivent les stratégies et la file de fusion de sa branche principale sur bitbucket.org.
Sur un projet Bitbucket, votre équipage peut aussi lire les pipelines du projet et le journal d’une étape, déposer un fichier de version dans ses Downloads et se réveiller à chaque nouveau commentaire sur sa demande de tirage, comme sur GitHub et GitLab ; Bitbucket ne propose pas de télécharger les artefacts d’un pipeline.
Votre connexion reste sur cet ordinateur.

Si une connexion cesse de fonctionner, une carte vous demande de vous reconnecter.
Le travail qui en a besoin attend que vous le fassiez.

## Copies de travail {#working-copies}

Votre équipage ne travaille jamais directement dans le dossier de votre projet.
Chaque équipier travaille dans sa propre copie de travail de votre projet, sur sa propre branche.
Vos fichiers restent tels quels jusqu’à ce que vous fusionniez un changement.

## Se concentrer sur un projet {#focus-on-one-project}

À partir de deux projets, la barre du haut affiche une pastille de projet.
Appuyez dessus, ou appuyez sur ⇧⌘P (Ctrl+Shift+P sous Linux), pour ouvrir une rangée de vos projets.
Chaque pastille compte les tâches qui vous attendent et les tâches en cours.
Choisissez un projet pour y concentrer la fenêtre.

Tant qu’un projet a le focus :

- Le panneau Tâches et le tableau des tâches n’affichent que les tâches de ce projet.
- Activité n’affiche que les lignes sur ce projet, et les lignes qui ne concernent aucune tâche.
- Les cartes sur d’autres projets attendent que le focus change.
  Rien n’est fermé, et chaque projet envoie toujours des notifications.
- Une courte ligne à côté de la pastille indique combien de tâches vous attendent ailleurs, comme « 2 en attente ailleurs ».
- Votre second place le nouveau travail que vous demandez dans ce projet, sauf si vous en nommez un autre.

Appuyez sur le **×** à côté de la pastille (**Afficher tous les projets**), ou choisissez **Tous les projets** dans la rangée, pour tout revoir.
Infinitary se souvient de votre focus quand vous le redémarrez.

## Comment les changements arrivent dans votre projet {#how-changes-reach-your-project}

Ouvrez un projet dans **Réglages → Projets** pour choisir comment son travail terminé est fusionné.
**Où vont les modifications** propose :

- **demandes de tirage** : chaque changement est proposé en demande de tirage sur GitHub, GitLab ou Bitbucket.
- **demandes de tirage groupées** : vos changements approuvés sont réunis en une seule demande de tirage groupée, un commit pour chaque changement, et fusionnés une fois ses vérifications réussies.
- **fusion locale** : le changement est fusionné dans le projet sur cet ordinateur, sans demande de tirage.

Un projet qui n’existe que sur cet ordinateur ne propose que **fusion locale**.

Quand un changement est prêt, son équipier vous apporte une carte de fusion.
Le bouton de la carte dit ce qu’il fait, comme **Fusionner la demande de tirage**, **Fusionner la branche** ou **Fusionner dans le prochain lot**.
Si les vérifications sont encore en cours, le bouton indique **Fusionner une fois les vérifications réussies**, et Infinitary fusionne dès qu’elles réussissent.

**Demander avant de fusionner** décide qui fusionne.
Il est activé pour un nouveau projet, si bien que le travail terminé attend votre feu vert.
Désactivez-le, et le travail qui réussit les vérifications peut fusionner sans vous demander.

**Soin** règle le degré de vérification du travail : **Rapide**, **Par défaut** ou **Minutieux**.

**Dire qu’un équipier l’a écrit** est activé pour un projet dont les changements passent par des demandes de tirage.
Quand un équipier relit la demande de tirage d’une autre personne, le commentaire qu’il publie commence par une ligne qui dit qu’un équipier d’Infinitary l’a écrit.
Modifiez la ligne et appuyez sur **Enregistrer**, ou désactivez l’interrupteur pour ne pas l’ajouter.

## Retirer un projet {#remove-a-project}

1. Ouvrez le projet dans **Réglages → Projets**.
2. Appuyez sur **Retirer** sur sa dernière ligne.
3. Appuyez de nouveau sur **Retirer** pour confirmer.

Retirer un projet l’enlève de la liste.
Son dossier et ses tâches terminées restent.
Si le projet a encore des tâches, Infinitary les nomme, et vous les terminez ou les écartez d’abord.

## Pour la suite {#next}

- [Tâches et équipiers](/fr/tasks-and-crewmates/)
- [Cartes et décisions](/fr/cards-and-decisions/)
