import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlayerFontOption, PlayerFontPreview } from "../../shared/contracts.js";
import { atomicCopyFile } from "./fs-safe.js";

/**
 * The interface font a player picks in the launcher. H1Z1 reads its Latin
 * interface fonts by file name from UI/Resource/Fonts only when it starts, so
 * the launcher puts the chosen files there before every launch.
 *
 * resources/fonts/manifest.json is the allow-list (scripts/build-player-fonts.py):
 * every managed file is rewritten to the stock font or the chosen one, so a
 * font a player dropped there by hand is replaced at the next launch.
 */
export const PLAYER_FONT_DIRECTORY = "UI/Resource/Fonts";
export const DEFAULT_PLAYER_FONT = "original";

export interface PlayerFontManifest {
  version: 1;
  slots: string[];
  fonts: (PlayerFontOption & { capHeight: number; slots: Record<string, string> })[];
  files: Record<string, string>;
}

/** Managed file whose font each preview line uses: titles, buttons, text. */
const PREVIEW_SLOTS = {
  title: "Oswald-Regular_0.ttf", button: "Montserrat-SemiBold.ttf", body: "Roboto-Regular.ttf", bold: "Roboto-Bold.ttf",
} as const;

async function fileHash(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  } catch {
    return "";
  }
  return hash.digest("hex");
}

export async function readPlayerFontManifest(bundledFontsPath: string): Promise<PlayerFontManifest> {
  return JSON.parse(await readFile(join(bundledFontsPath, "manifest.json"), "utf8")) as PlayerFontManifest;
}

/** Unknown or missing ids mean the stock fonts. */
export function playerFont(manifest: PlayerFontManifest, id: string | undefined): PlayerFontManifest["fonts"][number] {
  return manifest.fonts.find((font) => font.id === id) ?? manifest.fonts.find((font) => font.id === DEFAULT_PLAYER_FONT)!;
}

export async function playerFontPreview(bundledFontsPath: string, id: string): Promise<PlayerFontPreview> {
  const font = playerFont(await readPlayerFontManifest(bundledFontsPath), id);
  const read = (slot: string) => readFile(join(bundledFontsPath, font.slots[slot]));
  const [title, button, body, bold] = await Promise.all(
    [PREVIEW_SLOTS.title, PREVIEW_SLOTS.button, PREVIEW_SLOTS.body, PREVIEW_SLOTS.bold].map(read),
  );
  return { id: font.id, title, button, body, bold, capHeight: font.capHeight };
}

/**
 * Brings the managed font files to the player's choice. Cosmetic and best
 * effort: a missing bundle or a locked file never blocks Play, it only leaves
 * the fonts as they were. Matching files are left untouched (mtime, hash cache).
 */
export async function deployPlayerFonts(root: string, bundledFontsPath: string, id: string | undefined): Promise<string | null> {
  try {
    const manifest = await readPlayerFontManifest(bundledFontsPath);
    const font = playerFont(manifest, id);
    for (const slot of manifest.slots) {
      const source = join(bundledFontsPath, font.slots[slot]);
      const expected = manifest.files[font.slots[slot]];
      if (await fileHash(source) !== expected) throw new Error(`bundled font ${font.slots[slot]} is missing or modified`);
      const target = join(root, PLAYER_FONT_DIRECTORY, slot);
      if (await fileHash(target) === expected) continue;
      await atomicCopyFile(source, target);
    }
    return font.id;
  } catch (error) {
    console.warn("Player fonts were not applied; launching anyway.", error);
    return null;
  }
}
