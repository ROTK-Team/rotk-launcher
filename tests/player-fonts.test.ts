import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deployPlayerFonts, playerFont, playerFontPreview, type PlayerFontManifest } from "../electron/services/player-fonts.js";

const directories: string[] = [];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "rotk-fonts-test-"));
  directories.push(directory);
  const bundle = join(directory, "bundle");
  const root = join(directory, "game");
  await mkdir(join(bundle, "original"), { recursive: true });
  await mkdir(join(bundle, "inter"), { recursive: true });
  await mkdir(join(root, "UI", "Resource", "Fonts"), { recursive: true });
  const files: Record<string, string> = {
    "original/A.ttf": "stock-a", "original/B.ttf": "stock-b", "inter/400.ttf": "inter-400",
  };
  for (const [path, body] of Object.entries(files)) await writeFile(join(bundle, path), body);
  const manifest: PlayerFontManifest = {
    version: 1,
    slots: ["A.ttf", "B.ttf"],
    fonts: [
      { id: "original", name: "Original", cyrillic: true, capHeight: 0.7, slots: { "A.ttf": "original/A.ttf", "B.ttf": "original/B.ttf" } },
      { id: "inter", name: "Inter", cyrillic: true, capHeight: 0.73, slots: { "A.ttf": "inter/400.ttf", "B.ttf": "inter/400.ttf" } },
    ],
    files: Object.fromEntries(Object.entries(files).map(([path, body]) => [path, sha(body)])),
  };
  await writeFile(join(bundle, "manifest.json"), JSON.stringify(manifest));
  const font = (name: string) => readFile(join(root, "UI", "Resource", "Fonts", name), "utf8");
  return { bundle, root, manifest, font };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("player fonts", () => {
  it("falls back to the stock fonts for an unknown or missing choice", async () => {
    const { manifest } = await fixture();
    expect(playerFont(manifest, "inter").id).toBe("inter");
    expect(playerFont(manifest, "comic").id).toBe("original");
    expect(playerFont(manifest, undefined).id).toBe("original");
  });

  it("serves the preview files of a choice", async () => {
    const { bundle } = await fixture();
    await writeFile(join(bundle, "manifest.json"), JSON.stringify({
      ...JSON.parse(await readFile(join(bundle, "manifest.json"), "utf8")),
      fonts: [{ id: "original", name: "Original", cyrillic: true, capHeight: 0.7, slots: {
        "Oswald-Regular_0.ttf": "original/A.ttf", "Montserrat-SemiBold.ttf": "original/B.ttf", "Roboto-Regular.ttf": "inter/400.ttf",
        "Roboto-Bold.ttf": "original/A.ttf",
      } }],
    }));
    const preview = await playerFontPreview(bundle, "original");
    expect([preview.title, preview.button, preview.body, preview.bold].map((bytes) => Buffer.from(bytes).toString()))
      .toEqual(["stock-a", "stock-b", "inter-400", "stock-a"]);
    expect(preview.capHeight).toBe(0.7);
  });

  it("installs the chosen font and replaces a font dropped by hand", async () => {
    const { bundle, root, font } = await fixture();
    await writeFile(join(root, "UI", "Resource", "Fonts", "A.ttf"), "player-font");
    expect(await deployPlayerFonts(root, bundle, "inter")).toBe("inter");
    expect(await font("A.ttf")).toBe("inter-400");
    expect(await font("B.ttf")).toBe("inter-400");

    expect(await deployPlayerFonts(root, bundle, undefined)).toBe("original");
    expect(await font("A.ttf")).toBe("stock-a");
    expect(await font("B.ttf")).toBe("stock-b");
  });

  it("never blocks the launch on a tampered bundle", async () => {
    const { bundle, root } = await fixture();
    await writeFile(join(bundle, "original", "A.ttf"), "tampered");
    expect(await deployPlayerFonts(root, bundle, "original")).toBeNull();
  });
});
