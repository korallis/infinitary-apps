---
source: 2633a75241365106
title: Installer
description: Téléchargez la version stable d’Infinitary pour Mac, Linux ou Windows, ou demandez une invitation TestFlight privée pour iPhone et iPad.
---

Téléchargez la version stable d’Infinitary pour [Mac](https://getinfinitary.com/downloads/#macos), [Linux](https://getinfinitary.com/downloads/#linux) ou [Windows](https://getinfinitary.com/downloads/#windows).
Si vous voulez vérifier un téléchargement, comparez sa somme de contrôle SHA-256 avec celle affichée à côté de ce fichier sur la page des téléchargements.

## Sur un Mac {#on-a-mac}

Téléchargez l’**image disque (.dmg)** pour un Mac à puce Apple ou un Mac Intel.
Ouvrez-la et faites glisser Infinitary dans **Applications**.
Si vous choisissez plutôt le **ZIP**, ouvrez-le et déplacez l’app Infinitary extraite dans **Applications**.

## Sous Linux {#on-linux}

Choisissez le paquet **.deb** pour Ubuntu ou Debian, ou le paquet **.rpm** pour Fedora, et ouvrez-le avec l’installateur de logiciels de votre système.
Pour Arch ou Omarchy, utilisez la recette de paquet Arch ; pour NixOS, utilisez la recette Nix.
Sur les autres systèmes Linux x64, téléchargez l’**AppImage**, autorisez son exécution comme programme dans les propriétés du fichier, puis ouvrez-la.

## Sous Windows {#on-windows}

Infinitary pour Windows est expérimental.
Téléchargez le **programme d’installation (.exe)** pour un PC sous Windows 11 avec un processeur 64 bits Intel ou AMD.
Le programme d’installation n’est pas encore signé avec un certificat que Microsoft vérifie : Windows ne connaît donc pas son éditeur et vous avertit deux fois avant l’installation :

1. Si votre navigateur indique que le fichier n’est pas couramment téléchargé, choisissez **Conserver**, puis **Conserver quand même**.
2. Quand vous l’ouvrez, Windows affiche « Windows a protégé votre ordinateur » avec un éditeur inconnu.
   Choisissez **Informations complémentaires**, puis **Exécuter quand même**.

Si le contrôle intelligent des applications est activé, Windows bloque cette version et n’offre aucun moyen de l’exécuter.
Laissez le contrôle intelligent des applications activé et attendez la version signée.

Le programme d’installation installe Infinitary pour vous seul, l’ajoute au menu Démarrer et l’ouvre.
Si votre PC n’a pas Git for Windows, Infinitary propose de l’installer à son premier lancement, car votre équipage en a besoin.

## Sur iPhone et iPad {#on-iphone-and-ipad}

Infinitary pour iPhone et iPad est en TestFlight privé.
[Écrivez à help@getinfinitary.com pour demander une invitation](mailto:help@getinfinitary.com?subject=Infinitary%20TestFlight%20request).
Consultez [iPhone et iPad](/fr/iphone-and-ipad/) pour savoir comment rejoindre votre ordinateur.

## Ce qu’il vous faut {#what-you-need}

- **Un ordinateur.**
  Un Mac sous macOS 12 ou plus récent, un ordinateur Linux avec un processeur x64, ou un PC sous Windows 11 avec un processeur x64 (expérimental).
- **Un abonnement d’IA.**
  Votre second a besoin d’au moins un abonnement capable de répondre : Codex, Grok, Claude, Kimi Code, Copilot, OpenRouter avec une clé d’API, ou Amazon Bedrock avec votre connexion AWS.
- **Claude Code, pour Claude.**
  Si vous utilisez un abonnement Claude, installez d’abord Claude Code sur cet ordinateur.
  Infinitary utilise le Claude Code que vous avez installé.

## Votre premier lancement {#your-first-launch}

1. Ouvrez Infinitary.
   La fenêtre vous accueille et affiche un bouton pour chaque fournisseur.
2. Choisissez votre fournisseur et connectez-vous comme il le demande : dans votre navigateur, avec un code, ou avec une clé que vous collez.
3. Dès qu’un abonnement peut répondre, la zone de message s’ouvre et votre second est prêt.

Installez votre second sur un ordinateur qui reste allumé le plus possible.
Vos autres appareils ont besoin que votre second soit éveillé.

Pour mettre à jour ou supprimer Infinitary plus tard, consultez [Mettre à jour et supprimer Infinitary](/fr/update-and-remove/).
Si quelque chose ne fonctionne pas, consultez [Obtenir de l’aide](/fr/get-help/).
