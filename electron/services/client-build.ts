export interface SupportedClientBuild {
  id: string;
  fileVersion: string;
  executableSize: number;
  executableSha256: string;
}

/** Exact Steam client build currently supported by the ROTK protocol and patch set. */
export const SUPPORTED_CLIENT_BUILDS: readonly SupportedClientBuild[] = [
  {
    id: "h1z1-1.0.326.439939",
    fileVersion: "1.0.326.439939",
    executableSize: 82_158_616,
    executableSha256: "5f5a4922b0671e4ed8fd415e753be096ef7a17e360ae80e025f11544c8db9261",
  },
] as const;

/**
 * Steam depot that still serves the supported H1Z1.exe. Steam replaced the exe
 * on 2026-11-20 (manifest 9048628616520611413); every other file is unchanged,
 * so a player only needs this manifest's H1Z1.exe, fetched by Steam itself.
 */
export const SUPPORTED_STEAM_DEPOT = {
  appId: "433850",
  depotId: "433851",
  manifestId: "1929288548044868931",
} as const;

/**
 * Steam console command that downloads the supported manifest into
 * steamapps\content\app_433850\depot_433851. With the player's installed
 * manifest as delta, Steam only downloads the files that differ (H1Z1.exe).
 */
export function depotDownloadCommand(installedManifestId: string | null): string {
  const { appId, depotId, manifestId } = SUPPORTED_STEAM_DEPOT;
  const delta = installedManifestId && /^\d+$/.test(installedManifestId) && installedManifestId !== manifestId
    ? ` ${installedManifestId}`
    : "";
  return `download_depot ${appId} ${depotId} ${manifestId}${delta}`;
}

export class UnsupportedClientBuildError extends Error {
  constructor(readonly command: string) {
    super(
      `Steam a installé une version de H1Z1 que ROTK ne prend pas encore en charge. Ouvre la console Steam (steam://open/console), colles-y la commande en fin de message, appuie sur Entrée, attends « Depot download complete » puis relance. Commande : ${command}`,
    );
    this.name = "UnsupportedClientBuildError";
  }
}

export function findSupportedBuild(executableSize: number, executableSha256: string): SupportedClientBuild | undefined {
  return SUPPORTED_CLIENT_BUILDS.find(
    (build) =>
      build.executableSize === executableSize &&
      build.executableSha256 === executableSha256.toLocaleLowerCase("en-US"),
  );
}

export function identifyClientBuild(executableSize: number, executableSha256: string): SupportedClientBuild {
  const match = findSupportedBuild(executableSize, executableSha256);
  if (!match) throw new UnsupportedClientBuildError(depotDownloadCommand(null));
  return match;
}
