import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  type LauncherSnapshot,
  type RotkLauncherApi,
} from "../shared/contracts.js";

const api: RotkLauncherApi = {
  setDebugSessionEnabled: (enabled) => ipcRenderer.invoke(IPC_CHANNELS.setDebugSessionEnabled, enabled),
  getDiagnosticReports: () => ipcRenderer.invoke(IPC_CHANNELS.getDiagnosticReports),
  reportCrash: () => ipcRenderer.invoke(IPC_CHANNELS.reportCrash),
  captureDiagnostic: (request) => ipcRenderer.invoke(IPC_CHANNELS.captureDiagnostic, request),
  exportDiagnostic: (request) => ipcRenderer.invoke(IPC_CHANNELS.exportDiagnostic, request),
  openDiagnosticsFolder: () => ipcRenderer.invoke(IPC_CHANNELS.openDiagnosticsFolder),
  setDiagnosticCaptureEnabled: (enabled) => ipcRenderer.invoke(IPC_CHANNELS.setDiagnosticCaptureEnabled, enabled),
  onDiagnosticsChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: import("../shared/diagnostics.js").DiagnosticState): void => listener(state);
    ipcRenderer.on(IPC_CHANNELS.diagnosticsChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.diagnosticsChanged, wrapped);
  },
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getSnapshot),
  setLocale: (locale) => ipcRenderer.invoke(IPC_CHANNELS.setLocale, locale),
  setLaunchProfile: (serverId, role) => ipcRenderer.invoke(IPC_CHANNELS.setLaunchProfile, serverId, role),
  setPlayerKey: (profile, playerKey) => ipcRenderer.invoke(IPC_CHANNELS.setPlayerKey, profile, playerKey),
  clearPlayerKey: (profile) => ipcRenderer.invoke(IPC_CHANNELS.clearPlayerKey, profile),
  copyPlayerKey: (profile) => ipcRenderer.invoke(IPC_CHANNELS.copyPlayerKey, profile),
  detectSource: () => ipcRenderer.invoke(IPC_CHANNELS.detectSource),
  selectSource: () => ipcRenderer.invoke(IPC_CHANNELS.selectSource),
  selectDestination: () => ipcRenderer.invoke(IPC_CHANNELS.selectDestination),
  listInstallDrives: () => ipcRenderer.invoke(IPC_CHANNELS.listInstallDrives),
  chooseInstallDrive: (root) => ipcRenderer.invoke(IPC_CHANNELS.chooseInstallDrive, root),
  dismissError: () => ipcRenderer.invoke(IPC_CHANNELS.dismissError),
  install: () => ipcRenderer.invoke(IPC_CHANNELS.install),
  cancelInstall: () => ipcRenderer.invoke(IPC_CHANNELS.cancelInstall),
  play: () => ipcRenderer.invoke(IPC_CHANNELS.play),
  openWebsite: (path, serverId) => ipcRenderer.invoke(IPC_CHANNELS.openWebsite, path, serverId),
  checkLauncherUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.checkLauncherUpdate),
  downloadLauncherUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.downloadLauncherUpdate),
  installLauncherUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.installLauncherUpdate),
  verifyAssets: () => ipcRenderer.invoke(IPC_CHANNELS.verifyAssets),
  restoreVanillaAssets: () => ipcRenderer.invoke(IPC_CHANNELS.restoreVanillaAssets),
  setAssetSyncEnabled: (enabled) => ipcRenderer.invoke(IPC_CHANNELS.setAssetSyncEnabled, enabled),
  minimizeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.minimizeWindow),
  closeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.closeWindow),
  onSnapshot: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: LauncherSnapshot): void => {
      listener(snapshot);
    };
    ipcRenderer.on(IPC_CHANNELS.snapshotChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.snapshotChanged, wrapped);
  },
};

contextBridge.exposeInMainWorld("rotk", Object.freeze(api));
