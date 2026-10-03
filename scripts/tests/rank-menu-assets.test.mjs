import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildSync } from "esbuild";
import { CANDIDATE, SOURCE_PACK_SHA256, metadata, prepareRelease, updateManifests,
  verifyArchive, writeArchive } from "../prepare-rank-menu-assets.mjs";

const names = Object.keys(CANDIDATE);
const info = bytes => ({ size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
const small = info(Buffer.from("synthetic placeholder"));
const archives = { assets_x64_0: small, rank_menu_ui: small };
const packs = Object.fromEntries(names.map(name => [name, small]));
function baseline() {
  const assets = ["assets_x64_0", "unchanged"].map(name => ({ name, version: "1.6.0", type: "zip",
    installPath: "Resources/Assets", url: `https://github.com/h1z1rotk/assets/releases/download/assets-v1.6.0/${name}.zip`, ...small }));
  return {
    feed: { manifestVersion: 1, packVersion: "1.6.0", assets },
    payloads: { schemaVersion: 1, kind: "asset-payloads", packVersion: "1.6.0", files: [
      { asset: "assets_x64_0", path: "Resources/Assets/assets_x64_0.pack2", size: 2479085469, sha256: SOURCE_PACK_SHA256 },
      { asset: "unchanged", path: "Resources/Assets/unchanged.pack2", ...small },
    ] },
  };
}
const update = (base = baseline(), version = "1.7.0", a = archives, p = packs) =>
  updateManifests(base.feed, base.payloads, version, a, p);
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rotk-rank-release-"));
  t.after(() => {
    assert(path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith("rotk-rank-release-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("coordinated manifests preserve the existing catalog and assign both UI packs to one archive", () => {
  const base = baseline(), before = structuredClone(base), next = update(base);
  assert.deepEqual(base, before);
  assert.deepEqual(next.feed.assets[1], base.feed.assets[1]);
  assert.deepEqual(next.payloads.files[0], base.payloads.files[1]);
  assert.equal(next.feed.packVersion, next.payloads.packVersion);
  assert.equal(next.feed.assets.length, 3);
  assert.deepEqual(next.payloads.files.filter(f => f.asset === "rank_menu_ui").map(f => f.path),
    ["Resources/Assets/ui_x64_0.pack2", "Resources/Assets/ui_x64_2.pack2"]);
  for (const entry of [next.feed.assets[0], next.feed.assets[2]]) assert(entry.url.endsWith(`${entry.name}.payload`));
});

test("refuses stale, published admin/settings or overlapping releases instead of overwriting fixes", () => {
  for (const version of ["1.6.0", "1.5.9", "01.7.0", "1.7.0-rc"]) assert.throws(() => update(baseline(), version));
  const changed = baseline(); changed.payloads.files[0].sha256 = "0".repeat(64);
  assert.throws(() => update(changed), /main pack changed/);
  const mismatch = baseline(); mismatch.payloads.packVersion = "1.5.0";
  assert.throws(() => update(mismatch), /disagree/);
  const settings = baseline();
  settings.feed.assets.push({ ...settings.feed.assets[1], name: "UI_X64_2" });
  settings.payloads.files.push({ asset: "UI_X64_2", path: "Resources/Assets/UI_X64_2.pack2", ...small });
  assert.throws(() => update(settings), /already owns/);
  const alias = baseline(); alias.payloads.files.push({ asset: "unchanged", path: "resources\\assets\\UI_X64_0.pack2", ...small });
  assert.throws(() => update(alias), /already owns/);
  assert.throws(() => update(update(), "1.8.0"), /already owns/);
});

test("refuses invalid ownership, unsafe paths, duplicate payloads and oversized releases", () => {
  const duplicate = baseline(); duplicate.payloads.files.push({ ...duplicate.payloads.files[0], path: "resources\\assets\\ASSETS_X64_0.pack2" });
  assert.throws(() => update(duplicate), /duplicate payload/);
  const missing = baseline(); missing.payloads.files.pop();
  assert.throws(() => update(missing), /missing payload/);
  const unknown = baseline(); unknown.payloads.files[1].asset = "missing";
  assert.throws(() => update(unknown), /unknown payload owner/);
  for (const target of ["../outside", "C:/outside", "Resources/Assets/../x", "Elsewhere/x"]) {
    const bad = baseline(); bad.payloads.files[1].path = target;
    assert.throws(() => update(bad), /unsafe|outside/);
  }
  assert.throws(() => update(baseline(), "1.7.0", { ...archives, rank_menu_ui: { ...small, size: 2 * 1024 ** 3 } }), /size/);
  assert.throws(() => update(baseline(), "1.7.0", archives, Object.fromEntries(names.map(n => [n, { ...small, size: 3 * 1024 ** 3 }]))), /payload limit/);
});

test("production preparation rejects unreviewed packs before creating output or changing inputs", async t => {
  const dir = temporary(t), output = path.join(dir, "output");
  for (const name of names) fs.writeFileSync(path.join(dir, name), name);
  await assert.rejects(prepareRelease({ directory: dir, output }), /unsupported candidate size/);
  assert(!fs.existsSync(output));
  for (const name of names) assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), name);
});

test("archive readback verifies every decompressed name, size and SHA-256", async t => {
  const dir = temporary(t), expected = {};
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), Buffer.from(`invented pack: ${name}`));
    expected[name] = await metadata(path.join(dir, name));
  }
  const archive = path.join(dir, "test.payload");
  await writeArchive(dir, names, archive);
  await verifyArchive(archive, expected);
  await assert.rejects(verifyArchive(archive, { ...expected, "missing.pack2": small }), /missing archive/);
  await assert.rejects(verifyArchive(archive, { [names[0]]: expected[names[0]] }), /unexpected archive/);
  await assert.rejects(verifyArchive(archive, { ...expected, [names[0]]: { ...expected[names[0]], sha256: "0".repeat(64) } }), /SHA-256/);
  await assert.rejects(writeArchive(dir, names, archive), /EEXIST/);
});

test("real launcher installs all three packs, skips repeat sync, repairs corruption, restores originals", async t => {
  const dir = temporary(t), project = fileURLToPath(new URL("../../", import.meta.url));
  const stub = path.join(dir, "electron.mjs"), bundle = path.join(dir, "asset-sync.cjs");
  fs.writeFileSync(stub, "export const app = new Proxy({}, {get(){throw Error('Unexpected Electron UI access')}});");
  buildSync({ entryPoints: [path.join(project, "electron/services/asset-sync.ts")], outfile: bundle,
    bundle: true, platform: "node", format: "cjs", alias: { electron: stub } });
  const { AssetSyncService, ASSET_FEED_URL } = createRequire(import.meta.url)(bundle);
  const realRelease = process.env.ROTK_RANK_RELEASE_PROOF;
  let candidate, archiveDir;
  if (realRelease) {
    archiveDir = path.resolve(realRelease);
    candidate = { feed: JSON.parse(fs.readFileSync(path.join(archiveDir, "feed.json"))),
      payloads: JSON.parse(fs.readFileSync(path.join(archiveDir, "asset-payloads.v1.json"))) };
    for (const name of names) assert.deepEqual(
      (({ size, sha256 }) => ({ size, sha256 }))(candidate.payloads.files.find(row => row.path === `Resources/Assets/${name}`)), CANDIDATE[name]);
  } else {
    archiveDir = dir;
    const p = {};
    for (const name of names) { fs.writeFileSync(path.join(dir, name), `synthetic updated ${name}`); p[name] = await metadata(path.join(dir, name)); }
    await writeArchive(dir, [names[0]], path.join(dir, "assets_x64_0.payload"));
    await writeArchive(dir, names.slice(1), path.join(dir, "rank_menu_ui.payload"));
    const a = {};
    for (const asset of Object.keys(archives)) a[asset] = await metadata(path.join(dir, `${asset}.payload`));
    candidate = update(baseline(), "1.7.0", a, p);
  }
  const changed = candidate.feed.assets.filter(a => Object.hasOwn(archives, a.name));
  const client = path.join(dir, "client"), assets = path.join(client, "Resources/Assets");
  fs.mkdirSync(assets, { recursive: true }); fs.writeFileSync(path.join(client, ".rotk-installation.json"), "{}");
  const originals = Object.fromEntries(names.map(name => [name, Buffer.from(`synthetic original ${name}`)]));
  for (const [name, bytes] of Object.entries(originals)) fs.writeFileSync(path.join(assets, name), bytes);
  let downloads = 0;
  const sync = new AssetSyncService({ userDataDirectory: path.join(dir, "userdata"), fetchImpl: async input => {
    const url = String(input);
    if (url === ASSET_FEED_URL) return Response.json({ ...candidate.feed, assets: changed });
    const asset = changed.find(a => a.url === url);
    assert(asset, "unexpected network request"); downloads++;
    return new Response(Readable.toWeb(fs.createReadStream(path.join(archiveDir, `${asset.name}.payload`))));
  } });
  const checkPacks = async () => {
    for (const name of names) {
      const row = candidate.payloads.files.find(f => f.path === `Resources/Assets/${name}`);
      assert.deepEqual(await metadata(path.join(assets, name)), { size: row.size, sha256: row.sha256 });
    }
  };
  assert.equal((await sync.sync(client)).status, "updated"); await checkPacks();
  assert.equal(downloads, 2);
  assert.equal((await sync.sync(client)).status, "up-to-date");
  for (const name of names) {
    const file = fs.openSync(path.join(assets, name), "r+");
    try { fs.writeSync(file, Buffer.from([0xff]), 0, 1, 0); } finally { fs.closeSync(file); }
  }
  assert.equal((await sync.verify(client)).status, "updated"); await checkPacks();
  assert.equal(downloads, 2, "corruption repair reuses both verified archive caches");
  await sync.restore(client);
  for (const name of names) assert(fs.readFileSync(path.join(assets, name)).equals(originals[name]));
  assert.equal(await sync.readState(), null);
});
