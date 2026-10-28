import type { PlayerFontPreview } from "../shared/contracts";

/** CSS family names of a choice's fonts: game preview roles, and the launcher's titles and text. */
export type PreviewFamilies = { title: string; button: string; body: string; launcherDisplay: string; launcherText: string };

/**
 * Metrics of the launcher's own fonts, in em: capital height, and the ascent and
 * descent Chromium actually lays them out with (Eurostile: its OS/2 win values,
 * 108 px line at 100 px; Inter: 121 px). A picked font is scaled to the same
 * capital height and given the same line box, so a tall face such as Rock Salt
 * cannot push the layout around.
 */
const LAUNCHER_METRICS = {
  display: { cap: 0.6665, ascent: 0.866, descent: 0.209 }, // Eurostile
  text: { cap: 0.7275, ascent: 0.9688, descent: 0.2412 }, // Inter
} as const;

// The renderer never fetches the font files (CSP font-src 'self'): the main
// process hands their bytes over and FontFace registers them in memory.
const loaded = new Map<string, Promise<PreviewFamilies>>();

async function addFace(family: string, bytes: Uint8Array, descriptors: FontFaceDescriptors): Promise<void> {
  document.fonts.add(await new FontFace(family, new Uint8Array(bytes), descriptors).load());
}

/** Weights 400 and 700 (no synthesis in the launcher), sized and spaced like `reference`. */
async function addLauncherFamily(family: string, preview: PlayerFontPreview, reference: { cap: number; ascent: number; descent: number }) {
  const scale = reference.cap / preview.capHeight;
  // Overrides are scaled by size-adjust too: divide so the line box lands on the reference.
  const metrics = {
    sizeAdjust: `${(scale * 100).toFixed(2)}%`,
    ascentOverride: `${((reference.ascent / scale) * 100).toFixed(2)}%`,
    descentOverride: `${((reference.descent / scale) * 100).toFixed(2)}%`,
    lineGapOverride: "0%",
  };
  await Promise.all([
    addFace(family, preview.body, { ...metrics, weight: "100 500" }),
    addFace(family, preview.bold, { ...metrics, weight: "600 900" }),
  ]);
}

export function loadPlayerFont(id: string): Promise<PreviewFamilies> {
  let families = loaded.get(id);
  if (!families) {
    families = window.rotk.getPlayerFontPreview(id).then(async (result) => {
      if (!result.ok || !result.value) throw new Error(result.error ?? "font preview unavailable");
      const preview: PlayerFontPreview = result.value;
      const names = {
        title: `rotk-${id}-title`, button: `rotk-${id}-button`, body: `rotk-${id}-body`,
        launcherDisplay: `rotk-${id}-launcher-display`, launcherText: `rotk-${id}-launcher-text`,
      };
      await Promise.all([
        addFace(names.title, preview.title, { weight: "400" }),
        addFace(names.button, preview.button, { weight: "400" }),
        addFace(names.body, preview.body, { weight: "400" }),
        addLauncherFamily(names.launcherDisplay, preview, LAUNCHER_METRICS.display),
        addLauncherFamily(names.launcherText, preview, LAUNCHER_METRICS.text),
      ]);
      return names;
    });
    families.catch(() => loaded.delete(id));
    loaded.set(id, families);
  }
  return families;
}

let wanted = "original";

/** Draws the whole launcher in a font choice; "original" restores Eurostile/Inter. */
export function applyLauncherFont(id: string): void {
  wanted = id;
  const root = document.documentElement.style;
  if (id === "original") {
    root.removeProperty("--display");
    root.removeProperty("font-family");
    return;
  }
  loadPlayerFont(id).then((families) => {
    if (wanted !== id) return;
    const cjk = `"Microsoft YaHei", "PingFang SC", sans-serif`;
    root.setProperty("--display", `"${families.launcherDisplay}", ${cjk}`);
    root.setProperty("font-family", `"${families.launcherText}", ${cjk}`);
  }).catch(() => undefined);
}
