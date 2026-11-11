# ROTK Launcher 2.0.49

Update the bundled rotkc.dll to the supplied AMD64 build for the coordinated
launcher, server and asset release.

Expected supplied file: 126,843,904 bytes; SHA-256
`2c0a0ee62cccbda36d37574d8ad269b27e568b5daf3cc9bc06b11c54cd8ba746`.

The file is larger than GitHub's 100 MB limit per file, so the repository keeps
it Brotli-compressed as `resources/patches/rotkc.dll.br` (37,622,282 bytes).
`rotkc.dll.sha256` holds the SHA-256 of the restored file, not of the
compressed one. `npm run prepare:rotkc` restores `resources/patches/rotkc.dll`,
which git ignores, and fails unless it has that SHA-256. `dev`, `dev:isolated`,
`dist`, `dist:dir`, CI and the release workflow run it.

To store a newly supplied build:
`node scripts/prepare-rotkc.mjs --pack <path to rotkc.dll>` (about two and a
half minutes), then commit `rotkc.dll.br` and `rotkc.dll.sha256`.

The final installer must contain this exact DLL: the release workflow compares
the packaged file with `rotkc.dll.sha256`. Preserve the existing integrity
enforcement mode and register the new launcher version before public exposure.

The DLL is 105 MB larger than the one shipped since 2.0.40, in the launcher
folder and again in the game folder, where it is copied before every launch.
