import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { localizeServiceError } from "../electron/i18n";
import { assertOutsideLauncherFolder } from "../electron/services/path-policy";
import { APP_LOCALES, normalizeAppLocale } from "../shared/locale";

describe("launcher locales", () => {
  it.each(APP_LOCALES)("localizes account diagnostics while preserving technical codes in %s", (locale) => {
    const samples = [
      ["Unable to reach", "ENOTFOUND"],
      ["Unable to reach", "timeout"],
      ["Unable to reach", "ECONNRESET"],
      ["Unable to reach", "CERT_HAS_EXPIRED"],
      ["Unable to reach", "NETWORK_ERROR"],
      ["Invalid response from", "HTTP 502"],
    ];
    for (const [prefix, code] of samples) {
      const raw = `${prefix} the ROTK account service (${code})`;
      const translated = localizeServiceError(raw, locale);
      expect(translated).not.toBe(raw);
      expect(translated.endsWith(`(${code})`)).toBe(true);
      if (locale === "fr") expect(translated).toMatch(/ROTK.*(?:Réessaie|Vérifie)/);
      if (locale === "zh") expect(translated).toContain("请");
    }
    expect(localizeServiceError("Unable to reach the ROTK account service", locale))
      .not.toBe("Unable to reach the ROTK account service");
  });

  it.each(APP_LOCALES)("blames the clock only for certificate dates in %s", (locale) => {
    const clockHint = { en: "date and time", fr: "la date et l’heure", zh: "日期和时间" }[locale];
    const scanningHint = { en: "HTTPS scanning", fr: "l’analyse HTTPS", zh: "HTTPS 扫描" }[locale];
    const localize = (code: string) => localizeServiceError(`Unable to reach the ROTK account service (${code})`, locale);
    for (const code of ["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID"]) {
      expect(localize(code)).toContain(clockHint);
      expect(localize(code)).not.toContain(scanningHint);
      expect(localize(code).endsWith(`(${code})`)).toBe(true);
    }
    for (const code of ["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID"]) {
      expect(localize(code)).toContain(scanningHint);
      expect(localize(code)).not.toContain(clockHint);
      expect(localize(code).endsWith(`(${code})`)).toBe(true);
    }
  });

  it("defaults unknown or missing preferences to English", () => {
    expect(normalizeAppLocale(undefined)).toBe("en");
    expect(normalizeAppLocale("de")).toBe("en");
    expect(normalizeAppLocale("fr")).toBe("fr");
  });

  it("localizes known and parameterized service errors in English", () => {
    expect(localizeServiceError("Le chemin doit être absolu.", "en")).toBe("The path must be absolute.");
    expect(
      localizeServiceError("Client H1Z1 incomplet : H1Z1.exe est introuvable.", "en"),
    ).toBe("Incomplete H1Z1 client: H1Z1.exe could not be found.");
    expect(
      localizeServiceError(
        "La version Vivox 5 attendue est absente du client H1Z1.",
        "en",
      ),
    ).toBe("The required Vivox 5 version is missing from the H1Z1 client.");
    expect(
      localizeServiceError(
        "Le patch crouch ROTK obligatoire n'a pas été activé correctement.",
        "en",
      ),
    ).toBe("The mandatory ROTK crouch patch was not activated correctly.");
    expect(
      localizeServiceError(
        "Le patch sprint ROTK n’a pas pu être supprimé. Ferme H1Z1 puis réessaie.",
        "en",
      ),
    ).toBe("The ROTK sprint patch could not be removed. Close H1Z1 and try again.");
    expect(
      localizeServiceError(
        "Cette version de H1Z1 n’est pas compatible avec le patch sprint ROTK. Vérifie les fichiers du jeu dans Steam puis réessaie.",
        "en",
      ),
    ).toBe("This H1Z1 version is not compatible with the ROTK sprint patch. Verify the game files in Steam and try again.");
    expect(
      localizeServiceError(
        "Le patch sprint ROTK embarqué est absent ou modifié. Ton antivirus l’a peut-être mis en quarantaine : restaure-le depuis Sécurité Windows ou réinstalle le launcher.",
        "en",
      ),
    ).toBe("The bundled ROTK sprint patch is missing or modified. Your antivirus may have quarantined it: restore it from Windows Security or reinstall the launcher.");
    expect(
      localizeServiceError(
        "Le marqueur du patch sprint ROTK n’a pas pu être écrit. Ferme H1Z1 puis réessaie.",
        "en",
      ),
    ).toBe("The ROTK sprint patch marker could not be written. Close H1Z1 and try again.");
    expect(
      localizeServiceError(
        "Un dinput8.dll inconnu est présent dans le client ROTK. Supprime-le ou réimporte un client propre.",
        "en",
      ),
    ).toBe("An unknown dinput8.dll is present in the ROTK client. Remove it or import a clean client again.");
    expect(
      localizeServiceError("Le shim Steam ROTK n'a pas été copié correctement.", "en"),
    ).toBe("The ROTK Steam shim was not copied correctly.");
    expect(
      localizeServiceError(
        "Le shim Steam ROTK embarqué est absent ou modifié. Ton antivirus l’a peut-être mis en quarantaine : restaure-le depuis Sécurité Windows ou réinstalle le launcher.",
        "en",
      ),
    ).toBe("The bundled ROTK Steam shim is missing or modified. Your antivirus may have quarantined it: restore it from Windows Security or reinstall the launcher.");
  });

  it("localizes internal English errors for the French interface", () => {
    expect(localizeServiceError("Invalid ROTK session identity", "fr")).toBe(
      "L’identité de session ROTK est invalide.",
    );
  });

  it("explains the launcher folder rule in English and Chinese", async () => {
    const refused = "Le jeu ne peut pas être placé dans le dossier de ROTK Launcher : chaque mise à jour ou désinstallation du launcher supprime ce dossier. Place le jeu ailleurs, par exemple dans C:\\Games\\ROTK.";
    const deleted = "Le jeu était installé dans le dossier de ROTK Launcher, que chaque mise à jour ou désinstallation du launcher supprime. Si tu l’as déplacé, sélectionne-le à son nouvel emplacement ; sinon, réinstalle-le ailleurs, par exemple dans C:\\Games\\ROTK.";
    expect(() => assertOutsideLauncherFolder("C:\\Program Files\\ROTK Launcher\\ROTK", "C:\\Program Files\\ROTK Launcher"))
      .toThrow(refused);
    expect(await readFile(new URL("../electron/main.ts", import.meta.url), "utf8")).toContain(JSON.stringify(deleted));

    expect(localizeServiceError(refused, "en"))
      .toBe("The game cannot be placed in the ROTK Launcher folder: every launcher update or uninstall deletes that folder. Put the game somewhere else, for example in C:\\Games\\ROTK.");
    expect(localizeServiceError(deleted, "en"))
      .toBe("The game was installed in the ROTK Launcher folder, which every launcher update or uninstall deletes. If you moved it, select it at its new location; otherwise install it again somewhere else, for example in C:\\Games\\ROTK.");
    expect(localizeServiceError(refused, "zh")).toContain("ROTK Launcher 文件夹");
    expect(localizeServiceError(deleted, "zh")).toContain("ROTK Launcher 文件夹");
  });

  it("localizes common install errors in Chinese and falls back to English", () => {
    expect(localizeServiceError("Espace disque insuffisant : 19 Go sont nécessaires.", "zh"))
      .toBe("磁盘空间不足，需要 19 GB。");
    expect(localizeServiceError("H1Z1 est déjà lancé depuis cette installation.", "zh"))
      .toBe("H1Z1 正在运行，请先关闭游戏。");
    expect(localizeServiceError("Trop de redirections pendant le téléchargement des assets.", "zh"))
      .toBe("Too many redirects while downloading assets.");
  });

  it("localizes account service errors for Chinese players", () => {
    expect(localizeServiceError("The ROTK launcher key was rejected", "zh"))
      .toBe("ROTK 启动器密钥无效，请到网站账号页面重新复制。");
    expect(localizeServiceError("This ROTK account is permanently banned. Reason: cheating", "zh"))
      .toBe("此 ROTK 账号已被永久封禁。原因：cheating");
  });

  it("localizes account service errors for French players", () => {
    expect(localizeServiceError(
      "ROTK could not verify your game files: Unable to reach the ROTK integrity service. Check your connection and try again.", "fr",
    )).toBe("ROTK n’a pas pu vérifier tes fichiers de jeu : le service de vérification ROTK est injoignable. Vérifie ta connexion puis réessaie.");
    expect(localizeServiceError(
      "ROTK could not verify your game files: EACCES: permission denied. Check your connection and try again.", "fr",
    )).toBe("ROTK n’a pas pu vérifier tes fichiers de jeu : la vérification n’a pas pu aboutir. Vérifie ta connexion puis réessaie.");
    expect(localizeServiceError("This ROTK account is permanently banned. Reason: cheating", "fr"))
      .toBe("Ce compte ROTK est banni définitivement. Raison : cheating");
  });

  it("localizes the Steam level refusals for French and Chinese players", () => {
    const required = "Steam level 5 or higher is required to play ROTK with this account.";
    const unavailable = "Your Steam level could not be verified. Make sure your Steam profile is public, then try again shortly.";
    expect(localizeServiceError(required, "fr"))
      .toBe("Il faut un niveau Steam 5 ou plus pour jouer à ROTK avec ce compte.");
    expect(localizeServiceError(unavailable, "fr"))
      .toBe("Ton niveau Steam n’a pas pu être vérifié. Vérifie que ton profil Steam est public, puis réessaie dans quelques instants.");
    expect(localizeServiceError(required, "zh"))
      .toBe("使用此账号游玩 ROTK 需要 Steam 等级达到 5 级或以上。");
    expect(localizeServiceError(unavailable, "zh"))
      .toBe("无法验证你的 Steam 等级。请确认你的 Steam 个人资料为公开，然后稍后重试。");
    expect(localizeServiceError(required, "en")).toBe(required);
    expect(localizeServiceError(unavailable, "en")).toBe(unavailable);
  });

  it("localizes the early game exit message in English and Chinese", () => {
    const raw = "H1Z1 s’est fermé 12 s après son lancement (code Windows 0xC0000005). Si tu ne l’as pas fermé toi-même, relance le jeu ; si ça recommence, Debug (dans les réglages) permet d’envoyer un rapport à ROTK.";
    expect(localizeServiceError(raw, "en"))
      .toBe("H1Z1 closed 12 s after it started (Windows code 0xC0000005). If you did not close it yourself, start the game again; if it happens again, Debug (in the settings) lets you send a report to ROTK.");
    expect(localizeServiceError(raw, "zh"))
      .toBe("H1Z1 在启动 12 秒后关闭（Windows 代码 0xC0000005）。如果不是你自己关闭的，请重新启动游戏；如果再次发生，可以通过设置中的“调试”向 ROTK 发送报告。");
  });

  it("localizes the startup game exit message, its unknown code and the App Control hint", () => {
    expect(localizeServiceError("H1Z1 s’est fermé pendant son initialisation (code Windows 0xC0000005).", "zh"))
      .toBe("H1Z1 在初始化时关闭（Windows 代码 0xC0000005）。");
    const unknown = "H1Z1 s’est fermé pendant son initialisation (code Windows inconnu).";
    expect(localizeServiceError(unknown, "en")).toBe("H1Z1 closed during initialization (Windows code unknown).");
    expect(localizeServiceError(unknown, "zh")).toBe("H1Z1 在初始化时关闭（Windows 代码 未知）。");
    const blocked = "H1Z1 s’est fermé pendant son initialisation (code Windows 0xC0E90002). Windows a bloqué un fichier du jeu avec une stratégie App Control : vérifie le Contrôle intelligent des applications dans Sécurité Windows > Contrôle des applications et du navigateur.";
    expect(localizeServiceError(blocked, "en"))
      .toBe("H1Z1 closed during initialization (Windows code 0xC0E90002). Windows blocked a game file with an App Control policy: check Smart App Control in Windows Security > App & browser control.");
    expect(localizeServiceError(blocked, "zh"))
      .toBe("H1Z1 在初始化时关闭（Windows 代码 0xC0E90002）。Windows 的应用控制策略阻止了一个游戏文件：请在“Windows 安全中心 > 应用和浏览器控制”中检查“智能应用控制”。");
  });
});
