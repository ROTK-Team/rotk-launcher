# ROTK Launcher 2.0.24

Candidate from branch `fix/install-root-causes` on top of 2.0.23 (`ed73e5f`).
Focus: installation failures reported by players, clearer errors, Play no
longer stuck, antivirus and network robustness, Simplified Chinese.
`package.json` still says 2.0.23: bump it when cutting the release.

## Installation

- The Steam client is copied straight into the destination. No
  `.rotk-staging-*` folder and no final directory rename anymore: that rename
  failed with EPERM when an antivirus was scanning the new files, and the whole
  17 GB copy was then deleted (#68).
- A pending marker (`.rotk-install-pending.json`) claims the folder, the
  install marker is written last. A cancelled, failed or killed install
  resumes where it stopped (size + mtime per file).
- Copy uses 4 MB streams on 3 lanes: about as fast as `CopyFile` here, but
  cancellable and with progress inside big packs. A failing lane stops the
  others.
- Installing onto a finished ROTK folder repairs it (missing files come back,
  assets and `UserOptions.ini` / `InputProfile_User.xml` are kept) instead of
  "the ROTK folder already exists". A folder with someone else's files is
  refused when it is chosen.
- Drive picker in the setup panel (free space per drive, `X:\Games\ROTK`).
  Default is the Steam drive when it has 25 GB free, then the system drive.
- Steam detection reads `appmanifest_433850.acf` for the real folder name.
  When no client is found, a button opens `steam://install/433850` and the
  launcher looks again when the window gets focus back.
- Startup removes leftovers around the configured install: old staging
  folders (one real profile had 10 GB left since July) and temporary files.
- A copy abandoned on one drive is removed when the player installs elsewhere.
- Backups (`*.original.*`) are written atomically.

## Files, locks and antivirus

- `fs-safe.ts`: `retryFs` retries EPERM/EBUSY/EACCES for about 7 s on every
  rename/replace in the game folder and profile (installer, Vivox, sprint
  patch, config, player keys, assets, input profiles).
- `steam_api64.dll`, `ClientConfig.ini` and the BattlEye cfg are only
  rewritten when their content changes; a healthy install sees no write
  before launch. `ClientConfig.ini` is written as UTF-8 (the ASCII write
  turned a BOM into a stray byte).
- A running `H1Z1.exe` (EBUSY on open) is detected before attestation and the
  ticket, which are single-use.
- Bundled DLLs are checked against their `.sha256` at startup; a quarantined
  or modified one is reported with what to do.
- The player key file is no longer deleted on a read error, only when its
  content is invalid.
- See `docs/ANTIVIRUS.md` for the WDSI submission step and player guidance.

## Errors and state

- System errors keep the file path and a likely cause instead of
  "System error (EPERM)". Every failure goes to `startup.log` and the
  diagnostics.
- The error shows inside the setup panel and can be dismissed.
- Play is no longer locked by an uncaught exception or by a startup check that
  failed on a sleeping drive or a locked file. A really damaged install still
  sends the player to setup.
- A failed launcher update download no longer blocks Play; the next check asks
  again. Updates found by the updater still have to be installed first, as in
  2.0.23.
- The server's `requiredVersion` is shown when it refuses the launcher version.
  A real version refusal is no longer mistaken for a missing attestation.
- Account and integrity service errors are translated (FR, ZH) and keep the
  network cause and HTTP status.

## Network and assets

- The Windows certificate store is added to Node's trusted roots, so requests
  work behind antivirus HTTPS scanning (Kaspersky, ESET, Avast...).
- Asset downloads go to a `.part` file and resume with `Range`; 4 attempts on
  network errors, 5xx and stalls (30 s without data). A corrupt resumed file is
  downloaded once more from scratch; a 416 drops the part.
- Release auto-discovery through the GitHub API is off: `feed.json` is the only
  source (a discovered pack would be missing from the attestation payloads,
  and the anonymous API is limited to 60 requests/hour per IP).
- Asset cache and backups moved from `%APPDATA%` (always C:) to the game drive,
  `<parent>\.<install>-assets`. Old backups are still restored, still-current
  packs are moved from the old cache, the rest of it is removed.
- Free space is checked before downloading (about 3x the download size).
- `scripts/package-asset-packs.ps1` now writes `.payload` files. Launchers up
  to 2.0.23 install any `.zip` of the latest release on their own.

## Launch

- The fallback HWID is only collected when attestation did not run.
- Attestation reads the HWID while hashing and runs both TPM signatures in
  parallel. A challenge that is about to expire after hashing is replaced by a
  fresh one when build, patch mode and slots match; the measurement is reused.
- The TPM endorsement key read (the only `Add-Type`/csc.exe step) runs once
  per machine and is cached in `tpm-endorsement.v1.json`. Signing stays per
  launch in plain .NET.

## Languages

- Simplified Chinese: interface, diagnostics, main-process messages and the
  most common install and account errors (other errors fall back to English).
- The language follows Windows on first run, including the startup error box.
- CJK text uses a CJK font without letter spacing.

## Unchanged on purpose

- `perMachine: true` (install under Program Files) is kept.
- Native code is unchanged; `resources/patches` hashes are the 2.0.23 ones.

## Coordination

- Admit 2.0.24 in the server's accepted-version list and publish its
  attestation roots before exposing it. The bundled DLLs are unchanged.
- The TEST server currently accepts 2.0.21 only: 2.0.23 and this candidate are
  refused there.
- Asset releases: always commit `feed.json` and `asset-payloads.v1.json`
  together, keep the `.payload` suffix.
- Submit the installer and the four unsigned binaries to Microsoft WDSI.

## Validation

- `npm run typecheck`, 433 Vitest tests. New tests cover the installer flow
  with a fake client (fresh, cancel/resume, crash after patching, repair),
  leftovers, fs retries, resumable downloads, cache moves, locales.
- Opt-in real-client tests (`ROTK_H1Z1_SOURCE`, `ROTK_E2E_NETWORK=1`) passed
  on this build: full install with cancel/resume, live asset sync cut at
  300 MB and resumed, local integrity measurement against the signed base
  manifest with 0 deviations, restore vanilla with 0 deviations. TPM test on a
  real TPM passed.
- `npm test` with the native suites: all green except
  `native/diagnostics` test 11 (CPU/IO counters), which fails the same way on
  2.0.23 on this machine.
- Packaged app (NSIS + unpacked) built; bundled hashes match their sidecars.
  Run on a real 2.0.23 profile: startup, asset update 1.13.23 -> 1.13.24 with
  cache move, leftover cleanup, Play up to the ticket request. The game itself
  was not started: TEST only admits 2.0.21. The NSIS install (UAC) was not run.
