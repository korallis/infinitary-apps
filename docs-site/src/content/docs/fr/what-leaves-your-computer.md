---
source: 6bc810f8c25a2b9e
title: Ce qui quitte votre ordinateur
description: Ce qu’envoie Infinitary, où cela va, et le seul interrupteur qui nous envoie quoi que ce soit.
---

Infinitary s’exécute sur votre ordinateur, avec les abonnements que vous avez déjà.
Il n’a besoin d’aucun compte chez nous, et votre travail ne passe pas par nous.
Cette page liste ce qu’envoie l’app, et où.

## Votre travail va au fournisseur que vous avez choisi {#your-work-goes-to-the-provider-you-chose}

Votre second et votre équipage réfléchissent avec les abonnements d’IA auxquels vous vous êtes connecté.
Vos messages, et ce qu’un équipier lit de votre projet pour faire sa tâche, vont à ce fournisseur par votre abonnement.
Avec Claude, Infinitary utilise le Claude Code que vous avez installé, connecté à votre propre compte.
Avec un fournisseur personnalisé, cela va à l’adresse que vous avez saisie.

Vos connexions restent sur votre ordinateur.

## Vos projets vont là où ils sont hébergés {#your-projects-go-where-they-live}

Un équipier travaille dans une copie de travail de votre projet sur votre ordinateur.
Quand une tâche est proposée sous forme de demande de tirage, sa branche est envoyée là où votre projet est hébergé, comme GitHub, GitLab ou Bitbucket, et la demande de tirage y est ouverte.
Un projet gardé uniquement sur cet ordinateur reste sur cet ordinateur.

Quand un équipier prépare une copie de travail ou fait sa tâche, il peut récupérer ce dont votre projet a besoin, comme vous le feriez à la main.

## Vos autres ordinateurs et votre téléphone {#your-other-computers-and-your-phone}

Les ordinateurs et téléphones que vous ajoutez communiquent avec l’ordinateur où vit votre second.
Réglages → **Appareils** indique comment ils le trouvent.
**Par Internet** indique « Jamais. Infinitary n’ouvre pas cet ordinateur à Internet. »

Une connexion que vous saisissez pour un autre ordinateur va une fois à cet ordinateur.
L’ordinateur où vit votre second n’en garde aucune copie.
Voir [Vos autres ordinateurs](/fr/your-other-computers/).

## Les intégrations que vous connectez {#integrations-you-connect}

Une intégration que vous connectez dans Réglages → **Intégrations**, comme Google, est atteinte avec sa propre connexion, qui reste sur l’ordinateur où vous vous êtes connecté.
Votre second et votre équipage ne la lisent qu’une fois que vous l’avez connectée.
Voir [Intégrations](/fr/integrations/).

## Les rapports d’utilisation de votre entreprise {#your-companys-usage-reporting}

Si votre fichier de réglages Claude Code ou votre shell configure des rapports d’utilisation pour votre entreprise, comme le décrit le guide de Claude Code, Infinitary envoie au même endroit l’utilisation de tout le travail fait ici.
Le travail de Claude part sous la forme des relevés que Claude Code lui-même y enverrait.
Le travail de tout autre modèle part sous les mêmes noms, avec son modèle, son fournisseur, ses tokens, son coût estimé, le fait que votre second ou un membre d’équipage l’a fait, le type de travail et l’adresse e-mail de votre connexion Claude Code, jamais vos mots, les titres des tâches ni les noms des projets.
Réglages → **Utilisation** indique où il va.
Si cet endroit continue de refuser le travail de Claude, ou s’il est impossible de le joindre, cette ligne le dit à la place.
Une configuration que l’administrateur de votre entreprise gère pour tout l’ordinateur atteint Claude Code directement, comme avant, et Infinitary y envoie aussi le travail de tout autre modèle, de la même façon.
Les deux sortes de configuration ne reçoivent que le travail de Claude si elles envoient leur utilisation par gRPC, et Réglages → **Utilisation** le précise alors.

## Les recherches de mises à jour {#update-checks}

Infinitary recherche une version plus récente toutes les quelques heures, à l’endroit où ses versions sont publiées.
Cette recherche n’envoie aucun de vos contenus et aucun identifiant.
La première recherche de chaque jour, et la première de chaque mois, indique aussi qu’elle est la première, pour qu’Infinitary Labs puisse compter combien d’ordinateurs utilisent Infinitary.
Cela se produit quel que soit l’interrupteur **Diagnostics**, et une copie installée avec Homebrew ne l’envoie pas.
Une nouvelle version n’est téléchargée que lorsque vous choisissez de mettre à jour.
Vous pouvez aussi appuyer vous-même sur **Rechercher les mises à jour**.
Voir [Mettre à jour et supprimer Infinitary](/fr/update-and-remove/).

## La dictée {#dictation}

La dictée transforme votre voix en mots sur votre ordinateur.
La première fois que vous l’utilisez, elle demande avant de télécharger une fois son modèle vocal.

## Diagnostics, le seul interrupteur qui nous envoie quelque chose {#diagnostics-the-one-switch-that-sends-to-us}

Réglages → **Général** → **Partage** contient l’interrupteur **Diagnostics**.
C’est le seul interrupteur qui nous envoie quoi que ce soit ; la seule chose qui nous parvient sans lui est la mention « première du jour » et « première du mois » de la recherche de mises à jour ci-dessus, que **Partage** décrit aussi.
Il est activé sauf si vous le désactivez, et rien dans l’app n’en dépend.

À votre premier lancement, un avis sous la zone de message indique ce qu’il envoie, avec **Désactiver** et **OK**.
Rien n’est envoyé tant que vous n’avez pas répondu.

Diagnostics envoie des événements d’utilisation anonymes :

- l’ouverture de l’app,
- votre second qui termine ou échoue un tour, avec seulement le type d’échec,
- l’avancement de la première configuration,
- et, depuis un iPhone ou un iPad que vous avez ajouté, l’ouverture de l’app, sa configuration, un message envoyé et une carte répondue.

Chaque événement transporte la version de l’app et un identifiant d’installation aléatoire.
L’identifiant n’est lié à rien qui vous concerne ni à votre ordinateur, et il est remplacé chaque fois que Diagnostics est désactivé puis réactivé.
Aucun texte que vous avez écrit, aucun nom et aucun chemin ne sont envoyés : jamais une conversation, du code ou une carte.
Votre téléphone n’envoie rien lui-même ; votre ordinateur envoie ses événements sous le même interrupteur.

Pour voir exactement ce qui partirait, ouvrez **Ce qui quitterait cet ordinateur** sous **Partage**.
Cela affiche l’identifiant d’installation, ce qui attend d’être envoyé, ce qui a été envoyé, et chaque événement que Diagnostics peut envoyer.
Désactivez **Diagnostics**, et plus rien n’est enregistré ni envoyé.

## Secrets {#secrets}

Les valeurs que vous gardez dans Réglages → **Secrets** restent sur votre ordinateur.
Chaque valeur va directement dans Secrets : Infinitary ne l’affiche plus jamais, et ni le second ni l’équipage ne la reçoivent.
Voir [Secrets](/fr/secrets/).
