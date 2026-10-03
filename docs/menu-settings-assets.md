# Main-menu settings asset update (BR1315)

On the affected client, Graphics, Audio, Gameplay and Keybindings open from the
main menu but their controls do not work correctly until entering a game. The
repair uses copies of the complete InGame panels for the four PreGame entries in
`ui_x64_2.pack2`. A generated black backdrop hides the overlapping parent title;
the original panel scripts, native bindings and frame bounds are preserved.

The launcher already distributes this pack through `h1z1rotk/assets`. A server
deployment or merging this preparation tool does **not** deliver the changed
client file. No new launcher executable is required. The asset release and the
matching server integrity policy still need an operator to publish them.

## Prepare a candidate

Requirements: Node.js 22.16 or newer, `npm ci`, a supported unmodified BR1315
`Resources/Assets/ui_x64_2.pack2`, and about 250 MB free outside the game/repository.
The script refuses every source except SHA-256
`bee6c209f89a8433e28b19bcf738cd0e99285bd21ae48c3258c4b99e048f60f0`.
It never modifies the supplied game pack.

Download fresh `feed.json` and `asset-payloads.v1.json` from the **same commit** of
`h1z1rotk/assets/main`. Choose an unused stable version above their `packVersion`.
In PowerShell (replace the sample paths and version):

```powershell
npm run assets:prepare-menu-settings -- `
  'D:\Retail\Resources\Assets\ui_x64_2.pack2' `
  'D:\Staging\current\feed.json' `
  'D:\Staging\current\asset-payloads.v1.json' `
  'D:\Staging\menu-settings-1.6.2' `
  1.6.2
```

The output directory must not exist. It contains:

- `ui_x64_2.pack2`: the rebuilt pack; only four of 975 catalog entries change.
- `ui_x64_2.payload`: a normal deflated ZIP with the single root entry
  `ui_x64_2.pack2`, installed under `Resources/Assets`.
- `feed.json` and `asset-payloads.v1.json`: the complete existing catalogs plus
  the new pack, sharing the chosen version and recording the actual archive and
  installed-file sizes/hashes separately.
- `verification.json`: source hash, output hashes and count of preserved entries.

The `.payload` suffix is deliberate: launchers up to 2.0.23 discover conventional
`foo.zip` assets of `releases/latest` automatically, whereas this archive is
installed only through its explicit `type: "zip"` feed entry. Do not rename it to
`.zip`. On those launchers, publishing a stable release can still change the
effective `packVersion`, so coordinate that publication with the policy as well
as the feed update.

All existing catalog rows are preserved, including unrelated pending fixes
already present in the input. If another update lands first, regenerate from
fresh manifests and use a new version. The script refuses catalogs that already
own this menu pack; review their contents instead of overwriting another fix.
Do not replace the full catalog with a one-pack feed: removal uninstalls assets.

Compression bytes can differ between Node/zlib versions. Use the hashes generated
for **that exact candidate** in its manifests and policy; never mix an archive
from one run with hashes from another.

## Validate and publish

`npm run test:assets:menu-settings` runs eight synthetic regression tests and is
included in `npm test`. They check title/depth edits without changing script or
padding bytes, preservation of unrelated catalog/data bytes, corrupt input
refusal, manifest ownership/version guards and the real launcher's install,
repeat-sync, corruption-repair and vanilla-restore path with a generated ZIP.
The integration test supplies local HTTP responses and an Electron app stub that
throws if accessed; it does not launch the desktop app or touch a real client.

The original repair was tested in game on all four settings pages at 1440x900
and 1366x768, with 16 save/reopen assertions and a full-client restart persistence
check. The synthetic suite is not a substitute for checking a release candidate
on a fresh installation.

1. Review the current server integrity mode and accepted launcher versions. Build
   the policy for the new payload manifest and the actual supported launcher DLL
   overrides. Keep the production enforcement mode; do not bypass integrity to
   ship the asset. The signed retail base manifest stays unchanged.
2. Create a **draft** `assets-vX.Y.Z` release on `h1z1rotk/assets` and attach the
   generated `ui_x64_2.payload`. Do not commit game packs, ZIPs, screenshots or
   captures to this launcher repo. Only the recipe belongs here.
3. In a coordinated rollout, publish the release and commit the two generated
   manifests together to the assets repo, with the prepared server policy. Verify
   the public archive URL, size and SHA-256. The server policy publisher must
   validate the live feed and latest-release overlay before applying its policy;
   an offline computed root alone is insufficient. Keep server-only attestation
   roots/private policy material out of public repositories.
4. On a previously unmodified ROTK installation with asset sync enabled, launch
   or use **Verify files**. Verify all four pages, change/save/reopen a setting,
   restart to check persistence, and confirm no integrity rejection.

For rollback, coordinate a newer feed/policy release that removes this entry
and its payload metadata (restoring the launcher's original backup), or supplies
the approved replacement. Review the latest-release overlay at the same time.
