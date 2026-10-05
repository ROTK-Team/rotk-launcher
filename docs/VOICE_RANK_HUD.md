# Voice rank HUD correction

The BR1315 HUD overwrites the rank received in Voice.Identity with the actor's
rank every time it reads Tier/Subtier. A local or lightweight actor still at
zero erases the badge, including the row's fallback after leaving visual range.

The existing Vivox compatibility proxy now preserves Voice.Identity as the HUD
rank source. At the first `vx_get_message`, after client unpacking and outside
the loader phase, it changes only two branch opcodes in the getter. The client
build is pinned by the launcher, so the getter is not compared with its
original bytes; the patch is skipped only when both branches are already
installed. Page permissions are restored and the instruction cache is flushed.
The runtime log records installation, or an unsupported host whose image or
memory does not hold the getter; voice audio continues either way.
The executable on disk, actor state, killfeed, crouch and microphone logic are
unchanged. The server companion loads the display badge only in public Solo
and its waiting lobby. Practice, Hosted and caster modes remain unranked;
the HUD honors the server's zero rank and displays no badge there.

## Verification

With Zig 0.15.2 on PATH:

```powershell
npm run test:native:voice-rank
npm run test:native:crouch
npm run build:vivox
npx vitest run tests/vivox-client.test.ts tests/native-vivox-runtime.test.ts
npm run typecheck
```

The native C test installs the patch whatever the other 104 getter bytes
hold, completes a partially changed getter, verifies only two bytes change,
checks idempotence, original page protection and unsupported-host
initialization. Its ignored output
`native/vivoxproxy/dist/tests/voice_rank_patch_test.exe.patched-code.bin` can be
passed to the server's `prove-native-voice-ranks1315.py --hud-patch` harness.
That harness executes the original client x64, reproduces the loss first, then
verifies 720 corrected Tier/Subtier reads plus a same-row unranked reset.
Only memory allocation/string formatting and actor lookup are mocked.

A separate isolated client visual fixture exercised the unchanged Scaleform
VoiceItemRenderer with simulated speaking rows: Royalty I, Diamond, Platinum
and an unranked player. The owner confirmed the rendered result. This validates
the badge layout, not a real two-player microphone session or the full native
voice path; the fixture overrides the UI rows and is not shipped.

The release DLL is pinned in `resources/patches/vivoxsdk_x64.dll` (see
[Vivox release input provenance](VIVOX_RELEASE_20260920.md)), with the
matching hash in `electron/services/vivox-client.ts` and the checksum file.
It is not deployed to an installed game. Publish together with the server
change, refresh the allowed proxy hash in the release attestation, then check
two live speakers in the Solo lobby and match, plus the absence of badges in
Practice and Hosted. No microphone audio or rendered
Scaleform frames are exercised by the native harness.
