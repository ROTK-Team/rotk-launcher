# Launcher 2.0.25: administrator startup

The Windows launcher requires an administrator token before creating its
window or initializing IPC, account storage, downloads and game launch services.
The installed launcher uses Windows' normal `runas` consent flow when needed.
Cancellation closes the original process; query failures and unsuccessful
elevation stop startup. The replacement checks its token again, and an internal
retry marker cannot grant permission or cause an elevation loop.

The executable manifest remains `asInvoker` because Chromium uses the same
executable for restricted child processes. Renderer sandboxing stays enabled.
This avoids reintroducing the `requireAdministrator` startup regression from
2.0.14. Development checkouts require an explicitly elevated Windows terminal
and are never automatically elevated.

The UAC request starts only the installed executable, with a fixed retry
argument and its own directory as the working directory. Caller arguments are
not forwarded. The bundled native helper queries its inherited Windows token
with `GetTokenInformation` and uses `ShellExecuteExW` for consent. It derives the
fixed target from its own installed location; neither PATH nor environment
variables select a system tool or elevation target. Its SHA-256 sidecar is
verified before execution. Neither UAC settings nor security policies change.

H1Z1 is started by the launcher and inherits its administrator token. Windows
then keeps lower-integrity tools out of the game: OBS Game Capture (direct and
anti-cheat compatibility hooks) and Discord push-to-talk only work when OBS or
Discord also run as administrator. Tell players and streamers with the release.

The bundled client files changed since 2.0.24 (Vivox proxy and gameplay patch).
Register 2.0.25 with the clean and patched file roots of its own build before
publication.

Windows reference: [application launching and the runas verb](https://learn.microsoft.com/en-us/windows/win32/shell/launch).
