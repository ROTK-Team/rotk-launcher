# Voice reliability candidate

Launcher 2.0.36 accompanies server PR [943](https://github.com/ROTK-Team/returnoftheking/pull/943).
Both PRs remain draft; publication and production operations are outside this work.

The proxy defers ROTK Login/join HTTP to one network worker. It retains at most
eight accepted original requests, sixteen desired rooms, and eight internal
audio-setting requests. The application SDK entry points perform request
mutation, SDK submission and completion delivery. Network work uses copied
inputs and never owns the game's request_count pointer.

Each accepted original has exactly one SDK-owned completion, with its original
request, type, cookie and vcookie. Refusal before admission leaves ownership with
the caller. Temporary HTTP failures (network, 401, 409, 429, 503) get at most four
attempts within twenty seconds, with jitter and Retry-After. A request attempt
has a four-second HTTP budget. Forbidden, expired, malformed and mismatched
grants never fall back to the old token. Repeated Login tokens and active-room
duplicates cannot replenish recovery budgets.

Login epochs and room generations cancel late network work. Leaving a session,
disconnecting media, terminating its group, logout and shutdown retire desire.
The SDK notification callback wakes callback-driven message pumps when deferred
work completes; the initialization configuration is forwarded unchanged. The
V5 configuration callback offsets are tested against an actual SDK completion.
On shutdown, unsent accepted requests are freed before the SDK allocator stops;
already-issued originals remain SDK-owned.

A join response is not evidence of connected audio. The proxy observes real
media events and session removal independently. For documented transient media
statuses 408/480/486/503, it waits for removal and ten seconds, then requests a
fresh authorized grant. Each desired room has at most two media rejoin episodes.
Explicit departure and authorization failure prevent rejoin. Team and proximity
rooms have separate state. Internal responses are consumed without inventing a
second completion for the game's original request.
Session.Create handles returned by the SDK retain their per-room URI mapping;
rejoin preserves that exact handle as well as the legacy URI-based join handle.

Session receive mute and volume are retained during rejoin. Connector microphone
and speaker mute, capture/render device selection and transmission requests are
forwarded unchanged. An automatically removed group disables proxy rejoin
because recreating it could lose its transmission selection; the game recreates
that group. SDK recovery and device polling remain enabled according to the
game's original configuration. Bounded diagnostics distinguish ticket HTTP,
SDK response and media state without logging credentials or player identifiers.

Validation uses the shipped SDK, real loopback WinHTTP, SDK XML decoding and SDK
allocation/destruction: a 2.2-second delayed grant, Retry-After, network exhaustion,
forbidden/expired/wrong-channel/wrong-account grants, cancellation, internal media
rejoin, mute/volume restoration, account signout, fifty context changes, eight-slot
saturation and pending-request shutdown. Nine device/mute/transmission request
factories retain their original requests across fifty passes. Existing native
tests cover both join ABIs, event ordering, HUD fairness, volume 0–100 and position
disposition. They are part of `npm run build:vivox` and Windows PR CI.

The binary and service/sidecar/verification/CI/release pins must agree. Two output
directories must reproduce the same SHA-256. Directory and unsigned NSIS builds
are package checks, not a public release.

Remaining qualification: the game executable is unavailable locally. These
tests cannot establish audible microphone/output, physical device hot swap or
the game's callback and UI behavior. Keep the PR draft until two real accounts
complete at least 21 Menu/lobby/match cycles with team/proximity audio, network
loss, devices, PTT/mute, spectating and death. The server's 5,000-principal tests
exercise tickets and authorization, not 5,000 simultaneous Vivox microphones or
real regional RPC/moderation latency.

SDK contracts: [messaging](https://docs.vivox.com/v5/general/core/5_19_0/en-us/ReferenceManual/Core/group__messaging.html),
[configuration callback](https://docs.unity.com/en-us/vivox-core/developer-guide/messaging/message-callback),
[media failure](https://docs.vivox.com/v5/general/core/5_21_0/en-us/Core/developer-guide/channels-and-sessions/partial-connection-failure.htm),
[media statuses](https://docs.unity.com/en-us/vivox-core/reference-manual/core/structvx__evt__media__stream__updated).
