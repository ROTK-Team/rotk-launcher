# Asset packs — publishing custom assets through the dedicated GitHub repo

Issue: [#10](https://github.com/h1z1rotk/rotk-launcher/issues/10)

For the combined BR1315 rank menu, staff gate and settings update, use the
[rank menu release recipe](rank-menu-assets.md). Its three packs must be published
through the coordinated `.payload` archives and paired manifests described there.

## 1. Overview

The launcher synchronizes custom ROTK assets from a dedicated GitHub repository
(`h1z1rotk/assets`) before every launch and right after an installation, without
requiring a launcher release. The pipeline is implemented by
`electron/services/asset-sync.ts` (+ `electron/services/zip-archive.ts`):

1. Fetch `feed.json` from
   `https://raw.githubusercontent.com/h1z1rotk/assets/main/feed.json`
   (HTTPS only, 10 s timeout, 1 MB cap).
2. Diff the catalog against the local state (`asset-state.v1.json` in the launcher `userData`):
   an asset is (re)installed when it is new, its `version`/`sha256` changed, or one of
   its installed files is missing (the **Verify files** action additionally re-hashes
   every installed file).
3. Download into `userData/asset-cache/` (a cached pack with the right SHA-256 is
   reused without any network call), verify the streamed SHA-256 against the manifest,
   then install atomically (staging file + `rename`) into the ROTK installation.
4. Client files overwritten for the first time are backed up under
   `userData/asset-backups/` — **Restore vanilla client** puts them back and deletes
   everything the catalog added.
5. Assets removed from the catalog are uninstalled on the next sync (backup restored
   or file deleted).

Metadata that cannot be fetched **never blocks the game** once a first sync completed:
the launcher shows a warning and starts with the assets already on disk. Only a first
sync that never completed is blocking (players can also disable the sync entirely in
the setup panel — offline/dev mode).

## 2. The `h1z1rotk/assets` repository

- `feed.json` at the root of `main` — the always-current manifest.
- Binaries attached as **GitHub Release assets** (never committed): stable URLs, no
  git size limits.
- Only what `feed.json` lists is installed. The launcher no longer reads the
  GitHub releases API (it was rate-limited to 60 requests/hour per IP, and a pack
  missing from the feed would also be missing from the attestation payloads).
- Keep naming release payloads `*.payload`, not `*.zip`: launchers up to 2.0.23
  still pick up any `foo.zip` of the latest release on their own.

## 3. Manifest format

```json
{
  "manifestVersion": 1,
  "packVersion": "1.0.0",
  "assets": [
    {
      "name": "rotk-ui-pack",
      "version": "1.0.0",
      "url": "https://github.com/h1z1rotk/assets/releases/download/assets-v1.0.0/rotk-ui-pack.payload",
      "sha256": "<sha256 of the archive>",
      "size": 12345678,
      "installPath": ".",
      "type": "zip"
    },
    {
      "name": "rotk-sound-bank",
      "version": "1.0.0",
      "url": "https://github.com/h1z1rotk/assets/releases/download/assets-v1.0.0/rotk-sounds.pack",
      "sha256": "<sha256 of the file>",
      "size": 4567890,
      "installPath": "Resources/Assets/rotk-sounds.pack",
      "type": "file"
    }
  ]
}
```

- `installPath` is **relative to the ROTK installation root**, `/`-separated.
  `type: "zip"` extracts the archive at `installPath` (`"."` = root);
  `type: "file"` copies the payload as-is to `installPath`.
- `sha256` is the hash of the downloaded file (before extraction), `size` its exact
  byte count (enforced during the stream).
- `version` drives re-installation: bump it (or just change `sha256`) whenever the
  payload changes. `packVersion` is informational and shown in the launcher UI.

## 4. Validation rules (enforced by the launcher)

The launcher refuses the whole pack if any rule fails — nothing is written halfway:

- URLs: `https://` only, hosts limited to `github.com` / `raw.githubusercontent.com`
  (redirects may only land on `objects.githubusercontent.com` /
  `release-assets.githubusercontent.com`).
- Paths (manifest `installPath` **and** every zip entry): no absolute paths, no `..`,
  no `\`, no alternate data streams (`:`), no Windows reserved device names, no
  trailing dots/spaces, no `steam`/`steamapps`/`steamlibrary`/`common`/`battleye`
  segments.
- Protected targets: `H1Z1.exe`, `ClientConfig.ini`, `steam_api64.dll`,
  `.rotk-installation.json` and any `*.original.*` backup can never be overwritten.
- **No executable content**: `.exe`, `.dll`, `.sys`, `.bat`, `.cmd`, `.ps1`, `.msi`,
  `.scr`, `.com`, `.vbs`, `.lnk` are rejected. Sensitive binaries stay in the signed
  launcher (`resources/patches/`), never in the feed.
- Zips: plain store/deflate central-directory archives only (no zip64, no encryption),
  ≤ 20 000 entries, per-entry and total uncompressed sizes are bounded and enforced
  during inflation (zip-bomb guard).
- Sizes: ≤ 3 GB per asset (also bounds a single extracted zip entry — the main
  game pack is 2.47 GB uncompressed), ≤ 8 GB total. GitHub caps each release
  asset at 2 GiB, which is why big packs ship compressed, one zip per pack.

## 5. Publishing checklist

For the staff-only **O** panel hotfix, use the
[dedicated preparation tool](admin-panel-assets.md). It preserves the unchanged
entries in the current feed and payload manifest while rebuilding only
`assets_x64_0.pack2`. The general packager below generates a catalog from its
input directory; do not replace the live catalog with a one-pack catalog when
other packs must remain installed.

For the four main-menu settings pages and overlapping titles, use the
[menu settings preparation tool](menu-settings-assets.md). It adds the repaired
`ui_x64_2.pack2` to the current feed and payload manifest without removing other
assets. This update uses an explicit `.payload` ZIP entry and requires publishing
both manifests and coordinating the server integrity policy; merging the tool
alone does not distribute the fix.

1. Run `scripts/package-asset-packs.ps1 -SourceDirectory <packs dir>
   -OutputDirectory <out> -PackVersion X.Y.Z`. It zips **each file into its own
   `.payload` archive**, enforces the section 4 caps, and writes both `feed.json` and the
   attestation payload manifest.
2. Create the stable GitHub release `assets-vX.Y.Z` on `h1z1rotk/assets` and attach
   the generated `.payload` files.
3. Commit both `feed.json` and `asset-payloads.v1.json` to `main`, together.
4. Publish the attestation payload manifest with the server policy.
5. At the next launch or **Verify files**, missing or changed packs are downloaded.
   To roll back, commit the previous `feed.json` and payload manifest.

Manual fallback: build payloads yourself (avoid blocked extensions and
protected paths), `Get-FileHash -Algorithm SHA256`, then edit `feed.json` by
hand (bump `version` per changed asset and `packVersion`).

## 6. Launcher UX

- The pre-launch sync reports progress in the footer (`UPDATING ASSETS — n%`);
  the setup panel shows the pack version, warnings, a **Verify files** (repair) and a
  **Restore vanilla client** action, plus the automatic-sync toggle (persisted in
  `config.v1.json` as `assetSyncEnabled`).
