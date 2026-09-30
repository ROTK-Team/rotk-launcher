import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

interface PackageManifest {
  build: {
    win: { requestedExecutionLevel?: string };
    nsis: { perMachine?: boolean };
  };
}

/**
 * Launcher 2.0.14 shipped with `requireAdministrator` and did not open on
 * part of the player base (issue #59). Chromium starts its GPU, renderer and
 * utility processes as new instances of this same executable under restricted
 * sandbox tokens, so the manifest's requirement applies to every child. On a
 * session that runs with a full administrator token without UAC's split — the
 * built-in Administrator account, common on preinstalled or ghosted Windows —
 * Windows refuses to create them ("GPU process launch failed: error_code=18",
 * "Renderer process launch-failed") and Chromium aborts the process. Nothing
 * in-app can catch that abort, so the launcher runs as the invoking user; the
 * TPM steps that need elevation are the job of a one-shot helper, not of the
 * whole process. Flipping this back is a release decision, and this test makes
 * it a visible one.
 */
it("runs the launcher as the invoking user, never elevated as a whole", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as PackageManifest;
  expect(manifest.build.win.requestedExecutionLevel).toBe("asInvoker");
  // The per-machine install stays: one copy under Program Files, updated by
  // the assisted installer that asks for elevation itself.
  expect(manifest.build.nsis.perMachine).toBe(true);
});
