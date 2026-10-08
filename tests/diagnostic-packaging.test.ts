import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const afterSign = createRequire(import.meta.url)('../scripts/after-sign-diagnostics.cjs') as (context: { appOutDir: string; electronPlatformName: string }) => Promise<void>;
it('refreshes helper and Steam shim checksums after Authenticode changes their bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rotk-packaging-test-'));
  try {
    const directory = join(root, 'resources', 'diagnostics'); await mkdir(directory, { recursive: true });
    const executable = join(directory, 'ROTK.Diagnostics.exe');
    const bytes = Buffer.from('test PE bytes with an appended signing certificate');
    await writeFile(executable, bytes); await writeFile(`${executable}.sha256`, 'outdated hash');
    const patchDirectory = join(root, 'resources', 'patches'); await mkdir(patchDirectory, { recursive: true });
    const shim = join(patchDirectory, 'steam_api64.dll');
    const shimBytes = Buffer.from('Steam shim with its final signing certificate');
    await writeFile(shim, shimBytes); await writeFile(`${shim}.sha256`, 'outdated source hash');
    await copyFile(new URL('../resources/diagnostics/PresentMon.exe', import.meta.url), join(directory, 'PresentMon.exe'));
    await afterSign({ appOutDir: root, electronPlatformName: 'win32' });
    expect(await readFile(`${executable}.sha256`, 'utf8')).toBe(`${createHash('sha256').update(bytes).digest('hex')}  ROTK.Diagnostics.exe\n`);
    expect(await readFile(`${shim}.sha256`, 'utf8')).toBe(`${createHash('sha256').update(shimBytes).digest('hex')}  steam_api64.dll\n`);
    await writeFile(join(directory, 'PresentMon.exe'), 'modified third-party bytes');
    await expect(afterSign({ appOutDir: root, electronPlatformName: 'win32' })).rejects.toThrow('PresentMon differs');
  } finally {
    if (!resolve(root).startsWith(resolve(join(tmpdir(), 'rotk-packaging-test-')))) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
