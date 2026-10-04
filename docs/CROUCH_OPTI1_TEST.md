# Crouch Alpha/Bravo OPTI1 — test candidate

This candidate restores the Alpha/Bravo v12 transition behavior, with a
512-entry cache index table (4 KiB). A hint is bounds-checked and matched
against the network; the unchanged v12 resolver checks generation, call
ordering and expiration. Misses and collisions use its original full scan.
States and hints stay under the same lock. No animation-hook allocations
are added. Timings remain 400/200 ms idle and 250 ms moving; the camera
stays native. All crouch logs are compiled out by default.

The bundled source-built proxy retains the current voice fixes and safe
startup log cleanup. SHA-256:
`e797798683e5090760753d4d31bbd368a1d8ebae6f4f94ab61aa4efc410e3b2c`
(68,096 bytes). CI requires both source builds to match the bundled DLL.

Validation: cache edge cases and 8/16-thread stress, 400,000 differential
operations with identical slots/states/events, production-hook curves and
ADS forwarding, zero crouch log opens, Duo voice, actual SDK volume,
voice-rank signature guards, 32-KiB startup, deployment/repair and reproducible
builds. Synthetic hook time improved about 4.8% at 200 actors on the test PC;
this is not a game FPS measurement.

Keep the [OPTI1 test release](https://github.com/ROTK-Team/rotk-launcher/releases/tag/test-2026-10-04-crouch-alpha-bravo-opti1)
in draft pending review and in-game validation. The launcher stays 2.0.24.
TEST attestation roots must be aligned when activating this candidate;
no server policy or public release is changed by this PR.
