# Launcher 2.0.25

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
not forwarded, and paths are encoded as data rather than interpolated as script
syntax. Neither UAC settings nor Windows security policies are modified.

The bundled client files are byte-identical to 2.0.24. Register the new launcher
version with those same clean and patched file roots before publication.

Windows reference: [application launching and the runas verb](https://learn.microsoft.com/en-us/windows/win32/shell/launch).
