# ROTK Launcher

## Private Debug reports (2.0.8)

In Settings → Debug, **Debug and send session reports** is an explicit opt-in to
private uploads after the game exits. A previous local-only Debug preference does
not authorize transmission. The launcher sends bounded, redacted technical text
and available memory dumps, then displays the server's report reference. It does
not ask players to send ZIPs. Dumps can contain private data and remain quarantined
at reception; reports expire after seven days. Disable Debug after testing.

An interrupted transfer keeps its local evidence; restarting the launcher retries
the latest eligible report when Debug is still enabled. A changed key/account
blocks that resend. The dedicated receiver authenticates an account with recent
game activity, not the executable's integrity or the truth of submitted logs.

The developer ZIP-export APIs described in the technical documentation remain
local tools. They are no longer the player Debug workflow. See
[`docs/PRIVATE_DIAGNOSTICS.md`](docs/PRIVATE_DIAGNOSTICS.md).

Launcher Windows open source de **Return of the King (ROTK)**. Il utilise directement un client H1Z1 déjà isolé ou prépare une copie dédiée depuis Steam, affiche les deux dernières actualités publiées sur [rotk.app](https://rotk.app/updates), puis lance le jeu avec la configuration réseau ROTK.

> [!IMPORTANT]
> Le dépôt ne contient, ne télécharge et ne redistribue **aucun fichier du client H1Z1**. Il faut disposer d’une copie obtenue légitimement, par exemple via Steam. H1Z1 et les marques associées appartiennent à leurs ayants droit. ROTK est un projet communautaire indépendant, sans affiliation avec Daybreak Game Company.

## Sélection intelligente du client

Le launcher inspecte le chemin logique et physique sélectionné :

- un client déjà isolé hors de `Steam`, `SteamLibrary`, `steamapps` et `common` est configuré et utilisé directement ;
- une installation située sous l’un de ces dossiers sert uniquement de **source de copie** vers un emplacement séparé.

Cette règle évite tout conflit avec la version live sans imposer une nouvelle copie à l’utilisateur qui possède déjà un client Alpha ou une installation indépendante.

La validation porte aussi sur le chemin physique afin qu’une jonction ou un lien symbolique ne permette pas de contourner la règle. La copie passe par un dossier temporaire, vérifie les fichiers critiques en SHA-256 et n’est rendue active qu’après finalisation.

Une installation terminée est mémorisée dans `%APPDATA%\ROTK Launcher\config.v1.json`, avec une copie de secours locale. Le même chemin canonique est utilisé par les versions suivantes du launcher ; les anciens dossiers de configuration connus sont migrés automatiquement. Le sélecteur du client ne réapparaît que si aucune installation valide n’a encore été enregistrée.

## Fonctionnalités

- interface Electron/React inspirée de l’identité visuelle de la web app ROTK ;
- interface bilingue, en anglais par défaut, avec choix English/Français mémorisé localement ;
- affichage des deux derniers dev updates ou patch notes publiés sur `rotk.app` ;
- images de couverture chargées à la demande depuis `https://rotk.app` ;
- utilisation directe d’un client déjà isolé ou assistant de copie depuis Steam ;
- contrôle d’espace disque, progression par fichier et annulation sûre ;
- sauvegarde des fichiers originaux avant configuration ;
- lancement de `H1Z1.exe` sans shell, avec une liste d’arguments construite par le launcher ;
- clé launcher créée depuis le compte Steam sur `rotk.app`, obligatoire avant le lancement et conservée chiffrée avec Windows DPAPI ;
- échange HTTPS de cette clé durable contre un ticket court à usage unique, avec validation stricte du ROTKID, du GameAccountGUID et du SteamID renvoyés ;
- mini-gateway Steam de session lié exclusivement à `127.0.0.1` pendant l’exécution du jeu : H1Z1 reçoit uniquement le ticket court, jamais la clé durable ;
- shim `steam_api64.dll` open source, compilable de façon déterministe avec Zig ;
- proxy Vivox 5 open source intégrant le patch crouch v12 obligatoire, vérifié et réparé avant chaque lancement ;
- isolation Electron (`contextIsolation`, sandbox, IPC limité et navigation externe filtrée).

La branche `new-server` cible le serveur GAME 2 ROTK `162.19.94.95` et ses listeners login `20042` à `20045`. Le futur manifeste runtime HTTPS signé remplacera cette configuration bornée sans exposer d’arguments arbitraires au renderer.

## Patch crouch obligatoire

Le launcher 1.4.2 déploie le hook crouch ADS-safe dans son proxy
`vivoxsdk_x64.dll`. Il préserve la DLL Vivox historique, installe le runtime
Vivox 5, puis crée `rotk-crouch-parity.ini` dans le client. Ces fichiers sont
vérifiés et réparés pendant l’installation, lors de l’adoption d’un client
isolé, avant l’attestation et une seconde fois juste avant le démarrage du jeu.
Le lancement échoue si cet état ne peut pas être garanti.

Le hook ne modifie pas `H1Z1.exe` sur disque. Il ne s’active qu’en mémoire sur
le build BR1315 `1.0.326.439939`, après validation du SHA-256 du fichier, de
l’en-tête PE et des signatures machine ciblées. Le hook caméra expérimental
reste désactivé : seul le poids de pose crouch validé est remplacé afin de
préserver les événements Morpheme utilisés par l’ADS.

La v12 conserve séparément les transitions de 256 réseaux d’animation, détecte
les réseaux recréés pendant un handoff et ne remplace jamais une transition
encore active. Si le cache ne peut exceptionnellement pas accepter un nouvel
acteur, ce seul appel reste sur le blend natif au lieu de modifier un joueur
déjà animé.

Le séquencement de release, le verrou serveur et le rollback sont documentés
dans [`docs/CROUCH_PATCH_ROLLOUT.md`](docs/CROUCH_PATCH_ROLLOUT.md).

## Réparation des assets 1.4.5

Le launcher 1.4.5 re-hashe désormais à chaque synchronisation les assets
distribués comme fichiers autonomes, même lorsque leur taille n’a pas changé.
Cela couvre notamment `Weapons.bnk_pc` et `Weapons_SFX.bnk_pc` du feed 1.5.0 :
le lancement normal comme **Vérifier les fichiers** restaurent automatiquement
la copie officielle si une variante vanilla de même taille l’a remplacée.

## Retrait du proxy gameplay 1.4.3

Le launcher 1.4.4 ne distribue et ne charge plus le proxy DirectInput gameplay.
Lors d’une installation, d’une adoption et avant chaque attestation/lancement,
il supprime uniquement le `dinput8.dll` officiel de la 1.4.3 après validation
de sa taille et de son SHA-256. Un fichier inconnu, un lien ou un répertoire
portant ce nom n’est jamais supprimé automatiquement et bloque le lancement
avec une erreur explicite.

## Droits d'exécution et ancre TPM (2.0.12 → 2.0.15)

Le launcher s'exécute avec les droits de l'utilisateur qui le lance
(`requestedExecutionLevel: asInvoker`) et l'installeur s'installe pour la
machine (`perMachine`, sous `Program Files` ; la mise à jour passe par
l'installeur assisté, qui demande lui-même l'élévation).

La 2.0.12 — publiée sous le numéro 2.0.14 — demandait les droits
administrateur au démarrage (`requireAdministrator`) pour l'**ancre TPM**
(issue h1z1rotk/returnoftheking#320 §A) : Windows refuse à un utilisateur
standard `TPM2_ActivateCredential` et la lecture du certificat de la clé
d'endossement (EK). Or Chromium lance ses processus GPU, renderer et
utilitaires comme de nouvelles instances de l'exécutable du launcher, sous des
jetons restreints par le sandbox : l'exigence du manifeste s'applique à chacun
de ces enfants. Sur une session qui tourne avec un jeton administrateur
complet sans dédoublement UAC — le compte `Administrator` intégré, courant sur
les Windows préinstallés ou « ghostés » — Windows refuse de les créer
(`GPU process launch failed: error_code=18`, `Renderer process launch-failed`)
et Chromium abandonne le processus (`GPU process isn't usable. Goodbye.`,
exception `0x80000003`) : le launcher ne s'ouvrait plus (issue
h1z1rotk/rotk-launcher#59). `--no-sandbox` le confirme, les enfants reprenant
alors le jeton du parent ; l'emplacement d'installation n'y est pour rien (une
copie sous `%LOCALAPPDATA%` échoue de même, les ACL de `Program Files` sont
celles par défaut). La 2.0.11, `asInvoker`, tournait sur ces mêmes sessions et
fonctionnait ; rien dans l'application n'intercepte cet abandon, la 2.0.15 y
revient.

L'ancre reste telle que le code la prévoit sans élévation : en plus de la clé
TPM de niveau 1, le launcher crée une clé d'identité dans le TPM
(`rotk-tpm-aik-v1`, Platform Crypto Provider) et signe le même message ; la
partie publique de l'EK est lue (`PCP_EKPUB`, accessible sans élévation), le
certificat EK n'est pas envoyé et l'activation échoue, ce que le serveur
journalise (`electron/services/tpm-anchor.ts`). L'activation et la lecture du
certificat relèveront d'un assistant élevé ponctuel, lancé une fois à
l'enrôlement, jamais du processus entier.

Tout est en observation : sans TPM ou sans certificat, le lancement se déroule
exactement comme avant et le serveur ne fait que journaliser. Le launcher
n'envoie de la clé d'endossement que sa partie publique ; le serveur n'en
garde qu'un hash à clé et l'émetteur de la chaîne.

Le démarrage écrit ses étapes dans `%APPDATA%\ROTK Launcher\startup.log` (la
course précédente dans `startup.previous.log`) : version, création et
affichage de la fenêtre, services prêts, et les processus enfants qui se
terminent anormalement avec la raison donnée par Chromium.

## Authentification du compte joueur

Le launcher ne génère aucune identité joueur. L’utilisateur doit se connecter avec Steam sur [rotk.app](https://rotk.app), ouvrir **Avatar → Account settings → ROTK launcher key**, générer sa clé puis la coller dans le launcher. Sans clé hexadécimale valide de 32 caractères, le bouton de lancement ouvre cette procédure au lieu de démarrer H1Z1.

La clé est chiffrée par Electron `safeStorage` — Windows DPAPI sur la plateforme cible — avant son écriture dans `%APPDATA%\ROTK Launcher\player-key.v1.json`. À chaque lancement, elle est envoyée uniquement dans le corps JSON d’un POST HTTPS vers le service de compte. La réponse fournit un ticket éphémère à usage unique ainsi que le ROTKID, le GameAccountGUID, le vrai SteamID et le pseudo validés. Seuls ce ticket et cette identité validée sont ensuite transmis au client ; la clé durable n’apparaît ni dans ses arguments, ni dans `ClientConfig.ini`, ni dans le XML du mini-gateway.

## Prérequis de développement

- Windows 10 ou 11 x64 ;
- Node.js 22 ;
- npm 10 ou ultérieur ;
- SDK .NET 10 pour le client deathcomm (le joueur n'a rien à installer) ;
- [Zig 0.15.2](https://ziglang.org/download/0.15.2/) pour reconstruire les DLL natives.

Lancer l’application en développement :

```powershell
git clone https://github.com/h1z1rotk/rotk-launcher.git
cd rotk-launcher
npm ci
npm run dev
```

Les commandes `dev`, `dev:isolated`, `dist` et `dist:dir` reconstruisent
automatiquement les proxies Vivox et DirectInput, puis vérifient le runtime
Vivox officiel avant de démarrer. Un worktree frais ne peut ainsi pas lancer un
client avec un binaire natif absent ou incohérent.

Le mode développeur normal réutilise la configuration du launcher installé. Pour un test volontairement isolé, sans toucher à cette configuration :

```powershell
npm run dev:isolated
```

Si Zig n’est pas dans le `PATH`, le script accepte le chemin explicite de l’exécutable :

```powershell
$env:ZIG_EXE = "C:\Tools\zig\zig.exe"
npm run build:shim
```

## Vérifier et construire

La commande principale exécute le typage, les tests et les builds Electron/renderer :

```powershell
npm run build
```

Pour reconstruire le DLL open source livré avec le launcher :

```powershell
npm run build:shim
Copy-Item native\steamshim\dist\steam_api64.dll resources\patches\steam_api64.dll -Force
```

Puis générer une release Windows (signée si un certificat Authenticode est configuré, non signée sinon) :

```powershell
npm run dist
```

Pour générer uniquement un dossier de prévisualisation local non signé :

```powershell
npm run dist:dir
```

La CI Windows fixe Zig à la version `0.15.2`, compile de façon reproductible le
shim Steam et le proxy Vivox+crouch, puis compare leurs SHA-256 avant de
construire l’application. Les artefacts CI utilisent toujours les DLL
recompilées depuis leurs sources publiques.

## Architecture

| Dossier | Rôle |
| --- | --- |
| `src/` | interface React du launcher |
| `electron/` | processus principal, preload et services système |
| `shared/` | contrats TypeScript partagés |
| `native/steamshim/` | source C et script de build reproductible du shim |
| `native/vivoxproxy/` | proxy vocal, compatibilité Vivox 5 et hook crouch v12 |
| `resources/patches/` | DLL open source embarquées dans l’application |
| `public/branding/` | identité visuelle propre au projet |
| `tests/` | tests unitaires des règles critiques |
| `contracts/` | contrats versionnés pour la future configuration OVH signée |

Le renderer n’accède jamais directement à Node.js. Les sélections de dossiers, la copie, la configuration et le lancement sont exécutés dans le processus principal derrière une API preload volontairement étroite.

## Flux des actualités

Le launcher lit la collection publique `publishedUpdates`, limite la réponse aux deux publications les plus récentes et n’accepte pour les couvertures que les URLs HTTPS de l’origine `rotk.app`. Une copie locale du dernier flux valide permet de conserver les actualités déjà consultées en cas de coupure réseau.

Les contrôles, états, dates, dialogues système et erreurs connues du launcher sont localisés en anglais et en français. Le titre et le résumé d’une actualité restent affichés dans la langue utilisée par son auteur sur `rotk.app` : le launcher ne traduit pas automatiquement le contenu éditorial distant.

Les captures du jeu ne sont pas versionnées dans ce dépôt. Voir [ASSET_LICENSE.md](ASSET_LICENSE.md).

## Releases vérifiables

Le workflow de release reconstruit les DLL natives restantes depuis leurs sources C,
exécute les tests, génère l’installateur Windows et publie ses sommes SHA-256
ainsi qu’une attestation de provenance GitHub. Il refuse notamment un tag
différent de la version `package.json`, un commit extérieur à `main` ou une
DLL inattendue dans les artefacts.

La signature Authenticode est optionnelle. Si l’environnement GitHub `release` contient les secrets `WINDOWS_CERTIFICATE_BASE64` et `WINDOWS_CERTIFICATE_PASSWORD` ainsi que la variable `WINDOWS_PUBLISHER_SUBJECT` (le sujet Authenticode exact du certificat), la release est signée et le workflow échoue si l’installateur, l’exécutable principal ou le shim n’a pas une signature valide, horodatée et cohérente avec l’éditeur attendu. Les secrets ne sont exposés qu’aux étapes de détection et de packaging.

Sans certificat configuré, la release est publiée non signée : le résumé du run l’indique explicitement, et les téléchargements se vérifient via `SHA256SUMS.txt` et l’attestation de provenance GitHub. Windows SmartScreen affichera alors un avertissement « Éditeur inconnu » à l’installation. Un certificat public délivré après validation de l’identité de l’éditeur est nécessaire pour le retirer : un certificat auto-signé n’y change rien. Pour un projet open source, [SignPath Foundation](https://signpath.org/) offre une signature gratuite après candidature.

## Contribuer et signaler une faille

Les contributions sont bienvenues : consultez [CONTRIBUTING.md](CONTRIBUTING.md). Pour une vulnérabilité, n’ouvrez pas d’issue publique et suivez [SECURITY.md](SECURITY.md).

## Licence

Le code du launcher, y compris le shim C, est distribué sous **GNU GPL v3.0 ou ultérieure** (`GPL-3.0-or-later`). Consultez [LICENSE](LICENSE), [ASSET_LICENSE.md](ASSET_LICENSE.md) et [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Vivox runtime distribution

The Unity-signed Vivox 5 client runtime is versioned in this repository and packaged in official launcher releases. The launcher verifies its expected SHA-256 before deploying it to the selected game client. Launcher installation, updates, and Vivox deployment do not download this DLL from any external host.

See `THIRD_PARTY_NOTICES.md` for the applicable third-party notice.
