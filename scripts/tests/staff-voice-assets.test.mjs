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
import { CANDIDATE, SOURCE_CANDIDATE, metadata, prepareRelease, updateManifests,
  verifyArchive, writeArchive } from "../prepare-staff-voice-assets.mjs";

const names = Object.keys(CANDIDATE);
const info = bytes => ({ size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
const small = info(Buffer.from("synthetic placeholder"));
const archives = { assets_x64_0: small, rank_menu_ui: small };
const packs = Object.fromEntries(names.map(name => [name, small]));
function baseline() {
  const assets = ["assets_x64_0", "rank_menu_ui", "unchanged"].map(name => ({ name, version: "1.8.1", type: "zip",
    installPath: "Resources/Assets", url: `https://github.com/h1z1rotk/assets/releases/download/assets-v1.8.1/${name}.payload`, ...small }));
  return {
    feed: { manifestVersion: 1, packVersion: "1.8.1", assets },
    payloads: { schemaVersion: 1, kind: "asset-payloads", packVersion: "1.8.1", files: [
      ...names.map(name => ({ asset: name === "assets_x64_0.pack2" ? "assets_x64_0" : "rank_menu_ui", path: `Resources/Assets/${name}`, ...SOURCE_CANDIDATE[name] })),
      { asset: "unchanged", path: "Resources/Assets/unchanged.pack2", ...small },
    ] },
  };
}
const update = (base = baseline(), version = "1.9.0", a = archives, p = packs) => updateManifests(base.feed, base.payloads, version, a, p);
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rotk-staff-voice-release-"));
  t.after(() => {
    assert(path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith("rotk-staff-voice-release-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("updates the two existing archives without losing settings, Top Ten or unrelated catalog rows", () => {
  const base = baseline(), before = structuredClone(base), next = update(base);
  assert.deepEqual(base, before);
  assert.equal(next.feed.assets.length, base.feed.assets.length);
  assert.deepEqual(next.feed.assets[2], base.feed.assets[2]);
  assert.deepEqual(next.payloads.files[0], base.payloads.files[3]);
  assert.deepEqual(CANDIDATE["ui_x64_2.pack2"], SOURCE_CANDIDATE["ui_x64_2.pack2"]);
  assert.equal(next.payloads.files.filter(row => row.asset === "rank_menu_ui").length, 2);
  assert(next.feed.assets.slice(0,2).every(row => row.url.endsWith(".payload") && row.version === "1.9.0"));
});

test("rejects stale sources, ownership conflicts, unsafe paths and non-increasing versions", () => {
  for (const version of ["1.8.1", "1.6.0", "01.9.0", "1.9.0-beta"]) assert.throws(() => update(baseline(), version));
  for (let i=0; i<3; i++) {
    const base = baseline(); base.payloads.files[i].sha256 = "0".repeat(64);
    assert.throws(() => update(base), /source pack changed/);
  }
  const wrong = baseline(); wrong.payloads.files[1].asset = "unchanged";
  assert.throws(() => update(wrong), /ownership/);
  const duplicate = baseline(); duplicate.payloads.files.push({...duplicate.payloads.files[0], path:"resources\\assets\\ASSETS_X64_0.pack2"});
  assert.throws(() => update(duplicate), /duplicate payload/);
  const unsafe = baseline(); unsafe.payloads.files[0].path = "Resources/Assets/../outside";
  assert.throws(() => update(unsafe), /unsafe/);
  const missing = baseline(); missing.feed.assets.splice(1,1);
  assert.throws(() => update(missing), /unknown payload owner/);
  const mismatch = baseline(); mismatch.payloads.packVersion = "1.6.0";
  assert.throws(() => update(mismatch), /disagree/);
  assert.throws(() => update(baseline(), "1.9.0", {...archives, rank_menu_ui: {...small,size:2*1024**3}}), /size/);
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
  const realRelease = process.env.ROTK_STAFF_VOICE_RELEASE_PROOF;
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
    candidate = update(baseline(), "1.9.0", a, p);
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
