import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearUpdateAttempt, failedUpdateAttempt, recordUpdateAttempt } from "../electron/services/update-attempt";

const roots: string[] = [];
async function userData(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rotk-update-attempt-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const marker = (root: string): string => join(root, "launcher-update-attempt.v1.json");
const MINUTE = 60_000;

describe("a launcher update that was started", () => {
  it("is reported when the same version starts again later", async () => {
    const root = await userData();
    await recordUpdateAttempt(root, "2.0.50", "2.0.51", 1_000);
    expect(await failedUpdateAttempt(root, "2.0.50", 1_000 + 2 * MINUTE)).toBe("2.0.51");
    // Said once: the next start has nothing to report.
    expect(existsSync(marker(root))).toBe(false);
    expect(await failedUpdateAttempt(root, "2.0.50", 1_000 + 3 * MINUTE)).toBeNull();
  });

  it("is forgotten once the new version runs", async () => {
    const root = await userData();
    await recordUpdateAttempt(root, "2.0.50", "2.0.51", 1_000);
    expect(await failedUpdateAttempt(root, "2.0.51", 5_000)).toBeNull();
    expect(existsSync(marker(root))).toBe(false);
  });

  it("is not judged while the installer may still be replacing the launcher", async () => {
    const root = await userData();
    await recordUpdateAttempt(root, "2.0.50", "2.0.51", 1_000);
    expect(await failedUpdateAttempt(root, "2.0.50", 1_000 + 20_000)).toBeNull();
    // Kept: still the old version after the grace period means it failed.
    expect(existsSync(marker(root))).toBe(true);
    expect(await failedUpdateAttempt(root, "2.0.50", 1_000 + 2 * MINUTE)).toBe("2.0.51");
  });

  it("says nothing without an attempt, and drops a damaged or cleared record", async () => {
    const root = await userData();
    expect(await failedUpdateAttempt(root, "2.0.50")).toBeNull();
    await writeFile(marker(root), "\0\0\0");
    expect(await failedUpdateAttempt(root, "2.0.50")).toBeNull();
    await writeFile(marker(root), JSON.stringify({ from: 2 }));
    expect(await failedUpdateAttempt(root, "2.0.50")).toBeNull();
    expect(existsSync(marker(root))).toBe(false);
    await recordUpdateAttempt(root, "2.0.50", "2.0.51", 1_000);
    await clearUpdateAttempt(root);
    expect(await failedUpdateAttempt(root, "2.0.50", 1_000 + 2 * MINUTE)).toBeNull();
  });
});
