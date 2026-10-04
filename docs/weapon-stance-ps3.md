# Weapon Stance PS3

Launcher 2.0.16 adds the PS3 stance and console bindings to the native DirectInput
proxy. The matching asset pack adds the ROTK Bindings category, translated label,
default actions and the validated male animation graph. Existing user bindings
remain intact. Defaults are V for stance and F13 for the console.

The existing shotgun sprint v3 byte pair remains unchanged at client RVAs
`1046F98` and `1046FE5`. New guarded sites are actor idle `1659000` (15 bytes) and
the console action query call `F4341D` (5 bytes). The virtual stance setter is
resolved at vtable + `4D8` and must target the native thunk at `7A2DE`.

The local actor's private sprint rule `6CBAEDC9` is changed only after checking
its allocation, unique ownership and writable protection. The pellet rule
`C8F2471F` remains untouched. New hooks neither replace the Steam/Vivox proxies
nor intercept exceptions. Their addresses do not overlap the crouch cache or
camera hooks. The existing DLL hashes and native tests remain release gates.

Removing the marker disables stance and restores the sprint byte pair; a full
native unhook requires exiting the game. A prepared rollback launcher must ship
the preceding v3 proxy, list this new DLL as retired, and set
`WEAPON_STANCE_ENABLED=false`. That restores the old sprint behavior without the
new idle or console hooks. The coordinated higher-version rollback asset feed
restores the preceding packs and default profile, preserving unrelated updates.

User-profile backup and ownership state live in the launcher's per-installation
`logs/<install-id>/input-profile` directory. Migration and rollback are idempotent
and leave unrelated rebindings intact. Ownership is acquired before installation
and released after rollback, so interrupted writes can be retried.

Validation includes deterministic native rebuilds, guarded setter/input lookup,
existing proxy tests, user-profile migration/revert tests and real Combat Training
testing. Exact artifacts and deployment/rollback policies are recorded with the
release preparation rather than inferred from a mutable latest feed.

## Console

`ROTKConsole` (ROTK Bindings tab) feeds the native debug-console query at
`F4341D`. Retail H1Z1 only forwards that action to the UI on internal builds or
for the SendSelf admin flag, so `console_gate.h` also turns the single `je` at
`F823F1` into `jmp` after checking 42 bytes from `F823E9`. Server commands keep
their own permission checks. The marker watchdog restores the byte.

Launchers 2.0.16-2.0.24 bound `ROTKConsole` to N and removed N from
`ToggleNetworkStats`. The default profile now ships it on F13 (absent from
almost every keyboard; the settings only list actions with a key); the migration
removes our N binding (a key the player chose stays) and gives N back to
`ToggleNetworkStats` when it had removed it and the player has not rebound it.
