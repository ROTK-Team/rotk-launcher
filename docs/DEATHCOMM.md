# Deathcomm client

The launcher starts a hidden, self-contained .NET Windows helper with the game
and stops it when the game exits. The existing launch ticket is passed over
stdin, not added to its command line or saved. The helper connects using WSS to
the selected region's voice origin. Plain WS is permitted only on loopback.
It cannot request a deathcomm or choose a recipient: the server alone issues
short-lived capture/listen grants after an authoritative kill.

Reception is independent of the killer's `[Voice] Enable`,
`[VoiceChat] ProximityEnabled`, `[Voice] ReceiveVolume` and
`[VoiceChat] ProximityVolume`. Disabling native chat/proximity or setting either
receive volume to zero does not prevent or interrupt a server-granted reaction.
Playback does not read or change `UserOptions.ini`, including when that file is
missing or unreadable, and never activates the killer's microphone.
The Windows output device and system audio volume/mute controls still apply.

Automatic transmission requires all of the following:

- `[Voice] Enable=1` and `MicrophoneVolume` in `(0, 100]` in `UserOptions.ini`.
- `[VoiceChat] ProximityEnabled=1`; disabling proximity also stops capture.
- The game process owns the foreground window.
- The input selected by `[VoiceChat] InputDevice` exists and maps uniquely to
  a Windows capture device. System/communication defaults resolve to their
  current Windows endpoints. An unknown or ambiguous device is refused.
- The Windows endpoint is active, not muted and has a positive level.

The helper checks the preferences and endpoint during capture and never changes
them. Missing/unreadable/ambiguous settings deny capture. Unmuting later does
not restart an already-cancelled reaction. A visible, click-through indicator
shows `DEATHCOMM · MICRO OUVERT` and the remaining seconds. PTT is not required
during an authorized deathcomm. No audio device is opened for capture while idle.

The server deadline and a separate monotonic client deadline cap each reaction
at four seconds. Buffered output is cleared on stop, deadline or disconnect.
Audio uses 20 ms PCM frames with a grant ID; queues are bounded. Audio is never
written to disk. Existing Vivox proximity and Duo controls are unchanged.

## Build and tests

Install the .NET 10 SDK for development only. `npm run build:deathcomm` publishes
`resources/deathcomm/RotkDeathcomm.exe` including its runtime; players do not need
to install .NET. The normal build/release workflow rebuilds and packages it.
`scripts/build-deathcomm.ps1 -DotnetPath <sdk-path>` supports a separate SDK.

- `npm run test:deathcomm`: real WebSocket frames with fake audio devices;
  disabled mic, reception with native chat/proximity off or volumes at zero,
  preference changes during playback, authorized capture, live microphone mute,
  deadlines, invalid/late audio, malformed text frames and playback cleanup. It never opens a physical mic.
- `npm exec -- vitest run tests/deathcomm-client.test.ts
  tests/diagnostic-game-lifecycle.test.ts tests/runtime-config.test.ts
  tests/vivox-client.test.ts`: endpoint policy, stdin credential handling,
  hidden process, teardown and existing launcher voice/lifecycle behavior.
- `npm run typecheck` and a self-contained Release publish pass locally.

Both the corresponding server and its nginx WebSocket route are required.
The server transport is already implemented in `h1z1rotk/returnoftheking#575`;
no additional server protocol change is needed for independent reception.
Both players need the updated launcher. Existing launchers retain their current
behavior; this feature does not change the minimum launcher version or force
players to update. No production launcher release is performed here. Two running game clients
with physical audio devices remain a release validation step, especially for
custom microphone names and exclusive-fullscreen indicator visibility.
