import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const count = (value: string, needle: string): number =>
  value.split(needle).length - 1;
const main = () => readFile(root + "electron/main.ts", "utf8");

function body(source: string, start: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  return source.slice(from, source.indexOf("\n}\n", from));
}

describe("sandbox fallback wiring", () => {
  it("turns the sandbox off before ready, from this version's marker in the resolved user data", async () => {
    const source = await main();
    const appended = source.indexOf('app.commandLine.appendSwitch("no-sandbox");');
    expect(count(source, '"no-sandbox"')).toBe(1);
    expect(appended).toBeGreaterThan(source.lastIndexOf('app.setPath("userData"'));
    // Top level, before any function and before the window or ready.
    expect(appended).toBeLessThan(source.indexOf("\nfunction "));
    expect(appended).toBeLessThan(source.indexOf("new BrowserWindow("));
    expect(appended).toBeLessThan(source.indexOf(".whenReady()"));
    expect(source).toContain('singleInstanceLock && process.platform === "win32"\n  ? readSandboxFallback(app.getPath("userData"), app.getVersion())');
    expect(source).toContain('startupLog.mark("sandbox-fallback-active", app.getVersion());');
  });

  it("saves the choice before restarting with the same arguments", async () => {
    const offer = body(await main(), "function askRestartWithoutSandbox(): boolean {");
    const recorded = offer.indexOf('recordSandboxFallback(app.getPath("userData"), app.getVersion());');
    const unsaved = offer.indexOf("return false;");
    const relaunched = offer.indexOf("app.relaunch();");
    expect(recorded).toBeGreaterThan(offer.indexOf("dialog.showMessageBoxSync("));
    expect(recorded).toBeLessThan(unsaved);
    expect(unsaved).toBeLessThan(relaunched);
    expect(relaunched).toBeLessThan(offer.indexOf("app.exit(0);"));
    // Quit is the default and the answer to Escape or closing the box.
    expect(offer).toContain("buttons: [copy.sandboxFallback.restart, copy.sandboxFallback.quit]");
    expect(offer).toContain("defaultId: 1,");
    expect(offer).toContain("cancelId: 1,");
    expect(count(await main(), "app.relaunch(")).toBe(1);
  });

  it("offers it only for a window that never loaded in the elevated launcher, and never twice", async () => {
    const source = await main();
    const handler = body(source, 'window.webContents.on("render-process-gone"');
    const offered = handler.indexOf("offersSandboxFallback(details, {");
    expect(offered).toBeGreaterThan(handler.indexOf('if (details.reason === "clean-exit" || rendererFailureReported) return;'));
    expect(offered).toBeLessThan(handler.indexOf("rendererFailureReported = true;"));
    expect(handler).toContain("administrator: runsAsAdministrator,");
    expect(handler).toContain("fallbackActive: sandboxFallbackActive,");
    expect(handler).toContain("windowLoaded,");
    expect(handler).toContain("&& askRestartWithoutSandbox()) {");
    expect(source).toContain('window.webContents.once("did-finish-load", () => { windowLoaded = true; });');
    expect(source).toContain("isAdministrator: async () => (runsAsAdministrator = await elevation.isAdministrator()),");
  });

  it("cancels the window's remote requests before it is created while the sandbox is off", async () => {
    const source = await main();
    const start = body(source, "initialize: async () => {");
    const guarded = start.indexOf("if (sandboxFallbackActive) {");
    const filter = start.indexOf("session.defaultSession.webRequest.onBeforeRequest(");
    expect(guarded).toBeGreaterThan(0);
    expect(filter).toBeGreaterThan(guarded);
    expect(filter).toBeLessThan(start.indexOf("await initialize();"));
    expect(start).toContain("callback({ cancel: cancelsRequestWithoutSandbox(details.url, devServer) });");
    expect(start).toContain("const devServer = app.isPackaged ? null : process.env.VITE_DEV_SERVER_URL ?? null;");
  });

  it("leaves the administrator restart's fixed command alone", async () => {
    const elevation = await readFile(root + "electron/services/startup-elevation.ts", "utf8");
    expect(elevation).not.toContain("sandbox");
    expect(elevation).toContain('run(helperPath, "--elevate-launcher", 120_000)');
  });
});
