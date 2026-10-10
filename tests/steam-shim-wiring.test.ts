import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const count = (value: string, needle: string): number =>
  value.split(needle).length - 1;

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("Steam shim wiring", () => {
  it("deploys the bundled shim after the Vivox repair and before attestation", async () => {
    const launcher = await readFile(root + "electron/services/game-launcher.ts", "utf8");
    const vivox = launcher.indexOf("deployVivoxCompatibility(");
    const shim = launcher.indexOf("deploySteamShim(");
    const attest = launcher.indexOf("request.attest()");

    expect(vivox).toBeGreaterThanOrEqual(0);
    expect(shim).toBeGreaterThan(vivox);
    expect(attest).toBeGreaterThan(shim);
    expect(launcher).toContain("await deploySteamShim(installationRoot, request.bundledShimPath);");
    expect(count(launcher, "deploySteamShim(")).toBe(1);
  });

  it("only rechecks the shim while preparing the client", async () => {
    const launcher = await readFile(root + "electron/services/game-launcher.ts", "utf8");
    const prepareClient = functionBody(launcher, "async function prepareClient(");

    expect(launcher).not.toContain("copyFile(request.bundledShimPath");
    expect(prepareClient).toContain("await assertSteamShim(root, request.bundledShimPath);");
    expect(prepareClient).not.toContain("deploySteamShim(");
    // The ticket-refresh path prepares the client again and must recheck too.
    expect(count(launcher, "await prepareClient(")).toBe(2);
  });
});
