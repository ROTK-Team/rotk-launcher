# ROTK Launcher 2.0.42

Fix the client camera remaining attached to a teammate after an accepted Trio
reboot. Keep camera recovery pending across deferred alive application, camera
changes, duplicate responses and transient native setter refusal. A new death
or a changed local identity or match cancels recovery.

The launcher replaces the prior official `dinput8.dll` on the next game launch.
The new bundled artifact is 48,128 bytes with SHA-256
`b1f35314f2e183cdc1ccbbc2b24ee76b8e991179e1adb653f560128d500852d9`.
Other bundled patches and game asset packs are unchanged.

Before publishing the installer, register the exact packaged clean/patched
integrity roots and allow launcher 2.0.42 while preserving existing admissions
and enforcement. This requires a configuration update only; game servers do
not need a new build or restart. Players must update the launcher and restart
the game for the new DLL to load.

See `TRIO_REBOOT_CAMERA_RECOVERY.md` for the reproduced failure cases and native
validation limits. The regression suite and launcher build are supplemented
by Windows CI and verification of the final release artifacts.
