# Mandatory crouch patch rollout

This page describes the previous v13 release. The proposed Alpha/Bravo v12
OPTI1 candidate and its validation gates are documented in
[CROUCH_OPTI1_TEST.md](CROUCH_OPTI1_TEST.md).

## Scope

This branch ships the ADS-safe crouch parity v13 hook inside the
open-source Vivox 5 compatibility proxy. The launcher does not patch
`H1Z1.exe` on disk.

For the movement fix, remaining visual checks and TEST procedure, see
[CROUCH_V13_TEST_20260929.md](CROUCH_V13_TEST_20260929.md). The v13 candidate
has not yet been validated in a running BR1315 game or publicly released.

The supported client is pinned to:

- build: `h1z1-1.0.326.439939`;
- `H1Z1.exe` size: `82158616` bytes;
- `H1Z1.exe` SHA-256:
  `5F5A4922B0671E4ED8FD415E753BE096EF7A17E360AE80E025F11544C8DB9261`;
- Vivox+crouch proxy SHA-256:
  `8AB1F2379C61B81391492EDB84875610FFBE4D3A8D97A180C73355D989AC27A2`.

The native hook also validates the BR1315 PE timestamp, image size and target
machine-code signatures before modifying memory. An unknown client build is
rejected by the launcher before any client file is changed.

## Enforced client state

Installation, adoption and every launch enforce all of the following:

1. preserve the verified stock Vivox 4 DLL as
   `vivoxsdk_x64.original.dll`;
2. install and verify the official Vivox 5 runtime;
3. install and verify the ROTK Vivox+crouch proxy;
4. write the exact `rotk-crouch-parity.ini` production marker;
5. repair missing, stale or corrupt proxy/runtime/marker files;
6. fail the launch if the final state cannot be verified.

Replacement files use a same-directory temporary file followed by an atomic
rename. A verified legacy backup named `vivoxsdk_x64_original.dll` is
migrated to the canonical name without overwriting the only known-good stock
copy.

The launcher repairs the patch once before integrity attestation, so the first
launch after an update cannot attest the previous proxy, and verifies it again
immediately before spawning H1Z1.

## Production marker

```ini
mode=patch-v2
animation=v13-perf1-ads-safe-cache256-hints-quiet-pose-only-interruptible-sine-idle400-200-move250
cameraScalePitch=disabled
h1z1Sha256=5F5A4922B0671E4ED8FD415E753BE096EF7A17E360AE80E025F11544C8DB9261
proxySha256=8AB1F2379C61B81391492EDB84875610FFBE4D3A8D97A180C73355D989AC27A2
```

The direct camera hook must remain disabled. The v13 hook replaces only the
trajectory/transform weight and preserves Morpheme event, sampled-event and
sync-event weights, which is the ADS-safe behavior validated in the client.
Its fixed 256-entry store keys each transition by the animation network and
its node-bin generation. A full store only reclaims the least-recently-seen
stale entry after its real transition deadline; otherwise the new call fails
open to the stock graph without mutating any live transition.

## Release order

1. Complete the TEST visual checks, then merge the launcher changes into `main`.
2. Choose a new launcher version above the existing published/draft versions,
   then publish its release, checksums, provenance and update metadata.
3. Verify an existing installation upgrades and repairs the v12 proxy.
4. Verify one fresh Steam-copy installation and one adopted isolated client.
5. Only after the update is publicly available, set the account/ticket
   service minimum launcher version to that validated release, if required.

The last step is what makes the patch mandatory for every server-authenticated
player. Enabling the server gate before the release is downloadable would
block all players.

## Release gates

- `npm ci`;
- `npm audit --omit=dev --audit-level=high`;
- `npm run dist`;
- two proxy builds from different output paths must have the same SHA-256;
- the optimized native cache harness must pass its 200-network handoff,
  collision, TTL, fail-open and multithreaded tests;
- all unit tests must pass;
- the packaged proxy hash must match the source rebuild and sidecar;
- migration from the legacy backup name and repair after deliberate corruption
  must pass on a copy of the real BR1315 files;
- a runtime smoke load must succeed with the official Vivox 5 DLL present.
- the exact packaged proxy must start a real BR1315 client past
  `cClientRunStatePreInitialize`; a `LoadLibrary`-only smoke test is not enough.

The withdrawn 1.4.0 artifact started the crouch worker from `DllMain`, while
the Windows loader lock was still held. In the combined Vivox 5 build this
terminated BR1315 in PreInitialize (`0xc00000fd`). 1.4.1 starts the same
ADS-safe worker only after the first proxied Vivox initialization call.

## Rollback

Do not remove or overwrite the verified stock backup. If a production-only
regression appears, publish a higher launcher version containing the corrected
proxy, verify its new hash throughout CI/release/attestation, and move the
server minimum to that version. Do not ask players to manually replace DLLs or
disable the marker.
