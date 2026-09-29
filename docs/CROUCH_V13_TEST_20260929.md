# Accroupissement v13 : correctifs et validation sur TEST

## Ce que cette branche corrige

Dans v12, relâcher l'accroupissement après 100 ms laissait la pose continuer
jusqu'en bas avant de remonter. Même défaut pendant le relevé et en marchant.
v13 évalue d'abord la pose courante, puis accepte immédiatement la nouvelle
destination. Le temps restant est proportionnel à la distance de pose ; un
appui bref n'impose plus un nouveau cycle complet. La position reste continue
à l'inversion ; la vitesse de la courbe repart volontairement de zéro.

v12 choisissait aussi brutalement entre 250 et 400/200 ms selon qu'un nœud
mobile avait été vu depuis 100 ou 101 ms, puis figeait ce choix. v13 conserve
la mémoire de mouvement de 100 ms, puis diminue son influence progressivement
sur les 100 ms suivantes. La progression intègre exactement cette influence
entre deux évaluations et s'adapte pendant la transition. Un nœud mobile
nouvellement observé ne réécrit pas le mouvement déjà écoulé.

Les transitions complètes en locomotion stable conservent la courbe sinus et
les durées **400 ms pour descendre, 200 ms pour remonter à l'arrêt, 250 ms dans
les deux sens en mouvement**. Les poids d'événements, de synchronisation et
les arguments d'additivité restent ceux du moteur. Ni vitesses de déplacement,
ni règles de saut/chute, ni animations d'armes, ni packs ne sont modifiés.
Le hook caméra reste désactivé. Le cache conserve ses protections de génération,
capacité, TTL et repli sur le graphe original ; son échéance tient compte du
profil le plus lent possible pendant une transition.

## Artefact et intégration

Il s'agit d'un **correctif client du launcher**. Déployer seulement le serveur
Rust sur TEST ne change pas le hook installé chez les joueurs.

- DLL versionnée : `resources/patches/vivoxsdk_x64.dll`, 73 216 octets.
- SHA-256 : `8ab1f2379c61b81391492edb84875610ffbe4d3a8d97a180c73355d989ac27a2`.
- Source : `native/vivoxproxy/crouch_transition.h`, appelée par le hook dans
  `crouch_parity_patch.h`.
- Empreinte mise à jour dans le launcher, le sidecar, le vérificateur et les
  workflows CI/release. Le marqueur d'installation annonce v13.
- Le binaire doit être reconstruit avec **Zig 0.15.2**, comme en CI.

Procédure admins :

1. Récupérer cette branche et attendre la CI Windows verte pour son commit exact.
2. Utiliser une copie de client réservée à TEST. Construire le launcher depuis
   ce commit (`npm ci`, puis `npm run dist:dir`) avec les dépendances habituelles
   du projet : Node, Zig 0.15.2, .NET 10. La compilation complète et le packaging
   restent des contrôles de CI/admin ; aucun installeur public n'est publié par
   cette branche.
3. Lancer cette version du launcher sur la copie TEST : son mécanisme existant
   installe le proxy et vérifie l'empreinte et le marqueur. Ne pas utiliser un
   ancien launcher ensuite sur cette copie : il réinstallerait son propre proxy.
4. Vérifier le SHA-256 ci-dessus et la ligne `ADS-safe v13-perf1 installed` dans
   `rotk-crouch-parity.log`. Vérifier le démarrage du vrai jeu, la voix et l'ADS.
   Ne pas assouplir l'attestation ; utiliser la politique TEST prévue par les admins.
5. Exécuter la recette ci-dessous avant fusion/release générale. Réserver une
   nouvelle version de launcher avant publication : `package.json` n'a pas été
   augmenté et le tag/release public existant ne doit pas être remplacé.

Retour arrière TEST : réutiliser le launcher validé précédent sur la copie
TEST pour restaurer ses fichiers vérifiés. Conserver la sauvegarde stock gérée
par le launcher. Aucun serveur de production n'est modifié par cette procédure.

## Vérifications locales réalisées

- `npm run typecheck` : réussi.
- Vitest : 389 tests réussis, 3 tests de diagnostic natif opt-in ignorés.
- `npm run build:electron` et `npm run build:renderer` : réussis.
- `npm run build:vivox` : réussi, avec cache multithread, transitions, chargement
  sur pile de 32 Kio, voix Duo, rangs et volumes sur le vrai SDK Vivox.
- Deux compilations du proxy vers des chemins différents : SHA-256 identiques
  à celui du binaire versionné. Noms et ordinaux des exports identiques à v12.
- Le nouveau banc appelle le **hook de production**, avec une horloge contrôlée
  et une fonction moteur collectrice : 1 571 appels, poids d'événements et
  arguments ADS/additivité préservés sur chacun. Il ne lance aucun jeu et
  n'installe aucun hook dans un autre processus.
- Le même banc compilé contre les sources v12 échoue à la première inversion,
  après avoir validé les courbes nominales : la régression est bien détectée.
- `npm test` : suites d'assets et tests natifs accroupissement/sprint/rangs
  réussis, mais arrêt dans les diagnostics natifs (17/18). Le test
  `debug records real 1s CPU memory IO page-fault thread counters and bounded
  peak summary` échoue sur `cpuOneCorePercent > 25`. Même échec reproduit sur
  une extraction intacte du commit de base `8f82770d`, sans ces corrections.
  Ce résultat local préexistant est signalé ; la suite globale n'est pas
  annoncée verte. Les 389 tests Vitest ont été exécutés séparément.

Reproduire les tests natifs : `npm run test:native:crouch`. Ils couvrent les
deux sens, appuis de 30/50/100 ms, inversions répétées, frontière 100/101 ms,
adaptation en cours de mouvement, différents pas temporels, ordre des nœuds,
inversion sans distance, identité invalide et état périmé. Ils sont inclus
dans les commandes `test` et `build:vivox` existantes, donc en CI.

## Recette visuelle : nécessaire avant validation du ressenti

Comparer v12 et v13 avec les mêmes réglages, localement et depuis un second
joueur, en priorité en troisième personne, puis en première personne.

| Groupe | Cas |
|---|---|
| Accroupissement | Maintien, appuis 30/50/100 ms, inversion à mi-course dans les deux sens, répétitions rapides |
| Locomotion | Marche/course, recul, strafe, diagonales ; arrêt puis accroupissement ; départ/arrêt de marche pendant la transition |
| Armes | Pistolet, AR/AK, shotgun, sniper ; hanche/ADS, tir, recharge, changement d'arme ; sprint → visée/tir → sprint |
| Postures voisines | Debout/accroupi/couché, saut et réception, pente, escalier, plafond bas, couverture |
| Cycle de vie | Véhicule → à pied, parachute → sol, mort/respawn, retour en visibilité après 2 secondes, changement de cible spectateur |
| Cohérence visuelle | Pas de détour forcé par l'ancienne pose, pas de saut au changement de locomotion, pas d'arme ou de visée bloquée ; vérifier les différents modèles de personnage |

## Ce qui reste ouvert dans l'audit élargi

**La coupure horizontale sur toute l'image avec un léger flou, en tournant vite
la souris accroupi en troisième personne, n'est pas reproduite ici.** Les
défauts corrigés concernent les transitions ; une posture stabilisée n'avance
pas la courbe. Ne pas annoncer que v13 corrige nécessairement ce symptôme.

Sur TEST : même scène dégagée, rotations debout puis accroupi après deux
secondes ; comparer temporairement avec VSync effectivement appliquée, puis
si nécessaire l'ajustement automatique de caméra, une variable à la fois.
Relever les temps d'image avec les diagnostics existants et, si la déchirure
n'apparaît pas dans la capture logicielle, filmer l'écran. Ces essais n'ont
pas été effectués pendant cette correction.

Le serveur a une réserve distincte en entraînement : après sortie de véhicule,
`AwaitingGroundBaseline` attend un état complet dans l'enveloppe autorisée.
L'absence durable de cet état pourrait empêcher la reprise ; aucun blocage
réel n'a été reproduit. Ne pas accepter arbitrairement des paquets partiels
ou anciens pour contourner cette protection. Le solo possède une récupération
plus complète. Les 81 tests Rust de l'audit précédent passaient ; aucun code
serveur n'a été changé dans cette branche.

Enfin, l'identité du graphe d'animation chargé depuis les packs n'avait pas
été établie par l'audit. Cette correction ne remplace aucun pack et ne
désactive pas les additifs Season3 nécessaires à la visée.
