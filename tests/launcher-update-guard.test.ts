import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

describe("launcher update restart guard", () => {
  it("refuses the manual restart while an asset pass runs", async () => {
    const main = await readFile(root + "electron/main.ts", "utf8");
    const start = main.indexOf("IPC_CHANNELS.installLauncherUpdate,");
    const handler = main.slice(start, main.indexOf("launcherUpdate.install()", start));
    expect(start).toBeGreaterThan(0);
    expect(handler).toContain("if (assetSyncRunning) return { ok: false, error: MAIN_COPY[currentLocale].assets.busy };");
  });

  it("never installs on its own, so the restart always goes through that handler", async () => {
    const service = await readFile(root + "electron/services/launcher-update.ts", "utf8");
    expect(service).toContain("this.updater.autoInstallOnAppQuit = false;");
    expect(service.match(/quitAndInstall\(/g)).toHaveLength(2);
  });
});
