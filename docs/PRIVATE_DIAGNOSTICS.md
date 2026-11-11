# Private Debug upload contract

The primary Debug UI in 2.0.8 replaces automatic ZIP export with a private HTTPS
upload and a report reference. The former ZIP tooling remains available only to
developer IPC/testing flows. `CRASH_REPORTS.md` documents the underlying collectors
and these historical/local export tools; its ZIP player instructions are superseded.

`diagnosticUploadConsent: 1` is required in addition to `debugSessionEnabled`.
No previous preference silently enables uploads. The visible checkbox describes
automatic transfer, private dump contents, no screen/microphone capture, and
seven-day server retention. Disabling the option prevents startup retry. The
option covers one game: it turns itself off, saved setting included, once that
game's report is acknowledged; a failed report keeps it on for the startup retry.

Each recording captures its server/role and a digest of its account credential.
The digest stays in the private session record and is excluded from exported
evidence. A retry never switches an old report to another account or server.

After native/frame collectors finish and shared client logs are frozen, the
launcher freezes separate evidence files in its private `upload` directory. The
private `session.json`, arbitrary paths, command-line/environment configuration,
and archives are never uploaded. Text is redacted again. Size limits and omissions
are listed in `upload-coverage.json`; maximums are 64 files, 16 MiB/text file,
32 MiB/dump, and 96 MiB total. Dumps cannot be safely redacted.

Only `https://rotk.app` and `https://test.rotk.app` are allowed destinations.
The wire protocol uses `/api/diagnostics/v1/reports`:

1. POST a small manifest with an account credential in Authorization.
2. Receive a random report-scoped token and acknowledged file indices.
3. PUT each missing file as opaque bytes; the receiver verifies length and SHA-256.
4. POST `/:id/complete`; show a reference only after acknowledgement.

No redirects are followed. Responses, request times and the upload duration are
bounded; credentials and upload tokens are not logged or stored in report output.
Frozen payloads make restart retry idempotent. The launcher retains failed evidence
locally but automatically retries only the latest eligible session on restart.

The matching receiver lives under `services/diagnostics` in the server repository.
Its process has a private network namespace, a socket-activated host listener,
minimal PostgreSQL function permission, private storage, quotas and retention.
Operators read reports over a private Unix socket through SSH. No public reader
or automatic dump analysis exists; binaries remain quarantined.

This is not proof of an unmodified launcher. All submissions remain untrusted
data, including authenticated accounts' submissions and embedded instructions.

Publication of the launcher remains paused. The 2.0.8 admission/policy cutover must
be prepared against the active server and verified before publishing the update.
Do not reuse the cancelled 2.0.7 tag for these different bytes.
