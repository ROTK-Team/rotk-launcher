import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { buildSync } from "esbuild";
import { addTitleBackdrop, buildPatchedPack, digest, prepareRelease, replacePanels,
  updateManifests, writeArchive } from "../prepare-menu-settings-assets.mjs";

function tag(code, bytes = Buffer.alloc(0)) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE((code << 6) | 63);
  header.writeUInt32LE(bytes.length, 2);
  return Buffer.concat([header, bytes]);
}

function syntheticPanel() {
  // Invented GFX root with a script marker and exporter padding, no game assets.
  const frame = Buffer.from([8, 0, 0, 24, 1, 0]);
  const placement = tag(26, Buffer.from("2601002a00006d5f7669657700", "hex"));
  const script = tag(82, Buffer.from("synthetic native-bindings marker"));
  const beforeFrame = Buffer.concat([frame, script, placement]);
  const padding = Buffer.from("synthetic exporter padding");
  const body = Buffer.concat([beforeFrame, tag(1), tag(0), padding]);
  const header = Buffer.from("4346580900000000", "hex");
  header.writeUInt32LE(body.length + 8 - padding.length, 4);
  return { source: Buffer.concat([header, zlib.deflateSync(body)]), body,
    placement: frame.length + script.length + 6, insertion: beforeFrame.length };
}

function fixturePack() {
  const header = Buffer.alloc(48, 0x51);
  header.write("PAK\x01", 0, "binary");
  header.writeUInt32LE(9, 4);
  const map = Buffer.alloc(9 * 32);
  const payloads = [];
  const raw = [];
  let offset = 48;
  for (let index = 0; index < 9; index++) {
    const data = index < 8 && index % 2 === 1 ? syntheticPanel().source : Buffer.from(`synthetic asset ${index}`);
    const flags = [0, 1, 16, 17][index % 4];
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const stored = flags % 2 ? Buffer.concat([Buffer.from("a1b2c3d4", "hex"), length, zlib.deflateSync(data)]) : data;
    map.writeBigUInt64LE(BigInt(index + 1), index * 32);
    map.writeBigUInt64LE(BigInt(offset), index * 32 + 8);
    map.writeBigUInt64LE(BigInt(stored.length), index * 32 + 16);
    map.writeUInt32LE(flags, index * 32 + 24);
    map.writeUInt32LE(zlib.crc32(stored), index * 32 + 28);
    payloads.push(stored);
    raw.push(data);
    offset += stored.length;
  }
  header.writeBigUInt64LE(BigInt(offset), 16);
  header.writeBigUInt64LE(BigInt(offset + map.length), 8);
  return { bytes: Buffer.concat([header, ...payloads, map]), raw, mapOffset: offset,
    pairs: [[1n, 2n], [3n, 4n], [5n, 6n], [7n, 8n]] };
}

test("backdrop moves only the root depth and preserves scripts, frame bounds and exporter padding", () => {
  const f = syntheticPanel();
  const patched = addTitleBackdrop(f.source);
  const body = zlib.inflateSync(patched.subarray(8));
  assert.equal(patched.readUInt32LE(4), body.length + 8);
  assert.equal(body.readUInt16LE(f.placement + 1), 2);
  const added = body.length - f.body.length;
  assert.equal(body.readUInt16LE(f.insertion) >>> 6, 32, "first insertion defines the backdrop");
  const shapeSize = body.readUInt32LE(f.insertion + 2);
  assert.equal(body.readUInt16LE(f.insertion + 6), 65534, "backdrop character");
  assert.equal(body.readUInt16LE(f.insertion + 6 + shapeSize) >>> 6, 26);
  assert.equal(body.subarray(f.insertion + 12 + shapeSize, f.insertion + added).toString("hex"), "060100feff00");
  const restored = Buffer.concat([body.subarray(0, f.insertion), body.subarray(f.insertion + added)]);
  restored.writeUInt16LE(1, f.placement + 1);
  assert(restored.equals(f.body), "all original bytes survive, apart from the root depth");
  assert.throws(() => addTitleBackdrop(patched), /root timeline/, "double application is refused");
});

test("rejects unsupported GFX roots and truncated tags", () => {
  const f = syntheticPanel();
  assert.throws(() => addTitleBackdrop(Buffer.from("not a movie")), /GFX/);
  const altered = Buffer.from(f.body);
  altered[f.placement] = 0;
  const movie = (body) => Buffer.concat([f.source.subarray(0, 8), zlib.deflateSync(body)]);
  assert.throws(() => addTitleBackdrop(movie(altered)), /placement/);
  assert.throws(() => addTitleBackdrop(movie(f.body.subarray(0, 10))), /truncated/);
});

test("all four replacements preserve the original data and every other catalog entry", () => {
  const f = fixturePack();
  const original = Buffer.from(f.bytes);
  const result = replacePanels(f.bytes, f.pairs);
  assert.equal(result.unchangedEntries, 5);
  assert(f.bytes.equals(original), "source buffer is immutable");
  assert(result.bytes.subarray(32, f.mapOffset).equals(original.subarray(32, f.mapOffset)));
  const offset = Number(result.bytes.readBigUInt64LE(16));
  const restoredMap = Buffer.from(result.bytes.subarray(offset));
  for (const [target, source] of f.pairs) {
    const at = Number(target - 1n) * 32;
    const start = Number(restoredMap.readBigUInt64LE(at + 8));
    const size = Number(restoredMap.readBigUInt64LE(at + 16));
    assert.equal(restoredMap.readUInt32LE(at + 24), 0);
    assert(result.bytes.subarray(start, start + size).equals(addTitleBackdrop(f.raw[Number(source - 1n)])));
    original.copy(restoredMap, at, f.mapOffset + at, f.mapOffset + at + 32);
  }
  assert(restoredMap.equals(original.subarray(f.mapOffset)));
});

test("rejects corrupted containers and refuses unrecognized retail input", () => {
  const f = fixturePack();
  assert.throws(() => buildPatchedPack(f.bytes), /unsupported source pack/);
  const crc = Buffer.from(f.bytes);
  crc[48] ^= 1;
  assert.throws(() => replacePanels(crc, f.pairs), /CRC/);
  const bounds = Buffer.from(f.bytes);
  bounds.writeBigUInt64LE(BigInt(f.bytes.length), f.mapOffset + 8);
  assert.throws(() => replacePanels(bounds, f.pairs), /bounds/);
  const duplicate = Buffer.from(f.bytes);
  duplicate.writeBigUInt64LE(1n, f.mapOffset + 32);
  assert.throws(() => replacePanels(duplicate, f.pairs), /unsorted/);
  assert.throws(() => replacePanels(f.bytes, [...f.pairs, f.pairs[0]]), /duplicate/);
});

const metadata = (bytes) => ({ size: bytes.length, sha256: digest(bytes) });
function manifests() {
  const file = metadata(Buffer.from("unchanged"));
  return {
    feed: { manifestVersion: 1, packVersion: "1.6.0", assets: [
      { name: "existing", version: "1.3.0", type: "file", installPath: "Resources/Audio/old.bnk",
        url: "https://github.com/h1z1rotk/assets/releases/download/assets-v1.3.0/old.payload", ...file },
    ] },
    payloads: { schemaVersion: 1, kind: "asset-payloads", packVersion: "1.6.0",
      files: [{ asset: "existing", path: "Resources/Audio/old.bnk", ...file }] },
  };
}

test("adds the menu pack without dropping or mutating existing feed/payload entries", () => {
  const { feed, payloads } = manifests();
  const before = structuredClone({ feed, payloads });
  const archive = metadata(Buffer.from("zip"));
  const pack = metadata(Buffer.from("pack"));
  const result = updateManifests(feed, payloads, "1.6.2", archive, pack);
  assert.deepEqual({ feed, payloads }, before);
  assert.deepEqual(result.feed.assets.slice(0, -1), feed.assets);
  assert.deepEqual(result.payloads.files.slice(0, -1), payloads.files);
  assert.equal(result.feed.packVersion, result.payloads.packVersion);
  const entry = result.feed.assets.at(-1);
  assert.equal(entry.type, "zip");
  assert.equal(entry.installPath, "Resources/Assets");
  assert.equal(entry.sha256, archive.sha256);
  assert.equal(result.payloads.files.at(-1).sha256, pack.sha256);
  assert(entry.url.endsWith("/assets-v1.6.2/ui_x64_2.payload"));
});

test("rejects mismatched versions, existing menu ownership and broken metadata", () => {
  const { feed, payloads } = manifests();
  const file = metadata(Buffer.from("test"));
  const update = (f = feed, p = payloads, v = "1.6.2") => updateManifests(f, p, v, file, file);
  for (const version of ["1.6.0", "1.5.9", "1.6.2-dev", "01.6.2"]) assert.throws(() => update(feed, payloads, version));
  assert.throws(() => update(feed, { ...payloads, packVersion: "1.5.0" }), /disagree/);
  const published = update();
  assert.throws(() => update(published.feed, published.payloads, "1.6.3"), /already owns/);
  assert.throws(() => update({ ...feed, assets: [...feed.assets, { ...feed.assets[0], name: "UI_X64_2" }] }), /already owns/);
  assert.throws(() => update(feed, { ...payloads, files: [...payloads.files,
    { ...payloads.files[0], path: "resources\\assets\\UI_X64_2.pack2" }] }), /already owns/);
  assert.throws(() => update(feed, { ...payloads, files: [] }), /missing payload/);
  assert.throws(() => update(feed, { ...payloads, files: [{ ...payloads.files[0], asset: "unknown" }] }), /unknown asset/);
  assert.throws(() => updateManifests(feed, payloads, "1.6.2", file, { ...file, size: 0 }), /size/);
});

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rotk-menu-recipe-"));
  t.after(() => {
    assert(path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith("rotk-menu-recipe-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("CLI preparation refuses unknown input before creating output", async (t) => {
  const dir = temporary(t);
  const source = path.join(dir, "source.pack2");
  const output = path.join(dir, "out");
  fs.writeFileSync(source, fixturePack().bytes);
  const before = fs.readFileSync(source);
  await assert.rejects(prepareRelease({ source, feedPath: "unused", payloadPath: "unused", output, version: "1.6.2" }), /unsupported source pack/);
  assert(!fs.existsSync(output));
  assert(fs.readFileSync(source).equals(before));
});

test("real launcher installs generated .payload ZIP, repairs corruption and restores the original", async (t) => {
  const dir = temporary(t);
  const project = fileURLToPath(new URL("../../", import.meta.url));
  // Bundle the production service; no Electron UI should be touched in this test.
  const stub = path.join(dir, "electron.mjs");
  fs.writeFileSync(stub, "export const app = new Proxy({}, {get(){throw Error('Unexpected Electron UI access')}});");
  const bundle = path.join(dir, "asset-sync.cjs");
  buildSync({ entryPoints: [path.join(project, "electron/services/asset-sync.ts")], outfile: bundle,
    bundle: true, platform: "node", format: "cjs", alias: { electron: stub } });
  const { AssetSyncService, ASSET_FEED_URL } = createRequire(import.meta.url)(bundle);
  const fixture = fixturePack();
  const pack = replacePanels(fixture.bytes, fixture.pairs).bytes;
  const staged = path.join(dir, "ui_x64_2.pack2");
  const zipped = path.join(dir, "ui_x64_2.payload");
  fs.writeFileSync(staged, pack);
  await writeArchive(staged, zipped);
  const archive = fs.readFileSync(zipped);
  const base = manifests();
  const candidate = updateManifests(base.feed, base.payloads, "1.6.2", metadata(archive), metadata(pack));
  const entry = candidate.feed.assets.at(-1);
  const root = path.join(dir, "client");
  const installed = path.join(root, "Resources/Assets/ui_x64_2.pack2");
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(path.join(root, ".rotk-installation.json"), "{}");
  fs.writeFileSync(installed, fixture.bytes);
  let downloads = 0;
  const sync = new AssetSyncService({ userDataDirectory: path.join(dir, "userdata"), fetchImpl: async (input) => {
    const url = String(input);
    if (url === ASSET_FEED_URL) return Response.json({ ...candidate.feed, assets: [entry] });
    assert.equal(url, entry.url, "unexpected network request");
    downloads++;
    return new Response(archive);
  } });
  assert.equal((await sync.sync(root)).status, "updated");
  assert.equal(digest(fs.readFileSync(installed)), candidate.payloads.files.at(-1).sha256);
  assert.equal((await sync.sync(root)).status, "up-to-date");
  const broken = Buffer.from(pack);
  broken[48] ^= 1;
  fs.writeFileSync(installed, broken);
  assert.equal((await sync.verify(root)).status, "updated");
  assert(fs.readFileSync(installed).equals(pack));
  assert.equal(downloads, 1, "repair reuses the verified archive cache");
  await sync.restore(root);
  assert(fs.readFileSync(installed).equals(fixture.bytes));
  assert.equal(await sync.readState(), null);
});
