import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// UTF-8 text decoded as Windows-1252 and saved again ("prÃ©sent", "lâ€™").
// Player-facing strings broken this way reach every language untranslated.
const MOJIBAKE = /Ã[\u0080-\u00bf]|â€|Â[\u00a0-\u00bf]/;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

describe("launcher sources", () => {
  it("contain no double-encoded text", async () => {
    const offenders: string[] = [];
    for (const root of ["electron", "src", "shared"]) {
      for (const file of await sourceFiles(root)) {
        const lines = (await readFile(file, "utf8")).split("\n");
        lines.forEach((line, index) => { if (MOJIBAKE.test(line)) offenders.push(`${file}:${index + 1}`); });
      }
    }
    expect(offenders).toEqual([]);
  });
});
