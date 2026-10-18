# Vehicle exits on slopes

The native exit-point validator converts a named world point into the vehicle's
rotated frame, then transforms it back with an upright frame. On a tilted
vehicle this mismatch can reject the preferred exit and send the native search
to the other side.

The guarded gameplay proxy intercepts both normal and bailout candidate calls.
It preserves a successful native result. If the named candidate is rejected and
the frames differ, it retries using the upright frame for the inverse as well.
Ground and clearance checks still run through the native validator. A rejected
retry restores the first result, so blocked exits retain the native fallback.
Thread-local scope confines the frame substitution to this candidate's retry.
Removing the gameplay marker disables the custom behavior through the watchdog.

Installation guards three CALL sites and the native frame instruction. It opens
thread handles, suspends them and refuses an instruction pointer in an overwrite
window before modifying executable memory. Startup threads can disappear after
the snapshot: pre-write thread failures resume and close everything, then retry
with a fresh snapshot, at most 20 attempts with a 10 ms pause. Signature,
protection and cache failures remain terminal; partially installed bridges are
never retried and remain disabled. No pause holds another thread suspended.

`test-dinput8-proxy.ps1` covers candidate acceptance, recovery, rejected recovery,
flat ground, disable behavior, thread isolation, emitted x64 bridges and guarded
installation. The startup regression replays the observed OpenThread error 87
after a real snapshot thread exits. Persistent thread failures are bounded;
protection failures are terminal and preserve the three original CALL sites.
`verify-gameplay-patch.mjs` checks the reproducible bundled DLL, its sidecar and
the absence of per-exit test logging.

Local native qualification observed 16 candidate attempts: 15 accepted directly
and one rejected initially but accepted on retry. Three subsequent starts of
the production DLL installed successfully. These observations do not establish
all vehicle models, final character placement or every moving-slope scenario.
The request/response delay, cached exit point, server and assets are unchanged.
