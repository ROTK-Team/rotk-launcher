# Crouch patch rollout

## Scope

The crouch parity hook lives in the open-source Vivox 5 compatibility proxy
(`native/vivoxproxy`). The launcher never patches `H1Z1.exe` on disk; the hook
validates the BR1315 PE timestamp, image size and code signatures before it
touches memory, and the launcher refuses unknown client builds.

## Sources and shipped DLL

The sources are the v12-perf1 hook: idle 400/200 ms, moving 250 ms, transitions
not interruptible, pose weight only (Morpheme event weights stay stock, which
keeps ADS intact), 256-entry state cache with acquire hints, no disk I/O in the
normal hook path and an opt-in `transitionTrace=1` log. The interruptible v13
hook was dropped.

CI builds these sources twice and pins the reference hash in
`.github/workflows/ci.yml`. That reference build is not what players get: the
shipped `resources/patches/vivoxsdk_x64.dll` (and its `.sha256` sidecar) is
supplied by the release owner and still carries the v13 hook and the v13 marker
in `electron/services/vivox-client.ts` until it is rebuilt from these sources.

## Enforced client state

Install, adoption and every launch: keep the verified stock Vivox 4 DLL as
`vivoxsdk_x64.original.dll`, install the official Vivox 5 runtime and the
proxy, write the exact `rotk-crouch-parity.ini` marker, repair anything
missing or stale with an atomic same-directory rename, and fail the launch if
the final state cannot be verified.

## Shipping a rebuilt proxy

1. Rebuild with `npm run build:vivox:source` (Zig 0.15.2) and confirm the CI
   reference hash.
2. Replace the shipped DLL and sidecar, update the proxy hash and marker in
   the launcher, release a new launcher version.
3. Raise the server minimum launcher version only after that release is
   downloadable, otherwise every player is blocked.

Never ask players to replace DLLs by hand or remove the marker.
