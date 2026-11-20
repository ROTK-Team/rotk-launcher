import { describe, expect, it } from "vitest";
import { CHINESE_ERRORS, ENGLISH_ERRORS, localizeServiceError } from "../electron/i18n";

describe("French messages that used to stay untranslated (#174)", () => {
  it("has a Chinese entry for every exact message that has an English one", () => {
    for (const french of ENGLISH_ERRORS.keys()) {
      expect(CHINESE_ERRORS.has(french) || localizeServiceError(french, "zh") !== localizeServiceError(french, "en"), french).toBe(true);
    }
  });

  it("translates the dynamic messages that had no Chinese entry and keeps their values", () => {
    const samples: Array<[string, string, string]> = [
      ["Espace disque insuffisant pour les assets : 3,5 Go sont nécessaires.", "Not enough disk space for the assets: 3,5 GB is required.", "资源所需的磁盘空间不足，需要 3,5 GB。"],
      ["Erreur système (ECONNRESET, read).", "System error (ECONNRESET, read).", "系统错误（ECONNRESET, read）。"],
      ["Erreur système (EBUSY) : resource busy.", "System error (EBUSY): resource busy.", "系统错误（EBUSY）：resource busy。"],
      ["Fichier introuvable : C:\Games\ROTK\a.dll.", "File not found: C:\Games\ROTK\a.dll.", "找不到文件：C:\Games\ROTK\a.dll。"],
      ["Disque plein pendant l’écriture de a.pak. Libère de l’espace puis réessaie.", "Disk full while writing a.pak. Free some space and try again.", "写入 a.pak 时磁盘已满。请释放空间后重试。"],
      ["Le téléchargement de l’asset ui-1 s’est interrompu.", "The download of the ui-1 asset was interrupted.", "资源 ui-1 的下载已中断。"],
      ["L’asset ui-1 est corrompu (empreinte SHA-256 inattendue).", "The ui-1 asset is corrupted (unexpected SHA-256 fingerprint).", "资源 ui-1 已损坏（SHA-256 校验值不符）。"],
      ["Hôte de téléchargement d’assets non autorisé : example.com.", "Asset download host not allowed: example.com.", "不允许的资源下载主机：example.com。"],
      ["Manifeste du jeu de base invalide : version absente.", "Invalid base game manifest: version absente.", "基础游戏清单无效：version absente。"],
      ["Erreur launcher ab12 : boom", "Launcher error ab12: boom", "启动器错误 ab12：boom"],
    ];
    for (const [french, english, chinese] of samples) {
      expect(localizeServiceError(french, "en")).toBe(english);
      expect(localizeServiceError(french, "zh")).toBe(chinese);
    }
  });

  it("translates the game start refusal and keeps the Windows detail", () => {
    const raw = "Windows n’a pas pu initialiser H1Z1 : spawn UNKNOWN";
    expect(localizeServiceError(raw, "en")).toBe("Windows could not start H1Z1: spawn UNKNOWN");
    expect(localizeServiceError(raw, "zh")).toBe("Windows 无法启动 H1Z1：spawn UNKNOWN");
    expect(localizeServiceError(raw, "fr")).toBe(raw);
  });

  it("translates the French system tail of a wrapped error", () => {
    expect(localizeServiceError("terminated Erreur système (ECONNRESET, read).", "en"))
      .toBe("terminated System error (ECONNRESET, read).");
    expect(localizeServiceError("fetch failed Erreur système (ENOTFOUND, getaddrinfo).", "zh"))
      .toBe("fetch failed 系统错误（ENOTFOUND, getaddrinfo）。");
    expect(localizeServiceError("something unknown entirely", "en")).toBe("something unknown entirely");
  });

  it("translates a French reason inside the game file check message", () => {
    const raw = "ROTK could not verify your game files: Un dinput8.dll inconnu est présent dans le client ROTK. Supprime-le ou réimporte un client propre. Check your connection and try again.";
    expect(localizeServiceError(raw, "en"))
      .toBe("ROTK could not verify your game files: An unknown dinput8.dll is present in the ROTK client. Remove it or import a clean client again. Check your connection and try again.");
    expect(localizeServiceError(raw, "zh"))
      .toBe("ROTK 无法验证你的游戏文件：ROTK 客户端中存在未知的 dinput8.dll。请删除它，或重新导入干净的客户端。 请检查网络后重试。");
  });
});
