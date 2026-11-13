import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const count = (value: string, needle: string): number =>
  value.split(needle).length - 1;

describe("shotgun sprint patch wiring", () => {
  it("applies the server mode during attestation and rechecks before spawn", async () => {
    // The attestation pass moved from main.ts to its own service; its order
    // and its patch-mode rules are pinned by launch-attestation.test.ts.
    const [launcher, main, attestation] = await Promise.all([
      readFile(root + "electron/services/game-launcher.ts", "utf8"),
      readFile(root + "electron/main.ts", "utf8"),
      readFile(root + "electron/services/launch-attestation.ts", "utf8"),
    ]);

    expect(launcher).not.toContain("removeRetiredGameplayPatch");
    expect(main).not.toContain("removeRetiredGameplayPatch");
    expect(launcher).toContain("bundledGameplayPatchPath: string;");
    expect(launcher).toContain("clientPatchModeFallback: GameplayPatchMode;");
    expect(launcher).toContain("await assertGameplayPatchState(root, clientPatchMode);");
    expect(count(launcher, "await prepareClient(")).toBe(2);

    expect(attestation).toContain("challenge.clientPatchMode ?? \"clean\"");
    expect(attestation).toContain("await applyGameplayPatchMode(");
    expect(attestation).toContain("await recordGameplayPatchState(");
    expect(main).toContain("gameplayPatch: resolveBundledGameplayPatchPath()");
    expect(main).toContain("bundledGameplayPatchPath: resolveBundledGameplayPatchPath()");
    expect(main).toContain("clientPatchModeFallback:");
  });

  it("attests dinput8.dll only when the server directs the patched mode", async () => {
    const attestation = await readFile(root + "electron/services/launch-attestation.ts", "utf8");
    expect(attestation).toContain(
      '{ installPath: "dinput8.dll", bundledPath: context.bundled.gameplayPatch }',
    );
    expect(attestation).toContain('...(clientPatchMode === "patched"');
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
