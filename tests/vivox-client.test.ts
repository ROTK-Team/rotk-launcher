import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CROUCH_PARITY_MARKER_CONTENTS,
  VIVOX_PROXY_SHA256,
  vivoxClientInternals,
} from "../electron/services/vivox-client.js";

const temporaryDirectories: string[] = [];
const reads = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, createReadStream: (...args: Parameters<typeof fs.createReadStream>) => {
    reads.push(String(args[0]));
    return fs.createReadStream(...args);
  } };
});

function hash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

const contents = {
  h1z1: "supported-h1z1-build",
  v4: "stock-vivox-v4",
  v5: "official-vivox-v5",
  proxy: "rotk-vivox-proxy",
  stale: "stale-or-corrupt",
  marker: [
    "mode=patch-v2",
    "animation=v12-test",
    "cameraScalePitch=disabled",
    "",
  ].join("\n"),
};

const policy = {
  stockV4Sha256: hash(contents.v4),
  stockV5Sha256: hash(contents.v5),
  proxySha256: hash(contents.proxy),
  proxyMinBytes: 1,
  proxyMaxBytes: 1_024,
  h1z1Sha256: hash(contents.h1z1),
  h1z1Bytes: Buffer.byteLength(contents.h1z1),
  crouchMarkerContents: contents.marker,
};

async function createFixture(): Promise<{
  root: string;
  proxy: string;
  runtime: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "rotk-vivox-test-"));
  temporaryDirectories.push(directory);

  const root = join(directory, "game");
  const proxy = join(directory, "bundled-proxy.dll");
  const runtime = join(directory, "bundled-v5.dll");
  await mkdir(root);
  await writeFile(join(root, "H1Z1.exe"), contents.h1z1);
  await writeFile(proxy, contents.proxy);
  await writeFile(runtime, contents.v5);
  return { root, proxy, runtime };
}

async function deploy(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): Promise<void> {
  await vivoxClientInternals.deployVivoxCompatibilityWithPolicy(
    fixture.root,
    fixture.proxy,
    fixture.runtime,
    policy,
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("Vivox client deployment", () => {
  it("hashes each healthy installed file once per pass and does not revalidate bundles in the final check", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, "vivoxsdk_x64.dll"), contents.v4);
    await deploy(fixture);
    reads.length = 0;
    await deploy(fixture);
    for (const name of ["H1Z1.exe", "vivoxsdk_x64.dll", "vivoxsdk_x64_v5.dll", "vivoxsdk_x64.original.dll"]) {
      expect(reads.filter(path => path === join(fixture.root, name))).toHaveLength(1);
    }
    reads.length = 0;
    await vivoxClientInternals.assertVivoxCompatibilityWithPolicy(fixture.root, policy);
    expect(reads).toHaveLength(4);
    expect(reads).not.toContain(fixture.proxy);
    expect(reads).not.toContain(fixture.runtime);
  });

  it.each(["H1Z1.exe", "vivoxsdk_x64.dll", "vivoxsdk_x64_v5.dll", "vivoxsdk_x64.original.dll", "rotk-crouch-parity.ini"])(
    "refuses same-size drift of %s after deployment, without repairing it", async name => {
      const fixture = await createFixture();
      await writeFile(join(fixture.root, "vivoxsdk_x64.dll"), contents.v4);
      await deploy(fixture);
      const path = join(fixture.root, name);
      const changed = Buffer.from(await readFile(path)); changed[0] ^= 1;
      await writeFile(path, changed);
      await expect(vivoxClientInternals.assertVivoxCompatibilityWithPolicy(fixture.root, policy)).rejects.toThrow();
      expect(await readFile(path)).toEqual(changed);
    });
  it("ships the ADS-safe mandatory production marker", () => {
    expect(CROUCH_PARITY_MARKER_CONTENTS).toContain("mode=patch-v2\n");
    expect(CROUCH_PARITY_MARKER_CONTENTS).toContain("cameraScalePitch=disabled\n");
    expect(CROUCH_PARITY_MARKER_CONTENTS).toContain(
      `proxySha256=${VIVOX_PROXY_SHA256.toUpperCase()}\n`,
    );
    expect(CROUCH_PARITY_MARKER_CONTENTS).not.toContain("cameraScalePitch=direct");
  });

  it("installs and verifies both DLLs while preserving the stock runtime", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, "vivoxsdk_x64.dll"), contents.v4);

    await deploy(fixture);
    await deploy(fixture);

    await expect(readFile(join(fixture.root, "vivoxsdk_x64.dll"), "utf8"))
      .resolves.toBe(contents.proxy);
    await expect(readFile(join(fixture.root, "vivoxsdk_x64_v5.dll"), "utf8"))
      .resolves.toBe(contents.v5);
    await expect(readFile(join(fixture.root, "vivoxsdk_x64.original.dll"), "utf8"))
      .resolves.toBe(contents.v4);
    await expect(readFile(join(fixture.root, "rotk-crouch-parity.ini"), "ascii"))
      .resolves.toBe(contents.marker);
  });

  it("repairs a stale proxy, runtime and crouch marker", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, "vivoxsdk_x64.dll"), contents.stale);
    await writeFile(join(fixture.root, "vivoxsdk_x64.original.dll"), contents.v4);
    await writeFile(join(fixture.root, "vivoxsdk_x64_v5.dll"), contents.stale);
    await writeFile(join(fixture.root, "rotk-crouch-parity.ini"), "mode=disabled\n");

    await deploy(fixture);

    await expect(readFile(join(fixture.root, "vivoxsdk_x64.dll"), "utf8"))
      .resolves.toBe(contents.proxy);
    await expect(readFile(join(fixture.root, "vivoxsdk_x64_v5.dll"), "utf8"))
      .resolves.toBe(contents.v5);
    await expect(readFile(join(fixture.root, "rotk-crouch-parity.ini"), "ascii"))
      .resolves.toBe(contents.marker);
  });

  it("migrates a valid legacy backup over a corrupt canonical backup", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, "vivoxsdk_x64.dll"), contents.stale);
    await writeFile(join(fixture.root, "vivoxsdk_x64.original.dll"), contents.stale);
    await writeFile(join(fixture.root, "vivoxsdk_x64_original.dll"), contents.v4);

    await deploy(fixture);

    await expect(readFile(join(fixture.root, "vivoxsdk_x64.original.dll"), "utf8"))
      .resolves.toBe(contents.v4);
    // The legacy name does not match the attestation's `.original.dll` backup
    // shape, so keeping it would flag the install as carrying an unexpected DLL.
    await expect(readFile(join(fixture.root, "vivoxsdk_x64_original.dll")))
      .rejects.toThrow();
  });

  it("leaves an unknown file under the legacy backup name untouched", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, "vivoxsdk_x64.dll"), contents.v4);
    await writeFile(join(fixture.root, "vivoxsdk_x64_original.dll"), contents.stale);

    await deploy(fixture);

    // Not our backup: it must survive and surface through attestation instead
    // of being silently deleted.
    await expect(readFile(join(fixture.root, "vivoxsdk_x64_original.dll"), "utf8"))
      .resolves.toBe(contents.stale);
  });

  it("repairs a corrupt backup from an untouched stock DLL", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, "vivoxsdk_x64.dll"), contents.v4);
    await writeFile(join(fixture.root, "vivoxsdk_x64.original.dll"), contents.stale);

    await deploy(fixture);

    await expect(readFile(join(fixture.root, "vivoxsdk_x64.original.dll"), "utf8"))
      .resolves.toBe(contents.v4);
  });

  it("fails closed before mutation when no valid stock backup exists", async () => {
    const fixture = await createFixture();
    const activePath = join(fixture.root, "vivoxsdk_x64.dll");
    await writeFile(activePath, contents.stale);

    await expect(deploy(fixture)).rejects.toThrow(/sauvegarde.+invalide/i);
    await expect(readFile(activePath, "utf8")).resolves.toBe(contents.stale);
    await expect(readFile(join(fixture.root, "vivoxsdk_x64_v5.dll")))
      .rejects.toThrow();
  });

  it("fails before mutation when either bundled DLL has an unexpected hash", async () => {
    const fixture = await createFixture();
    const activePath = join(fixture.root, "vivoxsdk_x64.dll");
    await writeFile(activePath, contents.v4);
    await writeFile(fixture.runtime, contents.stale);

    await expect(deploy(fixture)).rejects.toThrow(/runtime Vivox 5.+absent ou modifié/i);
    await expect(readFile(activePath, "utf8")).resolves.toBe(contents.v4);

    await writeFile(fixture.runtime, contents.v5);
    await writeFile(fixture.proxy, contents.stale);
    await expect(deploy(fixture)).rejects.toThrow(/proxy vocal ROTK.+absent ou modifié/i);
    await expect(readFile(activePath, "utf8")).resolves.toBe(contents.v4);
  });

  it("fails closed before mutation for an unsupported H1Z1 executable", async () => {
    const fixture = await createFixture();
    const activePath = join(fixture.root, "vivoxsdk_x64.dll");
    await writeFile(activePath, contents.v4);
    await writeFile(join(fixture.root, "H1Z1.exe"), contents.stale);

    await expect(deploy(fixture)).rejects.toThrow(/patch crouch ROTK obligatoire/i);
    await expect(readFile(activePath, "utf8")).resolves.toBe(contents.v4);
    await expect(readFile(join(fixture.root, "vivoxsdk_x64_v5.dll")))
      .rejects.toThrow();
    await expect(readFile(join(fixture.root, "rotk-crouch-parity.ini")))
      .rejects.toThrow();
  });
});
