# Launcher hardware verification hardening

## Scope and security boundary

This change prevents the shipped launcher from silently proceeding after hardware collection fails or the integrity attestation attempt cannot complete. It does **not** make a modified launcher trustworthy, validate hardware bans on the server, or prevent a custom client from omitting or fabricating evidence.

A completed attestation can still report file deviations; the server remains responsible for accepting or rejecting those measurements.

The account service and game server are outside this repository. Their required work is tracked in [Backend and game-server security requirements](BACKEND_SECURITY_REQUIREMENTS.md). Client-only hardening must not be announced as a complete fix for hardware-ban evasion.

## Behavior changes

Previously, a failed PowerShell read produced `{}`, the ticket request omitted `hwid`, and unavailable attestation could proceed to ticket issuance. A second empty hardware reading could replace an earlier successful one.

The launcher now:

- Requires completed attestation and nonempty, structurally valid hardware evidence before requesting a launch ticket.
- Applies the same gate when refreshing an expired ticket; it never reuses a previous vector under a fresh proof.
- Collects hardware once per attestation attempt, after the signed challenge specifies the slots.
- Emits one JSON row per completed hardware read, keeping completed rows distinguishable from missing or failed reads.
- Treats collection timeout, execution failure, malformed/incomplete output, permission errors, unknown requested slots and unsupported platforms as launch failures.
- Runs up to two source groups concurrently, with a default five-second budget per group and a shared ten-second work deadline, including queue time.
- Cancels active readers on failure or cancellation, stops queued work, and waits for child-process closure before releasing worker slots or returning the attempt.
- Checks monotonic elapsed time as well as timers, so a delayed event loop cannot accept late results.
- Rejects empty/placeholder-only evidence, excessive sizes and control characters without altering bytes already covered by a proof.
- Prevents overlapping launches within one `GameLauncher` instance and releases the lock after failure.

An explicitly unavailable value, such as an OEM placeholder, is recorded as `missing`. It may coexist with usable evidence from another slot. This compatibility allowance is **not** a server-side minimum-quality policy and does not establish a trustworthy identity. The backend must decide whether that exact combination is sufficient. A collector error or missing output row is not treated as an ordinary absent hardware value.

TPM proofs and anchor activation retain the existing wire protocol and optional behavior. Requiring TPM, choosing trusted manufacturers and supporting devices without TPM require a coordinated server policy. A valid signature over a fabricated hardware vector does not make the vector true.

## Reader groups and process lifecycle

| Group | Sources |
|---|---|
| Registry | MachineGuid |
| Firmware | SMBIOS UUID, baseboard, BIOS, enclosure, system SKU |
| Storage | Disk serial/model/firmware and volume serial |
| Compute | CPU, RAM modules and GPU |
| Network | Physical adapter MAC addresses |
| Display | Monitor EDID serials |
| Operating system | OS installation date |

Only groups containing requested slots are started. Each requested slot belongs to exactly one group. The two-worker limit is fixed in code and is not a renderer or environment option. A later group's budget is capped by the time remaining in the shared deadline.

Each group uses a direct PowerShell process, without an intermediate command shell. Output is limited to 256 KiB of combined stdout/stderr per process. The reader is force-terminated on cancellation, timeout or excess output. The scheduler retains ownership until the process and its stdio have closed, following the distinction between termination requests and the `close` event in the [Node.js process lifecycle](https://nodejs.org/api/child_process.html#event-close).

The deadline bounds acceptable work; it is not a promise that operating-system cleanup finishes within exactly ten seconds. Cleanup is awaited even after the deadline, and no replacement process takes that worker's place while it is still terminating. An unresponsive operating system can delay cleanup; the attempt cannot become successful while waiting. The fixed scripts do not spawn external child programs, and OS-owned WMI services are not killed.

All state and output snapshots belong to one attempt. Late output from a cancelled attempt cannot alter a returned result or a subsequent attempt. There is no automatic retry. Completed rows from a failed group may be retained as ephemeral diagnostics when available, but cannot turn the attempt into valid evidence.

The five-second group budget is a conservative initial bound, not a measured hardware-compatibility guarantee. Multiple PowerShell startups may increase cost on slower systems. Real Windows latency measurements remain required before release.

## Compatibility and rollout implications

An unavailable or unconfigured attestation service now prevents launch, including on development/test servers. There is no environment-variable or platform-declaration bypass. Unknown challenge slots require a compatible launcher. Non-Windows execution no longer silently produces empty evidence.

These are intentional availability changes. Maintainers must validate the policy and supported hardware before shipping. A slow or broken WMI provider can block launch even when other readers succeed; the player can retry explicitly. No collector failure automatically bans an account.

The request schema and TPM binding bytes for accepted evidence are unchanged. No diagnostic status field has been added to the production API without server support. Collector results are ephemeral; raw identifiers are not added to logs, persisted reports or error messages by this change.

## Implementation TODOs

`[x]` means implemented locally, not deployed or verified on production.

| ID | Status | Task | Acceptance criterion |
|---|---|---|---|
| L01 | [x] | Replace empty-success collection with structured outcomes | Empty, failed and unsupported attempts cannot return launchable evidence |
| L02 | [x] | Preserve per-slot outcomes | Per-slot outcomes remain distinguishable when valid output is available |
| L03 | [x] | Bound execution and cancellation | Hung work is aborted; late output cannot become success; timers/listeners are cleaned up |
| L04 | [x] | Validate evidence at the ticket boundary | No HTTP request is made for missing or malformed HWID |
| L05 | [x] | Require completed attestation at launch | Unavailable/unconfigured attestation cannot request a ticket or spawn the game |
| L06 | [x] | Remove pre-attestation fingerprint fallback | Every transmitted vector belongs to its attestation attempt |
| L07 | [x] | Repeat validation on ticket refresh | Failed refresh cannot reuse the previous identity or spawn the game |
| L08 | [x] | Reject concurrent launch attempts | A second attempt cannot overlap verification or preparation |
| L09 | [x] | Add portable regression tests | Windows collection paths execute through injected runners on non-Windows CI |
| L10 | [x] | Document maintainer responsibilities | Server requirements identify responsible roles, priorities and acceptance criteria |
| L11 | [ ] | Validate real Windows PowerShell 5.1/WMI/TPM behavior | Test supported physical Windows devices, including slow/broken providers; no simulated runner |
| L12 | [ ] | Measure and tune collection latency | Record anonymized p50/p95/p99 timings before changing the deadline |
| L13 | [x] | Add independently bounded source groups | Fixed source groups, two worker slots, capped deadlines and close-aware cancellation |
| L14 | [ ] | Add UI cancellation if a cancel action is introduced | Connect the existing collector signal to the whole attempt, TPM work and cleanup; reject stale completions |
| L15 | [ ] | Integrate signed server evidence requirements | Depends on B02/B06; do not invent local minimum counts or a client-selected compatibility exception |
| L16 | [ ] | Integrate mandatory TPM/enrolment outcomes if required | Depends on B06/B07 and an agreed policy for unsupported hardware |
| L17 | [ ] | Add bounded automatic retry only after measurements | Fresh challenge when required; no overlapping children, retry storm or weakened requirements |
| L18 | [ ] | Package and run a Windows release smoke test | Real executable launch, expected failures and a successful verified session on a controlled backend |

L14/L17 are follow-up improvements, not prerequisites for the implemented local refusal. L11/L18 are release checks that cannot be replaced by unit tests. L15/L16 require changes outside this repository.

## Regression coverage and commands

Focused checks:

```sh
npm run typecheck
npx vitest run tests/machine-identity.test.ts tests/hwid-reader-process.test.ts tests/launch-ticket.test.ts tests/diagnostic-game-lifecycle.test.ts tests/hwid-pool-binding.test.ts tests/gameplay-patch-wiring.test.ts
```

Run `npx vitest run` for the complete TypeScript test suite. The repository's `npm test` and full release build also include native Windows/PowerShell/.NET checks; passing Vitest is not equivalent to passing those release checks.

Coverage includes empty/invalid evidence, placeholders, control characters, oversized output, unrequested/duplicate rows, incomplete output, partial timeout results, permission failures, hung runners, delayed event-loop deadlines, cancellation, unknown slots, unsupported systems, unavailable attestation, refresh failure and concurrent launches. Scheduler tests also cover queue deadlines, bounded concurrency, sibling cancellation, close acknowledgement and stale results. Portable process tests exercise actual child termination, nonzero exits and stdout/stderr limits. Existing TPM binding test vectors verify unchanged signature serialization.

### Verification performed

- Environment: macOS, Node.js 25.9.0; hardware collection uses injected Windows runners in unit tests.
- Focused suite: 119 tests passed across six files.
- `npm run typecheck`: passed.
- `npm run build:electron`: passed.
- Complete Vitest suite: 455 passed, 10 failed, three skipped. The same 10 failures reproduce from the unmodified `8f82770` sources on this environment: five Windows path-policy cases, four Windows Steam-discovery cases and one TPM activation case. They are not regressions introduced by this change.
- Native Windows/PowerShell/.NET release checks and real WMI/TPM execution have not been run. A successful Windows release smoke test remains a release requirement.

## Explicit limitations

- Readers within each source group remain sequential. Partial output improves diagnostics when valid completed rows are available; a deadline/cancellation race may discard those diagnostics. Malformed output is discarded. None of these failures permits launch.
- Cancellation support is available at the collector API; this change does not add a new UI cancel button or cancel every attestation dependency.
- A local process lock does not coordinate separate launcher processes or servers. Backend atomicity is required.
- No heartbeat, kernel driver, TPM requirement or hardware matching threshold has been added. Those need separate designs and, where applicable, server enforcement.
- A ticket remains subject to the existing transport and game protocol. This change does not establish proof of possession for a stolen bearer ticket.
- The backend's current admission behavior has not been verified here. Tests use controlled responses and never exercise production accounts.
