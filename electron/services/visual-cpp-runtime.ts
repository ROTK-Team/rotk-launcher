import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { windowsSystemRoot } from "./windows-tools.js";

/** Major, minor, build and revision, as Windows shows a file version. */
export type FileVersion = readonly [number, number, number, number];

/**
 * Oldest Visual C++ runtime accepted for the bundled rotkc.dll. Visual C++
 * 14.40 (Visual Studio 2022 17.10, first released as 14.40.33810) changed
 * std::mutex: code built that way can crash inside an older msvcp140.dll,
 * which matches issue #171 (0xC0000005 in MSVCP140.dll 14.36). The STL
 * changelog documents no other break of this kind; Microsoft's general rule
 * asks for a runtime at least as new as the toolset. The three files ship
 * together in the Redistributable, so one minimum covers them. Check it again
 * whenever rotkc.dll is rebuilt.
 */
export const VISUAL_CPP_RUNTIME_MINIMUM: FileVersion = [14, 40, 33810, 0];

/** Microsoft's permalink to the latest x64 Visual C++ Redistributable. */
export const VISUAL_CPP_RUNTIME_DOWNLOAD_URL = "https://aka.ms/vc14/vc_redist.x64.exe";

// The voice proxy loads rotkc.dll from the game folder by full path and has
// Windows look for these imports in that folder, then in System32 (none of them
// is a KnownDLL). The check stops there too: the Redistributable installs them
// in System32, and a copy found only further down the old search order, in a
// PATH folder for example, is not counted. The proxy falls back to that order
// only when the strict load cannot find an import, and logs that it did.
// The launcher is a 64-bit process: its System32 is the folder H1Z1 uses too.
const VISUAL_CPP_RUNTIME_FILES = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"] as const;

const VERSION_INFO_KEY = Buffer.from("VS_VERSION_INFO\0", "utf16le");
// VS_VERSIONINFO opens with wLength, wValueLength and wType, then its key, and
// pads the key to 32 bits before its value, a VS_FIXEDFILEINFO.
const VERSION_INFO_KEY_OFFSET = 6;
const FIXED_FILE_INFO_OFFSET = 40;
const FIXED_FILE_INFO_SIZE = 52;
const FIXED_FILE_INFO_SIGNATURE = 0xfeef04bd;
// e_lfanew points to the PE signature, which IMAGE_FILE_HEADER.Machine follows.
const PE_HEADER_POINTER_OFFSET = 0x3c;
const PE_SIGNATURE = 0x00004550;
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;

interface RuntimeFile {
  path: string;
  /** Null when the file or its version cannot be read: it is then not judged. */
  version: FileVersion | null;
  inGameFolder: boolean;
}

/**
 * The file version of a PE image, read from the VS_FIXEDFILEINFO of its
 * VS_VERSIONINFO resource without loading the image.
 */
export function readFileVersion(image: Buffer): FileVersion | null {
  for (let key = image.indexOf(VERSION_INFO_KEY); key !== -1; key = image.indexOf(VERSION_INFO_KEY, key + 1)) {
    const start = key - VERSION_INFO_KEY_OFFSET;
    const fixed = start + FIXED_FILE_INFO_OFFSET;
    // dwSignature and dwStrucVersion come before dwFileVersionMS and dwFileVersionLS.
    if (start < 0 || fixed + 16 > image.length) continue;
    if (image.readUInt16LE(start + 2) !== FIXED_FILE_INFO_SIZE) continue;
    if (image.readUInt32LE(fixed) !== FIXED_FILE_INFO_SIGNATURE) continue;
    const high = image.readUInt32LE(fixed + 8);
    const low = image.readUInt32LE(fixed + 12);
    return [high >>> 16, high & 0xffff, low >>> 16, low & 0xffff];
  }
  return null;
}

function olderThan(version: FileVersion, minimum: FileVersion): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index] !== minimum[index]) return version[index] < minimum[index];
  }
  return false;
}

function x64Image(image: Buffer): boolean {
  if (image.length < PE_HEADER_POINTER_OFFSET + 4) return false;
  const header = image.readUInt32LE(PE_HEADER_POINTER_OFFSET);
  return header + 6 <= image.length
    && image.readUInt32LE(header) === PE_SIGNATURE
    && image.readUInt16LE(header + 4) === IMAGE_FILE_MACHINE_AMD64;
}

async function runtimeFile(root: string, system32: string, name: string): Promise<RuntimeFile | null> {
  for (const directory of [root, system32]) {
    const path = join(directory, name);
    const inGameFolder = directory === root;
    let image: Buffer;
    try {
      image = await readFile(path);
    } catch (error) {
      // Only a missing copy moves the search on; one that cannot be read is not judged.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { path, version: null, inGameFolder };
    }
    // Windows passes over a game-folder copy that is not a 64-bit image, as
    // H1Z1 cannot load it. System32 is left as it is: ARM64 Windows keeps
    // hybrid images there.
    if (inGameFolder && !x64Image(image)) continue;
    return { path, version: readFileVersion(image), inGameFolder };
  }
  return null;
}

function runtimeProblem(name: string, file: RuntimeFile | null): string | null {
  if (!file) {
    return `Le runtime Microsoft Visual C++ x64 nécessaire à ROTK est absent de ce PC (${name} introuvable). `
      + `Installe-le depuis ${VISUAL_CPP_RUNTIME_DOWNLOAD_URL} puis réessaie.`;
  }
  if (!file.version || !olderThan(file.version, VISUAL_CPP_RUNTIME_MINIMUM)) return null;
  const versions = `${file.version.join(".")}, minimum ${VISUAL_CPP_RUNTIME_MINIMUM.join(".")}`;
  if (file.inGameFolder) {
    return `Le dossier du jeu contient une ancienne copie de ${name} (${versions}) : H1Z1 se fermerait au démarrage. `
      + `Supprime ${file.path} puis réessaie.`;
  }
  return `Le runtime Microsoft Visual C++ x64 de ce PC est trop ancien (${name} ${versions}) : H1Z1 se fermerait au démarrage. `
    + `Installe la dernière version depuis ${VISUAL_CPP_RUNTIME_DOWNLOAD_URL} puis réessaie.`;
}

/** Refuse a launch that would start H1Z1 on a Visual C++ runtime rotkc.dll cannot use. */
export async function assertVisualCppRuntime(root: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const system32 = join(windowsSystemRoot(env), "System32");
  for (const name of VISUAL_CPP_RUNTIME_FILES) {
    const problem = runtimeProblem(name, await runtimeFile(root, system32, name));
    if (problem) throw new Error(problem);
  }
}
