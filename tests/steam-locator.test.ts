import { join, normalize } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  locateSteamClient,
  parseLibraryFoldersVdf,
  STEAM_GAME_DIRECTORY_CANDIDATES,
  type SteamLocatorDependencies,
} from "../electron/services/steam-locator.js";

const STEAM_ROOT = "C:\\Program Files (x86)\\Steam";

function dependencies(options: {
  registrySteamPath?: string | null;
  existingDirectories?: string[];
  vdfByPath?: Record<string, string>;
  validClients?: string[];
}): SteamLocatorDependencies {
  const existing = new Set(
    (options.existingDirectories ?? []).map((value) => normalize(value).toLocaleLowerCase("en-US")),
  );
  const manifests = new Map(
    Object.entries(options.vdfByPath ?? {}).map(([path, content]) => [
      normalize(path).toLocaleLowerCase("en-US"),
      content,
    ]),
  );
  const valid = new Set(
    (options.validClients ?? []).map((value) => normalize(value).toLocaleLowerCase("en-US")),
  );
  return {
    readRegistrySteamPath: async () => options.registrySteamPath ?? null,
    directoryExists: async (path) => existing.has(normalize(path).toLocaleLowerCase("en-US")),
    readTextFile: async (path) => manifests.get(normalize(path).toLocaleLowerCase("en-US")) ?? null,
    validateCandidate: async (path) => {
      if (valid.has(normalize(path).toLocaleLowerCase("en-US"))) return normalize(path);
      throw new Error(`invalid client: ${path}`);
    },
    programFilesX86: "C:\\Program Files (x86)",
    programFiles: "C:\\Program Files",
  };
}

describe("libraryfolders.vdf parsing", () => {
  it("extracts every library path and unescapes VDF backslashes", () => {
    const content = `"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"
\t\t"label"\t\t""
\t}
\t"1"
\t{
\t\t"path"\t\t"D:\\\\SteamLibrary"
\t\t"apps"
\t\t{
\t\t\t"433850"\t\t"31967004052"
\t\t}
\t}
}`;
    expect(parseLibraryFoldersVdf(content)).toEqual([
      "C:\\Program Files (x86)\\Steam",
      "D:\\SteamLibrary",
    ]);
  });

  it("deduplicates repeated libraries case-insensitively and skips empty paths", () => {
    const content = `
"path"  "D:\\\\SteamLibrary"
"path"  "d:\\\\steamlibrary"
"path"  ""
`;
    expect(parseLibraryFoldersVdf(content)).toEqual(["D:\\SteamLibrary"]);
  });

  it("returns no library for unrelated content", () => {
    expect(parseLibraryFoldersVdf(`"contentstatsid" "123"`)).toEqual([]);
  });
});

describe("Steam client discovery", () => {
  it("finds the H1Z1 client under the registry Steam root", async () => {
    const client = join(STEAM_ROOT, "steamapps", "common", "H1Z1");
    const located = await locateSteamClient(
      dependencies({
        registrySteamPath: "C:/Program Files (x86)/Steam",
        existingDirectories: [STEAM_ROOT],
        validClients: [client],
      }),
    );
    expect(located).toBe(normalize(client));
  });

  it("falls back to the Program Files Steam root when the registry has no entry", async () => {
    const client = join(STEAM_ROOT, "steamapps", "common", "H1Z1");
    const located = await locateSteamClient(
      dependencies({
        registrySteamPath: null,
        existingDirectories: [STEAM_ROOT],
        validClients: [client],
      }),
    );
    expect(located).toBe(normalize(client));
  });

  it("finds a client living in a secondary library on another drive", async () => {
    const client = "D:\\SteamLibrary\\steamapps\\common\\H1Z1";
    const located = await locateSteamClient(
      dependencies({
        registrySteamPath: STEAM_ROOT,
        existingDirectories: [STEAM_ROOT],
        vdfByPath: {
          [join(STEAM_ROOT, "steamapps", "libraryfolders.vdf")]:
            `"path"  "D:\\\\SteamLibrary"`,
        },
        validClients: [client],
      }),
    );
    expect(located).toBe(normalize(client));
  });

  it("tries every historical game directory name", async () => {
    expect(STEAM_GAME_DIRECTORY_CANDIDATES).toContain("H1Z1");
    const client = join(STEAM_ROOT, "steamapps", "common", "Z1 Battle Royale");
    const located = await locateSteamClient(
      dependencies({
        registrySteamPath: STEAM_ROOT,
        existingDirectories: [STEAM_ROOT],
        validClients: [client],
      }),
    );
    expect(located).toBe(normalize(client));
  });

  it("returns null when no Steam root exists", async () => {
    const located = await locateSteamClient(
      dependencies({ registrySteamPath: null, existingDirectories: [] }),
    );
    expect(located).toBeNull();
  });

  it("uses the folder named by the Steam app manifest", async () => {
    const located = await locateSteamClient(
      dependencies({
        registrySteamPath: STEAM_ROOT,
        existingDirectories: [STEAM_ROOT],
        vdfByPath: {
          [join(STEAM_ROOT, "steamapps", "appmanifest_433850.acf")]:
            '"AppState"\n{\n\t"appid"\t\t"433850"\n\t"StateFlags"\t\t"4"\n\t"installdir"\t\t"Z1BR Renamed"\n}',
        },
        validClients: [join(STEAM_ROOT, "steamapps", "common", "Z1BR Renamed")],
      }),
    );
    expect(located).toBe(normalize(join(STEAM_ROOT, "steamapps", "common", "Z1BR Renamed")));
  });

  it("skips a library whose app manifest is not fully installed", async () => {
    const located = await locateSteamClient(
      dependencies({
        registrySteamPath: STEAM_ROOT,
        existingDirectories: [STEAM_ROOT],
        vdfByPath: {
          [join(STEAM_ROOT, "steamapps", "appmanifest_433850.acf")]:
            '"AppState"\n{\n\t"StateFlags"\t\t"1026"\n\t"installdir"\t\t"H1Z1"\n}',
        },
        validClients: [join(STEAM_ROOT, "steamapps", "common", "H1Z1")],
      }),
    );
    expect(located).toBeNull();
  });

  it("ignores a manifest installdir that is not a plain folder name", async () => {
    const located = await locateSteamClient(
      dependencies({
        registrySteamPath: STEAM_ROOT,
        existingDirectories: [STEAM_ROOT],
        vdfByPath: {
          [join(STEAM_ROOT, "steamapps", "appmanifest_433850.acf")]:
            '"AppState"\n{\n\t"StateFlags"\t\t"4"\n\t"installdir"\t\t"..\\Elsewhere"\n}',
        },
        validClients: [join(STEAM_ROOT, "steamapps", "Elsewhere")],
      }),
    );
    expect(located).toBeNull();
  });

  it("returns null when no candidate passes the client validation", async () => {
    const located = await locateSteamClient(
      dependencies({
        registrySteamPath: STEAM_ROOT,
        existingDirectories: [STEAM_ROOT],
        validClients: [],
      }),
    );
    expect(located).toBeNull();
  });

  it("checks each candidate only once when registry and defaults overlap", async () => {
    const deps = dependencies({
      registrySteamPath: "c:/program files (x86)/steam",
      existingDirectories: [STEAM_ROOT],
      validClients: [],
    });
    const validateCandidate = vi.fn(deps.validateCandidate);
    await locateSteamClient({ ...deps, validateCandidate });
    expect(validateCandidate).toHaveBeenCalledTimes(STEAM_GAME_DIRECTORY_CANDIDATES.length);
  });
});
