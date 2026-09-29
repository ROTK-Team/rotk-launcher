# Antivirus false positives

The launcher ships four unsigned binaries that replace or wrap game DLLs:
`steam_api64.dll`, `vivoxsdk_x64.dll` (voice proxy), `dinput8.dll` (sprint
patch) and `ROTK.Diagnostics.exe`. DLL proxies like these are a common
malware pattern, so Defender and other products sometimes quarantine them.

## On each release

Submit the installer and the four files to Microsoft as a software developer:
<https://www.microsoft.com/wdsi/filesubmission> → "Software developer" →
"Incorrectly detected as malware". Definitions are usually updated within a
few days. Do the same with other vendors when players report them.

Rebuilding a DLL changes its hash and loses the reputation it had, so only
rebuild the native files when their source changes.

## What players see

- The launcher checks the bundled DLLs at startup and says when one is
  missing or modified.
- File errors name the file and suggest the antivirus when access is denied.

## What to tell a player

1. Open Windows Security → Virus & threat protection → Protection history
   and restore the ROTK file that was quarantined.
2. Add two exclusions (Virus & threat protection settings → Exclusions):
   the launcher folder (`C:\Program Files\ROTK Launcher`) and the game folder
   (`<drive>:\Games\ROTK` by default).
3. Click Play again. If the file is still missing, reinstall the launcher.
