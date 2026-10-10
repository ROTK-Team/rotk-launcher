# Vivox position responses

The bundled Vivox proxy requests no successful replies for `session_set_3d_position` (request 0x1c). Position updates still reach the SDK, and error responses still reach the game. Authentication, channels, volumes and microphone behavior are unchanged.

The source, bundled DLL, deployment hash, sidecar and CI/release pins use the same binary. The new native regression checks the writable request boundary, unchanged positions/cookies, unrelated request types and actual SDK errors through the bundled proxy. Existing voice regressions remain mandatory.

Local verification: native Vivox suite, TypeScript and 472 Vitest tests pass; three existing Vitest tests are skipped. No connected-channel gameplay benchmark was performed. This reduces unnecessary client callbacks; no FPS gain or server CPU saving is claimed.
