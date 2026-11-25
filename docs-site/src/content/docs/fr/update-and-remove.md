---
source: 8949d6275dea6548
title: Mettre à jour et supprimer Infinitary
description: Comment chaque type d’installation reçoit une nouvelle version stable, et comment supprimer Infinitary en gardant votre travail enregistré.
---

Infinitary recherche une nouvelle version stable toutes les quelques heures.
La recherche ne télécharge rien, et rien ne s’installe tant que vous ne l’avez pas choisi.
Une mise à jour garde votre travail enregistré.

## Quand une nouvelle version est disponible {#when-a-new-version-is-out}

Un bouton rond avec une flèche vers le bas apparaît en haut à droite de la fenêtre.
Laissez le pointeur dessus pour lire « Mise à jour disponible » et le numéro de la nouvelle version, et appuyez dessus pour voir quoi faire ensuite.
Réglages → **Général** affiche la même chose, sous **Version**.

Pour vérifier vous-même, utilisez l’un de ces moyens :

- **Rechercher les mises à jour** sous **Version** dans Réglages → **Général**.
- **Rechercher les mises à jour** dans la recherche de commandes.
- Sur un Mac, **Rechercher les mises à jour…** dans le menu Infinitary.

La suite dépend de la façon dont vous avez installé Infinitary.

## Une copie pour Mac depuis la page de téléchargement {#a-mac-copy-from-the-downloads-page}

1. Appuyez sur **Mettre à jour et redémarrer**.
2. Infinitary télécharge la nouvelle version et vérifie sa somme de contrôle et sa signature Apple.
3. Il enregistre le travail de votre équipage.
   Le travail en cours termine d’abord ce qu’il exécute, donc rien n’est perdu.
4. Infinitary redémarre sur la nouvelle version et reprend le travail que la mise à jour a mis en pause.

Pendant qu’il attend le travail en cours, **Mettre à jour plus tard** laisse la mise à jour de côté jusqu’à ce que vous la choisissiez de nouveau.
Votre travail continue.

Si Infinitary n’a pas pu finir de redémarrer, le bouton indique **Redémarrer**.
Appuyez de nouveau dessus une fois votre travail en cours arrêté.

Infinitary ne se met à jour que depuis Applications.
S’il s’exécute depuis l’image disque, faites-le glisser dans Applications, éjectez l’image disque et ouvrez la copie dans Applications.

## Une copie pour Mac depuis Homebrew {#a-mac-copy-from-homebrew}

Une copie installée avec Homebrew se met à jour avec Homebrew.
L’avis affiche la commande, avec **Copier la commande** :

```sh wrap
brew update && brew upgrade --cask infinitary-labs/tap/infinitary
```

Exécutez-la dans Terminal.
Homebrew quitte Infinitary pendant qu’il le remplace, alors rouvrez Infinitary quand il a terminé.

## Linux {#linux}

- **Ubuntu, Debian et Fedora**, depuis le paquet .deb ou .rpm : appuyez sur **Installer**.
  Infinitary télécharge la nouvelle version, la vérifie, enregistre le travail de votre équipage et demande votre mot de passe, puis redémarre.
- **Une AppImage** : appuyez sur **Installer**.
  Infinitary remplace le fichier AppImage par la nouvelle version et redémarre, sans mot de passe.
  Il doit pouvoir modifier le dossier où se trouve l’AppImage.
- **Arch, Omarchy et NixOS** se mettent à jour avec leur propre gestionnaire de paquets.
  L’avis affiche la commande, avec **Copier la commande** ; exécutez-la dans un terminal.

Si l’installation ne peut pas aboutir, rien ne change et le travail de votre équipage continue.
L’avis affiche alors une commande qui installe la même version à la main.

## Windows {#windows}

1. Appuyez sur **Mettre à jour et redémarrer**.
2. Infinitary télécharge le nouveau programme d’installation, vérifie sa somme de contrôle et enregistre le travail de votre équipage.
3. Infinitary se ferme, le programme d’installation le remplace, et Infinitary se rouvre sur la nouvelle version.

Si l’installation ne peut pas aboutir, rien ne change et le travail de votre équipage continue.

## Vos autres ordinateurs et votre téléphone {#your-other-computers-and-your-phone}

Un ordinateur que vous avez ajouté se met à jour depuis l’ordinateur où vit votre second.
Dans Réglages → **Appareils**, un ordinateur sur une autre version affiche **Mettre à jour** sur sa ligne.
Il reçoit la version de cet ordinateur, et son travail en cours s’arrête un instant puis reprend.

Depuis un ordinateur qui pilote votre second, Réglages → **Général** comporte une ligne pour Infinitary sur l’ordinateur où vit votre second.
Quand cet ordinateur a une mise à jour prête, appuyez sur **Mettre à jour** suivi de son nom pour lancer la mise à jour depuis l’endroit où vous êtes.
Votre téléphone peut aussi lancer cette mise à jour, après vous avoir demandé d’abord.
Voir [Vos autres ordinateurs](/fr/your-other-computers/) et [iPhone et iPad](/fr/iphone-and-ipad/).

## Supprimer Infinitary {#remove-infinitary}

Supprimer l’app laisse votre travail enregistré en place, donc réinstaller Infinitary reprend là où vous vous étiez arrêté.
Si cet ordinateur exécute le travail d’un autre, appuyez d’abord sur **Quitter** dans Réglages → **Appareils**.

- **Une copie pour Mac depuis la page de téléchargement** : quittez Infinitary et déplacez-le d’Applications vers la Corbeille.
- **Une copie pour Mac depuis Homebrew** : exécutez `brew uninstall --cask infinitary` dans Terminal.
  N’ajoutez jamais `--zap` : cela supprime votre travail enregistré.
- **Linux** : supprimez le paquet avec l’installateur de logiciels ou le gestionnaire de paquets qui a servi à l’installer.
  Pour une AppImage, supprimez le fichier.
- **Windows** : dans Paramètres Windows → **Applications** → **Applications installées**, choisissez **Désinstaller** dans le menu d’Infinitary.

Votre travail enregistré reste dans `~/Library/Application Support/infinitary` sur un Mac, dans `~/.config/infinitary` sous Linux, et dans `%APPDATA%\infinitary` sous Windows.

### Ce qui supprime votre travail enregistré {#what-deletes-your-saved-work}

Ces actions suppriment ce dossier, et ce qu’Infinitary y gardait disparaît avec lui :

- `brew uninstall --zap`.
- Une app de désinstallation qui supprime aussi les fichiers de support d’une app.
- Placer le dossier lui-même dans la Corbeille, ou le supprimer.

Sur un ordinateur qui exécute le travail d’un autre, ce dossier contient la clé propre à l’ordinateur, ses copies de travail et les fichiers de ses tâches.
Sans lui, l’ordinateur rejoint de nouveau comme une nouvelle entrée, et le travail qu’il n’avait pas rapporté reste perdu.
Voir [Un ordinateur apparaît deux fois](/fr/troubleshooting/#a-computer-is-listed-twice).
