const { createHash } = require('node:crypto');
const { readFile, writeFile, lstat } = require('node:fs/promises');
const { join } = require('node:path');

// electron-builder signs extraResources executables during packaging. Hash the
// final bytes, after Authenticode, so the observer can verify the shipped helper.
module.exports = async function afterSignDiagnostics(context) {
  if (context.electronPlatformName !== 'win32') return;
  const executable = join(context.appOutDir, 'resources', 'diagnostics', 'ROTK.Diagnostics.exe');
  const info = await lstat(executable);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Packaged diagnostic helper is missing or invalid');
  const digest = createHash('sha256').update(await readFile(executable)).digest('hex');
  await writeFile(`${executable}.sha256`, `${digest}  ROTK.Diagnostics.exe\n`, 'ascii');
  // The Steam shim is also signed by electron-builder. Attestation must use
  // the installed bytes, including Authenticode, rather than the source DLL.
  const shim = join(context.appOutDir, 'resources', 'patches', 'steam_api64.dll');
  const shimInfo = await lstat(shim);
  if (!shimInfo.isFile() || shimInfo.isSymbolicLink()) throw new Error('Packaged Steam shim is missing or invalid');
  const shimDigest = createHash('sha256').update(await readFile(shim)).digest('hex');
  await writeFile(`${shim}.sha256`, `${shimDigest}  steam_api64.dll\n`, 'ascii');
  // Keep Intel's Authenticode signature and original release bytes intact.
  const presentMon = join(context.appOutDir, 'resources', 'diagnostics', 'PresentMon.exe');
  const pinned = '9bec3083069f58f911e6a512f4806db51a27bd096103087bc1d05ef54c80a191';
  if (createHash('sha256').update(await readFile(presentMon)).digest('hex') !== pinned) {
    throw new Error('Packaged PresentMon differs from the pinned official Intel release');
  }
};
