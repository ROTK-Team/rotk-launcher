import type { AppLocale } from "../shared/locale.js";

export const MAIN_COPY = {
  en: {
    unexpectedError: "An unexpected error occurred.",
    installationCancelled: "Installation cancelled.",
    windowUnavailable: "The launcher window is unavailable.",
    selectSourceFirst: "Select the H1Z1 client first.",
    selectBoth: "Choose where the standalone copy should be created.",
    destinationNotNeeded: "This standalone client can be used directly.",
    clientInUse: "Close H1Z1 before changing its installation.",
    installationInProgress: "An installation is already in progress.",
    clientNotReady: "The ROTK client is not ready.",
    identityLocked: "Close H1Z1 before changing the ROTK account key.",
    serverLocked: "Close H1Z1 before changing the ROTK server.",
    unknownServer: "This ROTK server is not available in this launcher.",
    unknownRole: "This ROTK launch mode is not supported.",
    keyRequired: "Add the ROTK launcher key from your account before playing.",
    adminKeyRequired: "Add the administrator key for this server, or switch back to player mode.",
    unauthorizedLink: "This ROTK link is not allowed.",
    sourceDialog: {
      title: "Choose the H1Z1 client",
      message: "Standalone clients are used directly. Steam clients are copied before ROTK configures them.",
      button: "Select client",
    },
    destinationDialog: {
      title: "Where should the independent ROTK installation be created?",
      message: (directory: string) => `The launcher will create a ${directory} subfolder.`,
      button: "Install ROTK here",
    },
    startupTitle: "ROTK Launcher could not start",
    startupSafety: "No H1Z1 files were modified.",
    rendererGone: (reason: string) =>
      `The launcher window's process stopped (${reason}). Restart the launcher; if this happens again, send %APPDATA%\\ROTK Launcher\\startup.log to the ROTK team.`,
    launcherError: (id: string, message: string) => `Launcher error ${id}: ${message}`,
    update: {
      required: "Update the ROTK launcher before playing.",
      unavailable: "Launcher updates are only available in the installed launcher.",
      "no-update": "No launcher update is available yet.",
      "not-downloaded": "The launcher update has not been downloaded yet.",
      gameRunning: "Close H1Z1 before updating the launcher.",
    },
    assets: {
      busy: "An asset synchronization is already in progress.",
      disabled: "Asset synchronization is disabled in the launcher settings.",
    },
  },
  fr: {
    unexpectedError: "Une erreur inattendue est survenue.",
    installationCancelled: "Installation annulée.",
    windowUnavailable: "Fenêtre indisponible.",
    selectSourceFirst: "Choisis d’abord le client H1Z1.",
    selectBoth: "Choisis où créer la copie indépendante.",
    destinationNotNeeded: "Ce client isolé peut être utilisé directement.",
    clientInUse: "Ferme H1Z1 avant de modifier son installation.",
    installationInProgress: "Une installation est déjà en cours.",
    clientNotReady: "Le client ROTK n’est pas prêt.",
    identityLocked: "Ferme H1Z1 avant de modifier la clé de compte ROTK.",
    serverLocked: "Ferme H1Z1 avant de changer de serveur ROTK.",
    unknownServer: "Ce serveur ROTK n’est pas disponible dans ce launcher.",
    unknownRole: "Ce mode de lancement ROTK n’est pas pris en charge.",
    keyRequired: "Ajoute la clé launcher de ton compte ROTK avant de jouer.",
    adminKeyRequired: "Ajoute la clé administrateur de ce serveur, ou repasse en mode joueur.",
    unauthorizedLink: "Lien ROTK non autorisé.",
    sourceDialog: {
      title: "Choisir le client H1Z1",
      message: "Un client isolé est utilisé directement. Un client Steam est copié avant d’être configuré par ROTK.",
      button: "Sélectionner ce client",
    },
    destinationDialog: {
      title: "Où créer l’installation ROTK indépendante ?",
      message: (directory: string) => `Le launcher créera un sous-dossier ${directory}.`,
      button: "Installer ROTK ici",
    },
    startupTitle: "ROTK Launcher ne peut pas démarrer",
    startupSafety: "Aucun fichier H1Z1 n’a été modifié.",
    rendererGone: (reason: string) =>
      `Le processus de la fenêtre du launcher s’est arrêté (${reason}). Relance le launcher ; si cela se reproduit, envoie %APPDATA%\\ROTK Launcher\\startup.log à l’équipe ROTK.`,
    launcherError: (id: string, message: string) => `Erreur launcher ${id} : ${message}`,
    update: {
      unavailable: "Les mises à jour ne sont disponibles que depuis le launcher installé.",
      "no-update": "Aucune mise à jour du launcher n’est disponible pour l’instant.",
      "not-downloaded": "La mise à jour du launcher n’a pas encore été téléchargée.",
      gameRunning: "Ferme H1Z1 avant de mettre à jour le launcher.",
      required: "Mets à jour le launcher ROTK avant de jouer.",
    },
    assets: {
      busy: "Une synchronisation des assets est déjà en cours.",
      disabled: "La synchronisation des assets est désactivée dans les réglages du launcher.",
    },
  },
} as const;

const ENGLISH_ERRORS = new Map<string, string>([
  ["Une erreur inattendue est survenue.", "An unexpected error occurred."],
  ["Installation annulée.", "Installation cancelled."],
  ["Installation annulée", "Installation cancelled."],
  ["Impossible de résoudre le disque de destination.", "The destination drive could not be resolved."],
  ["Le chemin doit être absolu.", "The path must be absolute."],
  ["Les chemins réseau et chemins de périphérique ne sont pas acceptés.", "Network and device paths are not allowed."],
  ["Le chemin contient un flux de fichier Windows non autorisé.", "The path contains an unauthorized Windows alternate data stream."],
  ["Le dossier source H1Z1 est introuvable.", "The H1Z1 source folder could not be found."],
  ["Une jonction ou un lien symbolique ne peut pas servir d’installation ROTK.", "A junction or symbolic link cannot be used as the ROTK installation."],
  ["La racine d’un disque ne peut pas servir directement d’installation ROTK.", "A drive root cannot be used directly as the ROTK installation."],
  ["La source Steam et l’installation ROTK doivent être dans deux arbres distincts.", "The Steam source and ROTK installation must be in separate directory trees."],
  ["Le dossier temporaire de copie n’est pas sûr.", "The temporary copy directory is not safe."],
  ["Le dossier source contient un nombre anormal de fichiers.", "The source folder contains an unusually large number of files."],
  ["Le dossier ROTK existe déjà. Choisis un nouvel emplacement vide.", "The ROTK folder already exists. Choose a new empty location."],
  ["H1Z1.exe a disparu pendant l’analyse du client.", "H1Z1.exe disappeared while the client was being scanned."],
  ["L’installation ROTK est incomplète : son marqueur est introuvable.", "The ROTK installation is incomplete: its marker is missing."],
  ["L’installation ROTK ne correspond plus à celle enregistrée par le launcher.", "The ROTK installation no longer matches the one saved by the launcher."],
  ["H1Z1.exe est introuvable dans l’installation ROTK.", "H1Z1.exe could not be found in the ROTK installation."],
  ["La sauvegarde de steam_api64.dll est absente. Réimporte le client.", "The steam_api64.dll backup is missing. Import the client again."],
  ["H1Z1 est déjà lancé depuis cette installation.", "H1Z1 is already running from this installation."],
  ["Installe d’abord le client ROTK.", "Install the ROTK client first."],
  ["Windows n’a pas retourné l’identifiant du processus H1Z1.", "Windows did not return an H1Z1 process identifier."],
  ["Cette version de H1Z1 n’est pas encore prise en charge par ROTK. Vérifie les fichiers du jeu dans Steam puis réessaie.", "This H1Z1 version is not supported by ROTK yet. Verify the game files in Steam and try again."],
  ["Cette version de H1Z1 n’est pas compatible avec le patch crouch ROTK obligatoire. Vérifie les fichiers du jeu dans Steam puis réessaie.", "This H1Z1 version is not compatible with the mandatory ROTK crouch patch. Verify the game files in Steam and try again."],
  ["Cette version de H1Z1 n’est pas compatible avec le patch sprint ROTK. Vérifie les fichiers du jeu dans Steam puis réessaie.", "This H1Z1 version is not compatible with the ROTK sprint patch. Verify the game files in Steam and try again."],
  ["Le patch sprint ROTK embarqué est absent ou modifié. Ton antivirus l’a peut-être mis en quarantaine : restaure-le depuis Sécurité Windows ou réinstalle le launcher.", "The bundled ROTK sprint patch is missing or modified. Your antivirus may have quarantined it: restore it from Windows Security or reinstall the launcher."],
  ["Le patch sprint ROTK n’a pas pu être installé. Ferme H1Z1 puis réessaie.", "The ROTK sprint patch could not be installed. Close H1Z1 and try again."],
  ["Le patch sprint ROTK n’a pas pu être supprimé. Ferme H1Z1 puis réessaie.", "The ROTK sprint patch could not be removed. Close H1Z1 and try again."],
  ["Le marqueur du patch sprint ROTK n’a pas pu être écrit. Ferme H1Z1 puis réessaie.", "The ROTK sprint patch marker could not be written. Close H1Z1 and try again."],
  ["Un dinput8.dll inconnu est présent dans le client ROTK. Supprime-le ou réimporte un client propre.", "An unknown dinput8.dll is present in the ROTK client. Remove it or import a clean client again."],
  ["Le proxy vocal ROTK embarqué est absent ou modifié. Ton antivirus l’a peut-être mis en quarantaine : restaure-le depuis Sécurité Windows ou réinstalle le launcher.", "The bundled ROTK voice proxy is missing or modified. Your antivirus may have quarantined it: restore it from Windows Security or reinstall the launcher."],
  ["Le runtime Vivox 5 embarqué est absent ou modifié. Ton antivirus l’a peut-être mis en quarantaine : restaure-le depuis Sécurité Windows ou réinstalle le launcher.", "The bundled Vivox 5 runtime is missing or modified. Your antivirus may have quarantined it: restore it from Windows Security or reinstall the launcher."],
  ["Le SDK Vivox historique est introuvable.", "The legacy Vivox SDK could not be found."],
  ["La version Vivox 5 attendue est absente du client H1Z1.", "The required Vivox 5 version is missing from the H1Z1 client."],
  ["Le SDK Vivox actif est inconnu; vérifie les fichiers H1Z1.", "The active Vivox SDK is unknown. Verify the H1Z1 files."],
  ["La sauvegarde du SDK Vivox historique est invalide.", "The legacy Vivox SDK backup is invalid."],
  ["Le proxy vocal ROTK n'a pas été copié correctement.", "The ROTK voice proxy was not copied correctly."],
  ["Le patch crouch ROTK obligatoire n'a pas été activé correctement.", "The mandatory ROTK crouch patch was not activated correctly."],
  ["Le flux d’assets ROTK est indisponible. Vérifie ta connexion puis réessaie.", "The ROTK asset feed is unavailable. Check your connection and try again."],
  ["Trop de redirections pendant le téléchargement des assets.", "Too many redirects while downloading assets."],
  ["Téléchargement d’assets refusé (redirection invalide).", "Asset download refused (invalid redirect)."],
]);

const FRENCH_ERRORS = new Map<string, string>([
  ["Invalid ROTK session identity", "L’identité de session ROTK est invalide."],
  ["Invalid ROTK player key", "La clé joueur ROTK est invalide."],
  ["Secure ROTK key storage is unavailable on this Windows account", "Le stockage Windows sécurisé de la clé ROTK est indisponible sur ce compte."],
  ["Unsupported launcher locale", "Langue du launcher non prise en charge."],
  ["Unknown ROTK server", "Serveur ROTK inconnu."],
  ["Unknown ROTK launch role", "Mode de lancement ROTK inconnu."],
  ["Unknown ROTK launch profile", "Profil de lancement ROTK inconnu."],
]);

const DYNAMIC_ENGLISH_ERRORS: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [/^H1Z1 s’est fermé pendant son initialisation \(code Windows (.+)\)\.$/, (match) => `H1Z1 closed during initialization (Windows code ${match[1]}).`],
  [/^Client H1Z1 incomplet : (.+) est introuvable\.$/, (match) => `Incomplete H1Z1 client: ${match[1]} could not be found.`],
  [/^Un fichier du launcher est absent : (.+)\. Ton antivirus l’a peut-être mis en quarantaine : restaure-le depuis Sécurité Windows ou réinstalle le launcher\.$/, (match) => `A launcher file is missing: ${match[1]}. Your antivirus may have quarantined it: restore it from Windows Security or reinstall the launcher.`],
  [/^ROTK ne peut pas jouer depuis un dossier « (.+) »\. Choisis un emplacement indépendant de Steam\.$/, (match) => `ROTK cannot run from a “${match[1]}” folder. Choose a location outside Steam.`],
  [/^Cet emplacement renvoie physiquement vers « (.+) » et ne peut pas être utilisé\.$/, (match) => `This location physically resolves to “${match[1]}” and cannot be used.`],
  [/^Le client source contient une jonction non sûre : (.+)$/, (match) => `The source client contains an unsafe junction: ${match[1]}`],
  [/^Type de fichier source non pris en charge : (.+)$/, (match) => `Unsupported source file type: ${match[1]}`],
  [/^Espace disque insuffisant : (.+) Go sont nécessaires\.$/, (match) => `Not enough disk space: ${match[1]} GB is required.`],
  [/^La taille copiée de (.+) ne correspond pas à la source\.$/, (match) => `The copied size of ${match[1]} does not match the source.`],
  [/^La copie de (.+) ne correspond pas à la source\.$/, (match) => `The copy of ${match[1]} does not match the source.`],
  [/^Le fichier source (.+) a changé pendant la copie\.$/, (match) => `The source file ${match[1]} changed during the copy.`],
  [/^Erreur launcher ([a-f0-9]+) : (.+)$/, (match) => `Launcher error ${match[1]}: ${match[2]}`],
  [/^Manifeste d’assets invalide : (.+)\.$/, (match) => `Invalid asset manifest: ${match[1]}.`],
  [/^Archive d’assets invalide : (.+)\.$/, (match) => `Invalid asset archive: ${match[1]}.`],
  [/^L’asset (.+) est corrompu \(empreinte SHA-256 inattendue\)\.$/, (match) => `The ${match[1]} asset is corrupted (unexpected SHA-256 fingerprint).`],
  [/^L’asset (.+) dépasse la taille annoncée\.$/, (match) => `The ${match[1]} asset exceeds its declared size.`],
  [/^Hôte de téléchargement d’assets non autorisé : (.+)\.$/, (match) => `Asset download host not allowed: ${match[1]}.`],
  [/^Téléchargement d’assets refusé \(HTTP (\d+)\)\.$/, (match) => `Asset download refused (HTTP ${match[1]}).`],
  [/^Erreur système \(([^)]+)\)\.$/, (match) => `System error (${match[1]}).`],
  [/^Erreur système \(([^)]+)\) : (.+)\.$/, (match) => `System error (${match[1]}): ${match[2]}.`],
  [/^Un fichier du launcher a disparu : (.+)\. Ton antivirus l’a probablement mis en quarantaine : restaure-le depuis Sécurité Windows ou réinstalle le launcher\.$/, (match) => `A launcher file is missing: ${match[1]}. Your antivirus probably quarantined it: restore it from Windows Security or reinstall the launcher.`],
  [/^Accès refusé au fichier (.+) \(([^)]+)\) : droits insuffisants, antivirus ou fichier utilisé par un autre programme\. Réessaie, vérifie les droits du dossier ou ajoute le dossier ROTK aux exclusions de l’antivirus\.$/, (match) => `Access denied to ${match[1]} (${match[2]}): missing permissions, antivirus or file in use by another program. Try again, check the folder permissions or add the ROTK folder to your antivirus exclusions.`],
  [/^Disque plein pendant l’écriture de (.+)\. Libère de l’espace puis réessaie\.$/, (match) => `Disk full while writing ${match[1]}. Free some space and try again.`],
  [/^Fichier introuvable : (.+)\.$/, (match) => `File not found: ${match[1]}.`],
];

export function localizeServiceError(message: string, locale: AppLocale): string {
  if (locale === "fr") return FRENCH_ERRORS.get(message) ?? message;
  const exact = ENGLISH_ERRORS.get(message);
  if (exact) return exact;
  for (const [pattern, translate] of DYNAMIC_ENGLISH_ERRORS) {
    const match = message.match(pattern);
    if (match) return translate(match);
  }
  // "<known message> <system cause>", built by rawErrorMessage for wrapped errors.
  for (const [french, english] of ENGLISH_ERRORS) {
    if (message.startsWith(`${french} `)) {
      return `${english} ${localizeServiceError(message.slice(french.length + 1), locale)}`;
    }
  }
  return message;
}
