import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Bytes of the files under `root`. Junctions and symbolic links are not
 * followed (Dirent.isDirectory() is false for them), and an entry that cannot
 * be read counts for nothing: this is a figure shown to the player, not a check.
 */
export async function folderSize(root: string): Promise<number> {
  let total = 0;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) total += await folderSize(path);
    else if (entry.isFile()) total += (await stat(path).catch(() => null))?.size ?? 0;
  }
  return total;
}
