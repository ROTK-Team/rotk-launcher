import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkInstallation } from "../electron/services/integrity-attestation";

let workspace: string;
let root: string;

async function writeGameFile(relativePath: string, content = "bytes") {
  const absolute = join(root, ...relativePath.split("/"));
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

async function walk(maxEntries?: number) {
  const seen: string[] = [];
  await walkInstallation(root, (path) => { seen.push(path); }, maxEntries);
  return seen.sort();
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "rotk-install-walk-"));
  root = join(workspace, "game");
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("walkInstallation", () => {
  it("reads a folder reached twice once, under its real path, and ends a link loop", async () => {
    await writeGameFile("Resources/Assets/a.pack2");
    await writeGameFile("H1Z1.exe");
    // Sorts before the real folder it points to, and a loop back to the root.
    await symlink(join(root, "Resources"), join(root, "AAA-link"), "junction");
    await symlink(root, join(root, "loop"), "junction");

    expect(await walk()).toEqual(["H1Z1.exe", "Resources/Assets/a.pack2"]);
  });

  it("looks through a junction to a folder outside the installation", async () => {
    await mkdir(join(workspace, "elsewhere"), { recursive: true });
    await writeFile(join(workspace, "elsewhere", "extra.dll"), "bytes", "utf8");
    await symlink(join(workspace, "elsewhere"), join(root, "plugins"), "junction");

    expect(await walk()).toEqual(["plugins/extra.dll"]);
  });

  it("treats a folder link named like a file as a folder, and skips a broken link", async () => {
    await mkdir(join(workspace, "elsewhere"), { recursive: true });
    await writeFile(join(workspace, "elsewhere", "inside.txt"), "bytes", "utf8");
    await symlink(join(workspace, "elsewhere"), join(root, "plugins.dll"), "junction");
    await symlink(join(workspace, "gone"), join(root, "missing.dll"), "junction");

    expect(await walk()).toEqual(["plugins.dll/inside.txt"]);
  });

  it("stops after the entry limit", async () => {
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]) await writeGameFile(name);
    expect(await walk(3)).toHaveLength(3);
    expect(await walk(5)).toHaveLength(5);
  });

  it("stops as soon as the visitor asks to", async () => {
    for (const name of ["a.txt", "b.txt", "c.txt"]) await writeGameFile(name);
    const seen: string[] = [];
    await walkInstallation(root, (path) => { seen.push(path); return false; });
    expect(seen).toHaveLength(1);
  });

  it("walks a folder named like an exempt file but skips the exempt trees", async () => {
    await writeGameFile("rotkc.dll/inside.dll");
    await writeGameFile("Logs/crash.dll");
    await writeGameFile("BattlEye/BEClient_x64.dll");
    await writeGameFile("rotkc.dll.txt");
    await writeGameFile("UserOptions.ini");
    expect(await walk()).toEqual(["rotkc.dll.txt", "rotkc.dll/inside.dll"]);
  });
});
