import { describe, expect, it } from "vitest";
import { localizeServiceError } from "../electron/i18n";
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
  });

  it("localizes internal English errors for the French interface", () => {
    expect(localizeServiceError("Invalid ROTK session identity", "fr")).toBe(
      "L’identité de session ROTK est invalide.",
    );
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
});
