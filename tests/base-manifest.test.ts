import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The manifest signature is covered by the attestation tests; here only the
// order between the cache and the network matters.
vi.mock("../shared/attestation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/attestation.js")>()),
  verifyAttestationSignature: () => true,
}));
const { BASE_MANIFEST_URL, loadBaseManifest } = await import("../electron/services/base-manifest.js");

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function manifest(buildId: string) {
  return {
    schemaVersion: 1,
    kind: "base-game",
    buildId,
    root: "a".repeat(64),
    issuedAt: "2026-08-01T00:00:00.000Z",
    keyId: "fixture-key",
    signature: "s".repeat(86),
    files: [{ path: "H1Z1.exe", size: 1, sha256: "b".repeat(64) }],
  };
}

async function userData(cachedBuild?: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rotk-base-manifest-test-"));
  directories.push(directory);
  if (cachedBuild) await writeFile(join(directory, "base-manifest.v1.json"), JSON.stringify(manifest(cachedBuild)));
  return directory;
}

describe("loadBaseManifest", () => {
  it("uses the cached manifest of the expected build without touching the network", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const loaded = await loadBaseManifest({ url: BASE_MANIFEST_URL, userDataDirectory: await userData("1.0.326.439939"),
      expectedBuildId: "1.0.326.439939", fetchImpl });
    expect(loaded.buildId).toBe("1.0.326.439939");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("downloads the manifest when the cache holds another build, and keeps it for the next launch", async () => {
    const directory = await userData("1.0.325.000000");
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(manifest("1.0.326.439939"))));
    const loaded = await loadBaseManifest({ url: BASE_MANIFEST_URL, userDataDirectory: directory,
      expectedBuildId: "1.0.326.439939", fetchImpl });
    expect(loaded.buildId).toBe("1.0.326.439939");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const again = vi.fn<typeof fetch>();
    await loadBaseManifest({ url: BASE_MANIFEST_URL, userDataDirectory: directory, expectedBuildId: "1.0.326.439939", fetchImpl: again });
    expect(again).not.toHaveBeenCalled();
  });

  it("downloads the manifest when there is no usable cache", async () => {
    const directory = await userData();
    await writeFile(join(directory, "base-manifest.v1.json"), "\0\0\0");
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(manifest("1.0.326.439939"))));
    await loadBaseManifest({ url: BASE_MANIFEST_URL, userDataDirectory: directory, expectedBuildId: "1.0.326.439939", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
