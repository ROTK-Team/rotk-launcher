# Publish the staff-only O-key panel asset

The launcher already installs the custom packs from `h1z1rotk/assets` before
launch. A server/launcher code release alone cannot change the `UIRoot.gfx`
inside an older published pack. This tool prepares the asset update for that
existing distribution channel; it does not alter the launch path.

The patch restores the existing native `UIBindingOrganizedPlay.IsModerator()`
condition before opening the Host Admin Panel. Closing an open panel remains
possible. The server continues to own staff identity and command permissions.

## Prepare an incremental asset release

Use Node.js 22.16 or newer and `npm ci`. Supply your own authorized copy of
`assets_x64_0.pack2`, the current public `feed.json` and matching
`asset-payloads.v1.json`. Obtain both manifests from the same commit of
`h1z1rotk/assets`. Choose an unused version greater than their `packVersion`.

```text
npm run assets:prepare-admin-panel -- <source.pack2> <current-feed.json> <current-payloads.json> <new-output-directory> <X.Y.Z>
```

Quote paths containing spaces. The output directory must not already exist;
its parent must exist. Allow about 4 GB of free staging space. The script reads
the source, writes a separate pack and compresses it; it neither overwrites the
game installation nor downloads/publishes anything.

Supported source pack SHA-256:
`b72dcc5245e654e498cadf5493761d63a93fea14904d3da32fda1545ae3d07f3`.

Supported source UIRoot SHA-256:
`cdd8d6925a6bfac73bb08335c1f221dc97214d31eee2cbcd4845b3f8cde4a769`.

Both are checked before an asset can be patched. A different or already-patched
source is refused; do not change the pins to accept an unreviewed pack. Only
hashes, format handling and the small guard edit are included in this repository.
No original method body, proprietary GFX, pack or capture is included.

Outputs:

- `packs/assets_x64_0.pack2`: the corrected pack, reread and verified. Every
  other map entry and the old payload region remain byte-identical.
- `assets_x64_0.zip`: a conventional single-entry ZIP for the existing launcher.
- `feed.json` and `asset-payloads.v1.json`: updated together. Only the main pack's
  entry and the global version change; other packs retain their URLs, versions,
  sizes and hashes. This avoids accidentally uninstalling the rest of the catalog
  when publishing a one-pack hotfix.
- `verification.json`: actual archive, pack and UIRoot hashes and the number of
  unchanged entries. Compression can vary between Node/zlib versions, so use
  these generated measurements, not a hash from another operator's build.

Do not commit the output directory or proprietary files to this repository.
If a command fails, the directory is incomplete and must not be published.

## Publish through the existing asset channel

1. Recheck the live feed and latest stable release before publishing. If another
   pack update has landed, prepare again from its matching manifests. Launchers up
   to 2.0.23 overlay conventional ZIPs from `releases/latest` on top of the feed,
   so a stale release asset can override a manifest entry for them.
2. Have the server operator prepare and verify the integrity policy for the
   **new payload hash**, using the complete generated payload manifest and the
   intended launcher patches. Agree the policy/asset rollout before publishing;
   do not disable integrity or assume an existing policy already accepts the pack.
3. Prepare a draft release `assets-vX.Y.Z` in `h1z1rotk/assets` and attach only
   `assets_x64_0.zip` from this staging directory. The draft does not change the
   launcher's `releases/latest` view.
4. In the agreed rollout, publish the stable release and commit **both generated
   manifests together** to the assets repository. Release publication and a git
   commit are separate operations; coordinate them with the server policy.
5. Launch with asset sync enabled, or use **Verify files**. Confirm the installed
   pack hash matches `verification.json`. Test O with an ordinary player and a
   staff account: only staff should open the panel, and staff should still close
   it normally. A successful offline preparation is not a live client test.

Merging this PR neither publishes the pack nor switches the server's integrity
policy. Existing launchers can receive the asset release without a new launcher
binary. Keep the previous release available for a coordinated rollback.

## Verification

`npm run test:assets:admin-panel` uses synthetic instructions and tiny pack
containers. It checks branch targets, raw/compressed storage, preservation of
other assets, refusal of unknown/truncated inputs and existing destinations,
and incremental manifest consistency. It runs as part of `npm test` / CI.

The normal launcher tests additionally cover ZIP decoding, asset synchronization
and integrity attestation. Before publication, check the generated real ZIP with
the launcher and perform the two-account in-game test above.
