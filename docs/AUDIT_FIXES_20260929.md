# Audit client : corrections du 29 septembre 2026

Base launcher : `8f82770`, branche `fix/audit-launcher-performance-20260929`.
Correctifs proposés dans la [PR #83](https://github.com/h1z1rotk/rotk-launcher/pull/83),
commit validé localement : `fe6cc58`. Aucun fichier
propriétaire nouveau ; les deux proxies embarqués sont reconstruits depuis leurs
sources avec Zig 0.15.2. Aucune installation de jeu modifiée.

## Disposition C1–C7

| Point | Statut et changement | Validation / limite |
|---|---|---|
| C1 — crash CZ | Correctif local absent de la base, intégré : normalisation du seul opérande de continuation après validation de l’EXE et stabilisation des signatures. Migration des anciennes DLL connues conservée. | Banc natif : défaut `0x280f6f676` reproduit avant correction ; 10 000 continuations après, gardes/idempotence/RX vérifiés. Pas une série de respawns réels ; autre signature `+0x1bea5a4` non résolue. |
| C2 — tir/visée | Posture v17 intégrée : actions `Infantry.Fire` / `SecondaryFire`, pas boutons souris physiques. | Véritable hook d’acteur sur mémoire synthétique : commandes logiques et absence d’action ; recette souris remappée/manette/menus/véhicule encore requise. |
| C3 — coût du hook | Optimisations locales portées **sur v12** : traces détaillées opt-in, indice de cache vérifié avec repli. Marqueur `v12-perf1`. | Zéro ouverture disque pendant le hook normal ; trace explicite disponible ; 98 appels avec paramètres événementiels préservés, cache différentiel de 10 000 opérations et stress multithread. Aucun gain FPS mesuré. |
| C4 — validation répétée | Une réparation Vivox avant attestation, puis contrôle des octets installés sans nouvelle réparation ni validation des bundles. Dans une passe, seuls les fichiers remplacés sont rehashés. | Comptage des lectures : un hash par fichier installé sain et par passe ; quatre hashes installés au contrôle final. Dérives de même taille de l’EXE, des trois DLL et du marqueur refusées avant spawn, sans réparation silencieuse. **L’EXE reste rehashé au contrôle final**, pas de cache persistant de confiance. |
| C5 — relecture ZIP | Empreinte calculée sur le flux décompressé et retournée après écriture réussie ; plus de seconde lecture du staging pour remplir le ledger. | Store/deflate/vide/multi-chunks, taille excessive et sortie déjà existante ; `Verify files` détecte et répare une corruption ZIP de même taille. SHA de l’archive, limites, sauvegarde et renommage conservés. Le digest en flux ne constitue pas une relecture indépendante du disque ; la vérification explicite reste indépendante. |
| C6 — métadonnées | Feed et release lus en parallèle, fusion inchangée, timeout partagé de 10 s, annulation de la requête restante sur erreur. | Chevauchement avant réponse, attente des deux résultats, erreurs de chaque branche, annulation, préannulation et budget commun testés ; repli hors ligne et découverte désactivée conservés. Pas de synchronisation en arrière-plan. |
| C7 — attente vocale | **Partiellement corrigé** : les grants restent sérialisés, mais leur HTTP ne garde plus le verrou d’état partagé avec le traitement des messages. | Blocage secondaire reproduit avant/après sur le vrai hook et WinHTTP loopback. **L’appel HTTP du demandeur reste synchrone** ; le lien avec un thread critique du jeu n’est pas établi. |

## C7 : preuve et frontière du correctif

`grant_lock_test.c` inclut le source de production et fait répondre un serveur
loopback avec un retard contrôlé d’environ 300 ms. L’ancien source bloque le
traitement d’un événement `sessiongroup_added` pendant cette attente ; le source
corrigé le traite avant la réponse. Cinq scénarios passent : login valide,
canal incorrect, grant expiré, HTTP 503, join valide. Le même test peut être compilé
contre le source initial avec `EXPECT_NETWORK_LOCK=1` pour caractériser l’ancien
comportement. Mesures du banc : appel demandeur autour de 297–328 ms après,
312–313 ms avant ; **ce n’est pas une accélération de cet appel**, ni une mesure FPS.

Le verrou `g_grant_lock` conserve la sérialisation des grants et mutations ;
`g_voice_lock` ne protège plus que les accès à l’état partagé. Les deux sont
relâchés avant l’appel original SDK. Le banc vérifie la progression des messages,
le refus d’un second détenteur du verrou de grant pendant HTTP, l’absence de
verrou à l’entrée du SDK et la conservation du thread/pointeur de requête.

La requête empruntée et `request_count` ne sont pas transférés à un worker : leur
durée de vie, le retour SDK et les callbacks doivent d’abord être validés pour
une solution asynchrone. Restent donc ouverts : identifier le thread réel en jeu,
corréler son attente aux frametimes, puis décider d’une préobtention/asynchronie
respectant identité, canal, expiration, déconnexion et propriété mémoire.
Ne pas annoncer « Vivox désormais non bloquant » ni « tous les FPS corrigés ».

## Coordination des PR

- [#82](https://github.com/h1z1rotk/rotk-launcher/pull/82) couvre déjà la continuité
  des transitions v13. Cette branche **n’inclut ni `crouch_transition.h`, ni sa
  nouvelle logique, ni ses tests d’inversion**. C3 porte uniquement les gains
  I/O/cache sur le comportement v12 existant ; il ne faut pas annoncer v13/v14
  complet dans ce binaire.
- Les deux PR touchent le hook, le marqueur et les empreintes. Après fusion de
  l’une, résoudre les chevauchements de l’autre au niveau source, reconstruire
  deux fois le proxy et actualiser tous les pins. Ne pas sélectionner simplement
  l’une des DLL binaires au moment de résoudre un conflit.
- #58 (background sync), #81 (hardware), #77 (deathcomm) et #76 (restore originals)
  ne sont pas repris. Le contrôle des assets reste attendu avant lancement.

## Vérifications exécutées

Windows x64, Node 22.17.1, Zig 0.15.2, dépendances npm déjà disponibles.
Pour la validation finale, SDK .NET **10.0.401** installé dans un répertoire local
avec le [script officiel Microsoft](https://dot.net/v1/dotnet-install.ps1),
`-Channel 10.0 -Architecture x64 -NoPath` et `-InstallDir` explicite.
Signature Authenticode Microsoft valide, sources et comportement relus avant
exécution ; SHA-256 du script :
`e8b873e18a81e5c4cd8ab69d84dac8fead291d50b3c44633cd7fddad709a13d6`.
`PATH` et `DOTNET_ROOT` limités au processus ; caches .NET/NuGet locaux à la copie
de travail, restauration NuGet réussie. Aucune installation globale.
Le problème du wrapper npm utilisateur a été
contourné avec un préfixe/cache propres à la copie de travail.

- `npm run typecheck` : réussi.
- `npm test` : réussi, dont **404 tests Vitest réussis / 3 opt-in ignorés**,
  **18/18 diagnostics natifs**, suites d’assets, cache/hooks, DirectInput et rangs.
  Le test d’assets nécessitant une installation BR1315 est ignoré.
- `npm run build:vivox` : réussi, incluant pile 32 Kio, scénarios C7, cache,
  transitions nominales v12, rangs et compatibilité des volumes sur le runtime
  SDK déjà fourni. Cinquante cycles de volume et propriété des requêtes validés.
- `npm run build:electron` et `npm run build:renderer` : réussis.
- DirectInput reconstruit deux fois avec égalité SHA-256 ; Vivox reconstruit dans
  deux chemins de sortie distincts avec égalité SHA-256. Vérificateurs et sidecars
  cohérents avec les pins TypeScript/CI/release. `git diff --check` : réussi.
- **`npm run build` complet : réussi, code 0, sur `fe6cc58`.** Vérification
  PresentMon, compilation diagnostics, publication .NET locale de Deathcomm,
  tests Deathcomm (sans périphérique audio physique), typecheck, suite complète
  (404 Vitest réussis / 3 ignorés et 18/18 diagnostics), Electron et renderer.
  L’absence initiale de .NET 10 est résolue par le SDK local, sans changer les
  sources ni la cible du projet. Aucun changement suivi produit par le build.
  Log conservé dans `.dev-data/validation-final/npm-build.log`, SHA-256 :
  `745ec16f34e374cb76022a97818cb8b93e65f065c0a657d447a70cca74a923cb`.
  Version SDK et code retour dans `dotnet-info.log` et `build-result.log` du même
  répertoire ignoré. Ces logs locaux ne sont pas ajoutés au dépôt.
- `npm run build` ne crée pas le paquet Electron ; aucune commande `dist`,
  publication externe, installation du launcher ou nouvelle recette en jeu.

Statut de remise : **build complet local validé, prêt pour poursuite de revue de
la PR #83**. Cette vérification ne vaut pas exécution de GitHub CI. Seule cette
documentation change après `fe6cc58` ; packaging et
recette en jeu restent à valider avant diffusion. C7 reste partiel.

Artefacts open source produits :

| Artefact | Octets | SHA-256 |
|---|---:|---|
| `dinput8.dll` | 34 304 | `2c8c7d65f8410a2f05f58318978b44f08860c4f5647b5474a11bf70a0ebc0b3a` |
| `vivoxsdk_x64.dll` | 72 192 | `461d14e5ed11305508e85cf014c73ec90578b560a4bca1019ebe24adee583b20` |

Les essais historiques plafonnés à 170 FPS et les processus corrélés aux saccades
ne démontrent pas une causalité. Aucun chiffre de gain FPS ni promesse concernant
Chrome, le tearing ou le second crash CZ n’est attaché à ce lot.
