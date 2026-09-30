# Client compatibility release input

Launcher 2.0.24 packages the release owner's supplied client compatibility DLL
as `resources/patches/vivoxsdk_x64.dll`.

- SHA-256: `5350449196dea51278b9c70da36ac621d4bda626bcded8c1bb3a83b07ec62c32`.
- Size: 80,384 bytes; AMD64 PE32+ DLL.
- The official Vivox 5 runtime and other bundled patches remain unchanged.

The launcher verifies and installs these exact bytes before Play, including
existing installations, and uses the same hash in its attestation override and
crouch marker. Signing and reference builds must not alter this supplied file.

This is a supplied binary, not a rebuild of the reference C sources in this
repository. CI still reproduces the unchanged reference source twice and
independently validates the supplied file and its runtime ABI. The load and ABI
test processes prohibit child-process creation so they do not install an
external module during automated testing. These checks cover the proxy's
compatibility and failure path; they do not certify external runtime behavior.

The release uses the existing launcher updater, not the generic asset feed.
Before publication, register the new launcher version and its manifest root
against the current asset pack. Keep the prior release available for rollback.
