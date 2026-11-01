import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_COPY } from "../electron/i18n.js";
import {
  SANDBOX_FALLBACK_MARKER_NAME,
  cancelsRequestWithoutSandbox,
  offersSandboxFallback,
  readSandboxFallback,
  recordSandboxFallback,
  type SandboxFallbackContext,
} from "../electron/services/sandbox-fallback.js";
import { APP_LOCALES } from "../shared/locale.js";

const faults = vi.hoisted(() => ({
  held: null as { operation: "lstat" | "read"; code: string } | null,
}));
// While set, every lstat or read of a marker fails with the given code, like a
// file an antivirus holds right after it was written.
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const fault = (operation: "lstat" | "read", path: string): NodeJS.ErrnoException | null => {
    if (faults.held?.operation !== operation || !path.endsWith("sandbox-fallback.v1.json")) return null;
    return Object.assign(new Error(`${faults.held.code}: ${operation} '${path}'`), { code: faults.held.code });
  };
  return {
    ...fs,
    lstatSync: ((...args: Parameters<typeof fs.lstatSync>) => {
      const failure = fault("lstat", String(args[0]));
      if (failure) throw failure;
      return fs.lstatSync(...args);
    }) as typeof fs.lstatSync,
    readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
      const failure = fault("read", String(args[0]));
      if (failure) throw failure;
      return fs.readFileSync(...args);
    }) as typeof fs.readFileSync,
  };
});

const PREFIX = join(tmpdir(), "rotk-sandbox-fallback-test-");
let root: string;

beforeEach(async () => {
  root = await mkdtemp(PREFIX);
});

afterEach(async () => {
  faults.held = null;
  if (!resolve(root).startsWith(resolve(PREFIX))) throw new Error("Unsafe test cleanup");
  await rm(root, { recursive: true, force: true });
});

// Issue #151: the elevated launcher's renderer refused at its first start.
const refused = { reason: "launch-failed", exitCode: 18 };
const elevatedStart: SandboxFallbackContext = {
  platform: "win32", administrator: true, fallbackActive: false, windowLoaded: false,
};

describe("sandbox fallback offer", () => {
  it("is offered for a refused sandbox in the elevated launcher before the window ever loaded", () => {
    expect(offersSandboxFallback(refused, elevatedStart)).toBe(true);
  });

  it.each([
    ["on another platform", refused, { platform: "linux" }],
    ["without a verified administrator token", refused, { administrator: false }],
    ["when it already runs without the sandbox", refused, { fallbackActive: true }],
    ["once a window has loaded", refused, { windowLoaded: true }],
    ["for a crashed renderer", { reason: "crashed", exitCode: 18 }, {}],
    ["for an out-of-memory renderer", { reason: "oom", exitCode: 18 }, {}],
    ["for another launch failure code", { reason: "launch-failed", exitCode: 1 }, {}],
    ["for a launch failure without a code", { reason: "launch-failed", exitCode: 0 }, {}],
  ] as const)("is not offered %s", (_case, failure, change) => {
    expect(offersSandboxFallback(failure, { ...elevatedStart, ...change })).toBe(false);
  });
});

describe("sandbox fallback marker", () => {
  const marker = () => join(root, SANDBOX_FALLBACK_MARKER_NAME);

  it("is absent until the player accepts", () => {
    expect(readSandboxFallback(root, "2.0.41")).toBe("absent");
  });

  it("holds for the launcher version that recorded it", async () => {
    recordSandboxFallback(root, "2.0.41", new Date(Date.UTC(2026, 9, 18, 9, 30)));
    expect(JSON.parse(await readFile(marker(), "utf8"))).toEqual({
      launcherVersion: "2.0.41", acceptedAt: "2026-10-18T09:30:00.000Z",
    });
    expect(readSandboxFallback(root, "2.0.41")).toBe("active");
    expect(readSandboxFallback(root, "2.0.41")).toBe("active");
  });

  it("is ignored and removed by any other launcher version", async () => {
    recordSandboxFallback(root, "2.0.41");
    expect(readSandboxFallback(root, "2.0.42")).toBe("outdated");
    expect(await readdir(root)).toEqual([]);
    expect(readSandboxFallback(root, "2.0.41")).toBe("absent");
  });

  it.each([
    ["damaged JSON", "{\"launcherVersion\": \"2.0.4"],
    ["an empty file", ""],
    ["a missing version", "{\"acceptedAt\": \"2026-10-18T09:30:00.000Z\"}"],
    ["a version that is not a string", "{\"launcherVersion\": 2041}"],
    ["an empty version", "{\"launcherVersion\": \"\"}"],
    ["a JSON string", "\"2.0.41\""],
    ["JSON null", "null"],
    ["an oversized file", JSON.stringify({ launcherVersion: "2.0.41", padding: "x".repeat(2048) })],
  ])("ignores and removes %s", async (_case, contents) => {
    await writeFile(marker(), contents);
    expect(readSandboxFallback(root, "2.0.41")).toBe("invalid");
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    ["lstat", "EBUSY"],
    ["lstat", "EPERM"],
    ["lstat", "EACCES"],
    ["read", "EBUSY"],
    ["read", "EPERM"],
    ["read", "EACCES"],
  ] as const)("keeps a marker it cannot %s right now (%s) for the next start", async (operation, code) => {
    recordSandboxFallback(root, "2.0.41");
    faults.held = { operation, code };
    expect(readSandboxFallback(root, "2.0.41")).toBe("absent");
    expect(readSandboxFallback(root, "2.0.42")).toBe("absent");
    faults.held = null;
    expect(await readdir(root)).toEqual([SANDBOX_FALLBACK_MARKER_NAME]);
    expect(readSandboxFallback(root, "2.0.41")).toBe("active");
  });

  it("ignores a directory in place of the marker without failing", async () => {
    await mkdir(marker());
    expect(readSandboxFallback(root, "2.0.41")).toBe("invalid");
  });

  it("is written atomically and replaces an earlier marker", async () => {
    recordSandboxFallback(root, "2.0.40");
    recordSandboxFallback(root, "2.0.41");
    expect(await readdir(root)).toEqual([SANDBOX_FALLBACK_MARKER_NAME]);
    expect(readSandboxFallback(root, "2.0.41")).toBe("active");
  });

  it("creates the user data directory if needed", () => {
    const directory = join(root, "ROTK Launcher");
    recordSandboxFallback(directory, "2.0.41");
    expect(readSandboxFallback(directory, "2.0.41")).toBe("active");
  });

  it("throws when the choice cannot be saved and leaves no temporary file", async () => {
    await mkdir(join(marker(), "occupied"), { recursive: true });
    expect(() => recordSandboxFallback(root, "2.0.41")).toThrow();
    expect(await readdir(root)).toEqual([SANDBOX_FALLBACK_MARKER_NAME]);
  });
});

describe("requests without the sandbox", () => {
  const bundled = pathToFileURL(join(tmpdir(), "ROTK Launcher", "resources", "app.asar", "dist", "index.html")).href;

  it.each([
    "https://rotk.app/media/updates/cover.webp",
    "http://rotk.app/media/updates/cover.webp",
    "https://example.com/tracker.gif",
    "wss://rotk.app/socket",
    "ws://127.0.0.1:9222/devtools",
    "ftp://example.com/file",
    "not a url",
  ])("cancels %s", (url) => {
    expect(cancelsRequestWithoutSandbox(url)).toBe(true);
  });

  it.each([
    bundled,
    "file:///C:/Program%20Files/ROTK%20Launcher/resources/app.asar/dist/assets/index.js",
    "data:image/svg+xml;base64,PHN2Zy8+",
    "blob:file:///6f1c2a4e-1d8c-4bd1-9a7e-0d6c1f3a9b11",
    "devtools://devtools/bundled/devtools_app.html",
  ])("lets the launcher's own content through: %s", (url) => {
    expect(cancelsRequestWithoutSandbox(url)).toBe(false);
  });

  it("lets a development run reach its own Vite server only", () => {
    const devServer = "http://localhost:5173";
    expect(cancelsRequestWithoutSandbox("http://localhost:5173/src/main.tsx", devServer)).toBe(false);
    expect(cancelsRequestWithoutSandbox("ws://localhost:5173/", devServer)).toBe(false);
    expect(cancelsRequestWithoutSandbox("https://rotk.app/media/updates/cover.webp", devServer)).toBe(true);
    expect(cancelsRequestWithoutSandbox("http://localhost:5174/", devServer)).toBe(true);
    expect(cancelsRequestWithoutSandbox("http://localhost:5173/src/main.tsx")).toBe(true);
    expect(cancelsRequestWithoutSandbox("http://localhost:5173/src/main.tsx", "not a url")).toBe(true);
  });
});

describe("sandbox fallback copy", () => {
  it.each(APP_LOCALES)("explains the choice and its limits in %s", (locale) => {
    const copy = MAIN_COPY[locale].sandboxFallback;
    const words = {
      en: { sandbox: "sandbox", version: "this launcher version only", images: "news images" },
      fr: { sandbox: "bac à sable", version: "cette version du launcher", images: "images des actualités" },
      zh: { sandbox: "沙盒", version: "当前版本", images: "图片" },
    }[locale];
    for (const text of [copy.message, copy.detail, copy.restart, copy.quit]) expect(text.trim()).not.toBe("");
    expect(copy.message).toContain(words.sandbox);
    expect(copy.restart).toContain(words.sandbox);
    expect(copy.detail).toContain("#151");
    expect(copy.detail).toContain(words.version);
    expect(copy.detail).toContain(words.images);
    expect(copy.restart).not.toBe(copy.quit);
  });

  it("speaks to the player with tu and curly apostrophes in French", () => {
    const copy = MAIN_COPY.fr.sandboxFallback;
    expect(copy.detail).toMatch(/\bTu peux\b/);
    for (const text of Object.values(copy)) expect(text).not.toContain("'");
    expect(copy.detail).toContain("s’exécute");
  });
});
