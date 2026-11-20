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
const CHOSEN_KEY = "rotk.launcher.localeChosen";

/**
 * Whether the player was asked for a language. The stored locale cannot tell:
 * it is written on the first start, from the language of Windows. A storage
 * that cannot be read answers yes, so the question is not asked at every start.
 */
export function languageWasChosen(): boolean {
  try {
    return window.localStorage.getItem(CHOSEN_KEY) === "1";
  } catch {
    return true;
  }
}

export function rememberLanguageChosen(): void {
  try {
    window.localStorage.setItem(CHOSEN_KEY, "1");
  } catch {
    // The question may come back once; the language itself is kept by the provider.
  }
}

export interface Copy {
  diagnostics: DiagnosticsCopy;
  language: {
    english: string;
    french: string;
    chinese: string;
  };
  chrome: {
    home: string;
    settings: string;
    minimize: string;
    close: string;
  };
  app: {
    initializing: string;
    initializingSlow: string;
    initializingFailed: string;
    operationFailed: string;
    operationInterrupted: string;
    notice: string;
    closeError: string;
  };
  events: {
    label: string;
    /** Tag of a message written by the staff. */
    message: string;
    running: string;
    applications: string;
    soon: string;
    until: (date: string) => string;
    view: string;
    previous: string;
    next: string;
  };
  news: {
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
    /** A card of the staff: its default tag, and its link. */
    featured: string;
    readMore: string;
    previous: string;
    next: string;
  };
  footer: {
    play: string;
    inGame: string;
    stopGame: string;
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
    addAccountKey: string;
    finishingReport: string;
    adminMode: string;
    selectServer: string;
    playersInGame: string;
    playersUnavailable: string;
    playersUnknown: string;
  };
  identity: {
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
    openAccount: (websiteHost: string) => string;
    invalid: string;
    applied: string;
    removed: string;
    copied: string;
    remove: string;
    copy: string;
    show: string;
    hide: string;
  };
  update: {
    available: (version: string) => string;
    availableDetail: string;
    download: string;
    autoDownload: string;
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
    manualDownload: string;
  };
  install: {
    steps: { language: string; h1z1: string; location: string; copy: string; key: string };
    languageTitle: string;
    languageLead: string;
    stepOf: (index: number, total: number) => string;
    title: string;
    lead: string;
    searching: string;
    h1z1Found: string;
    h1z1FoundDetail: string;
    h1z1Missing: string;
    h1z1MissingDetail: string;
    noGame: string;
    noGameDetail: string;
    steamButton: string;
    steamWaiting: string;
    haveGame: string;
    haveGameDetail: string;
    chooseFolder: string;
    otherFolderLink: string;
    directFound: string;
    directDetail: string;
    locationTitle: string;
    locationLead: string;
    recommended: string;
    free: (gigabytes: number) => string;
    otherFolder: string;
    otherFolderDetail: string;
    changeFolder: string;
    installsIn: string;
    subfolder: string;
    noDrive: string;
    install: string;
    adopt: string;
    copyTitle: string;
    phases: Record<"scanning" | "copying" | "verifying" | "configuring" | "finalizing", string>;
    starting: string;
    gigabytes: (done: string, total: string) => string;
    remaining: (minutes: number) => string;
    remainingSoon: string;
    canLeave: string;
    cancel: string;
    failedTitle: string;
    failedKept: string;
    steamExeTitle: string;
    steamExeLead: string;
    steamExeSteps: readonly string[];
    steamExeOpen: string;
    steamExeWaiting: string;
    retry: string;
    keyTitle: string;
    keyLead: string;
    keyPlaceholder: string;
    saveKey: string;
    doneTitle: string;
    doneLead: string;
    later: string;
    back: string;
    next: string;
    close: string;
    legal: string;
    progressPhases: Record<"scanning" | "copying" | "verifying" | "configuring" | "finalizing", string>;
  };
  settings: {
    title: string;
    tabs: Record<"general" | "game" | "updates" | "look" | "account" | "help", string>;
    /** One line under each tab's title. */
    leads: Record<"general" | "game" | "updates" | "look" | "account" | "help", string>;
    language: string;
    languageHint: string;
    location: string;
    notInstalled: string;
    installElsewhere: string;
    installElsewhereHint: string;
    installNow: string;
    files: string;
    filesHint: string;
    verify: string;
    advanced: string;
    restore: string;
    restoreHint: string;
    launcher: string;
    version: (version: string) => string;
    /** What a check for a launcher update answered when it found none. */
    upToDate: string;
    checkFailed: string;
    gameFiles: string;
    releaseNotes: string;
    releaseNotesHint: string;
    open: string;
    versionInfo: string;
    versionInfoHint: string;
    behaviour: string;
    onClose: string;
    onCloseOptions: Record<"quit" | "tray", string>;
    onPlay: string;
    onPlayOptions: Record<"keep" | "minimize" | "close", string>;
    notifications: string;
    notificationsHint: string;
    openFolder: string;
    diskUse: string;
    computing: string;
    gigabytes: (value: string) => string;
    repair: string;
    repairHint: string;
    /** A game used where it already was: no original to repair it from, and its folder is the player's. */
    repairAdoptedHint: string;
    uninstallAdoptedHint: string;
    repairButton: string;
    uninstall: string;
    uninstallHint: string;
    uninstallButton: string;
    uninstallConfirm: { title: string; remove: string; forget: string; cancel: string };
    speedLimit: string;
    noLimit: string;
    megabytesPerSecond: (megabytes: number) => string;
    report: string;
    reportHint: string;
    logs: string;
    logsHint: string;
    discord: string;
    discordHint: string;
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
    description: string;
    updating: string;
    status: Record<"idle" | "disabled" | "checking" | "downloading" | "installing" | "up-to-date" | "warning" | "error", string>;
    packVersion: (version: string) => string;
    neverSynced: string;
    warnings: Record<"feed-unavailable" | "sync-failed", string>;
    restore: string;
    autoSync: string;
  };
  fonts: {
    description: string;
    original: string;
    sampleTitle: string;
    sampleButtons: string;
    sampleFeed: string;
    sampleText: string;
    noCyrillic: string;
    nextLaunch: string;
    targetGame: string;
    targetLauncher: string;
    launcherDescription: string;
    launcherNow: string;
    sampleLauncherNav: string;
    sampleLauncherText: string;
  };
}

const COPY: Record<AppLocale, Copy> = {
  en: {
    diagnostics: DIAGNOSTICS_COPY.en,
    language: {
      english: "English",
      french: "Français",
      chinese: "简体中文",
    },
    chrome: {
      home: "HOME",
      settings: "SETTINGS",
      minimize: "Minimize",
      close: "Close",
    },
    app: {
      initializing: "INITIALIZING LAUNCHER",
      initializingSlow: "This is taking longer than usual: the launcher is reading its files, often on a drive that was asleep. If nothing changes, close the launcher and start it again.",
      initializingFailed: "The launcher could not finish starting. Close it and start it again; if it happens again, send %APPDATA%\\ROTK Launcher\\startup.log to the ROTK team.",
      operationFailed: "The operation failed.",
      operationInterrupted: "OPERATION INTERRUPTED",
      notice: "NOTICE",
      closeError: "Close",
    },
    events: {
      label: "Announcements and events",
      message: "NOTICE",
      running: "LIVE",
      applications: "SIGN-UPS OPEN",
      soon: "SOON",
      until: (date) => `until ${date}`,
      view: "VIEW",
      previous: "Previous event",
      next: "Next event",
    },
    news: {
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
      featured: "EVENT",
      readMore: "LEARN MORE",
      previous: "Previous news item",
      next: "Next news item",
    },
    footer: {
      play: "PLAY",
      inGame: "IN GAME",
      stopGame: "Close H1Z1 (game window gone or not responding)",
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
      setupRequired: "NOT INSTALLED",
      createIndependentInstall: "CLICK INSTALL TO GET STARTED",
      install: "INSTALL",
      environment: "ENVIRONMENT",
      addAccountKey: "ADD ROTK KEY",
      finishingReport: "FINISHING THE LAST GAME'S REPORT",
      adminMode: "ADMIN",
      selectServer: "Choose the ROTK server and launch mode",
      playersInGame: "IN GAME",
      playersUnavailable: "—",
      playersUnknown: "Player count unavailable",
    },
    identity: {
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
      openAccount: (websiteHost) => `OPEN ${websiteHost.toLocaleUpperCase("en-US")}`,
      invalid: "Enter exactly 32 hexadecimal characters (0-9, a-f).",
      applied: "ROTK account key saved securely.",
      removed: "ROTK account key removed from this computer.",
      copied: "ROTK account key copied.",
      remove: "Remove this key",
      copy: "Copy ROTK account key",
      show: "Show ROTK account key",
      hide: "Hide ROTK account key",
    },
    update: {
      available: (version) => `LAUNCHER UPDATE ${version} AVAILABLE`,
      availableDetail: "Get the latest improvements and fixes before playing.",
      download: "UPDATE",
      autoDownload: "Download launcher updates automatically",
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
      manualDownload: "Still stuck? Download the launcher installer from rotk.app and install it over this one.",
    },
    install: {
      steps: { language: "LANGUAGE", h1z1: "H1Z1", location: "LOCATION", copy: "INSTALL", key: "ACCOUNT" },
      languageTitle: "CHOOSE YOUR LANGUAGE",
      languageLead: "You can change it later in the settings.",
      stepOf: (index, total) => `STEP ${index} OF ${total}`,
      title: "INSTALL ROTK",
      lead: "ROTK runs on H1Z1, free on Steam. The launcher takes care of the rest.",
      searching: "Looking for H1Z1 on this PC…",
      h1z1Found: "H1Z1 FOUND ON THIS PC",
      h1z1FoundDetail: "Installed by Steam. ROTK leaves it alone and makes its own copy.",
      h1z1Missing: "H1Z1 IS NOT ON THIS PC YET",
      h1z1MissingDetail: "ROTK needs the H1Z1 files to run.",
      noGame: "I DON’T HAVE H1Z1",
      noGameDetail: "Free on Steam, listed as “Z1 Battle Royale”. About 20 GB to download.",
      steamButton: "INSTALL WITH STEAM",
      steamWaiting: "Steam is open. Start the Z1 Battle Royale download, then come back here when it is done: the launcher will find it on its own.",
      haveGame: "I ALREADY HAVE H1Z1",
      haveGameDetail: "Point to the folder it is in (the one that holds H1Z1.exe).",
      chooseFolder: "CHOOSE THE FOLDER",
      otherFolderLink: "Use another H1Z1 folder",
      directFound: "H1Z1 COPY OUTSIDE STEAM",
      directDetail: "This folder does not depend on Steam: ROTK uses it as it is, nothing is copied.",
      locationTitle: "WHERE TO INSTALL ROTK?",
      locationLead: "The launcher copies H1Z1 into its own folder, about 21 GB. Your Steam H1Z1 stays untouched.",
      recommended: "RECOMMENDED",
      free: (gigabytes) => `${gigabytes} GB free`,
      otherFolder: "OTHER FOLDER",
      otherFolderDetail: "Let me choose",
      changeFolder: "Change folder",
      installsIn: "ROTK WILL BE INSTALLED IN",
      subfolder: "The “ROTK” folder is created for you.",
      noDrive: "No drive has the 30 GB of free space needed. Free some space, or choose a folder on another drive.",
      install: "INSTALL",
      adopt: "USE THIS FOLDER",
      copyTitle: "INSTALLING",
      phases: {
        scanning: "Scanning H1Z1",
        copying: "Copying files",
        verifying: "Checking the copy",
        configuring: "Setting up ROTK",
        finalizing: "Finishing",
      },
      starting: "Starting…",
      gigabytes: (done, total) => `${done} of ${total} GB`,
      remaining: (minutes) => `about ${minutes} min left`,
      remainingSoon: "less than a minute",
      canLeave: "You can cancel or close the launcher: the copy resumes where it stopped.",
      cancel: "CANCEL",
      failedTitle: "THE INSTALL STOPPED",
      failedKept: "What is already copied is kept: retrying resumes from there.",
      steamExeTitle: "Steam updated H1Z1",
      steamExeLead: "Steam installed a new H1Z1.exe that ROTK does not support. Steam can download the right one in about a minute, without reinstalling the game.",
      steamExeSteps: [
        "The Steam console has opened and the command below is copied.",
        "Paste it in the console (Ctrl+V) and press Enter.",
        "Wait for “Depot download complete”: the installation resumes on its own.",
      ],
      steamExeOpen: "COPY AND OPEN THE CONSOLE",
      steamExeWaiting: "Waiting for Steam's download…",
      retry: "TRY AGAIN",
      keyTitle: "LINK YOUR ROTK ACCOUNT",
      keyLead: "Last step. Your launcher key is on the website: copy it, then paste it here.",
      keyPlaceholder: "Paste your key here (32 characters)",
      saveKey: "SAVE",
      doneTitle: "ALL SET",
      doneLead: "On the first launch, the launcher downloads the ROTK files and checks the game. Allow a few minutes, once only.",
      later: "LATER",
      back: "BACK",
      next: "CONTINUE",
      close: "Close",
      legal: "The game is not downloaded or redistributed by ROTK. The copy only comes from your local files.",
      progressPhases: {
        scanning: "SCANNING",
        copying: "COPYING",
        verifying: "VERIFYING",
        configuring: "CONFIGURING",
        finalizing: "FINALIZING",
      },
    },
    settings: {
      title: "SETTINGS",
      tabs: { general: "GENERAL", game: "GAME", updates: "UPDATES", look: "APPEARANCE", account: "ACCOUNT", help: "HELP" },
      leads: {
        general: "The launcher’s language and behaviour.",
        game: "Where the game is installed, and how to repair it.",
        updates: "What the launcher downloads on its own.",
        look: "The fonts of the launcher and of the game.",
        account: "The keys that link the launcher to your ROTK account.",
        help: "What helps the team help you.",
      },
      language: "Language",
      languageHint: "Used by the launcher and the news.",
      location: "GAME LOCATION",
      notInstalled: "The game is not installed yet.",
      installElsewhere: "INSTALL SOMEWHERE ELSE",
      installElsewhereHint: "Prepares another installation. This one stays in use until the new one is done.",
      installNow: "INSTALL THE GAME",
      files: "ROTK files",
      filesHint: "Checks the ROTK files and downloads again the missing or damaged ones.",
      verify: "VERIFY AND REPAIR",
      advanced: "ADVANCED",
      restore: "Back to the original H1Z1",
      restoreHint: "Removes the ROTK files from the game. They come back on the next launch if automatic updates are on.",
      launcher: "LAUNCHER",
      version: (version) => `Version ${version}`,
      upToDate: "The launcher is up to date.",
      checkFailed: "The check did not go through. Check your connection, then try again.",
      gameFiles: "GAME FILES",
      releaseNotes: "Release notes",
      releaseNotesHint: "What changed in each version, on the website.",
      open: "OPEN",
      versionInfo: "Version details",
      versionInfoHint: "Paste them in your message when you ask for help.",
      behaviour: "BEHAVIOUR",
      onClose: "When I close the window",
      onCloseOptions: { quit: "Quit", tray: "Stay in the tray" },
      onPlay: "When the game starts",
      onPlayOptions: { keep: "Stay open", minimize: "Minimize", close: "Close" },
      notifications: "Windows notifications",
      notificationsHint: "Install finished, launcher update ready.",
      openFolder: "Open the game folder",
      diskUse: "Disk space used",
      computing: "Calculating…",
      gigabytes: (value) => `${value} GB`,
      repair: "Original H1Z1 files",
      repairHint: "Copies again, from your Steam H1Z1, the files that are missing or of the wrong size.",
      repairAdoptedHint: "This game is a copy of H1Z1 you already had, used where it is: the launcher has no original to repair it from.",
      uninstallAdoptedHint: "The launcher stops using this folder. It stays on the disk: it is your own copy of H1Z1.",
      repairButton: "REPAIR",
      uninstall: "Uninstall the game",
      uninstallHint: "Deletes the ROTK folder. Your Steam H1Z1 is left alone.",
      uninstallButton: "UNINSTALL",
      uninstallConfirm: {
        title: "UNINSTALL THE GAME?",
        remove: "This folder is deleted. Your Steam H1Z1 is left alone, and the launcher keeps your account keys and your settings.",
        forget: "This folder is your own copy of H1Z1: it stays on the disk, the launcher only stops using it.",
        cancel: "CANCEL",
      },
      speedLimit: "Download speed limit",
      noLimit: "No limit",
      megabytesPerSecond: (megabytes) => `${megabytes} MB/s`,
      report: "Report a problem",
      reportHint: "Opens the support page of the website.",
      logs: "Logs folder",
      logsHint: "To send a file to the team when they ask for it.",
      discord: "ROTK Discord",
      discordHint: "Help between players, and announcements.",
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
      restore: "RESTORE VANILLA CLIENT",
      autoSync: "Update the custom assets automatically",
    },
    fonts: {
      description: "Pick the font of the in-game interface. Hover a font to preview it, click to keep it.",
      original: "Original",
      sampleTitle: "PRESS ANY KEY",
      sampleButtons: "PLAY · LOADOUT · SETTINGS",
      sampleFeed: "Raven_77 knocked out xXSniperXx with an AR-15 (124 m)",
      sampleText: "Squad 3 · Victory Royale · Bandage ×5 · Été, Ça, Ñ, Ğ",
      noCyrillic: "This font has no Cyrillic letters: Russian text keeps a fallback font.",
      nextLaunch: "Applied the next time you press Play.",
      targetGame: "IN GAME",
      targetLauncher: "LAUNCHER",
      launcherDescription: "Pick the font of this launcher. Hover a font to preview it, click to apply it.",
      launcherNow: "Applied to the launcher as soon as you click.",
      sampleLauncherNav: "PLAY · NEWS · EU SERVER",
      sampleLauncherText: "128 players online · Assets up to date · 2.0.48",
    },
  },
  fr: {
    diagnostics: DIAGNOSTICS_COPY.fr,
    language: {
      english: "English",
      french: "Français",
      chinese: "简体中文",
    },
    chrome: {
      home: "ACCUEIL",
      settings: "RÉGLAGES",
      minimize: "Réduire",
      close: "Fermer",
    },
    app: {
      initializing: "INITIALISATION DU LAUNCHER",
      initializingSlow: "C’est plus long que d’habitude : le launcher lit ses fichiers, souvent sur un disque qui était en veille. Si rien ne change, ferme le launcher puis relance-le.",
      initializingFailed: "Le launcher n’a pas pu finir de démarrer. Ferme-le puis relance-le ; si cela se reproduit, envoie %APPDATA%\\ROTK Launcher\\startup.log à l’équipe ROTK.",
      operationFailed: "L’opération a échoué.",
      operationInterrupted: "OPÉRATION INTERROMPUE",
      notice: "INFORMATION",
      closeError: "Fermer",
    },
    events: {
      label: "Annonces et événements",
      message: "ANNONCE",
      running: "EN COURS",
      applications: "INSCRIPTIONS OUVERTES",
      soon: "BIENTÔT",
      until: (date) => `jusqu’au ${date}`,
      view: "VOIR",
      previous: "Événement précédent",
      next: "Événement suivant",
    },
    news: {
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
      featured: "ÉVÉNEMENT",
      readMore: "EN SAVOIR PLUS",
      previous: "Actualité précédente",
      next: "Actualité suivante",
    },
    footer: {
      play: "JOUER",
      inGame: "EN JEU",
      stopGame: "Fermer H1Z1 (fenêtre du jeu disparue ou bloquée)",
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
      setupRequired: "À INSTALLER",
      createIndependentInstall: "CLIQUE SUR INSTALLER POUR COMMENCER",
      install: "INSTALLER",
      environment: "ENVIRONNEMENT",
      addAccountKey: "AJOUTER LA CLÉ ROTK",
      finishingReport: "FIN DU RAPPORT DE LA DERNIÈRE PARTIE",
      adminMode: "ADMIN",
      selectServer: "Choisir le serveur ROTK et le mode de lancement",
      playersInGame: "EN JEU",
      playersUnavailable: "—",
      playersUnknown: "Nombre de joueurs indisponible",
    },
    identity: {
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
      openAccount: (websiteHost) => `OUVRIR ${websiteHost.toLocaleUpperCase("en-US")}`,
      invalid: "Saisis exactement 32 caractères hexadécimaux (0-9, a-f).",
      applied: "Clé de compte ROTK enregistrée de façon sécurisée.",
      removed: "Clé de compte ROTK supprimée de cet ordinateur.",
      copied: "Clé de compte ROTK copiée.",
      remove: "Supprimer cette clé",
      copy: "Copier la clé de compte ROTK",
      show: "Afficher la clé de compte ROTK",
      hide: "Masquer la clé de compte ROTK",
    },
    update: {
      available: (version) => `MISE À JOUR ${version} DISPONIBLE`,
      availableDetail: "Profite des dernières améliorations et corrections avant de jouer.",
      download: "METTRE À JOUR",
      autoDownload: "Télécharger les mises à jour du launcher automatiquement",
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
      manualDownload: "Toujours bloqué ? Télécharge l’installateur du launcher sur rotk.app et installe-le par-dessus.",
    },
    install: {
      steps: { language: "LANGUE", h1z1: "H1Z1", location: "EMPLACEMENT", copy: "INSTALLATION", key: "COMPTE" },
      languageTitle: "CHOISIS TA LANGUE",
      languageLead: "Tu pourras la changer plus tard dans les réglages.",
      stepOf: (index, total) => `ÉTAPE ${index} SUR ${total}`,
      title: "INSTALLER ROTK",
      lead: "ROTK se joue avec H1Z1, gratuit sur Steam. Le launcher s’occupe du reste.",
      searching: "Recherche de H1Z1 sur ce PC…",
      h1z1Found: "H1Z1 TROUVÉ SUR CE PC",
      h1z1FoundDetail: "Installé par Steam. ROTK n’y touche pas : il en fait une copie à part.",
      h1z1Missing: "H1Z1 N’EST PAS ENCORE SUR CE PC",
      h1z1MissingDetail: "ROTK a besoin des fichiers de H1Z1 pour fonctionner.",
      noGame: "JE N’AI PAS H1Z1",
      noGameDetail: "Gratuit sur Steam, sous le nom « Z1 Battle Royale ». Environ 20 Go à télécharger.",
      steamButton: "INSTALLER AVEC STEAM",
      steamWaiting: "Steam s’est ouvert. Lance le téléchargement de Z1 Battle Royale, puis reviens ici quand il est terminé : le launcher le trouvera tout seul.",
      haveGame: "J’AI DÉJÀ H1Z1",
      haveGameDetail: "Indique le dossier où il se trouve (celui qui contient H1Z1.exe).",
      chooseFolder: "CHOISIR LE DOSSIER",
      otherFolderLink: "Utiliser un autre dossier H1Z1",
      directFound: "COPIE DE H1Z1 HORS DE STEAM",
      directDetail: "Ce dossier ne dépend pas de Steam : ROTK l’utilise tel quel, sans rien copier.",
      locationTitle: "OÙ INSTALLER ROTK ?",
      locationLead: "Le launcher copie H1Z1 dans un dossier à part, environ 21 Go. Ton H1Z1 de Steam reste intact.",
      recommended: "RECOMMANDÉ",
      free: (gigabytes) => `${gigabytes} Go libres`,
      otherFolder: "AUTRE DOSSIER",
      otherFolderDetail: "Choisir moi-même",
      changeFolder: "Changer de dossier",
      installsIn: "ROTK SERA INSTALLÉ DANS",
      subfolder: "Le dossier « ROTK » est créé pour toi.",
      noDrive: "Aucun disque n’a les 30 Go libres nécessaires. Libère de l’espace, ou choisis un dossier sur un autre disque.",
      install: "INSTALLER",
      adopt: "UTILISER CE DOSSIER",
      copyTitle: "INSTALLATION EN COURS",
      phases: {
        scanning: "Analyse de H1Z1",
        copying: "Copie des fichiers",
        verifying: "Vérification de la copie",
        configuring: "Préparation de ROTK",
        finalizing: "Dernières finitions",
      },
      starting: "Démarrage…",
      gigabytes: (done, total) => `${done} sur ${total} Go`,
      remaining: (minutes) => `environ ${minutes} min restantes`,
      remainingSoon: "moins d’une minute",
      canLeave: "Tu peux annuler ou fermer le launcher : la copie reprendra là où elle s’est arrêtée.",
      cancel: "ANNULER",
      failedTitle: "L’INSTALLATION S’EST ARRÊTÉE",
      failedKept: "Ce qui est déjà copié est gardé : réessayer reprend au même endroit.",
      steamExeTitle: "Steam a mis à jour H1Z1",
      steamExeLead: "Steam a installé un nouveau H1Z1.exe que ROTK ne prend pas en charge. Steam peut télécharger le bon en une minute environ, sans réinstaller le jeu.",
      steamExeSteps: [
        "La console Steam s’est ouverte et la commande ci-dessous est copiée.",
        "Colle-la dans la console (Ctrl+V) puis appuie sur Entrée.",
        "Attends « Depot download complete » : l’installation reprend toute seule.",
      ],
      steamExeOpen: "COPIER ET OUVRIR LA CONSOLE",
      steamExeWaiting: "En attente du téléchargement Steam…",
      retry: "RÉESSAYER",
      keyTitle: "RELIE TON COMPTE ROTK",
      keyLead: "Dernière étape. Ta clé launcher se trouve sur le site : copie-la, puis colle-la ici.",
      keyPlaceholder: "Colle ta clé ici (32 caractères)",
      saveKey: "ENREGISTRER",
      doneTitle: "TOUT EST PRÊT",
      doneLead: "Au premier lancement, le launcher télécharge les fichiers ROTK et vérifie le jeu. Compte quelques minutes, une seule fois.",
      later: "PLUS TARD",
      back: "RETOUR",
      next: "CONTINUER",
      close: "Fermer",
      legal: "Le jeu n’est ni téléchargé ni redistribué par ROTK. La copie provient uniquement de tes fichiers locaux.",
      progressPhases: {
        scanning: "ANALYSE",
        copying: "COPIE",
        verifying: "VÉRIFICATION",
        configuring: "CONFIGURATION",
        finalizing: "FINALISATION",
      },
    },
    settings: {
      title: "RÉGLAGES",
      tabs: { general: "GÉNÉRAL", game: "JEU", updates: "MISES À JOUR", look: "APPARENCE", account: "COMPTE", help: "AIDE" },
      leads: {
        general: "La langue et le comportement du launcher.",
        game: "Où le jeu est installé, et de quoi le réparer.",
        updates: "Ce que le launcher télécharge tout seul.",
        look: "Les polices du launcher et du jeu.",
        account: "Les clés qui relient le launcher à ton compte ROTK.",
        help: "De quoi aider l’équipe à t’aider.",
      },
      language: "Langue",
      languageHint: "Celle du launcher et des actualités.",
      location: "EMPLACEMENT DU JEU",
      notInstalled: "Le jeu n’est pas encore installé.",
      installElsewhere: "INSTALLER AILLEURS",
      installElsewhereHint: "Prépare une autre installation. Celle-ci reste utilisée jusqu’à la fin de la nouvelle.",
      installNow: "INSTALLER LE JEU",
      files: "Fichiers ROTK",
      filesHint: "Contrôle les fichiers ROTK et retélécharge ceux qui manquent ou sont abîmés.",
      verify: "VÉRIFIER ET RÉPARER",
      advanced: "AVANCÉ",
      restore: "Revenir au H1Z1 d’origine",
      restoreHint: "Retire les fichiers ROTK du jeu. Ils seront remis au prochain lancement si la mise à jour automatique est active.",
      launcher: "LAUNCHER",
      version: (version) => `Version ${version}`,
      upToDate: "Le launcher est à jour.",
      checkFailed: "La vérification n’a pas abouti. Vérifie ta connexion, puis réessaie.",
      gameFiles: "FICHIERS DU JEU",
      releaseNotes: "Notes de mise à jour",
      releaseNotesHint: "Ce qui a changé dans chaque version, sur le site.",
      open: "OUVRIR",
      versionInfo: "Infos de version",
      versionInfoHint: "À coller dans ton message quand tu demandes de l’aide.",
      behaviour: "COMPORTEMENT",
      onClose: "Quand je ferme la fenêtre",
      onCloseOptions: { quit: "Quitter", tray: "Rester près de l’horloge" },
      onPlay: "Quand le jeu démarre",
      onPlayOptions: { keep: "Rester ouvert", minimize: "Se réduire", close: "Se fermer" },
      notifications: "Notifications Windows",
      notificationsHint: "Installation terminée, mise à jour du launcher prête.",
      openFolder: "Ouvrir le dossier du jeu",
      diskUse: "Espace utilisé",
      computing: "Calcul…",
      gigabytes: (value) => `${value} Go`,
      repair: "Fichiers H1Z1 d’origine",
      repairHint: "Recopie depuis ton H1Z1 de Steam les fichiers manquants ou de mauvaise taille.",
      repairAdoptedHint: "Ce jeu est une copie de H1Z1 que tu avais déjà, utilisée là où elle est : le launcher n’a pas d’original pour la réparer.",
      uninstallAdoptedHint: "Le launcher cesse d’utiliser ce dossier. Il reste sur le disque : c’est ta propre copie de H1Z1.",
      repairButton: "RÉPARER",
      uninstall: "Désinstaller le jeu",
      uninstallHint: "Supprime le dossier ROTK. Ton H1Z1 de Steam n’est pas touché.",
      uninstallButton: "DÉSINSTALLER",
      uninstallConfirm: {
        title: "DÉSINSTALLER LE JEU ?",
        remove: "Ce dossier sera supprimé. Ton H1Z1 de Steam n’est pas touché, et le launcher garde tes clés de compte et tes réglages.",
        forget: "Ce dossier est ta propre copie de H1Z1 : il reste sur le disque, le launcher cesse seulement de l’utiliser.",
        cancel: "ANNULER",
      },
      speedLimit: "Limite de débit des téléchargements",
      noLimit: "Sans limite",
      megabytesPerSecond: (megabytes) => `${megabytes} Mo/s`,
      report: "Signaler un problème",
      reportHint: "Ouvre la page d’aide du site.",
      logs: "Dossier des journaux",
      logsHint: "Pour envoyer un fichier à l’équipe quand elle le demande.",
      discord: "Discord ROTK",
      discordHint: "L’entraide entre joueurs et les annonces.",
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
      restore: "RESTAURER LE CLIENT VANILLA",
      autoSync: "Mettre à jour les assets personnalisés automatiquement",
    },
    fonts: {
      description: "Choisis la police de l’interface en jeu. Survole une police pour la voir, clique pour la garder.",
      original: "Originale",
      sampleTitle: "APPUIE SUR UNE TOUCHE",
      sampleButtons: "JOUER · ÉQUIPEMENT · RÉGLAGES",
      sampleFeed: "Raven_77 a mis à terre xXSniperXx à l’AR-15 (124 m)",
      sampleText: "Escouade 3 · Victoire royale · Bandage ×5 · Été, Ça, Ñ, Ğ",
      noCyrillic: "Cette police n’a pas de lettres cyrilliques : le texte russe garde une police de secours.",
      nextLaunch: "Appliquée au prochain clic sur Jouer.",
      targetGame: "EN JEU",
      targetLauncher: "LAUNCHER",
      launcherDescription: "Choisis la police de ce launcher. Survole une police pour la voir, clique pour l’appliquer.",
      launcherNow: "Appliquée au launcher dès le clic.",
      sampleLauncherNav: "JOUER · NOUVEAUTÉS · SERVEUR EU",
      sampleLauncherText: "128 joueurs en ligne · Assets à jour · 2.0.48",
    },
  },
  zh: {
    diagnostics: DIAGNOSTICS_COPY.zh,
    language: {
      english: "English",
      french: "Français",
      chinese: "简体中文",
    },
    chrome: {
      home: "首页",
      settings: "设置",
      minimize: "最小化",
      close: "关闭",
    },
    app: {
      initializing: "正在初始化启动器",
      initializingSlow: "启动时间比平时长：启动器正在读取文件，通常是硬盘刚从休眠中唤醒。如果一直没有变化，请关闭启动器后重新打开。",
      initializingFailed: "启动器未能完成启动。请关闭后重新打开；如果再次出现，请把 %APPDATA%\\ROTK Launcher\\startup.log 发给 ROTK 团队。",
      operationFailed: "操作失败。",
      operationInterrupted: "操作已中断",
      notice: "提示",
      closeError: "关闭",
    },
    events: {
      label: "公告与活动",
      message: "公告",
      running: "进行中",
      applications: "报名中",
      soon: "即将开始",
      until: (date) => `截止 ${date}`,
      view: "查看",
      previous: "上一个活动",
      next: "下一个活动",
    },
    news: {
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
      featured: "活动",
      readMore: "了解更多",
      previous: "上一条消息",
      next: "下一条消息",
    },
    footer: {
      play: "开始游戏",
      inGame: "游戏中",
      stopGame: "关闭 H1Z1（游戏窗口已消失或无响应）",
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
      createIndependentInstall: "点击“安装”开始",
      install: "安装",
      environment: "环境",
      addAccountKey: "添加 ROTK 密钥",
      finishingReport: "正在完成上一局的报告",
      adminMode: "管理员",
      selectServer: "选择 ROTK 服务器和启动模式",
      playersInGame: "游戏中",
      playersUnavailable: "—",
      playersUnknown: "玩家人数不可用",
    },
    identity: {
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
      openAccount: (websiteHost) => `打开 ${websiteHost.toLocaleUpperCase("en-US")}`,
      invalid: "请输入正好 32 位十六进制字符（0-9、a-f）。",
      applied: "ROTK 账号密钥已安全保存。",
      removed: "已从此电脑删除 ROTK 账号密钥。",
      copied: "已复制 ROTK 账号密钥。",
      remove: "删除此密钥",
      copy: "复制 ROTK 账号密钥",
      show: "显示 ROTK 账号密钥",
      hide: "隐藏 ROTK 账号密钥",
    },
    update: {
      available: (version) => `启动器更新 ${version} 可用`,
      availableDetail: "更新后即可获得最新的改进和修复。",
      download: "更新",
      autoDownload: "自动下载启动器更新",
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
      manualDownload: "仍然无法更新？请在 rotk.app 下载启动器安装程序，并覆盖安装。",
    },
    install: {
      steps: { language: "语言", h1z1: "H1Z1", location: "安装位置", copy: "安装", key: "账号" },
      languageTitle: "选择语言",
      languageLead: "之后可以在设置中更改。",
      stepOf: (index, total) => `第 ${index} 步，共 ${total} 步`,
      title: "安装 ROTK",
      lead: "ROTK 基于 H1Z1 运行，H1Z1 可在 Steam 免费获取。其余的交给启动器。",
      searching: "正在此电脑上查找 H1Z1…",
      h1z1Found: "已在此电脑上找到 H1Z1",
      h1z1FoundDetail: "由 Steam 安装。ROTK 不会改动它，而是另外复制一份。",
      h1z1Missing: "此电脑上还没有 H1Z1",
      h1z1MissingDetail: "ROTK 需要 H1Z1 的文件才能运行。",
      noGame: "我没有 H1Z1",
      noGameDetail: "在 Steam 上免费，名称为“Z1 Battle Royale”，下载约 20 GB。",
      steamButton: "通过 STEAM 安装",
      steamWaiting: "Steam 已打开。请开始下载 Z1 Battle Royale，下载完成后回到这里，启动器会自动找到它。",
      haveGame: "我已经有 H1Z1",
      haveGameDetail: "指定它所在的文件夹（包含 H1Z1.exe 的那个）。",
      chooseFolder: "选择文件夹",
      otherFolderLink: "使用其他 H1Z1 文件夹",
      directFound: "Steam 之外的 H1Z1 副本",
      directDetail: "此文件夹不依赖 Steam：ROTK 直接使用它，无需复制。",
      locationTitle: "把 ROTK 安装到哪里？",
      locationLead: "启动器会把 H1Z1 复制到单独的文件夹，约 21 GB。Steam 里的 H1Z1 不受影响。",
      recommended: "推荐",
      free: (gigabytes) => `可用 ${gigabytes} GB`,
      otherFolder: "其他文件夹",
      otherFolderDetail: "自行选择",
      changeFolder: "更换文件夹",
      installsIn: "ROTK 将安装到",
      subfolder: "“ROTK”文件夹会自动创建。",
      noDrive: "没有磁盘拥有所需的 30 GB 可用空间。请释放空间，或选择其他磁盘上的文件夹。",
      install: "安装",
      adopt: "使用此文件夹",
      copyTitle: "正在安装",
      phases: {
        scanning: "分析 H1Z1",
        copying: "复制文件",
        verifying: "校验副本",
        configuring: "配置 ROTK",
        finalizing: "收尾",
      },
      starting: "正在开始…",
      gigabytes: (done, total) => `${done} / ${total} GB`,
      remaining: (minutes) => `剩余约 ${minutes} 分钟`,
      remainingSoon: "不到一分钟",
      canLeave: "可以取消或关闭启动器：复制会从中断处继续。",
      cancel: "取消",
      failedTitle: "安装已中断",
      failedKept: "已复制的内容会保留：重试将从中断处继续。",
      steamExeTitle: "Steam 更新了 H1Z1",
      steamExeLead: "Steam 安装了 ROTK 不支持的新版 H1Z1.exe。Steam 可以在大约一分钟内下载正确的版本，无需重新安装游戏。",
      steamExeSteps: [
        "Steam 控制台已打开，下面的命令已复制。",
        "在控制台中粘贴（Ctrl+V）并按回车。",
        "等待出现“Depot download complete”：安装会自动继续。",
      ],
      steamExeOpen: "复制并打开控制台",
      steamExeWaiting: "正在等待 Steam 下载…",
      retry: "重试",
      keyTitle: "绑定你的 ROTK 账号",
      keyLead: "最后一步。启动器密钥在网站上：复制后粘贴到这里。",
      keyPlaceholder: "在此粘贴密钥（32 个字符）",
      saveKey: "保存",
      doneTitle: "一切就绪",
      doneLead: "首次启动时，启动器会下载 ROTK 文件并校验游戏，需要几分钟，仅此一次。",
      later: "稍后",
      back: "返回",
      next: "继续",
      close: "关闭",
      legal: "ROTK 不提供游戏下载，也不分发游戏文件。副本只来自你电脑上已有的游戏。",
      progressPhases: {
        scanning: "正在扫描",
        copying: "正在复制",
        verifying: "正在校验",
        configuring: "正在配置",
        finalizing: "正在完成",
      },
    },
    settings: {
      title: "设置",
      tabs: { general: "常规", game: "游戏", updates: "更新", look: "外观", account: "账号", help: "帮助" },
      leads: {
        general: "启动器的语言和行为。",
        game: "游戏的安装位置，以及修复方式。",
        updates: "启动器会自动下载的内容。",
        look: "启动器和游戏的字体。",
        account: "把启动器与你的 ROTK 账号绑定的密钥。",
        help: "便于团队帮你排查问题。",
      },
      language: "语言",
      languageHint: "用于启动器和新闻。",
      location: "游戏安装位置",
      notInstalled: "游戏尚未安装。",
      installElsewhere: "安装到其他位置",
      installElsewhereHint: "准备另一份安装。新安装完成之前，仍使用当前这份。",
      installNow: "安装游戏",
      files: "ROTK 文件",
      filesHint: "检查 ROTK 文件，并重新下载缺失或损坏的文件。",
      verify: "校验并修复",
      advanced: "高级",
      restore: "恢复原版 H1Z1",
      restoreHint: "从游戏中移除 ROTK 文件。若开启自动更新，下次启动时会重新安装。",
      launcher: "启动器",
      version: (version) => `版本 ${version}`,
      upToDate: "启动器已是最新版本。",
      checkFailed: "检查未完成。请检查网络连接后重试。",
      gameFiles: "游戏文件",
      releaseNotes: "更新说明",
      releaseNotesHint: "每个版本的改动，见网站。",
      open: "打开",
      versionInfo: "版本信息",
      versionInfoHint: "求助时把它粘贴到消息里。",
      behaviour: "行为",
      onClose: "关闭窗口时",
      onCloseOptions: { quit: "退出", tray: "留在托盘" },
      onPlay: "游戏启动时",
      onPlayOptions: { keep: "保持打开", minimize: "最小化", close: "关闭" },
      notifications: "Windows 通知",
      notificationsHint: "安装完成、启动器更新就绪。",
      openFolder: "打开游戏文件夹",
      diskUse: "已用空间",
      computing: "计算中…",
      gigabytes: (value) => `${value} GB`,
      repair: "H1Z1 原版文件",
      repairHint: "从 Steam 里的 H1Z1 重新复制缺失或大小不符的文件。",
      repairAdoptedHint: "这个游戏是你原有的 H1Z1 副本，在原位置直接使用：启动器没有可用来修复它的原版文件。",
      uninstallAdoptedHint: "启动器将不再使用这个文件夹。它会保留在磁盘上：这是你自己的 H1Z1 副本。",
      repairButton: "修复",
      uninstall: "卸载游戏",
      uninstallHint: "删除 ROTK 文件夹，不影响 Steam 里的 H1Z1。",
      uninstallButton: "卸载",
      uninstallConfirm: {
        title: "卸载游戏？",
        remove: "此文件夹将被删除。Steam 里的 H1Z1 不受影响，启动器会保留你的账号密钥和设置。",
        forget: "此文件夹是你自己的 H1Z1 副本：它会保留在磁盘上，启动器只是不再使用它。",
        cancel: "取消",
      },
      speedLimit: "下载限速",
      noLimit: "不限速",
      megabytesPerSecond: (megabytes) => `${megabytes} MB/s`,
      report: "反馈问题",
      reportHint: "打开网站的帮助页面。",
      logs: "日志文件夹",
      logsHint: "团队需要时，用来发送文件。",
      discord: "ROTK Discord",
      discordHint: "玩家互助与公告。",
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
      restore: "恢复原版客户端",
      autoSync: "自动更新 ROTK 定制资源",
    },
    fonts: {
      description: "选择游戏界面的字体。将鼠标悬停在字体上即可预览，点击即可保留。中文文本始终使用游戏自带的中文字体。",
      original: "原版",
      sampleTitle: "PRESS ANY KEY",
      sampleButtons: "PLAY · LOADOUT · SETTINGS",
      sampleFeed: "Raven_77 knocked out xXSniperXx with an AR-15 (124 m)",
      sampleText: "Squad 3 · Victory Royale · Bandage ×5 · Été, Ça, Ñ, Ğ",
      noCyrillic: "此字体不含西里尔字母：俄语文本会使用备用字体。",
      nextLaunch: "下次点击开始游戏时生效。",
      targetGame: "游戏内",
      targetLauncher: "启动器",
      launcherDescription: "选择本启动器的字体。将鼠标悬停在字体上即可预览，点击即可应用。",
      launcherNow: "点击后立即应用到启动器。",
      sampleLauncherNav: "开始游戏 · 新闻 · 欧洲服务器",
      sampleLauncherText: "128 名玩家在线 · 资源已是最新 · 2.0.48",
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
