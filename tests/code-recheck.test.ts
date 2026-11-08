import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findCodeChangedSinceMeasurement,
  measureInstallation,
} from "../electron/services/integrity-attestation";

let workspace: string;
let installRoot: string;
let userData: string;

function sha256(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function writeGameFile(relativePath: string, content: string) {
  const absolute = join(installRoot, ...relativePath.split("/"));
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
  return { path: relativePath, size: Buffer.byteLength(content), sha256: sha256(content) };
}

async function measure(expected: Array<{ path: string; size: number; sha256: string }>) {
  return measureInstallation({
    installationRoot: installRoot,
    userDataDirectory: userData,
    expected,
    detectUnexpected: true,
  });
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "rotk-code-recheck-"));
  installRoot = join(workspace, "game");
  userData = join(workspace, "userdata");
  await mkdir(installRoot, { recursive: true });
  await mkdir(userData, { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("executable files seen by the measurement", () => {
  it("lists every executable file in the attested tree with the digest it was measured with", async () => {
    const expected = [
      await writeGameFile("H1Z1.exe", "game executable"),
      await writeGameFile("Browser/Resources/x64/libcef.dll", "browser runtime"),
      await writeGameFile("Resources/Assets/assets_x64_0.pack2", "pack"),
    ];
    await writeGameFile("dxgi.dll", "undeclared module");
    // Exempt from attestation, so outside the measured tree.
    await writeGameFile("rotkc.dll", "client module");
    await writeGameFile("BattlEye/BEClient_x64.dll", "battleye");
    await writeGameFile("LaunchPad.libs/libcef.dll", "launchpad");
    await writeGameFile("Logs/crash.dll", "log folder");

    const measurement = await measure(expected);

    expect([...measurement.code].sort((left, right) => left.path.localeCompare(right.path))).toEqual([
      { path: "Browser/Resources/x64/libcef.dll", size: 15, sha256: sha256("browser runtime") },
      { path: "dxgi.dll", size: 17, sha256: sha256("undeclared module") },
      { path: "H1Z1.exe", size: 15, sha256: sha256("game executable") },
    ]);
  });
});

describe("findCodeChangedSinceMeasurement", () => {
  it("finds nothing when the executable files are as measured", async () => {
    const expected = [await writeGameFile("H1Z1.exe", "game executable")];
    await writeGameFile("dxgi.dll", "undeclared module");
    const measurement = await measure(expected);

    expect(await findCodeChangedSinceMeasurement(installRoot, measurement.code)).toBeNull();
  });

  it("ignores the files the launcher itself writes after the measurement", async () => {
    const expected = [await writeGameFile("H1Z1.exe", "game executable")];
    const measurement = await measure(expected);

    await writeGameFile("rotkc.dll", "client module copied before each launch");
    await writeGameFile("ClientConfig.ini", "[Client]");
    await writeGameFile("UserOptions.ini", "[Rendering]");
    await writeGameFile("steam_persona_name.txt", "Player");
    await writeGameFile("BattlEye/BEClient_x64.cfg", "MasterPort 20099");

    expect(await findCodeChangedSinceMeasurement(installRoot, measurement.code)).toBeNull();
  });

  it("names an executable file changed after the measurement, even with the same size and timestamps", async () => {
    const expected = [await writeGameFile("H1Z1.exe", "game executable")];
    const absolute = join(installRoot, "H1Z1.exe");
    await utimes(absolute, 1_700_000_000, 1_700_000_000);
    const measurement = await measure(expected);

    await writeFile(absolute, "game executablf", "utf8");
    await utimes(absolute, 1_700_000_000, 1_700_000_000);

    expect(await findCodeChangedSinceMeasurement(installRoot, measurement.code)).toBe("H1Z1.exe");
  });

  it.each(["dxgi.dll", "VERSION.DLL", "Browser/Resources/x64/winmm.dll", "scripts/plugin.asi", "tool.exe"])(
    "names %s when it appears after the measurement", async (path) => {
      const expected = [await writeGameFile("H1Z1.exe", "game executable")];
      const measurement = await measure(expected);

      await writeGameFile(path, "added later");

      expect(await findCodeChangedSinceMeasurement(installRoot, measurement.code)).toBe(path);
    },
  );

  it("names an executable file removed after the measurement", async () => {
    const expected = [
      await writeGameFile("H1Z1.exe", "game executable"),
      await writeGameFile("vivoxplatform.dll", "voice platform"),
    ];
    const measurement = await measure(expected);

    await rm(join(installRoot, "vivoxplatform.dll"));

    expect(await findCodeChangedSinceMeasurement(installRoot, measurement.code)).toBe("vivoxplatform.dll");
  });

  it("names a declared file that was missing when measured and is back", async () => {
    const declared = await writeGameFile("ortp_x64.dll", "voice transport");
    await rm(join(installRoot, "ortp_x64.dll"));
    const measurement = await measure([declared]);
    expect(measurement.deviations).toEqual([{ path: "ortp_x64.dll", kind: "missing", observedSha256: null }]);

    await writeGameFile("ortp_x64.dll", "voice transport");

    expect(await findCodeChangedSinceMeasurement(installRoot, measurement.code)).toBe("ortp_x64.dll");
  });

  it("counts a link to a file added after the measurement", async ({ skip }) => {
    const expected = [await writeGameFile("H1Z1.exe", "game executable")];
    const measurement = await measure(expected);
    await writeFile(join(workspace, "outside.dll"), "code outside the game folder", "utf8");
    // File links need Developer Mode or elevation on Windows.
    const linked = await symlink(join(workspace, "outside.dll"), join(installRoot, "d3d11.dll"), "file")
      .then(() => true, () => false);
    if (!linked) skip();

    expect(await findCodeChangedSinceMeasurement(installRoot, measurement.code)).toBe("d3d11.dll");
  });
});

describe("the recheck through linked folders", () => {
  async function linkedBrowserFolder() {
    // Browser/Resources/x64 is a junction to a copy kept outside the folder.
    const target = join(workspace, "elsewhere", "x64");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "libEGL.dll"), "browser module", "utf8");
    await mkdir(join(installRoot, "Browser", "Resources"), { recursive: true });
    await symlink(target, join(installRoot, "Browser", "Resources", "x64"), "junction");
    return target;
  }

  it("re-reads an executable reached through a junction and names it when it changed", async () => {
    const target = await linkedBrowserFolder();
    const expected = [
      await writeGameFile("H1Z1.exe", "game executable"),
      { path: "Browser/Resources/x64/libEGL.dll", size: 14, sha256: sha256("browser module") },
    ];
    const measurement = await measure(expected);
    expect(measurement.code.map((file) => file.path).sort()).toEqual(["Browser/Resources/x64/libEGL.dll", "H1Z1.exe"]);

    await writeFile(join(target, "libEGL.dll"), "browser modulf", "utf8");

    expect(await findCodeChangedSinceMeasurement(installRoot, measurement.code)).toBe("Browser/Resources/x64/libEGL.dll");
  });

  it("names an executable added inside a linked folder after the measurement", async () => {
    const target = await linkedBrowserFolder();
    const measurement = await measure([await writeGameFile("H1Z1.exe", "game executable")]);

    await writeFile(join(target, "version.dll"), "added later", "utf8");

    expect(await findCodeChangedSinceMeasurement(installRoot, measurement.code)).toBe("Browser/Resources/x64/version.dll");
  });

  it("names an executable behind a junction added after the measurement", async () => {
    const measurement = await measure([await writeGameFile("H1Z1.exe", "game executable")]);
    await mkdir(join(workspace, "modules"), { recursive: true });
    await writeFile(join(workspace, "modules", "dxgi.dll"), "added later", "utf8");

    await symlink(join(workspace, "modules"), join(installRoot, "plugins"), "junction");

    expect(await findCodeChangedSinceMeasurement(installRoot, measurement.code)).toBe("plugins/dxgi.dll");
  });

  it("finds nothing when a junctioned folder is unchanged", async () => {
    await linkedBrowserFolder();
    const measurement = await measure([await writeGameFile("H1Z1.exe", "game executable")]);
    expect(await findCodeChangedSinceMeasurement(installRoot, measurement.code)).toBeNull();
  });

  it("ignores a broken link named like a module", async () => {
    await symlink(join(workspace, "gone"), join(installRoot, "dxgi.dll"), "junction");
    const measurement = await measure([await writeGameFile("H1Z1.exe", "game executable")]);
    expect(measurement.code.map((file) => file.path)).toEqual(["H1Z1.exe"]);
    expect(await findCodeChangedSinceMeasurement(installRoot, measurement.code)).toBeNull();
  });
});

describe("what the recheck covers", () => {
  it("re-reads only executable files, so a changed pack or font is left to attestation", async () => {
    const expected = [
      await writeGameFile("H1Z1.exe", "game executable"),
      await writeGameFile("Resources/Assets/assets_x64_0.pack2", "pack"),
      await writeGameFile("UI/Resource/Fonts/Montserrat-Bold.ttf", "font"),
    ];
    const measurement = await measure(expected);
    expect(measurement.code.map((file) => file.path)).toEqual(["H1Z1.exe"]);

    await writeGameFile("Resources/Assets/assets_x64_0.pack2", "kcap");
    await writeGameFile("UI/Resource/Fonts/Montserrat-Bold.ttf", "tnof");

    expect(await findCodeChangedSinceMeasurement(installRoot, measurement.code)).toBeNull();
  });

  it("keeps an executable the undeclared scan did not see, and finds it unchanged", async () => {
    const expected = [await writeGameFile("H1Z1.exe", "game executable")];
    await writeGameFile("dxgi.dll", "present before the launch");
    const measurement = await measureInstallation({ installationRoot: installRoot, userDataDirectory: userData, expected });
    expect(measurement.code).toContainEqual({ path: "dxgi.dll", size: 25, sha256: sha256("present before the launch") });

    expect(await findCodeChangedSinceMeasurement(installRoot, measurement.code)).toBeNull();
  });

  it("counts a file named only by its extension as executable", async () => {
    const measurement = await measure([await writeGameFile("H1Z1.exe", "game executable")]);
    await writeGameFile(".dll", "added later");
    expect(await findCodeChangedSinceMeasurement(installRoot, measurement.code)).toBe(".dll");
  });
});
