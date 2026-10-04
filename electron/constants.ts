import { join } from "node:path";
import { app } from "electron";

export const APP_NAME = "ROTK Launcher";
export const WEBSITE_ORIGIN = "https://rotk.app";
export const WEBSITE_UPDATES_PATH = "/updates";
export const FORBIDDEN_INSTALL_SEGMENTS = new Set([
  "steam",
  "steamlibrary",
  "steamapps",
  "common",
]);

export const CRITICAL_CLIENT_FILES = [
  "H1Z1.exe",
  "ClientConfig.ini",
  "steam_api64.dll",
] as const;

export const ROTK_INSTALL_DIRECTORY_NAME = "ROTK";
export const RECOMMENDED_INSTALL_PARENT_NAME = "Games";
export const INSTALL_MARKER_NAME = ".rotk-installation.json";

export function resolveBundledDiagnosticsPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "diagnostics", "ROTK.Diagnostics.exe")
    : join(app.getAppPath(), "resources", "diagnostics", "ROTK.Diagnostics.exe");
}

export function resolveBundledShimPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "patches", "steam_api64.dll")
    : join(app.getAppPath(), "resources", "patches", "steam_api64.dll");
}

export function resolveBundledVivoxProxyPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "patches", "vivoxsdk_x64.dll")
    : join(app.getAppPath(), "resources", "patches", "vivoxsdk_x64.dll");
}

export function resolveBundledVivoxRuntimePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "patches", "vivoxsdk_x64_v5.dll")
    : join(app.getAppPath(), "resources", "patches", "vivoxsdk_x64_v5.dll");
}

export function resolveBundledGameplayPatchPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "patches", "dinput8.dll")
    : join(app.getAppPath(), "resources", "patches", "dinput8.dll");
}
