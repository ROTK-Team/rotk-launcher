import { describe, expect, it } from "vitest";
import { describeSystemError, isSystemError } from "../electron/services/system-error.js";
import { localizeServiceError } from "../electron/i18n.js";

function systemError(code: string, path?: string, syscall?: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code, path, syscall });
}

describe("describeSystemError", () => {
  const resources = "C:\\Program Files\\ROTK Launcher\\resources";

  it("names the file for locks and points at the antivirus", () => {
    const message = describeSystemError(
      systemError("EPERM", "D:\\Games\\ROTK\\steam_api64.dll", "rename"),
      resources,
    );
    expect(message).toContain("D:\\Games\\ROTK\\steam_api64.dll");
    expect(message).toContain("EPERM, rename");
    expect(message).toContain("antivirus");
    expect(message).toContain("droits");
    expect(localizeServiceError(message, "en")).toMatch(/^Access denied to .+: missing permissions, antivirus/);
  });

  it("reports a missing bundled file as a likely quarantine", () => {
    const message = describeSystemError(
      systemError("ENOENT", `${resources}\\patches\\dinput8.dll`, "open"),
      resources,
    );
    expect(message).toMatch(/quarantaine/);
  });

  it("ignores Node ERR_* codes", () => {
    expect(isSystemError(systemError("ERR_INVALID_ARG_TYPE"))).toBe(false);
    expect(isSystemError(systemError("EAI_AGAIN"))).toBe(true);
  });

  it("keeps a plain code when there is no path", () => {
    expect(describeSystemError(systemError("ECONNRESET"), resources)).toBe("Erreur système (ECONNRESET).");
  });
});
