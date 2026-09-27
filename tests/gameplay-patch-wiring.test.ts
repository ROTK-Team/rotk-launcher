import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const count = (value: string, needle: string): number =>
  value.split(needle).length - 1;

describe("shotgun sprint patch wiring", () => {
  it("applies the server mode during attestation and rechecks before spawn", async () => {
    const [launcher, main] = await Promise.all([
      readFile(root + "electron/services/game-launcher.ts", "utf8"),
      readFile(root + "electron/main.ts", "utf8"),
    ]);

    expect(launcher).not.toContain("removeRetiredGameplayPatch");
    expect(main).not.toContain("removeRetiredGameplayPatch");
    expect(launcher).toContain("bundledGameplayPatchPath: string;");
    expect(launcher).toContain("await assertGameplayPatchState(root, clientPatchMode);");
    expect(count(launcher, "await prepareClient(")).toBe(2);

    expect(main).toContain("challenge.clientPatchMode ?? \"clean\"");
    expect(main).toContain("await applyGameplayPatchMode(");
    expect(main).toContain("await recordGameplayPatchState(");
    expect(main).toContain("resolveBundledGameplayPatchPath()");
    expect(main).toContain("bundledGameplayPatchPath: resolveBundledGameplayPatchPath()");
  });

  it("attests dinput8.dll only when the server directs the patched mode", async () => {
    const main = await readFile(root + "electron/main.ts", "utf8");
    expect(main).toContain(
      '{ installPath: "dinput8.dll", bundledPath: resolveBundledGameplayPatchPath() }',
    );
    expect(main).toContain('...(clientPatchMode === "patched"');
  });

  it("mirrors the override path in the shared attestation contract", async () => {
    const attestation = await readFile(root + "shared/attestation.ts", "utf8");
    expect(attestation).toContain('"dinput8.dll"');
    expect(attestation).toContain("clientPatchMode?: AttestationClientPatchMode");
    expect(attestation).toContain("AttestationClientPatchMode = \"patched\" | \"clean\"");
  });

  it("parses the signed client patch mode in the challenge", async () => {
    const source = await readFile(
      root + "electron/services/integrity-attestation.ts",
      "utf8",
    );
    expect(source).toContain("clientPatchMode?: AttestationClientPatchMode");
    expect(source).toContain('value.clientPatchMode !== "patched"');
    expect(source).toContain('...(clientPatchMode === undefined ? {} : { clientPatchMode })');
  });

  it("keeps installation patch-free and lets the first launch reconcile", async () => {
    const installer = await readFile(
      root + "electron/services/installer.ts",
      "utf8",
    );
    expect(installer).not.toContain("removeRetiredGameplayPatch");
    expect(installer).not.toContain("deployGameplayPatch");
    expect(installer).toContain("shotgun-sprint-v3");
  });

  it("resolves the bundled artifact from the packaged resources", async () => {
    const constants = await readFile(root + "electron/constants.ts", "utf8");
    expect(constants).toContain("resolveBundledGameplayPatchPath");
    expect(constants).toContain('"patches", "dinput8.dll"');
  });
});
