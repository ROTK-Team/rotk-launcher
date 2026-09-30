import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// No UAC automation: this exercises the runner's real, already granted token.
// A standard token must be refused without creating a renderer or prompting.
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "release");
await mkdir(output, { recursive: true });
const fixture = await mkdtemp(path.join(output, "startup-proof-"));
const reportPath = path.join(fixture, "report.json");
const gate = pathToFileURL(path.join(root, "dist-electron/electron/services/startup-elevation.js")).href;
try {
  await writeFile(path.join(fixture, "package.json"), JSON.stringify({ name: "rotk-startup-proof", type: "module", main: "main.mjs" }));
  await writeFile(path.join(fixture, "main.mjs"), `
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { startWithRequiredElevation, windowsElevation, ELEVATION_RELAUNCH_ARGUMENT } from ${JSON.stringify(gate)};
app.setPath('userData', ${JSON.stringify(path.join(fixture, "profile"))});
const receipt = { platform: process.platform, windows: 0, uacRequests: 0, status: 'pending', events: [] };
const errors = [];
app.on('child-process-gone', (_event, detail) => { if (detail.reason !== 'clean-exit') errors.push(detail.reason); });
app.whenReady().then(async () => {
  const transport = windowsElevation(${JSON.stringify(path.join(root, "resources/diagnostics/ROTK.Diagnostics.exe"))});
  await startWithRequiredElevation({ platform: process.platform, isPackaged: true,
    executablePath: process.execPath, argv: [ELEVATION_RELAUNCH_ARGUMENT] }, {
    ...transport,
    requestElevation: async () => { receipt.uacRequests++; throw Error('The proof must never prompt for UAC'); },
    releaseSingleInstanceLock: () => {},
    initialize: async () => {
      assert.equal(await transport.isAdministrator(), true);
      receipt.administratorVerified = true;
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      receipt.windows++;
      const preferences = window.webContents.getLastWebPreferences();
      assert.equal(preferences.sandbox, true);
      assert.equal(preferences.contextIsolation, true);
      assert.equal(preferences.nodeIntegration, false);
      await window.loadURL('data:text/html,<title>ROTK startup proof</title><p>ready</p>');
      assert.equal(await window.webContents.executeJavaScript('document.body.textContent'), 'ready');
      assert.deepEqual(errors, []);
      receipt.sandboxRendererVerified = true;
      receipt.status = 'ready';
      window.destroy();
    },
    quit: () => { receipt.quitRequested = true; },
    reportFailure: reason => { receipt.status = 'blocked'; receipt.reason = reason; },
    mark: event => receipt.events.push(event),
  });
  fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(receipt));
  app.exit(0);
}).catch(error => { fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ ...receipt, error: String(error) })); app.exit(1); });
app.on('window-all-closed', () => {});
`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let stderr = "";
  const child = spawn(require("electron"), [fixture], { cwd: fixture, env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-16_384); });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Electron startup proof timed out")); }, 60_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0, stderr);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.uacRequests, 0);
  assert(!report.error, report.error);
  if (report.status === "blocked") {
    assert.equal(report.reason, "required");
    assert.equal(report.windows, 0);
    assert.equal(report.quitRequested, true);
    assert(!process.argv.includes("--require-administrator"), "The CI runner must already have an administrator token for the elevated renderer proof");
    console.log("PASS: real standard Windows token refused; no window or UAC request. Elevated renderer proof requires an administrator runner.");
  } else {
    assert.equal(report.status, "ready");
    assert.equal(report.administratorVerified, true);
    assert.equal(report.sandboxRendererVerified, true);
    assert.equal(report.windows, 1);
    console.log("PASS: real administrator token verified; sandboxed Electron renderer starts and loads content.");
  }
} finally {
  const resolved = path.resolve(fixture);
  assert.equal(path.dirname(resolved), output);
  assert(path.basename(resolved).startsWith("startup-proof-"));
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
