# Contribuer à ROTK Launcher

Merci de contribuer au launcher. Le projet privilégie les changements limités, testables et faciles à auditer : le launcher manipule une installation de jeu locale et sa sécurité mérite la même attention que son interface.

## Avant de commencer

- recherchez une issue existante avant d’en ouvrir une nouvelle ;
- gardez un sujet par issue et un changement cohérent par pull request ;
- utilisez une branche créée depuis `main` ;
- pour une faille de sécurité, suivez [SECURITY.md](SECURITY.md) au lieu d’ouvrir une issue publique.

## Installation locale

Il faut Windows x64, Node.js 22, npm et Zig 0.15.2 pour le code natif.

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

Lancer le mode développement :

```powershell
npm run dev
```

## Modifier le shim

Le source de vérité est `native/steamshim/steam_api64.c`. Le DLL présent dans `resources/patches/steam_api64.dll` doit toujours pouvoir être régénéré depuis ce source avec Zig 0.15.2.

```powershell
npm run build:shim
Copy-Item native\steamshim\dist\steam_api64.dll resources\patches\steam_api64.dll -Force
```

Une pull request qui modifie le shim doit :

- expliquer les exports ou comportements ajoutés ;
- inclure les tests ou traces minimales permettant la revue ;
- mettre à jour le DLL embarqué ;
- ne jamais inclure le DLL Steam original ni un autre fichier propriétaire du client ;
- passer la double compilation reproductible de la CI.

## Règles de contenu

Ne commitez jamais :

- `H1Z1.exe`, `H1Z1_BE.exe` ou tout autre fichier du client H1Z1 ;
- une installation Steam, même partielle ;
- le DLL Steam original ou ses sauvegardes ;
- des captures, textures, sons ou autres assets propriétaires du jeu ;
- des journaux contenant des chemins personnels, identifiants ou secrets ;
- des clés privées, certificats de signature ou endpoints internes.

Les couvertures des actualités restent hébergées sur `rotk.app`. Un nouvel asset local doit indiquer clairement son auteur, sa provenance et sa licence dans [ASSET_LICENSE.md](ASSET_LICENSE.md) ou [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Qualité attendue

- TypeScript strict, sans désactiver un contrôle pour masquer une erreur ;
- IPC minimal : n’exposez ni `shell`, ni système de fichiers générique au renderer ;
- aucune construction de commande shell à partir d’une saisie utilisateur ;
- toute nouvelle URL externe doit être HTTPS et explicitement autorisée ;
- toute évolution des chemins doit tester les variantes de casse, jonctions et imbrications ;
- les messages destinés aux joueurs doivent être ajoutés aux dictionnaires anglais et français ; l’anglais reste la langue par défaut.

Avant d’envoyer la pull request :

```powershell
npm run typecheck
npm test
npm run build
```

## Pull request

Décrivez le résultat utilisateur, les risques et la manière de tester. Ajoutez une capture uniquement pour un changement visuel, sans contenu propriétaire non autorisé. Une contribution acceptée est publiée sous la licence `GPL-3.0-or-later` du dépôt.
