# Rapports de crash et sessions Debug — launcher ROTK 2.0.7

Cette fonctionnalité est préparée pour **2.0.7**. Cette documentation accompagne
une version de travail **non publiée** : elle ne signifie pas que la mise à jour
est déjà disponible pour les joueurs. Avant publication, le serveur doit admettre
la version **2.0.7** et les binaires correspondants dans les contrôles de version
et d’attestation applicables. Valider le paquet exact sur TEST, puis coordonner
son admission et sa publication. Une simple modification de `package.json` ne
met pas à jour cette politique serveur.

## Joueur : enregistrer une session Debug

Pour examiner des saccades ou un crash, active Debug **avant de jouer**. Le
parcours joueur utilise uniquement cette case ; aucun bouton de déclaration
manuelle de crash n’est proposé.

1. Avant de lancer le jeu, ouvre **Paramètres → Debug** et coche
   **Enregistrer ma session de jeu**.
2. Lance le jeu et reproduis le problème normalement.
3. À la fermeture du jeu, même sans crash, le launcher prépare automatiquement
   le ZIP et ouvre **Téléchargements → ROTK-Rapports** avec le fichier sélectionné.
   Envoie ce ZIP à l’administrateur par le canal privé convenu. Aucun formulaire
   ou choix de destination n’est nécessaire.

Le nom est `ROTK-session-DATE-ID8-unique.zip` : la date, un identifiant abrégé et
un suffixe unique distinguent les exports. Le fichier reste dans le dossier
Téléchargements configuré sur ce PC. La case est désactivée par défaut,
mémorisée pour les prochaines parties et verrouillée pendant la session. Décoche-la
après tes essais si tu ne souhaites plus enregistrer les parties suivantes.
Il s'agit d'un enregistrement technique, sans vidéo, microphone ou saisie clavier.
La fenêtre du launcher peut être fermée : son processus reste actif pendant le jeu
et jusqu'à la fin de la préparation. Si Windows ou le launcher s'arrête brutalement,
la dernière session Debug non exportée est reprise au redémarrage à partir des
fichiers encore présents ; le rapport identifie une éventuelle interruption.

Si la préparation du ZIP échoue, le launcher l’indique et conserve les preuves
déjà collectées localement. **Relance le launcher** : il retente l’export de la
dernière session Debug non exportée. Un fichier temporaire n’est pas un rapport
terminé. Le launcher **n’envoie aucun rapport automatiquement**.

Lors de l’envoi à l’administrateur, ajoute si possible l’heure approximative et
l’action effectuée : par exemple « Combat Training, changement d’arme à 21 h 34
heure de Paris, retour au bureau ». Un rapport sans dump reste utile ; il ne faut
pas recréer artificiellement un crash pour obtenir un fichier. Les dumps peuvent
contenir des données de session : partage le ZIP uniquement avec un administrateur
de confiance.

## Ce que contient le ZIP

La présence de chaque pièce dépend de ce qui était disponible pour la session.
`manifest.json` décrit le contenu réellement exporté.

| Fichier | Utilité |
| --- | --- |
| `README.txt` | Résumé lisible : identifiant du rapport, début UTC, décalage horaire, version, serveur, joueur, classification et code de sortie. |
| `NOTES.txt` | Description de l’export automatique de la session Debug. Ce texte ne remplace pas les preuves d’une exception native. |
| `report.json` | Schéma version 1 : `summary`, `context`, `timezoneOffsetMinutes`, `exit`, `issues`. |
| `manifest.json` | Identifiant et date d’export, fichiers avec taille et SHA-256, limites, problèmes de collecte et omissions, indicateur `containsUnredactedProcessMemory`. Le manifeste ne contient pas sa propre empreinte. |
| `events.jsonl` | Chronologie du launcher pour cette session : démarrage du jeu, sortie, demande de capture, portions de stdout/stderr, erreurs du launcher enregistrées. |
| `native-events.jsonl` et éventuellement `.1` | Attachement du helper, exceptions, compteurs, modules et versions, mesures mémoire/CPU, captures réussies ou échouées et sortie native. `.1` est le journal précédent. |
| `performance-summary.json` | En mode Debug : synthèse des compteurs du processus, pics, couverture, coût de collecte et limites. |
| `performance.jsonl` et éventuellement `.1` | En mode Debug : mesures du processus environ chaque seconde, dates UTC et horloge monotone QPC. |
| `frame-times-summary.json` | Disponibilité de PresentMon, raisons d'échec éventuelles, statistiques des intervalles de présentation par swapchain et pics. |
| `frame-times.jsonl` et éventuellement `.1` | Événements de présentation réellement observés pour ce PID, avec QPC et données numériques sélectionnées. |
| `client-game-KillFeed.log-….log`, `client-game-GFxWrap.log-….log` et autres journaux reconnus | Journaux du dossier `Logs` du jeu : killfeed, Scaleform/GFx, UI, échecs de chargement d'assets et erreurs de packs, lorsqu'ils existent et ont été écrits pendant cette session. |
| `client-local-….log`, `client-failure-….log`, `client-native-….log` et extensions similaires | Extraits des journaux autorisés du jeu, associés à cette session. Le suffixe évite d’exposer le chemin original. |
| `dumps/crash-….dmp` | Minidump d’une exception fatale observée, si la capture a réussi. Les dumps disponibles sont inclus dans le ZIP automatique de la session. |
| `dumps/snapshot-….dmp`, éventuellement `-full.dmp` | Capture de l’état du processus lorsqu’elle est disponible. Le suffixe `full` identifie une capture mémoire complète issue du mécanisme technique décrit plus bas. |

Dans `report.json`, consulter notamment :

- `summary.id`, `startedAt`, `endedAt`, `launcherVersion`, `serverLabel`,
  `playerName`, `kind`, `status`, `exitCodeHex`, `captureStatus`, `warnings` ;
- `context.pid`, `processStartedAt`, `processEndedAt`, `steamId`, `serverId`,
  `role`, `assetPackVersion`, lorsqu’ils sont disponibles ;
- `context.binaries` : taille, SHA-256 et date de modification des exécutables et
  DLL ciblés ; une entrée `unavailable` n’est pas une preuve de modification ;
- `context.debugSessionEnabled` et `context.clientContext` : mode de cette session,
  état de synchronisation des assets, ledger, fichiers observés et options graphiques
  autorisées. Les hash déclarés par le ledger sont distincts des hash réellement
  mesurés ; les gros packs sont inventoriés par taille/date pour éviter de les relire
  pendant la partie. Les petits fichiers UI sélectionnés peuvent être hashés ;
- `context.systemInfo` et éventuellement `systemInfoAtCapture` : Windows, CPU,
  RAM, carte graphique et pilote lorsque l’interrogation Windows a réussi ;
- `context.windowsEvents` : événements Windows Application Error, Hang et WER
  retrouvés dans la fenêtre de la session ;
- `context.rotkcModule` : ce que le proxy vocal a écrit dans
  `rotk-vivox-v5-compat.log` sur le chargement de `rotkc.dll` par ce processus
  (`loaded`, `loaded-legacy-imports`, `load-failed` avec le code d’erreur Windows,
  `path-failed`, `not-logged`, `log-unavailable` ou `unknown`), pour le support ;
- `exit.code`, `unsignedCode`, `hex`, `name`, `signal`, `error` et `issues` pour
  distinguer une exception, un échec de lancement et une information absente.

Les anciens rapports ou exports techniques peuvent aussi porter
`context.playerReportedCrash` et `playerReportedAt`. Ces champs décrivent une
déclaration manuelle ; ils ne sont pas nécessaires au parcours Debug automatique
et ne remplacent pas la classification ou le code de sortie observés.

Les journaux client sont bornés et sélectionnés ; il ne s’agit pas de tous les
fichiers du PC. Les portions antérieures au lancement sont normalement exclues.
Après la sortie, les limites et empreintes des sources sont figées pour éviter
qu’un export ultérieur mélange les journaux d’une nouvelle partie. Une rotation,
une réécriture ou une source devenue inaccessible est signalée dans `issues`.

## Administrateur : premier tri et corrélation serveur

Commencer par `README.txt`, `NOTES.txt`, puis `report.json`. Noter l’identifiant du
rapport, la version du launcher, le serveur, le joueur ou SteamID disponible, le
PID et les heures de début/fin. Les dates terminées par `Z` sont en **UTC**.
`timezoneOffsetMinutes` est le décalage local vers l’est : `120` signifie UTC+2.
Le PID seul ne suffit pas à corréler deux événements : Windows peut le réutiliser.

Rechercher la session correspondante dans les journaux du bon serveur, autour de
l’heure de sortie et de la dernière action décrite. Comparer les événements de
connexion/déconnexion et les journaux de mode de jeu. Un délai réseau ou un joueur
qui ne répond plus ne prouve pas un crash natif. Si un événement Windows porte
`correlation: "executable-and-time-only"`, il correspond au nom et à la fenêtre
horaire ; cette association est moins précise que `"pid-and-time"`.

Dans le journal natif, rechercher `exception` avec **`firstChance: false`** et le
`dump-written` de **`kind: "fatal"`** associé. Une exception `firstChance: true`
peut être traitée normalement par le jeu. Les trois premières notifications de
chaque code sont détaillées, puis les compteurs limitent le volume. Une capture
`kind: "snapshot"` décrit un état à examiner, pas une preuve d’exception fatale.

| Code Windows | Ce qu’il établit | Ce qu’il ne permet pas de conclure seul |
| --- | --- | --- |
| `0xC0000005` | Violation d’accès mémoire. Les paramètres d’exception peuvent préciser lecture, écriture ou exécution et l’adresse concernée. | La DLL ou la modification à corriger ; il faut le contexte, la pile, les versions et les étapes de reproduction. |
| `0xC00000FD` | Débordement de pile. | La fonction qui a provoqué l’épuisement ou sa cause exacte ; examiner les piles et les répétitions d’appels. |
| Code absent ou sortie non nulle différente | La sortie ou l’observation n’a pas fourni une exception reconnue. | Qu’un crash natif a nécessairement eu lieu, ou qu’aucun problème n’existe. |

Comparer les empreintes de `context.binaries` aux binaires de référence réellement
distribués. Pour regrouper plusieurs incidents, utiliser le code d’exception,
le module, son empreinte/version et l’**offset dans le module**, pas seulement une
adresse absolue : l’ASLR peut changer les bases entre deux lancements. Le module
au sommet de la pile est une piste d’analyse ; il ne désigne pas automatiquement
le composant responsable de la corruption.

Les échantillons `sample` permettent de voir la mémoire privée et résidente du
jeu, la disponibilité physique/engagée du système et le CPU toutes les cinq
secondes. Ils peuvent appuyer une hypothèse de pression mémoire ou de blocage,
sans remplacer l’analyse des piles et du code.

## Administrateur : stutters, killfeed et assets

La session commence avant le démarrage du processus. L'inventaire des binaires,
la lecture des options graphiques et la requête système sont réalisés avant le
spawn ; les compteurs natifs et PresentMon démarrent dès que le PID existe. Les
premiers événements précédant leur attachement peuvent donc manquer. Les heures
et statuts permettent de vérifier la couverture au lieu de supposer qu'elle est complète.

Commencer par les deux fichiers `*-summary.json`. Les compteurs natifs à une
seconde décrivent CPU (normalisé sur tous les processeurs et équivalent un cœur),
mémoire privée/résidente, fautes de pages, I/O, threads et pression mémoire système.
Les fautes de pages combinent fautes matérielles et logicielles ; les I/O ne sont
pas uniquement des accès au disque. Ces échantillons ne mesurent pas la durée
de chaque image ni le thread responsable d'un ralentissement.

PresentMon fournit séparément les intervalles de présentation et, lorsqu'elles
existent, des mesures GPU/affichage. Les statistiques restent séparées par
swapchain : additionner toutes les chaînes de présentation créerait de faux FPS.
Les percentiles issus d'un histogramme sont des bornes de classes, pas des valeurs
exactes. Les pics absolus et relatifs sont des candidats à examiner ; menus,
alt-tab, limiteur de FPS ou attente normale peuvent aussi créer un intervalle long.

Windows peut refuser ETW avec les droits courants. Le launcher ne déclenche pas
d'élévation de privilèges et ne modifie pas de groupe/service Windows. Le résumé
indique alors `unavailable` et sa raison ; l'absence de mesures PresentMon ne
signifie pas l'absence de stutters. CPU, mémoire, exceptions et journaux disponibles
restent collectés. Aucun FPS synthétique n'est calculé à partir des échantillons CPU.

Pour rapprocher un pic d'un kill :

1. Identifier sa swapchain, son QPC et sa durée dans la synthèse PresentMon ou le
   journal. Utiliser les ancres UTC/QPC et la fréquence QPC du journal natif pour
   rapprocher les horloges sur ce PC. L'heure UTC de **réception** du flux PresentMon
   peut être retardée par son buffering : ce n'est pas l'heure exacte de l'image.
2. Examiner `KillFeed`, `GFxWrap`, `uiDB`, `FailedLoadAssets`, `FailedSyncLoadAssets`
   et `ContentPackErrors` autour de l'événement. Les lignes du client peuvent employer
   une date locale et un compteur interne en millisecondes ; conserver ce compteur,
   vérifier son origine et appliquer le décalage horaire indiqué par le rapport.
3. Comparer plusieurs kills avec et sans pic. Refaire une session avec assets ROTK
   et une session stock, sur le même PC et avec Debug et les options graphiques
   identiques. Vérifier `context.clientContext` : une case de synchronisation
   désactivée ne prouve pas à elle seule que les anciens fichiers ont été restaurés.
4. Corréler avec les journaux serveur du même joueur/match, puis analyser les
   événements UI/chargement et le code correspondant. Un pic simultané à un kill
   justifie une piste ; il ne prouve pas que le rendu de la killfeed est la cause.

Cette version prépare les preuves nécessaires. Elle ne corrige pas encore une
cause de stutter démontrée et ne fournit pas un profil d'appels CPU/GPU complet.
Le coût de l'instrumentation peut modifier le timing ; comparer les deux variantes
avec la même instrumentation et contrôler les pertes/limites dans les résumés.

## Administrateur : ouvrir le dump avec WinDbg

Extraire le ZIP dans un dossier privé, puis ouvrir le `.dmp` avec **WinDbg → File
→ Open Crash Dump**, ou lancer `windbg -z "C:\Rapports\crash.dmp"`. Le fichier
est un minidump Windows avec signature `MDMP`. Il faut les binaires et, lorsque
disponibles, les symboles/PDB correspondant exactement à la version capturée.
[Guide Microsoft pour les dumps de processus](https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/analyzing-a-user-mode-dump-file).

Exemple de préparation des symboles, avec des chemins à adapter :

```text
.symfix C:\ROTK-Symbols\Microsoft
.sympath+ C:\ROTK-Symbols\Private\2.0.7
.reload /f
lm
```

Le serveur de symboles Microsoft sert les symboles Windows ; il ne fournit pas
les symboles privés de ROTK. Cette récupération éventuelle est une action de
l’administrateur dans WinDbg, distincte du launcher. Sans PDB correspondant, un
module et son offset restent exploitables, mais une ligne de code ou un nom de
fonction privé peut rester inconnu.
[Commandes et symboles WinDbg](https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/getting-started-with-windbg).

Pour un **dump fatal** contenant un flux d’exception :

```text
.exr -1
.ecxr
k
!analyze -v
~* k
```

`.exr -1` affiche l’exception, `.ecxr` sélectionne son contexte de registres,
`k` montre la pile du thread sélectionné et `~* k` les piles des threads. Conserver
le code, l’adresse, le module, l’offset, les piles et les avertissements sur les
symboles. L’analyse automatique est une aide à l’enquête.
[Contexte d’exception Microsoft](https://learn.microsoft.com/en-us/shows/inside/ecxr).

Pour un **snapshot de blocage**, commencer par `~* k` et `lm`. Il peut ne pas
exister de flux d’exception : l’échec de `.ecxr` dans ce cas ne signifie pas que le
snapshot est inutilisable. Plusieurs snapshots pris à des moments différents
peuvent aider à distinguer une attente stable d’un traitement lent.

## Développeur : capture native et mémoire complète

La capture automatique utilise un **minidump**, jamais un dump complet. La
collecte des exceptions, registres, modules et mesures mémoire/CPU reste active
dans le mécanisme de diagnostic. Le parcours joueur propose uniquement la case
**Debug** pour les prochaines sessions, puis l’export automatique à la fermeture
du jeu ; il ne demande aucune sélection de dump complet.

Les API backend de déclaration, capture et export manuels restent disponibles
pour les outils et tests techniques ; elles ne correspondent pas à des commandes
de l’interface joueur. Le helper conserve une commande de **dump mémoire complet**
pour une intervention technique explicite. Elle peut être utile pour examiner un
blocage ou une corruption, mais peut peser plusieurs Go, prendre plus longtemps
et perturber ou suspendre le processus pendant la collecte. Le helper vérifie que
l’espace disponible couvre la mémoire engagée du processus plus 512 Mio. Après
la fermeture du processus, sa mémoire complète ne peut plus être récupérée.
La commande et ses contraintes sont décrites dans le contrat natif lié en fin
de document. Il ne s’agit pas d’un bouton supplémentaire à demander au joueur.

## Confidentialité, volume et limites

Les textes exportés passent par des règles de masquage des secrets connus,
jetons, mots de passe, adresses et chemins sensibles reconnus. Les fichiers de
configuration/identifiants, l’environnement et la ligne de commande brute sont
exclus. Le joueur/SteamID, les codes, horaires et empreintes utiles à l’enquête
peuvent rester présents. Ce masquage n’est pas une garantie d’anonymisation de
toute chaîne arbitraire écrite par le jeu : relire le contexte avant partage.

**Les dumps binaires ne sont pas masqués.** Un minidump comme un dump complet
peut contenir des données de session, identifiants, messages ou autres morceaux
de mémoire du jeu. Les partager uniquement avec un administrateur de confiance,
par un canal privé. Le ZIP automatique de session Debug inclut les dumps disponibles,
y compris un dump complet déjà présent. Aucun rapport n’est transmis
automatiquement. Le dossier interne du launcher peut aussi contenir des
métadonnées de travail et des chemins locaux ; utiliser le ZIP préparé pour le
partage au support.

La collecte textuelle vise au maximum **2 Mio par fichier, 20 Mio au total et
40 fichiers de journaux collectés** ; les fichiers de synthèse du ZIP s’y
ajoutent. Les omissions et troncatures sont décrites dans le manifeste. Le helper
fait tourner son journal natif autour de 4 Mio avec une sauvegarde ; l’export peut
donc n’en conserver que les extraits bornés. Les dumps ont leurs propres limites
et ne sont pas réduits au budget des textes.

Les journaux Debug ont un budget distinct : deux fichiers de **16 Mio** pour
les compteurs natifs et deux de **16 Mio** pour les présentations. La rotation
garde les données récentes ; les synthèses conservent les statistiques agrégées
de la période observée. Chaque synthèse est bornée à **64 Kio**, et le budget
d'export Debug à **66 Mio**, en plus des textes et dumps. Les mesures détaillées
s'arrêtent après **8 heures** ; la capture des exceptions peut continuer. Les
résumés et `issues` décrivent rotation, troncature, perte et durée réellement observée.

Le minidump vise un budget de 256 Mio ; si la collecte enrichie échoue, le helper
réessaie une fois avec moins de mémoire indirecte. Ce contrôle utilise les
callbacks Windows et n’est pas un plafond strict. Le launcher applique un
watchdog d’environ 70 secondes pour un dump standard et 200 secondes pour un
complet ; une demande manuelle expire au plus tard autour de 75/205 secondes.
Par processus, le helper limite les captures réussies à dix snapshots manuels,
dont deux complets au maximum, et deux dumps fatals.

Le nettoyage local vise **10 rapports récents, 7 jours et 5 Gio**. Les sessions en
cours/en collecte, le rapport protégé par l’opération et le dernier rapport
terminé sont conservés. Ce sont des objectifs de rétention, **pas un quota disque
strict** : un dump complet protégé peut dépasser 5 Gio. Conserver les ZIP des
sessions importantes dans un emplacement adapté. Les ZIP créés dans
**Téléchargements → ROTK-Rapports** ne font pas partie de cette rétention locale.

Le helper suit uniquement le `H1Z1.exe` lancé par ce launcher. Il n’élève pas les
privilèges, ne modifie pas de DLL de gameplay et désactive le comportement Windows
qui tuerait le jeu à la fermeture du débogueur. Une capture indisponible ne doit
pas empêcher de jouer. Le mode débogage peut toutefois modifier le timing ou
interagir avec d’autres outils ; vérifier son état dans les métadonnées du rapport.

Aucun dump automatique n’est garanti si le problème survient avant l’attachement,
si le jeu est terminé avec `TerminateProcess`, si le launcher/helper est tué,
en cas de panne ou redémarrage du PC, de droits incompatibles, de disque plein ou
d’un autre débogueur déjà attaché. Un arrêt GPU/noyau peut nécessiter des preuves
différentes. Une session récupérée après interruption est signalée comme telle ;
cela ne prouve pas un crash du jeu. Les captures comportent des limites de temps
et un watchdog ; un dump incomplet `.partial` n’est pas présenté comme un `.dmp`
terminé. Aucune capture ne peut reconstituer la mémoire d’un processus disparu.

Le contrat natif et les tests reproductibles sont décrits dans
[`native/diagnostics/README.md`](../native/diagnostics/README.md).
