import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { retryFs } from "./fs-safe.js";

const HELD_BY_ANOTHER_PROGRAM = new Set(["EBUSY", "EPERM", "EACCES"]);

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/**
 * SHA-256 for the launcher's own comparisons; "" when the file is absent.
 *
 * A file another program holds for a moment (an antivirus scanning a DLL the
 * launcher just wrote, or H1Z1.exe) is waited for. Still held after that, the
 * error names the file: it used to hash to "" like a missing one, so the
 * player read "wrong H1Z1 version" or "copy failed" and the next Play worked.
 */
export async function fileHashOrEmpty(filePath: string): Promise<string> {
  try {
    return await retryFs(() => sha256(filePath));
  } catch (error) {
    if (HELD_BY_ANOTHER_PROGRAM.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    return "";
  }
}
