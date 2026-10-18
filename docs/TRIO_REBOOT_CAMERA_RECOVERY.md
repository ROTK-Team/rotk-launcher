# Trio reboot camera recovery

A paid reboot can finish on the server while the local client keeps following
its teammate. The native camera recovery previously discarded the accepted
respawn when the camera changed type, when five seconds elapsed before the
alive state was consumed, or before verifying that the native camera setter
actually succeeded. A second reply also erased the pending recovery after its
first reply had cleared the terminal history latches. At response time, native
spectator flags can precede their deferred controller, causing another refusal.

The response now retains the authorized next life independently of those
presentation transitions. Recovery still runs after the original native actor
state consumer, and only an alive local actor can regain a player camera.
Known death/team controllers may change while waiting. A missing or unknown
view waits without invoking the setter. An already installed player view
completes the visibility cleanup without setting the camera again.

The native setter can return without installing the selected controller.
Recovery keeps its state and retries at most four times per second. An applying
flag prevents callback re-entry while the setter and visibility functions run.
A refusal restores only the two spectator bits, preserving unrelated native
flag changes. Completion clears the pending state only after a player view is
verified. Hidden reason zero is removed only when team spectating was observed.

There is no wall-clock expiry of an otherwise valid paid life. Recovery is
cancelled on a new terminal death, disabled patch, or changed game, context,
actor, character, mode, history allocation or full 64-bit match identity.
The last guard also handles a history allocation reused for another match.
The supported client's `UIBindingMatch.GetMatchId` implementation at RVA
`0x16d5100` reads the match from `history+0x3d8`; installation verifies its
reader signature at RVA `0x16d5131`. Both original response UI branches remain
unchanged. No server command, health grant, raw alive bit, or leave-match packet
is introduced.

## Validation

The Windows native suite executes the installed x64 response bridge and actor
consumer trampoline against controlled native stand-ins. These five regression
cases fail against the previous implementation and pass against the fix:

- team camera changes between accepted response and alive application;
- alive application delayed beyond the former five-second deadline;
- a duplicate successful local response arrives before camera restoration;
- the native setter declines once and succeeds on its next eligible attempt;
- response flags and deferred team controller are temporarily out of sync.

The default suite repeats all five cases for 20 cycles and also checks native
re-entry, retry rate, already restored views, null/unknown views, cleared flags,
DeathCam-to-TeamSpectate transitions, full-width match changes, renewed death,
unrelated/rejected replies, identity changes, read-only history, Training and
both original Lua response continuations. The six installation signatures were
compared with an independently archived supported client image.

These are executable native ABI and state-machine tests, not a new graphical
acceptance run. The production incident's exact rejected guard cannot be
identified without its local trace; the reproducible failure paths are repaired
without assuming which one that player encountered.

The bundled DLL, digest sidecar, launcher policy and CI/release pins are updated
together. The previous production DLL is explicitly retired so the launcher
can replace it during the next normal installation check. Players receive this
change through a launcher release and a fresh game process.
