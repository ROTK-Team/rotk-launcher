/** Offline BR1315 menu repair recipe. No client assets or installation writes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import yazl from "yazl";

export const SOURCE_PACK_SHA256 = "bee6c209f89a8433e28b19bcf738cd0e99285bd21ae48c3258c4b99e048f60f0";
const ASSET = "ui_x64_2";
const PACK = `${ASSET}.pack2`;
const TARGET = `Resources/Assets/${PACK}`;
const MAX_PACK = 64 * 1024 ** 2;
const MAX_PANEL = 2 * 1024 ** 2;
// PreGame -> InGame name hashes. The entire retail pack is pinned above.
const PANELS = [
  [0xa93bb2a590114ac4n, 0x293a5a689a4b3cd3n], // Graphics
  [0x5b55ad2d06e2baaan, 0x274bb126894f58c0n], // Audio
  [0x27d633d439b08a03n, 0x877355c23d87e3bbn], // Gameplay
  [0x2d9ffe6e60ac2435n, 0xe99cb7f40c2dfb5en], // Keybindings
];
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function catalog(data) {
  assert(data.length >= 48 && data.length <= MAX_PACK, "unsupported pack size");
  assert.equal(data.subarray(0, 4).toString("hex"), "50414b01", "invalid pack header");
  const count = data.readUInt32LE(4);
  const offset = Number(data.readBigUInt64LE(16));
  assert.equal(data.readBigUInt64LE(8), BigInt(data.length), "invalid pack length");
  assert(Number.isSafeInteger(offset) && offset >= 48
    && offset + count * 32 === data.length, "invalid catalog bounds");
  const entries = new Map();
  let previous = -1n;
  for (let at = offset; at < data.length; at += 32) {
    const key = data.readBigUInt64LE(at);
    const start = Number(data.readBigUInt64LE(at + 8));
    const size = Number(data.readBigUInt64LE(at + 16));
    const flags = data.readUInt32LE(at + 24);
    assert(key > previous, "duplicate or unsorted catalog key");
    assert(Number.isSafeInteger(start) && Number.isSafeInteger(size)
      && start >= 48 && size >= 0 && size <= offset - start, "invalid asset bounds");
    assert([0, 1, 16, 17].includes(flags), "unsupported storage flags");
    entries.set(key, { at, start, size, flags, crc: data.readUInt32LE(at + 28) });
    previous = key;
  }
  return { offset, entries };
}

function readAsset(data, entry) {
  assert(entry, "missing settings panel");
  const stored = data.subarray(entry.start, entry.start + entry.size);
  assert.equal(zlib.crc32(stored), entry.crc, "asset CRC mismatch");
  if (entry.flags === 0 || entry.flags === 16) return stored;
  assert(stored.length >= 8 && stored.subarray(0, 4).toString("hex") === "a1b2c3d4",
    "invalid compressed asset");
  const raw = zlib.inflateSync(stored.subarray(8), { maxOutputLength: MAX_PANEL });
  assert.equal(raw.length, stored.readUInt32BE(4), "invalid inflated asset length");
  return raw;
}

function gfxTags(body) {
  assert(body.length >= 5, "truncated GFX frame header");
  let cursor = Math.ceil((5 + 4 * (body[0] >>> 3)) / 8) + 4;
  const tags = [];
  while (cursor + 2 <= body.length) {
    const start = cursor;
    const header = body.readUInt16LE(cursor);
    cursor += 2;
    let size = header & 63;
    if (size === 63) {
      assert(cursor + 4 <= body.length, "truncated GFX tag length");
      size = body.readUInt32LE(cursor);
      cursor += 4;
    }
    assert(cursor + size <= body.length, "truncated GFX tag body");
    tags.push({ code: header >>> 6, start, body: cursor, size });
    cursor += size;
    if ((header >>> 6) === 0) return tags;
  }
  assert.fail("GFX End tag missing");
}

function tag(code, body) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE((code << 6) | 63);
  header.writeUInt32LE(body.length, 2);
  return Buffer.concat([header, body]);
}

/** Low-level transform for synthetic tests; buildPatchedPack pins retail input. */
export function addTitleBackdrop(source) {
  assert(source.length >= 8 && source.subarray(0, 3).toString("ascii") === "CFX", "invalid settings GFX");
  const body = zlib.inflateSync(source.subarray(8), { maxOutputLength: MAX_PANEL });
  const tags = gfxTags(body);
  const placements = tags.filter((t) => t.code === 26);
  const frames = tags.filter((t) => t.code === 1);
  assert(placements.length === 1 && frames.length === 1, "unexpected settings root timeline");
  const placement = placements[0];
  assert(placement.size >= 3 && body[placement.body] === 38
    && body.readUInt16LE(placement.body + 1) === 1
    && placement.start < frames[0].start, "unexpected settings view placement");
  // Generated DefineShape3, character 65534: black (0,60,900,160) rectangle
  // in the native 1920x1080 canvas. The pinned inputs never use this character.
  // Put it behind m_view (depth 2) and above the parent menu's old title.
  const shape = Buffer.from("feff8000023280258089800100000000ff0010158000961f84650ed6407c5cd876ce0000", "hex");
  const changed = Buffer.from(body);
  changed.writeUInt16LE(2, placement.body + 1);
  const at = frames[0].start;
  const updated = Buffer.concat([
    changed.subarray(0, at), tag(32, shape), tag(26, Buffer.from("060100feff00", "hex")), changed.subarray(at),
  ]);
  const header = Buffer.from(source.subarray(0, 8));
  // Like retail, the declared length ends at the End tag; exporter padding stays after it.
  const end = tags.at(-1);
  header.writeUInt32LE(8 + end.body + end.size + updated.length - body.length, 4);
  return Buffer.concat([header, zlib.deflateSync(updated)]);
}

/** Append copies; retain every original payload byte and unrelated entry. */
export function replacePanels(original, pairs, transform = addTitleBackdrop) {
  const { offset, entries } = catalog(original);
  assert.equal(new Set(pairs.map(([target]) => target)).size, pairs.length, "duplicate replacement target");
  const header = Buffer.from(original.subarray(0, 32));
  const map = Buffer.from(original.subarray(offset));
  const appended = [];
  let nextOffset = offset;
  for (const [target, source] of pairs) {
    assert(target !== source && entries.has(target), "invalid replacement target");
    readAsset(original, entries.get(target)); // Refuse corrupt targets as well.
    const payload = transform(readAsset(original, entries.get(source)));
    assert(payload.length > 0 && payload.length <= MAX_PANEL, "invalid panel size");
    const at = entries.get(target).at - offset;
    map.writeBigUInt64LE(BigInt(nextOffset), at + 8);
    map.writeBigUInt64LE(BigInt(payload.length), at + 16);
    map.writeUInt32LE(0, at + 24);
    map.writeUInt32LE(zlib.crc32(payload), at + 28);
    appended.push(payload);
    nextOffset += payload.length;
  }
  header.writeBigUInt64LE(BigInt(nextOffset), 16);
  header.writeBigUInt64LE(BigInt(nextOffset + map.length), 8);
  const result = Buffer.concat([header, original.subarray(32, offset), ...appended, map]);
  const verified = catalog(result);
  for (let index = 0; index < pairs.length; index++) {
    assert(readAsset(result, verified.entries.get(pairs[index][0])).equals(appended[index]), "panel readback failed");
  }
  return { bytes: result, unchangedEntries: entries.size - pairs.length };
}

export function buildPatchedPack(original) {
  assert.equal(digest(original), SOURCE_PACK_SHA256, "unsupported source pack; nothing was patched");
  return replacePanels(original, PANELS);
}

export function updateManifests(feed, payloads, version, archive, pack) {
  const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  assert.match(version, versionPattern, "expected X.Y.Z release version");
  assert.equal(feed.manifestVersion, 1);
  assert.equal(payloads.schemaVersion, 1);
  assert.equal(payloads.kind, "asset-payloads");
  assert.equal(feed.packVersion, payloads.packVersion, "base manifests disagree");
  assert.match(feed.packVersion, versionPattern, "invalid base version");
  const old = feed.packVersion.split(".").map(BigInt);
  const next = version.split(".").map(BigInt);
  assert(next.map((value, i) => value - old[i]).find((value) => value !== 0n) > 0n, "release version must increase");
  assert(Array.isArray(feed.assets) && feed.assets.length < 64, "invalid feed asset count");
  assert(Array.isArray(payloads.files) && payloads.files.length < 20_000, "invalid payload count");
  const names = feed.assets.map((a) => a.name.toLowerCase());
  const paths = payloads.files.map((f) => f.path.replaceAll("\\", "/").toLowerCase());
  assert.equal(new Set(names).size, names.length, "duplicate feed asset");
  assert.equal(new Set(paths).size, paths.length, "duplicate payload path");
  assert(!names.includes(ASSET) && !paths.includes(TARGET.toLowerCase()), "base catalog already owns the menu pack; review that release before replacing it");
  assert(!feed.assets.some((a) => a.type === "file"
    && a.installPath.replaceAll("\\", "/").toLowerCase() === TARGET.toLowerCase()), "menu pack target already owned");
  assert(payloads.files.every((f) => names.includes(f.asset.toLowerCase())), "payload refers to an unknown asset");
  assert(names.every((name) => payloads.files.some((f) => f.asset.toLowerCase() === name)), "asset is missing payload metadata");
  for (const row of [archive, pack, ...payloads.files]) {
    assert.match(row.sha256, /^[a-f0-9]{64}$/);
    assert(Number.isSafeInteger(row.size) && row.size > 0 && row.size <= 3 * 1024 ** 3, "invalid payload size");
  }
  assert(archive.size < 2 * 1024 ** 3, "archive exceeds the GitHub release limit");
  assert(payloads.files.reduce((sum, file) => sum + file.size, pack.size) <= 8 * 1024 ** 3, "payloads exceed the launcher limit");
  return {
    feed: { ...feed, packVersion: version, assets: [...feed.assets, {
      name: ASSET, version, type: "zip", installPath: "Resources/Assets",
      // The nonconventional suffix keeps releases/latest from overriding the
      // explicit entry before feed + payload manifest + server policy are ready.
      url: `https://github.com/h1z1rotk/assets/releases/download/assets-v${version}/${ASSET}.payload`,
      size: archive.size, sha256: archive.sha256,
    }] },
    payloads: { ...payloads, packVersion: version, files: [...payloads.files, {
      asset: ASSET, path: TARGET, size: pack.size, sha256: pack.sha256,
    }] },
  };
}

export async function writeArchive(packPath, archivePath) {
  const zip = new yazl.ZipFile();
  zip.addFile(packPath, PACK, { mtime: new Date("2020-01-01T00:00:00Z"), mode: 0o100644 });
  const completed = pipeline(zip.outputStream, fs.createWriteStream(archivePath, { flags: "wx" }));
  zip.end({ forceZip64Format: false });
  await completed;
}

export async function prepareRelease({ source, feedPath, payloadPath, output, version }) {
  assert(fs.statSync(source).size <= MAX_PACK, "unsupported source pack size");
  const original = fs.readFileSync(source);
  const { bytes, unchangedEntries } = buildPatchedPack(original);
  const json = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  const feed = json(feedPath);
  const payloads = json(payloadPath);
  const pack = { size: bytes.length, sha256: digest(bytes) };
  updateManifests(feed, payloads, version, { size: 1, sha256: "0".repeat(64) }, pack);
  fs.mkdirSync(output); // Exclusive, so a game or an existing staging tree is never changed.
  const packPath = path.join(output, PACK);
  fs.writeFileSync(packPath, bytes, { flag: "wx" });
  const archivePath = path.join(output, `${ASSET}.payload`);
  await writeArchive(packPath, `${archivePath}.partial`);
  fs.renameSync(`${archivePath}.partial`, archivePath);
  const archiveBytes = fs.readFileSync(archivePath);
  const archive = { size: archiveBytes.length, sha256: digest(archiveBytes) };
  const next = updateManifests(feed, payloads, version, archive, pack);
  const report = { sourceSha256: digest(original), unchangedEntries, packVersion: version, pack, archive, published: false };
  for (const [name, data] of [["feed.json", next.feed], ["asset-payloads.v1.json", next.payloads], ["verification.json", report]]) {
    fs.writeFileSync(path.join(output, name), `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, feedPath, payloadPath, output, version, ...extra] = process.argv.slice(2);
  if (![source, feedPath, payloadPath, output, version].every(Boolean) || extra.length) {
    console.error("Usage: node scripts/prepare-menu-settings-assets.mjs <retail-ui_x64_2.pack2> <current-feed.json> <current-payloads.json> <new-output-directory> <X.Y.Z>");
    process.exitCode = 2;
  } else {
    prepareRelease({ source, feedPath, payloadPath, output, version }).then((report) => {
      console.log(JSON.stringify(report, null, 2));
      console.log("Prepared only. Coordinate server integrity policy, then publish the .payload ZIP and both manifests to h1z1rotk/assets.");
    }).catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
