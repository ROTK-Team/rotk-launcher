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
    driveUnavailable: "This drive is not available.",
    steamUnavailable: "Steam could not be opened. Install H1Z1 (Z1 Battle Royale) from your Steam library.",
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
    driveUnavailable: "Ce disque n’est pas disponible.",
    steamUnavailable: "Steam n’a pas pu être ouvert. Installe H1Z1 (Z1 Battle Royale) depuis ta bibliothèque Steam.",
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
  zh: {
    unexpectedError: "出现了意外错误。",
    installationCancelled: "安装已取消。",
    windowUnavailable: "启动器窗口不可用。",
    selectSourceFirst: "请先选择 H1Z1 客户端。",
    selectBoth: "请选择 ROTK 副本的安装位置。",
    destinationNotNeeded: "这个客户端可以直接使用，无需复制。",
    clientInUse: "请先关闭 H1Z1，再修改安装。",
    installationInProgress: "已有安装正在进行。",
    driveUnavailable: "这个磁盘当前不可用。",
    steamUnavailable: "无法打开 Steam。请在 Steam 库中安装 Z1 Battle Royale（Z1 大逃杀）。",
    clientNotReady: "ROTK 客户端尚未就绪。",
    identityLocked: "请先关闭 H1Z1，再修改 ROTK 账号密钥。",
    serverLocked: "请先关闭 H1Z1，再切换 ROTK 服务器。",
    unknownServer: "此启动器不支持这个 ROTK 服务器。",
    unknownRole: "不支持这种 ROTK 启动模式。",
    keyRequired: "开始游戏前，请先添加你账号里的 ROTK 启动器密钥。",
    adminKeyRequired: "请添加此服务器的管理员密钥，或切换回玩家模式。",
    unauthorizedLink: "不允许打开这个链接。",
    sourceDialog: {
      title: "选择 H1Z1 客户端",
      message: "不在 Steam 目录里的客户端会直接使用；Steam 里的客户端会先复制一份，再由 ROTK 配置。",
      button: "选择此客户端",
    },
    destinationDialog: {
      title: "ROTK 要安装到哪里？",
      message: (directory: string) => `启动器会在这里创建一个 ${directory} 子文件夹。`,
      button: "安装到这里",
    },
    startupTitle: "ROTK 启动器无法启动",
    startupSafety: "H1Z1 的游戏文件没有被改动。",
    rendererGone: (reason: string) =>
      `启动器窗口进程已停止（${reason}）。请重启启动器；如果再次出现，请把 %APPDATA%\\ROTK Launcher\\startup.log 发给 ROTK 团队。`,
    launcherError: (id: string, message: string) => `启动器错误 ${id}：${message}`,
    update: {
      required: "开始游戏前，请先更新 ROTK 启动器。",
      unavailable: "只有安装版启动器才能自动更新。",
      "no-update": "暂时没有启动器更新。",
      "not-downloaded": "启动器更新还没有下载完成。",
      gameRunning: "请先关闭 H1Z1，再更新启动器。",
    },
    assets: {
      busy: "资源正在同步中。",
      disabled: "资源同步已在启动器设置中关闭。",
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
  ["Le dossier ROTK choisi contient déjà d’autres fichiers. Choisis un dossier vide.", "The chosen ROTK folder already contains other files. Choose an empty folder."],
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
  ["The ROTK launcher key was rejected", "La clé launcher ROTK a été refusée. Recopie-la depuis ton compte sur le site."],
  ["Too many ROTK authentication attempts. Wait a moment and try again", "Trop de tentatives de connexion ROTK. Attends un peu puis réessaie."],
  ["The ROTK account service is temporarily unavailable", "Le service de compte ROTK est momentanément indisponible. Réessaie dans quelques minutes."],
  ["The ROTK account service refused the launch request", "Le service de compte ROTK a refusé le lancement."],
  ["The game files do not match the official ROTK installation. Use Verify files, then try again.", "Les fichiers du jeu ne correspondent pas à l’installation ROTK officielle. Utilise « Vérifier les fichiers », puis réessaie."],
  ["This launcher version is too old to verify the game files. Update the launcher.", "Cette version du launcher est trop ancienne. Mets le launcher à jour."],
  ["This ROTK account is not ready to play yet. Sign in on the ROTK website, then try again.", "Ce compte ROTK n’est pas encore prêt. Connecte-toi sur le site ROTK, puis réessaie."],
  ["Unable to reach the ROTK integrity service", "Impossible de joindre le service de vérification ROTK. Vérifie ta connexion."],
  ["The ROTK integrity service is temporarily unavailable", "Le service de vérification ROTK est momentanément indisponible."],
  ["Too many ROTK integrity checks. Wait a moment and try again", "Trop de vérifications ROTK. Attends un peu puis réessaie."],
]);

const DYNAMIC_FRENCH_ERRORS: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [/^Unable to reach the ROTK account service(?: \((.+)\))?$/, (match) => `Impossible de joindre le service de compte ROTK${match[1] ? ` (${match[1]})` : ""}. Vérifie ta connexion, ton pare-feu ou ton antivirus.`],
  [/^Invalid response from the ROTK account service(?: \(HTTP (\d+)\))?$/, (match) => `Réponse invalide du service de compte ROTK${match[1] ? ` (HTTP ${match[1]})` : ""}. Réessaie dans quelques minutes.`],
  [/^ROTK could not verify your game files: (.+) Check your connection and try again\.$/, (match) => `ROTK n’a pas pu vérifier tes fichiers de jeu : ${match[1]} Vérifie ta connexion puis réessaie.`],
  [/^This ROTK account is suspended until (.+?)\.(?: Reason: (.+))?$/, (match) => `Ce compte ROTK est suspendu jusqu’au ${match[1]}.${match[2] ? ` Raison : ${match[2]}` : ""}`],
  [/^This ROTK account is permanently banned\.(?: Reason: (.+))?$/, (match) => `Ce compte ROTK est banni définitivement.${match[1] ? ` Raison : ${match[1]}` : ""}`],
];

const DYNAMIC_ENGLISH_ERRORS: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [/^H1Z1 s’est fermé pendant son initialisation \(code Windows (.+)\)\.$/, (match) => `H1Z1 closed during initialization (Windows code ${match[1]}).`],
  [/^Client H1Z1 incomplet : (.+) est introuvable\.$/, (match) => `Incomplete H1Z1 client: ${match[1]} could not be found.`],
  [/^ROTK ne peut pas jouer depuis un dossier « (.+) »\. Choisis un emplacement indépendant de Steam\.$/, (match) => `ROTK cannot run from a “${match[1]}” folder. Choose a location outside Steam.`],
  [/^Cet emplacement renvoie physiquement vers « (.+) » et ne peut pas être utilisé\.$/, (match) => `This location physically resolves to “${match[1]}” and cannot be used.`],
  [/^Le client source contient une jonction non sûre : (.+)$/, (match) => `The source client contains an unsafe junction: ${match[1]}`],
  [/^Type de fichier source non pris en charge : (.+)$/, (match) => `Unsupported source file type: ${match[1]}`],
  [/^Espace disque insuffisant : (.+) Go sont nécessaires\.$/, (match) => `Not enough disk space: ${match[1]} GB is required.`],
  [/^Espace disque insuffisant pour les assets : (.+) Go sont nécessaires\.$/, (match) => `Not enough disk space for the assets: ${match[1]} GB is required.`],
  [/^La taille copiée de (.+) ne correspond pas à la source\.$/, (match) => `The copied size of ${match[1]} does not match the source.`],
  [/^La copie de (.+) ne correspond pas à la source\.$/, (match) => `The copy of ${match[1]} does not match the source.`],
  [/^Le fichier source (.+) a changé pendant la copie\.$/, (match) => `The source file ${match[1]} changed during the copy.`],
  [/^Erreur launcher ([a-f0-9]+) : (.+)$/, (match) => `Launcher error ${match[1]}: ${match[2]}`],
  [/^Manifeste d’assets invalide : (.+)\.$/, (match) => `Invalid asset manifest: ${match[1]}.`],
  [/^Archive d’assets invalide : (.+)\.$/, (match) => `Invalid asset archive: ${match[1]}.`],
  [/^L’asset (.+) est corrompu \(empreinte SHA-256 inattendue\)\.$/, (match) => `The ${match[1]} asset is corrupted (unexpected SHA-256 fingerprint).`],
  [/^L’asset (.+) dépasse la taille annoncée\.$/, (match) => `The ${match[1]} asset exceeds its declared size.`],
  [/^Le téléchargement de l’asset (.+) s’est interrompu\.$/, (match) => `The download of the ${match[1]} asset was interrupted.`],
  [/^Hôte de téléchargement d’assets non autorisé : (.+)\.$/, (match) => `Asset download host not allowed: ${match[1]}.`],
  [/^Téléchargement d’assets refusé \(HTTP (\d+)\)\.$/, (match) => `Asset download refused (HTTP ${match[1]}).`],
  [/^Erreur système \(([^)]+)\)\.$/, (match) => `System error (${match[1]}).`],
  [/^Erreur système \(([^)]+)\) : (.+)\.$/, (match) => `System error (${match[1]}): ${match[2]}.`],
  [/^Un fichier du launcher a disparu : (.+)\. Ton antivirus l’a probablement mis en quarantaine : restaure-le depuis Sécurité Windows ou réinstalle le launcher\.$/, (match) => `A launcher file is missing: ${match[1]}. Your antivirus probably quarantined it: restore it from Windows Security or reinstall the launcher.`],
  [/^Accès refusé au fichier (.+) \(([^)]+)\)\. Un antivirus, H1Z1 ou un autre programme l’utilise : réessaie, ou ajoute le dossier ROTK aux exclusions de l’antivirus\.$/, (match) => `Access denied to ${match[1]} (${match[2]}). An antivirus, H1Z1 or another program is using it: try again, or add the ROTK folder to your antivirus exclusions.`],
  [/^Disque plein pendant l’écriture de (.+)\. Libère de l’espace puis réessaie\.$/, (match) => `Disk full while writing ${match[1]}. Free some space and try again.`],
  [/^Fichier introuvable : (.+)\.$/, (match) => `File not found: ${match[1]}.`],
];

const CHINESE_ERRORS = new Map<string, string>([
  ["The ROTK launcher key was rejected", "ROTK 启动器密钥无效，请到网站账号页面重新复制。"],
  ["Too many ROTK authentication attempts. Wait a moment and try again", "登录尝试次数过多，请稍后再试。"],
  ["The ROTK account service is temporarily unavailable", "ROTK 账号服务暂时不可用，请几分钟后重试。"],
  ["The ROTK account service refused the launch request", "ROTK 账号服务拒绝了本次启动。"],
  ["The game files do not match the official ROTK installation. Use Verify files, then try again.", "游戏文件与 ROTK 官方版本不一致。请点击“验证文件”后重试。"],
  ["This launcher version is too old to verify the game files. Update the launcher.", "启动器版本过旧，请先更新启动器。"],
  ["This ROTK account is not ready to play yet. Sign in on the ROTK website, then try again.", "此 ROTK 账号还不能进入游戏。请先登录 ROTK 网站，然后重试。"],
  ["Unable to reach the ROTK integrity service", "无法连接 ROTK 校验服务，请检查网络。"],
  ["The ROTK integrity service is temporarily unavailable", "ROTK 校验服务暂时不可用。"],
  ["Too many ROTK integrity checks. Wait a moment and try again", "校验请求过于频繁，请稍后再试。"],
  ["Installation annulée.", "安装已取消。"],
  ["Le dossier ROTK choisi contient déjà d’autres fichiers. Choisis un dossier vide.", "所选的 ROTK 文件夹里已经有其他文件，请选择一个空文件夹。"],
  ["H1Z1 est déjà lancé depuis cette installation.", "H1Z1 正在运行，请先关闭游戏。"],
  ["Le flux d’assets ROTK est indisponible. Vérifie ta connexion puis réessaie.", "无法连接 ROTK 资源服务器，请检查网络后重试。"],
  ["Cette version de H1Z1 n’est pas encore prise en charge par ROTK. Vérifie les fichiers du jeu dans Steam puis réessaie.", "ROTK 暂不支持这个版本的 H1Z1。请在 Steam 中验证游戏文件完整性后重试。"],
  ["Installe d’abord le client ROTK.", "请先安装 ROTK 客户端。"],
  ["L’installation ROTK est incomplète : son marqueur est introuvable.", "ROTK 安装不完整，请重新安装。"],
  ["Le proxy vocal ROTK embarqué est absent ou modifié. Ton antivirus l’a peut-être mis en quarantaine : restaure-le depuis Sécurité Windows ou réinstalle le launcher.", "启动器自带的 ROTK 语音组件丢失或被改动，可能被杀毒软件隔离了。请在 Windows 安全中心恢复它，或重新安装启动器。"],
  ["Le runtime Vivox 5 embarqué est absent ou modifié. Ton antivirus l’a peut-être mis en quarantaine : restaure-le depuis Sécurité Windows ou réinstalle le launcher.", "启动器自带的 Vivox 5 组件丢失或被改动，可能被杀毒软件隔离了。请在 Windows 安全中心恢复它，或重新安装启动器。"],
  ["Le patch sprint ROTK embarqué est absent ou modifié. Ton antivirus l’a peut-être mis en quarantaine : restaure-le depuis Sécurité Windows ou réinstalle le launcher.", "启动器自带的 ROTK 补丁丢失或被改动，可能被杀毒软件隔离了。请在 Windows 安全中心恢复它，或重新安装启动器。"],
]);

const DYNAMIC_CHINESE_ERRORS: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [/^Espace disque insuffisant : (.+) Go sont nécessaires\.$/, (match) => `磁盘空间不足，需要 ${match[1]} GB。`],
  [/^Espace disque insuffisant pour les assets : (.+) Go sont nécessaires\.$/, (match) => `磁盘空间不足，下载资源需要 ${match[1]} GB。`],
  [/^Un fichier du launcher a disparu : (.+)\. Ton antivirus l’a probablement mis en quarantaine : restaure-le depuis Sécurité Windows ou réinstalle le launcher\.$/, (match) => `启动器文件丢失：${match[1]}。很可能被杀毒软件隔离了，请在 Windows 安全中心恢复它，或重新安装启动器。`],
  [/^Accès refusé au fichier (.+) \(([^)]+)\)\. Un antivirus, H1Z1 ou un autre programme l’utilise : réessaie, ou ajoute le dossier ROTK aux exclusions de l’antivirus\.$/, (match) => `无法访问文件 ${match[1]}（${match[2]}）。杀毒软件、H1Z1 或其他程序正在占用它。请重试，或把 ROTK 文件夹加入杀毒软件的白名单。`],
  [/^Disque plein pendant l’écriture de (.+)\. Libère de l’espace puis réessaie\.$/, (match) => `写入 ${match[1]} 时磁盘已满。请清理空间后重试。`],
  [/^Fichier introuvable : (.+)\.$/, (match) => `找不到文件：${match[1]}。`],
  [/^Client H1Z1 incomplet : (.+) est introuvable\.$/, (match) => `H1Z1 客户端不完整：找不到 ${match[1]}。请在 Steam 中验证游戏文件完整性。`],
  [/^Le téléchargement de l’asset (.+) s’est interrompu\.$/, (match) => `资源 ${match[1]} 下载中断，请检查网络后重试。`],
  [/^Téléchargement d’assets refusé \(HTTP (\d+)\)\.$/, (match) => `资源下载失败（HTTP ${match[1]}），请稍后重试。`],
  [/^Unable to reach the ROTK account service(?: \((.+)\))?$/, (match) => `无法连接 ROTK 账号服务${match[1] ? `（${match[1]}）` : ""}。请检查网络、防火墙或杀毒软件设置。`],
  [/^Invalid response from the ROTK account service(?: \(HTTP (\d+)\))?$/, (match) => `ROTK 账号服务返回异常${match[1] ? `（HTTP ${match[1]}）` : ""}，请几分钟后重试。`],
  [/^ROTK could not verify your game files: (.+) Check your connection and try again\.$/, (match) => `ROTK 无法验证你的游戏文件：${match[1]} 请检查网络后重试。`],
  [/^This ROTK account is suspended until (.+?)\.(?: Reason: (.+))?$/, (match) => `此 ROTK 账号已被封禁至 ${match[1]}。${match[2] ? `原因：${match[2]}` : ""}`],
  [/^This ROTK account is permanently banned\.(?: Reason: (.+))?$/, (match) => `此 ROTK 账号已被永久封禁。${match[1] ? `原因：${match[1]}` : ""}`],
];

export function localizeServiceError(message: string, locale: AppLocale): string {
  if (locale === "fr") {
    const exact = FRENCH_ERRORS.get(message);
    if (exact) return exact;
    for (const [pattern, translate] of DYNAMIC_FRENCH_ERRORS) {
      const match = message.match(pattern);
      if (match) return translate(match);
    }
    return message;
  }
  if (locale === "zh") {
    const exact = CHINESE_ERRORS.get(message);
    if (exact) return exact;
    for (const [pattern, translate] of DYNAMIC_CHINESE_ERRORS) {
      const match = message.match(pattern);
      if (match) return translate(match);
    }
    // Everything else: English reads better than French for most players.
    return localizeServiceError(message, "en");
  }
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
