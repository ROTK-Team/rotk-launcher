import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { isAppLocale, type AppLocale } from "../shared/locale";
import type { PlayerRole } from "../shared/launch-profile";
import { DIAGNOSTICS_COPY, type DiagnosticsCopy } from "./diagnostics-copy";

const STORAGE_KEY = "rotk.launcher.locale";

export interface Copy {
  diagnostics: DiagnosticsCopy;
  language: {
    label: string;
    change: (current: string) => string;
    english: string;
    french: string;
    chinese: string;
  };
  chrome: {
    launcher: string;
    updates: string;
    build: string;
    minimize: string;
    close: string;
  };
  app: {
    initializing: string;
    operationFailed: string;
    operationInterrupted: string;
    closeError: string;
  };
  news: {
    headline: string;
    latest: string;
    fallbackTitle: string;
    fallbackSummary: string;
    fallbackCategory: string;
    label: string;
    navigation: string;
    showItem: (index: number) => string;
    patchNote: string;
    devUpdate: string;
    version: string;
    readUpdate: string;
    previous: string;
    next: string;
  };
  footer: {
    play: string;
    inGame: string;
    process: string;
    activeProcess: string;
    launching: string;
    preparingClient: string;
    installing: string;
    secureCopy: string;
    attention: string;
    ready: string;
    clientConfigured: string;
    accountRequired: string;
    missingAccountKey: string;
    setupRequired: string;
    createIndependentInstall: string;
    install: string;
    environment: string;
    settings: string;
    playerIdentity: string;
    addAccountKey: string;
    adminMode: string;
    selectServer: string;
    playersInGame: string;
    playersUnavailable: string;
    playersUnknown: string;
  };
  identity: {
    panelLabel: string;
    eyebrow: string;
    title: string;
    intro: string;
    roles: Record<PlayerRole, string>;
    keyLabels: Record<PlayerRole, string>;
    keyHints: Record<PlayerRole, (websiteHost: string) => string>;
    keySet: string;
    keyMissing: string;
    extraKeys: string;
    extraKeysCount: (configured: number, total: number) => string;
    extraKeysHint: string;
    placeholder: string;
    sessionOnly: string;
    process: (websiteHost: string) => string;
    openAccount: (websiteHost: string) => string;
    invalid: string;
    applied: string;
    removed: string;
    copied: string;
    apply: string;
    remove: string;
    copy: string;
    show: string;
    hide: string;
    close: string;
  };
  update: {
    available: (version: string) => string;
    availableDetail: string;
    download: string;
    downloading: string;
    restart: string;
    restartDetail: string;
    failed: string;
    retry: string;
    dismiss: string;
    close: string;
    promptTitle: string;
    readyTitle: string;
    promptDetail: string;
    currentVersion: string;
    newVersion: string;
    later: string;
    closeGame: string;
    check: string;
    requiredDetail: string;
  };
  install: {
    notSelected: string;
    closeSetup: string;
    panelLabel: string;
    firstInstall: string;
    title: string;
    close: string;
    intro: string;
    protectionActive: string;
    protectionDetail: string;
    isolatedDetected: string;
    isolatedDetail: string;
    steamDetected: string;
    steamDetail: string;
    sourceClient: string;
    rotkInstall: string;
    detectedBadge: string;
    recommendedBadge: string;
    subfolderHint: string;
    driveLabel: string;
    driveFree: (gigabytes: number) => string;
    resumeHint: string;
    noClientFound: string;
    installWithSteam: string;
    choose: string;
    cancelCopy: string;
    createInstall: string;
    useExisting: string;
    legal: string;
    progressPhases: Record<"scanning" | "copying" | "verifying" | "configuring" | "finalizing", string>;
    progressFiles: Record<"scanning" | "verifying" | "configuring" | "finalizing", string>;
  };
  activity: {
    regionLabel: string;
    eyebrow: string;
    installation: string;
    assets: string;
    integrity: string;
    launch: string;
    launcherUpdate: string;
    checkingUpdate: string;
    checkingAssets: string;
    preparingFiles: string;
    integrityDetail: string;
    launchDetail: string;
    updateDetail: string;
    working: string;
    files: (completed: number, total: number) => string;
    packs: (completed: number, total: number) => string;
    progress: (operation: string) => string;
  };
  integrity: {
    verifying: string;
  };
  assets: {
    title: string;
    description: string;
    updating: string;
    status: Record<"idle" | "disabled" | "checking" | "downloading" | "installing" | "up-to-date" | "warning" | "error", string>;
    packVersion: (version: string) => string;
    neverSynced: string;
    warnings: Record<"feed-unavailable" | "sync-failed", string>;
    verify: string;
    restore: string;
    autoSync: string;
  };
}

const COPY: Record<AppLocale, Copy> = {
  en: {
    diagnostics: DIAGNOSTICS_COPY.en,
    language: {
      label: "Language",
      change: (current) => `Change language. Current language: ${current}`,
      english: "English",
      french: "Français",
      chinese: "简体中文",
    },
    chrome: {
      launcher: "LAUNCHER",
      updates: "DEV UPDATES",
      build: "BUILD",
      minimize: "Minimize",
      close: "Close",
    },
    app: {
      initializing: "INITIALIZING LAUNCHER",
      operationFailed: "The operation failed.",
      operationInterrupted: "OPERATION INTERRUPTED",
      closeError: "Close",
    },
    news: {
      headline: "RETURN TO THE FIGHT.",
      latest: "LATEST TRANSMISSION",
      fallbackTitle: "STAY IN THE LOOP",
      fallbackSummary: "The development feed is temporarily unavailable. The launcher remains available offline.",
      fallbackCategory: "DEVELOPMENT",
      label: "Latest ROTK news",
      navigation: "News navigation",
      showItem: (index) => `Show news item ${index}`,
      patchNote: "PATCH NOTE",
      devUpdate: "DEV UPDATE",
      version: "VERSION",
      readUpdate: "READ UPDATE",
      previous: "Previous news item",
      next: "Next news item",
    },
    footer: {
      play: "PLAY",
      inGame: "IN GAME",
      process: "PROCESS",
      activeProcess: "ACTIVE PROCESS",
      launching: "LAUNCHING",
      preparingClient: "PREPARING CLIENT",
      installing: "INSTALLING",
      secureCopy: "SECURE COPY IN PROGRESS",
      attention: "ATTENTION",
      ready: "READY",
      clientConfigured: "ROTK CLIENT CONFIGURED",
      accountRequired: "ROTK ACCOUNT REQUIRED",
      missingAccountKey: "ADD YOUR WEBSITE LAUNCHER KEY",
      setupRequired: "SETUP REQUIRED",
      createIndependentInstall: "SELECT AN H1Z1 CLIENT",
      install: "INSTALL",
      environment: "ENVIRONMENT",
      settings: "Installation and settings",
      playerIdentity: "ROTK account key",
      addAccountKey: "ADD ROTK KEY",
      adminMode: "ADMIN",
      selectServer: "Choose the ROTK server and launch mode",
      playersInGame: "IN GAME",
      playersUnavailable: "—",
      playersUnknown: "Player count unavailable",
    },
    identity: {
      panelLabel: "ROTK account authentication",
      eyebrow: "ROTK ACCOUNT",
      title: "LAUNCHER KEY",
      intro: "This key links every launch to your ROTK account, Steam identity and persistent game data.",
      roles: {
        player: "PLAYER",
        admin: "ADMIN / MOD",
      },
      keyLabels: {
        player: "PLAYER KEY",
        admin: "ADMIN / MOD KEY",
      },
      keyHints: {
        player: (websiteHost) => `${websiteHost} > Avatar > Account settings > ROTK launcher key.`,
        admin: (websiteHost) => `${websiteHost} > admin area > administrator launcher key. Only granted administrators have one.`,
      },
      keySet: "SAVED",
      keyMissing: "MISSING",
      extraKeys: "OTHER KEYS",
      extraKeysCount: (configured, total) => `${configured}/${total} saved`,
      extraKeysHint: "Each ROTK server has its own accounts, and an administrator key belongs to a different account than your player key. Fill in only what you need.",
      placeholder: "32 hexadecimal characters",
      sessionOnly: "Saved with Windows encryption for this account. It is never generated by the launcher.",
      process: (websiteHost) => `Create or sign in to your account on ${websiteHost}, copy the key below, then save it here.`,
      openAccount: (websiteHost) => `OPEN ${websiteHost.toLocaleUpperCase("en-US")}`,
      invalid: "Enter exactly 32 hexadecimal characters (0-9, a-f).",
      applied: "ROTK account key saved securely.",
      removed: "ROTK account key removed from this computer.",
      copied: "ROTK account key copied.",
      apply: "SAVE KEY",
      remove: "Remove this key",
      copy: "Copy ROTK account key",
      show: "Show ROTK account key",
      hide: "Hide ROTK account key",
      close: "Close ROTK account authentication",
    },
    update: {
      available: (version) => `LAUNCHER UPDATE ${version} AVAILABLE`,
      availableDetail: "Get the latest improvements and fixes before playing.",
      download: "UPDATE",
      downloading: "DOWNLOADING UPDATE",
      restart: "RESTART TO INSTALL",
      restartDetail: "Restart the launcher to install the update, then launch the game again.",
      failed: "UPDATE DOWNLOAD FAILED",
      retry: "RETRY",
      dismiss: "Hide update notification",
      close: "Close update reminder",
      promptTitle: "UPDATE BEFORE YOU PLAY",
      readyTitle: "YOUR UPDATE IS READY",
      promptDetail: "Update the ROTK launcher to play with the latest version of the game. Download the update, then restart the launcher to install it.",
      currentVersion: "INSTALLED",
      newVersion: "AVAILABLE",
      later: "LATER",
      closeGame: "Close the game before restarting the launcher.",
      check: "CHECK FOR UPDATE",
      requiredDetail: "The server requires a newer launcher. If the update cannot be found, check your connection and try again.",
    },
    install: {
      notSelected: "NOT SELECTED",
      closeSetup: "Close setup",
      panelLabel: "ROTK client installation",
      firstInstall: "CLIENT SETUP",
      title: "CLIENT INSTALLATION",
      close: "Close",
      intro: "Choose the H1Z1 folder ROTK should use. A standalone client is configured in place; a Steam client is copied to a safe location first.",
      protectionActive: "AUTOMATIC DETECTION",
      protectionDetail: "Select a client to check whether it can be used directly.",
      isolatedDetected: "STANDALONE CLIENT DETECTED",
      isolatedDetail: "This client is already outside Steam. No copy is required.",
      steamDetected: "STEAM CLIENT DETECTED",
      steamDetail: "This installation will not be modified. Choose a destination outside Steam for the ROTK copy.",
      sourceClient: "H1Z1 CLIENT",
      rotkInstall: "ROTK INSTALLATION",
      detectedBadge: "AUTO-DETECTED",
      recommendedBadge: "RECOMMENDED",
      subfolderHint: "A ROTK subfolder is created automatically in the chosen location — no need to create it yourself.",
      driveLabel: "INSTALL DRIVE",
      driveFree: (gigabytes) => `${gigabytes} GB free`,
      resumeHint: "You can cancel or close the launcher: the copy picks up where it stopped.",
      noClientFound: "No H1Z1 client was found. Install it with Steam (listed as Z1 Battle Royale), then come back here.",
      installWithSteam: "INSTALL H1Z1 WITH STEAM",
      choose: "CHOOSE",
      cancelCopy: "CANCEL",
      createInstall: "CREATE SEPARATE COPY",
      useExisting: "USE THIS CLIENT",
      legal: "The game is not downloaded or redistributed by ROTK. The copy only comes from your local files.",
      progressPhases: {
        scanning: "SCANNING",
        copying: "COPYING",
        verifying: "VERIFYING",
        configuring: "CONFIGURING",
        finalizing: "FINALIZING",
      },
      progressFiles: {
        scanning: "Scanning H1Z1 client",
        verifying: "SHA-256 verification",
        configuring: "Applying ROTK client configuration",
        finalizing: "Finishing the installation",
      },
    },
    activity: {
      regionLabel: "Launcher operations",
      eyebrow: "OPERATION IN PROGRESS",
      installation: "ROTK CLIENT INSTALLATION",
      assets: "ROTK GAME ASSETS",
      integrity: "GAME FILE VERIFICATION",
      launch: "GAME LAUNCH",
      launcherUpdate: "LAUNCHER UPDATE",
      checkingUpdate: "CHECKING FOR UPDATE",
      checkingAssets: "Checking the official asset feed",
      preparingFiles: "Preparing the H1Z1 client files",
      integrityDetail: "Checking every game file before launch",
      launchDetail: "Preparing the secure game session",
      updateDetail: "Contacting the official release feed",
      working: "WORKING",
      files: (completed, total) => `${completed} / ${total} files`,
      packs: (completed, total) => `${completed} / ${total} packs`,
      progress: (operation) => `${operation} progress`,
    },
    integrity: {
      verifying: "VERIFYING GAME FILES",
    },
    assets: {
      title: "CUSTOM ASSETS",
      description: "ROTK asset packs are downloaded from the official feed, verified with SHA-256 and updated before each launch.",
      updating: "UPDATING ASSETS",
      status: {
        idle: "NOT SYNCED YET",
        disabled: "SYNC DISABLED",
        checking: "CHECKING",
        downloading: "DOWNLOADING",
        installing: "INSTALLING",
        "up-to-date": "UP TO DATE",
        warning: "WARNING",
        error: "ERROR",
      },
      packVersion: (version) => `Asset pack ${version}`,
      neverSynced: "No asset pack installed",
      warnings: {
        "feed-unavailable": "Asset feed unreachable — playing with the assets already installed.",
        "sync-failed": "Asset update failed — playing with the assets already installed.",
      },
      verify: "VERIFY FILES",
      restore: "RESTORE VANILLA CLIENT",
      autoSync: "Update the custom assets automatically",
    },
  },
  fr: {
    diagnostics: DIAGNOSTICS_COPY.fr,
    language: {
      label: "Langue",
      change: (current) => `Changer de langue. Langue actuelle : ${current}`,
      english: "English",
      french: "Français",
      chinese: "简体中文",
    },
    chrome: {
      launcher: "LAUNCHER",
      updates: "DEV UPDATES",
      build: "BUILD",
      minimize: "Réduire",
      close: "Fermer",
    },
    app: {
      initializing: "INITIALISATION DU LAUNCHER",
      operationFailed: "L’opération a échoué.",
      operationInterrupted: "OPÉRATION INTERROMPUE",
      closeError: "Fermer",
    },
    news: {
      headline: "RETOUR AU COMBAT.",
      latest: "DERNIÈRES ACTUALITÉS",
      fallbackTitle: "SUIVEZ LE DÉVELOPPEMENT",
      fallbackSummary: "Le flux de développement est momentanément indisponible. Le launcher reste utilisable hors ligne.",
      fallbackCategory: "DÉVELOPPEMENT",
      label: "Dernières actualités ROTK",
      navigation: "Navigation des actualités",
      showItem: (index) => `Afficher l’actualité ${index}`,
      patchNote: "PATCH NOTE",
      devUpdate: "DEV UPDATE",
      version: "VERSION",
      readUpdate: "LIRE L’UPDATE",
      previous: "Actualité précédente",
      next: "Actualité suivante",
    },
    footer: {
      play: "JOUER",
      inGame: "EN JEU",
      process: "PROCESSUS",
      activeProcess: "PROCESSUS ACTIF",
      launching: "LANCEMENT",
      preparingClient: "PRÉPARATION DU CLIENT",
      installing: "INSTALLATION",
      secureCopy: "COPIE SÉCURISÉE EN COURS",
      attention: "ATTENTION",
      ready: "PRÊT",
      clientConfigured: "CLIENT ROTK CONFIGURÉ",
      accountRequired: "COMPTE ROTK REQUIS",
      missingAccountKey: "AJOUTE TA CLÉ LAUNCHER DU SITE",
      setupRequired: "À CONFIGURER",
      createIndependentInstall: "SÉLECTIONNER UN CLIENT H1Z1",
      install: "INSTALLER",
      environment: "ENVIRONNEMENT",
      settings: "Installation et réglages",
      playerIdentity: "Clé de compte ROTK",
      addAccountKey: "AJOUTER LA CLÉ ROTK",
      adminMode: "ADMIN",
      selectServer: "Choisir le serveur ROTK et le mode de lancement",
      playersInGame: "EN JEU",
      playersUnavailable: "—",
      playersUnknown: "Nombre de joueurs indisponible",
    },
    identity: {
      panelLabel: "Authentification du compte ROTK",
      eyebrow: "COMPTE ROTK",
      title: "CLÉ LAUNCHER",
      intro: "Cette clé relie chaque lancement à ton compte ROTK, ton identité Steam et tes données de jeu persistantes.",
      roles: {
        player: "JOUEUR",
        admin: "ADMIN / MOD",
      },
      keyLabels: {
        player: "CLÉ JOUEUR",
        admin: "CLÉ ADMIN / MOD",
      },
      keyHints: {
        player: (websiteHost) => `${websiteHost} > Avatar > Account settings > ROTK launcher key.`,
        admin: (websiteHost) => `${websiteHost} > espace admin > clé launcher administrateur. Réservée aux administrateurs autorisés.`,
      },
      keySet: "ENREGISTRÉE",
      keyMissing: "ABSENTE",
      extraKeys: "AUTRES CLÉS",
      extraKeysCount: (configured, total) => `${configured}/${total} enregistrées`,
      extraKeysHint: "Chaque serveur ROTK a ses propres comptes, et une clé administrateur appartient à un compte différent de ta clé joueur. Ne remplis que ce dont tu as besoin.",
      placeholder: "32 caractères hexadécimaux",
      sessionOnly: "Enregistrée avec le chiffrement Windows de ce compte. Le launcher ne la génère jamais.",
      process: (websiteHost) => `Crée ou connecte ton compte sur ${websiteHost}, copie la clé, puis enregistre-la ici.`,
      openAccount: (websiteHost) => `OUVRIR ${websiteHost.toLocaleUpperCase("en-US")}`,
      invalid: "Saisis exactement 32 caractères hexadécimaux (0-9, a-f).",
      applied: "Clé de compte ROTK enregistrée de façon sécurisée.",
      removed: "Clé de compte ROTK supprimée de cet ordinateur.",
      copied: "Clé de compte ROTK copiée.",
      apply: "ENREGISTRER LA CLÉ",
      remove: "Supprimer cette clé",
      copy: "Copier la clé de compte ROTK",
      show: "Afficher la clé de compte ROTK",
      hide: "Masquer la clé de compte ROTK",
      close: "Fermer l’authentification du compte ROTK",
    },
    update: {
      available: (version) => `MISE À JOUR ${version} DISPONIBLE`,
      availableDetail: "Profite des dernières améliorations et corrections avant de jouer.",
      download: "METTRE À JOUR",
      downloading: "TÉLÉCHARGEMENT",
      restart: "REDÉMARRER POUR INSTALLER",
      restartDetail: "Redémarre le launcher pour installer la mise à jour, puis relance le jeu.",
      failed: "ÉCHEC DU TÉLÉCHARGEMENT",
      retry: "RÉESSAYER",
      dismiss: "Masquer la notification de mise à jour",
      close: "Fermer le rappel de mise à jour",
      promptTitle: "METS À JOUR AVANT DE JOUER",
      readyTitle: "LA MISE À JOUR EST PRÊTE",
      promptDetail: "Mets à jour le launcher ROTK pour jouer avec la dernière version du jeu. Télécharge la mise à jour, puis redémarre le launcher pour l’installer.",
      currentVersion: "VERSION INSTALLÉE",
      newVersion: "NOUVELLE VERSION",
      later: "PLUS TARD",
      closeGame: "Ferme le jeu avant de redémarrer le launcher.",
      check: "RECHERCHER LA MISE À JOUR",
      requiredDetail: "Le serveur exige un launcher plus récent. Si la mise à jour reste introuvable, vérifie ta connexion puis réessaie.",
    },
    install: {
      notSelected: "NON SÉLECTIONNÉ",
      closeSetup: "Fermer la configuration",
      panelLabel: "Installation du client ROTK",
      firstInstall: "CONFIGURATION DU CLIENT",
      title: "INSTALLATION DU CLIENT",
      close: "Fermer",
      intro: "Choisis le dossier H1Z1 que ROTK doit utiliser. Un client isolé est configuré sur place ; un client Steam est d’abord copié vers un emplacement sûr.",
      protectionActive: "DÉTECTION AUTOMATIQUE",
      protectionDetail: "Sélectionne un client pour vérifier s’il peut être utilisé directement.",
      isolatedDetected: "CLIENT ISOLÉ DÉTECTÉ",
      isolatedDetail: "Ce client est déjà séparé de Steam. Aucune copie n’est nécessaire.",
      steamDetected: "CLIENT STEAM DÉTECTÉ",
      steamDetail: "Cette installation ne sera pas modifiée. Choisis un emplacement hors de Steam pour la copie ROTK.",
      sourceClient: "CLIENT H1Z1",
      rotkInstall: "INSTALLATION ROTK",
      detectedBadge: "DÉTECTÉ AUTO",
      recommendedBadge: "RECOMMANDÉ",
      subfolderHint: "Un sous-dossier ROTK est créé automatiquement dans l’emplacement choisi — inutile de le créer toi-même.",
      driveLabel: "DISQUE D’INSTALLATION",
      driveFree: (gigabytes) => `${gigabytes} Go libres`,
      resumeHint: "Tu peux annuler ou fermer le launcher : la copie reprendra là où elle s’est arrêtée.",
      noClientFound: "Aucun client H1Z1 trouvé. Installe-le avec Steam (sous le nom Z1 Battle Royale), puis reviens ici.",
      installWithSteam: "INSTALLER H1Z1 AVEC STEAM",
      choose: "CHOISIR",
      cancelCopy: "ANNULER",
      createInstall: "CRÉER UNE COPIE SÉPARÉE",
      useExisting: "UTILISER CE CLIENT",
      legal: "Le jeu n’est ni téléchargé ni redistribué par ROTK. La copie provient uniquement de tes fichiers locaux.",
      progressPhases: {
        scanning: "ANALYSE",
        copying: "COPIE",
        verifying: "VÉRIFICATION",
        configuring: "CONFIGURATION",
        finalizing: "FINALISATION",
      },
      progressFiles: {
        scanning: "Analyse du client H1Z1",
        verifying: "Vérification SHA-256",
        configuring: "Application du client ROTK",
        finalizing: "Finalisation de l’installation",
      },
    },
    activity: {
      regionLabel: "Opérations du launcher",
      eyebrow: "OPÉRATION EN COURS",
      installation: "INSTALLATION DU CLIENT ROTK",
      assets: "ASSETS DU JEU ROTK",
      integrity: "VÉRIFICATION DES FICHIERS",
      launch: "LANCEMENT DU JEU",
      launcherUpdate: "MISE À JOUR DU LAUNCHER",
      checkingUpdate: "RECHERCHE DE MISE À JOUR",
      checkingAssets: "Vérification du flux officiel des assets",
      preparingFiles: "Préparation des fichiers du client H1Z1",
      integrityDetail: "Vérification de chaque fichier avant le lancement",
      launchDetail: "Préparation de la session de jeu sécurisée",
      updateDetail: "Connexion au flux officiel des releases",
      working: "EN COURS",
      files: (completed, total) => `${completed} / ${total} fichiers`,
      packs: (completed, total) => `${completed} / ${total} packs`,
      progress: (operation) => `Progression de l’opération ${operation}`,
    },
    integrity: {
      verifying: "VÉRIFICATION DES FICHIERS DU JEU",
    },
    assets: {
      title: "ASSETS PERSONNALISÉS",
      description: "Les packs d’assets ROTK sont téléchargés depuis le flux officiel, vérifiés en SHA-256 et mis à jour avant chaque lancement.",
      updating: "MISE À JOUR DES ASSETS",
      status: {
        idle: "PAS ENCORE SYNCHRONISÉ",
        disabled: "SYNC DÉSACTIVÉE",
        checking: "VÉRIFICATION",
        downloading: "TÉLÉCHARGEMENT",
        installing: "INSTALLATION",
        "up-to-date": "À JOUR",
        warning: "AVERTISSEMENT",
        error: "ERREUR",
      },
      packVersion: (version) => `Pack d’assets ${version}`,
      neverSynced: "Aucun pack d’assets installé",
      warnings: {
        "feed-unavailable": "Flux d’assets injoignable — le jeu utilise les assets déjà installés.",
        "sync-failed": "Mise à jour des assets échouée — le jeu utilise les assets déjà installés.",
      },
      verify: "VÉRIFIER LES FICHIERS",
      restore: "RESTAURER LE CLIENT VANILLA",
      autoSync: "Mettre à jour les assets personnalisés automatiquement",
    },
  },
  zh: {
    diagnostics: DIAGNOSTICS_COPY.zh,
    language: {
      label: "语言",
      change: (current) => `切换语言。当前语言：${current}`,
      english: "English",
      french: "Français",
      chinese: "简体中文",
    },
    chrome: {
      launcher: "启动器",
      updates: "开发动态",
      build: "版本",
      minimize: "最小化",
      close: "关闭",
    },
    app: {
      initializing: "正在初始化启动器",
      operationFailed: "操作失败。",
      operationInterrupted: "操作已中断",
      closeError: "关闭",
    },
    news: {
      headline: "重返战场。",
      latest: "最新消息",
      fallbackTitle: "关注开发进度",
      fallbackSummary: "暂时无法获取开发动态，不影响启动器的使用。",
      fallbackCategory: "开发",
      label: "ROTK 最新消息",
      navigation: "消息导航",
      showItem: (index) => `显示第 ${index} 条消息`,
      patchNote: "更新说明",
      devUpdate: "开发动态",
      version: "版本",
      readUpdate: "查看详情",
      previous: "上一条消息",
      next: "下一条消息",
    },
    footer: {
      play: "开始游戏",
      inGame: "游戏中",
      process: "进程",
      activeProcess: "运行中的进程",
      launching: "正在启动",
      preparingClient: "正在准备客户端",
      installing: "正在安装",
      secureCopy: "正在复制游戏文件",
      attention: "注意",
      ready: "就绪",
      clientConfigured: "ROTK 客户端已配置",
      accountRequired: "需要 ROTK 账号",
      missingAccountKey: "请添加网站上的启动器密钥",
      setupRequired: "尚未安装",
      createIndependentInstall: "请选择 H1Z1 客户端",
      install: "安装",
      environment: "环境",
      settings: "安装与设置",
      playerIdentity: "ROTK 账号密钥",
      addAccountKey: "添加 ROTK 密钥",
      adminMode: "管理员",
      selectServer: "选择 ROTK 服务器和启动模式",
      playersInGame: "游戏中",
      playersUnavailable: "—",
      playersUnknown: "玩家人数不可用",
    },
    identity: {
      panelLabel: "ROTK 账号验证",
      eyebrow: "ROTK 账号",
      title: "启动器密钥",
      intro: "每次启动游戏时，启动器都会用这个密钥关联你的 ROTK 账号、Steam 身份和游戏数据。",
      roles: {
        player: "玩家",
        admin: "管理员 / 版主",
      },
      keyLabels: {
        player: "玩家密钥",
        admin: "管理员 / 版主密钥",
      },
      keyHints: {
        player: (websiteHost) => `在 ${websiteHost} 依次点击：Avatar > Account settings > ROTK launcher key。`,
        admin: (websiteHost) => `在 ${websiteHost} 的管理后台获取管理员启动器密钥。仅限获得授权的管理员。`,
      },
      keySet: "已保存",
      keyMissing: "未设置",
      extraKeys: "其他密钥",
      extraKeysCount: (configured, total) => `已保存 ${configured}/${total}`,
      extraKeysHint: "每个 ROTK 服务器的账号是独立的，管理员密钥和玩家密钥也属于不同账号。用不到的可以不填。",
      placeholder: "32 位十六进制字符",
      sessionOnly: "密钥已通过 Windows 加密保存在此账户下。启动器不会自动生成密钥。",
      process: (websiteHost) => `在 ${websiteHost} 上注册或登录，复制密钥，然后保存到这里。`,
      openAccount: (websiteHost) => `打开 ${websiteHost.toLocaleUpperCase("en-US")}`,
      invalid: "请输入正好 32 位十六进制字符（0-9、a-f）。",
      applied: "ROTK 账号密钥已安全保存。",
      removed: "已从此电脑删除 ROTK 账号密钥。",
      copied: "已复制 ROTK 账号密钥。",
      apply: "保存密钥",
      remove: "删除此密钥",
      copy: "复制 ROTK 账号密钥",
      show: "显示 ROTK 账号密钥",
      hide: "隐藏 ROTK 账号密钥",
      close: "关闭 ROTK 账号验证",
    },
    update: {
      available: (version) => `启动器更新 ${version} 可用`,
      availableDetail: "更新后即可获得最新的改进和修复。",
      download: "更新",
      downloading: "正在下载更新",
      restart: "重启以安装",
      restartDetail: "重启启动器以安装更新，然后重新启动游戏。",
      failed: "更新下载失败",
      retry: "重试",
      dismiss: "隐藏更新通知",
      close: "关闭更新提醒",
      promptTitle: "开始游戏前请先更新",
      readyTitle: "更新已就绪",
      promptDetail: "更新 ROTK 启动器即可使用最新版本进行游戏。下载更新后，重启启动器进行安装。",
      currentVersion: "当前版本",
      newVersion: "新版本",
      later: "稍后",
      closeGame: "重启启动器前请先关闭游戏。",
      check: "检查更新",
      requiredDetail: "服务器要求使用更新版本的启动器。如果找不到更新，请检查网络连接后重试。",
    },
    install: {
      notSelected: "未选择",
      closeSetup: "关闭设置",
      panelLabel: "ROTK 客户端安装",
      firstInstall: "客户端设置",
      title: "客户端安装",
      close: "关闭",
      intro: "选择 ROTK 要使用的 H1Z1 游戏文件夹。不在 Steam 目录里的客户端会直接使用；Steam 里的客户端会先复制一份，原文件保持不变。",
      protectionActive: "自动检测",
      protectionDetail: "选择一个客户端，检查它是否可以直接使用。",
      isolatedDetected: "已检测到独立客户端",
      isolatedDetail: "这个客户端不在 Steam 目录里，无需复制。",
      steamDetected: "已检测到 Steam 客户端",
      steamDetail: "Steam 里的游戏不会被改动。请为 ROTK 副本选择 Steam 目录以外的位置。",
      sourceClient: "H1Z1 客户端",
      rotkInstall: "ROTK 安装位置",
      detectedBadge: "自动检测",
      recommendedBadge: "推荐",
      subfolderHint: "会在所选位置自动创建 ROTK 子文件夹，无需手动创建。",
      driveLabel: "安装磁盘",
      driveFree: (gigabytes) => `剩余 ${gigabytes} GB`,
      resumeHint: "可以随时取消或关闭启动器，下次会从中断的地方继续复制。",
      noClientFound: "没有找到 H1Z1。请先在 Steam 库中安装 Z1 Battle Royale（Z1 大逃杀），装好后回到这里。",
      installWithSteam: "通过 STEAM 安装 H1Z1",
      choose: "选择",
      cancelCopy: "取消",
      createInstall: "创建独立副本",
      useExisting: "使用此客户端",
      legal: "ROTK 不提供游戏下载，也不分发游戏文件。副本只来自你电脑上已有的游戏。",
      progressPhases: {
        scanning: "正在扫描",
        copying: "正在复制",
        verifying: "正在校验",
        configuring: "正在配置",
        finalizing: "正在完成",
      },
      progressFiles: {
        scanning: "正在扫描 H1Z1 客户端",
        verifying: "SHA-256 校验",
        configuring: "正在应用 ROTK 客户端配置",
        finalizing: "正在完成安装",
      },
    },
    activity: {
      regionLabel: "启动器操作",
      eyebrow: "正在进行的操作",
      installation: "ROTK 客户端安装",
      assets: "ROTK 游戏资源",
      integrity: "游戏文件验证",
      launch: "启动游戏",
      launcherUpdate: "启动器更新",
      checkingUpdate: "正在检查更新",
      checkingAssets: "正在检查 ROTK 资源更新",
      preparingFiles: "正在准备 H1Z1 客户端文件",
      integrityDetail: "启动前检查游戏文件是否完整",
      launchDetail: "正在连接服务器并准备游戏",
      updateDetail: "正在检查启动器新版本",
      working: "处理中",
      files: (completed, total) => `${completed} / ${total} 个文件`,
      packs: (completed, total) => `${completed} / ${total} 个资源包`,
      progress: (operation) => `${operation} 进度`,
    },
    integrity: {
      verifying: "正在验证游戏文件",
    },
    assets: {
      title: "ROTK 定制资源",
      description: "ROTK 的定制资源包从官方地址下载，经过 SHA-256 校验，每次启动前自动更新。",
      updating: "正在更新资源",
      status: {
        idle: "尚未同步",
        disabled: "同步已关闭",
        checking: "正在检查",
        downloading: "正在下载",
        installing: "正在安装",
        "up-to-date": "已是最新",
        warning: "警告",
        error: "错误",
      },
      packVersion: (version) => `资源包 ${version}`,
      neverSynced: "未安装资源包",
      warnings: {
        "feed-unavailable": "暂时无法连接资源服务器，将使用已安装的资源开始游戏。",
        "sync-failed": "资源更新失败，将使用已安装的资源开始游戏。",
      },
      verify: "验证文件",
      restore: "恢复原版客户端",
      autoSync: "自动更新 ROTK 定制资源",
    },
  },
};

interface I18nContextValue {
  locale: AppLocale;
  copy: Copy;
  setLocale(locale: AppLocale): void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

// First run: follow the Windows display language when we have it.
function systemLocale(): AppLocale {
  const language = navigator.language.toLowerCase();
  if (language.startsWith("zh")) return "zh";
  if (language.startsWith("fr")) return "fr";
  return "en";
}

function storedLocale(): AppLocale {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isAppLocale(value) ? value : systemLocale();
  } catch {
    return systemLocale();
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<AppLocale>(storedLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // A blocked storage backend should not prevent language selection for
      // the current session.
    }
    void window.rotk.setLocale(locale);
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, copy: COPY[locale], setLocale }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
