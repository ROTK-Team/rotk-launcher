# ROTK Launcher 2.0.23

Candidate built from current main, including the already integrated #82/#83.
The public predecessor is 2.0.21; 2.0.22 is a draft prerelease.

## Player-facing changes

- Larger update banner with readable text and a prominent action.
- A known launcher update replaces Play with Update. Clicking opens a centered
  window showing the installed and available versions, download progress,
  retry and restart actions. Closing or postponing never launches the game.
- The main process also rejects Play while an update is pending. Server-required
  updates remain blocked when metadata is unavailable, with a retry action.
- ROTK/LIVE visual identity from main.
- #82: interruptible crouch transitions and continuous locomotion timing.
- #83: fix for the identified CZ respawn continuation crash, logical fire/aim
  input handling, reduced repeated launcher reads, streaming ZIP digests and
  concurrent metadata fetching; voice grant HTTP no longer holds the shared
  voice-state lock.

The voice request itself is still synchronous. This release does not claim
measured FPS gains, a fix for every CZ crash, or a tearing/blur fix.

## Coordination with server 1.3.145

Publish a new installer; never replace a released version. Verify its packaged
DLLs and sidecars, compute the clean and patched attestation roots against the
current published assets, and register/admit 2.0.23 before exposing it. Require
2.0.23 server-side only after its installer and latest.yml are publicly reachable
and the matching server is ready. Keep the existing integrity enforcement mode.

The larger notification becomes available after installing 2.0.23; existing
launchers continue using their own UI for this upgrade. Server-side admission
is therefore needed to require this first coordinated update.

Launcher PRs #58, #76, #77 and #81 are excluded from this release by the operator.

## Validation

Local complete `npm run build` passed: TypeScript, 406 Vitest tests (three native
opt-in tests skipped), asset/native suites, 18 native diagnostic tests, Deathcomm,
Electron and renderer builds. An isolated Electron renderer harness passed the
mandatory reminder, dismissal/reopening, progress/retry, install, running-game
guard and unavailable-metadata cases. No real game was launched by this harness.
Release CI, final installer verification and publication receipts remain the
authority for distribution; local build success is not a deployment receipt.
