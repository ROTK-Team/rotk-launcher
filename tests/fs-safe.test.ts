import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicCopyFile, atomicWriteFile, retryFs, syncFile } from "../electron/services/fs-safe.js";

function systemError(code: string, path?: string, syscall?: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code, path, syscall });
}

// Records every flush (with the path its handle was opened on) and every rename,
// in order, and can make either one fail.
const io = vi.hoisted(() => ({
  events: [] as string[],
  failSync: null as NodeJS.ErrnoException | null,
  failRename: null as NodeJS.ErrnoException | null,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        io.events.push(`sync ${String(args[0])}`);
        if (io.failSync) throw io.failSync;
        return sync();
      };
      return handle;
    },
    rename: (...args: Parameters<typeof fs.rename>) => {
      io.events.push(`rename ${String(args[0])} -> ${String(args[1])}`);
      return io.failRename ? Promise.reject(io.failRename) : fs.rename(...args);
    },
  };
});

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rotk-fs-safe-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

beforeEach(() => {
  io.events.length = 0;
  io.failSync = null;
  io.failRename = null;
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("retryFs", () => {
  it("retries transient Windows lock errors", async () => {
    let calls = 0;
    const value = await retryFs(async () => {
      calls += 1;
      if (calls < 3) throw systemError("EBUSY");
      return "done";
    }, { baseDelayMs: 1 });
    expect(value).toBe("done");
    expect(calls).toBe(3);
  });

  it("does not retry other errors", async () => {
    let calls = 0;
    await expect(retryFs(async () => {
      calls += 1;
      throw systemError("ENOENT");
    }, { baseDelayMs: 1 })).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
  });

  it("gives up on EPERM after about 1.5 s", async () => {
    let calls = 0;
    await expect(retryFs(async () => {
      calls += 1;
      throw systemError("EPERM");
    })).rejects.toMatchObject({ code: "EPERM" });
    expect(calls).toBe(5); // waits 100 + 200 + 400 + 800 ms
  });
});

describe("atomicWriteFile", () => {
  it("flushes the temporary file to disk before renaming it over the target", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "state.json");
    await writeFile(target, "old", "utf8");

    await atomicWriteFile(target, "new");

    expect(io.events).toHaveLength(2);
    const [flush, replace] = io.events;
    const temporary = flush.replace(/^sync /, "");
    expect(temporary).toMatch(/state\.json\.rotk-[0-9a-f-]{36}\.tmp$/);
    expect(replace).toBe(`rename ${temporary} -> ${target}`);
    expect(await readFile(target, "utf8")).toBe("new");
    expect(await readdir(directory)).toEqual(["state.json"]);
  });

  it("keeps the requested encoding", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "BEClient_x64.cfg");

    await atomicWriteFile(target, "MasterPort 20099é", "latin1");

    expect(await readFile(target)).toEqual(Buffer.from("MasterPort 20099é", "latin1"));
  });

  it("leaves the old file and no temporary file when the flush fails", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "state.json");
    await writeFile(target, "old", "utf8");
    io.failSync = systemError("EIO");

    await expect(atomicWriteFile(target, "new")).rejects.toMatchObject({ code: "EIO" });

    expect(io.events.some((event) => event.startsWith("rename "))).toBe(false);
    expect(await readFile(target, "utf8")).toBe("old");
    expect(await readdir(directory)).toEqual(["state.json"]);
  });

  it("removes the temporary file when the rename fails", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "state.json");
    await writeFile(target, "old", "utf8");
    io.failRename = systemError("EXDEV");

    await expect(atomicWriteFile(target, "new")).rejects.toMatchObject({ code: "EXDEV" });

    expect(await readFile(target, "utf8")).toBe("old");
    expect(await readdir(directory)).toEqual(["state.json"]);
  });
});

describe("atomicCopyFile", () => {
  it("flushes the copy to disk before renaming it over the target", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "bundled.dll");
    const target = join(directory, "active.dll");
    await writeFile(source, "bundled bytes");
    await writeFile(target, "previous bytes");

    await atomicCopyFile(source, target);

    expect(io.events).toHaveLength(2);
    const [flush, replace] = io.events;
    const temporary = flush.replace(/^sync /, "");
    expect(temporary).toMatch(/active\.dll\.rotk-[0-9a-f-]{36}\.tmp$/);
    expect(replace).toBe(`rename ${temporary} -> ${target}`);
    expect(await readFile(target, "utf8")).toBe("bundled bytes");
    expect((await readdir(directory)).sort()).toEqual(["active.dll", "bundled.dll"]);
  });

  it("leaves the old file and no temporary file when the flush fails", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "bundled.dll");
    const target = join(directory, "active.dll");
    await writeFile(source, "bundled bytes");
    await writeFile(target, "previous bytes");
    io.failSync = systemError("EIO");

    await expect(atomicCopyFile(source, target)).rejects.toMatchObject({ code: "EIO" });

    expect(io.events.some((event) => event.startsWith("rename "))).toBe(false);
    expect(await readFile(target, "utf8")).toBe("previous bytes");
    expect((await readdir(directory)).sort()).toEqual(["active.dll", "bundled.dll"]);
  });

  it("copies a read-only file, whose copy cannot be opened for the flush", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "ClientConfig.ini");
    const target = join(directory, "ClientConfig.original.ini");
    await writeFile(source, "[Client]\nLocale=en_us\n");
    // Some players lock their settings this way; copyFile keeps the attribute.
    await chmod(source, 0o444);
    try {
      await atomicCopyFile(source, target);

      // No flush for that copy: it goes straight to the rename, as before.
      expect(io.events).toEqual([expect.stringMatching(/^rename .+\.rotk-[0-9a-f-]{36}\.tmp -> .+ClientConfig\.original\.ini$/)]);
      expect(await readFile(target)).toEqual(await readFile(source));
      expect((await readdir(directory)).sort()).toEqual(["ClientConfig.ini", "ClientConfig.original.ini"]);
    } finally {
      // Windows refuses to delete read-only files: give write access back first.
      for (const path of [source, target]) await chmod(path, 0o666).catch(() => undefined);
    }
  });
});

describe("syncFile", () => {
  it("flushes a file without changing it", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, ".rotk-installation.json");
    await writeFile(path, "{}\n", "utf8");

    await syncFile(path);

    expect(io.events).toEqual([`sync ${path}`]);
    expect(await readFile(path, "utf8")).toBe("{}\n");
  });
});
