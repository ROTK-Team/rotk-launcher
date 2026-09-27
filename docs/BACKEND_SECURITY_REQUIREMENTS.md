# Backend and game-server security requirements

## Purpose and ownership

This is the server-side handoff for [launcher hardware verification hardening](HWID_HARDENING.md). These tasks are **not implemented in this repository**. They require account-service, game-server, infrastructure and policy owners. None should be marked complete solely because the launcher blocks an action locally.

Review basis: launcher commit `8f82770` and local tests. The old client can omit HWID after collection failure. Production server behavior and configuration were not inspected. Server-side weaknesses below are audit requirements, not assertions that every listed issue exists.

The core invariant is: a protected game session is created only after the server has positively established the evidence required by its own policy. An error, absence of data, unknown policy or unavailable dependency must not become an authorization success. This follows [OWASP's deny-by-default authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).

## P0: admission and tickets

### B01 — Inventory every admission route

- [ ] Identify ticket issuance, game login, reconnect, server transfer, legacy API, admin/test routes and supported old clients.
- [ ] Trace the same account through all routes and identify the authoritative decision and session store.
- [ ] Apply one admission policy to all protected routes; remove silent compatibility bypasses.
- Owner: account service and game server.
- Acceptance: no route creates a protected session when required evidence is absent, invalid or rejected. TEST credentials/tickets cannot authorize PROD.

### B02 — Make hardware-evidence requirements explicit and server-owned

- [ ] Reject omitted, null, empty and placeholder-only evidence when hardware verification is required.
- [ ] Validate allowed slots, types, lengths, control characters, duplicate JSON keys, canonicalization and resource limits before verification/storage.
- [ ] Define minimum evidence quality and required proofs using measured hardware compatibility and collision data. Do not choose an arbitrary count of strings.
- [ ] Bind the required policy to a server-held attempt and, when communicated to the launcher, an authenticated/signed contract.
- [ ] Do not let platform, version, TPM absence or an error reported by the client select a weaker route.
- Owner: account service and security/product policy owners.
- Acceptance: an empty result never means a clean device; a fabricated nonempty vector is not automatically considered strong identity. New accounts cannot self-select a weak exception.

### B03 — Implement an explicit verification decision

- [ ] Distinguish allow, banned, insufficient evidence, transient failure, unsupported capability and re-verification required.
- [ ] Issue no gameplay ticket for pending/retry/unsupported/insufficient states.
- [ ] Treat lookup timeout, database failure and unknown configuration as inability to authorize, not as absence of a ban.
- [ ] Return actionable errors without publishing exact ban-matching components or thresholds.
- [ ] Never automatically impose a permanent ban merely because WMI, TPM or the network failed.
- Owner: account service.
- Acceptance: induced dependency failures create neither a protected session nor an automatic cheating verdict.

### B04 — Bind challenges, evidence and tickets

- [ ] Bind attempts to authenticated account, environment, policy version, required proofs, nonce and expiry.
- [ ] Validate signature bytes and binding consistently across implementations; reject mismatched vectors/proofs and stale or consumed challenges.
- [ ] Keep server-owned expiry and unique challenge state. Do not trust the workstation clock.
- [ ] Bind a ticket to the approved attempt, account, intended game-server audience and environment.
- [ ] Audit the existing NUL-separated `tpmBindingMessage` contract: delimiters, allowed characters and normalization must be unambiguous. Version any incompatible changes and provide shared test vectors.
- Owner: account service and game server.
- Acceptance: evidence from another account/attempt/environment or edited after signing cannot authorize entry.

### B05 — Make ticket consumption atomic and retry-safe

- [ ] Atomically exchange a short-lived ticket for a session; simultaneous consumers across nodes cannot create two sessions.
- [ ] Recheck the authoritative ban/revocation state at admission and define required database/cache consistency.
- [ ] Define authenticated, bounded idempotency for response loss after challenge consumption and after ticket consumption.
- [ ] A retry may retrieve the same permitted result/status, but cannot create another authorization or revive a closed/revoked session.
- [ ] Determine whether the game protocol supports independent proof of possession. Account metadata inside a bearer ticket alone does not stop theft before first use.
- Owner: game server, account service and infrastructure.
- Acceptance: replay, concurrent consumption, expired tickets, wrong audiences and retry after a later ban fail as specified; valid transport retries do not duplicate sessions.

## P1: hardware trust and matching

### B06 — Define and verify the TPM trust model

- [ ] Separate possession of a signing key from proof that it resides in an accepted TPM.
- [ ] Define trusted endorsement identities/certificate chains or another reviewed enrolment trust process.
- [ ] Verify activation is bound to the intended identity key, endorsement material and fresh enrolment; an arbitrary self-asserted EK is insufficient by itself.
- [ ] Persist activation server-side; a client field must never establish an activated state.
- [ ] Test software keys, vTPM, unsupported algorithms, untrusted issuers and missing/invalid endorsement certificates.
- Owner: account service and security policy owner.
- Acceptance: only evidence meeting the published trust model receives the corresponding assurance level. See [Microsoft's TPM attestation overview](https://learn.microsoft.com/en-us/azure/attestation/tpm-attestation-concepts).

TPM signatures do not prove that arbitrary WMI/registry values are true. TPM key attestation also does not, by itself, prove the integrity of the running launcher. Platform measurements would require a separate reviewed design.

### B07 — Prevent silent downgrade and uncontrolled re-enrolment

- [ ] Define behavior for TPM disabled/cleared, deleted keys, reinstall, firmware changes, absent certificates and unsupported hardware.
- [ ] Track trusted device anchors across signing-key changes where the trust model supports it.
- [ ] Do not reset enforcement because a client deletes its cache, claims another platform or registers a new key.
- [ ] Apply evidence requirements to first-time accounts as well as previously enrolled ones.
- [ ] Make exceptions server-issued, scoped, time-limited, auditable and revocable. Explicitly separate lower-assurance environments if offered.
- Owner: account service, support and product policy owners.
- Acceptance: a capability failure cannot silently lower the requirements of the same protected game mode.

### B08 — Validate ban matching and protect identity history

- [ ] Separate trusted anchors from weak observations; model names are not unique identifiers.
- [ ] Measure false matches and stability; correlated fields from one component are not independent evidence.
- [ ] Distinguish agreement, contradiction and missing data. Missing fields must not improve confidence or become a clean verdict.
- [ ] Do not replace trusted identity history or extend device bans from arbitrary new client claims.
- [ ] Handle shared computers, secondhand hardware, repairs, replacement components and reinstalls through reviewed recovery/appeal rules.
- Owner: account service and moderation/support.
- Acceptance: synthetic identity-history poisoning does not spread bans to unrelated devices; legitimate hardware changes have a tested recovery path.

## P2: ongoing sessions, operations and rollout

### B09 — Specify active-session revocation

- [ ] Define the maximum time between a ban/revocation and removal from active play.
- [ ] Propagate revocation with recovery for lost events, restarts, partitions, reconnects and server transfers.
- [ ] Apply loss of trust in a key, anchor, certificate issuer or policy to existing enrolments, tickets and sessions.
- [ ] Decide separately whether continuous launcher presence is actually required. If required, enforce a bounded server-side session lease with authenticated, fresh renewals.
- Owner: game server and infrastructure.
- Acceptance: revocation reaches the agreed deadline. Local timers or repeatable heartbeat messages cannot extend authorization indefinitely.

P0 protects new admission. If prompt removal from existing sessions is a release requirement, move the relevant B09 tasks into P0. A heartbeat does not prove the responder is an unmodified launcher.

### B10 — Add observability and protect collected data

- [ ] Log attempt ID, policy version, decision class, proof availability and stage timings without raw hardware identifiers or credentials in standard logs.
- [ ] Limit collection to justified signals, restrict access and define retention/recovery procedures.
- [ ] Review keyed hashing/domain separation of stored identifiers and key rotation without losing ban continuity.
- [ ] Measure missing evidence, enrolment failures, latency percentiles, retry rate, false denials, appeals and revocation delay.
- [ ] Add bounded request sizes, rate limits, concurrency limits and backpressure for expensive verification/enrolment work.
- Owner: infrastructure, account service and support.
- Acceptance: malformed or high-volume requests cannot cause unbounded work; logs and diagnostics do not expose secrets.

### B11 — Coordinate protocol rollout and release gates

- [ ] Test server contracts with synthetic accounts and controlled hardware before production.
- [ ] Define supported launcher/protocol versions and the exact enforcement activation point.
- [ ] Close legacy routes before describing the system as protected.
- [ ] Use observation mode only for measurements; it is not enforcement and is not completion.
- [ ] Maintain a rollback that preserves the required authorization policy. If verification cannot be restored safely, use a controlled admission outage rather than accepting missing evidence.
- Owner: release engineering and all component owners.
- Acceptance: mixed versions and rollback do not silently disable evidence requirements; supported legitimate configurations pass controlled release tests.

## Required edge-case acceptance matrix

Each row needs an owner and recorded results. These are required tests, not claims that every current server behavior is vulnerable.

| Group | Cases | Expected property |
|---|---|---|
| Empty evidence | Omitted/null/empty HWID, empty strings, placeholders | No authorization when required evidence is absent |
| Partial evidence | One slot, weak model fields only, missing required fields | Explicit quality decision; no count-only assumption |
| Input schema | Arrays, numbers, nesting, unexpected fields, duplicate JSON keys | Consistent bounded validation |
| Input boundaries | Excessive slots/length, Unicode, NUL/control characters | No parser/signature ambiguity or excessive work |
| Canonicalization | Case, whitespace, ordering, encoding and separators | Cross-language signature vectors agree |
| Collection errors | WMI/PowerShell unavailable, permissions, process failure | Retry/refusal, never implied success |
| Collection output | Truncated JSON, BOM, noise, missing rows, oversized output | Invalid evidence remains invalid |
| Resource starvation | CPU/disk/RAM pressure, stuck helper, delayed event loop | Deadlines cannot weaken requirements |
| Lifecycle | Suspend/resume, hibernation, cancel, close, reboot | Stale attempts cannot authorize a new session |
| Concurrency | Multiple launchers, repeated Play, out-of-order responses | Attempts and identities remain isolated |
| Challenges | Expired/consumed/unknown challenge, changed policy | No new authorization from stale state |
| Proof binding | Wrong key, vector/account/attempt mismatch, edits after signing | Invalid binding rejected |
| TPM availability | Missing/disabled/cleared/busy TPM, deleted keys, old firmware | Explicit policy, no silent downgrade |
| TPM trust | Software key, unknown EK, invalid/missing certificate, vTPM | No unearned hardware assurance |
| Enrolment | Activation replay, wrong key pair, parallel activation, restart | Atomic, correctly bound activation |
| Trust revocation | Compromised key, revoked issuer/anchor/policy | Existing trust and derived authorizations reevaluated |
| Key rotation | New signing key, deleted cache, reinstall | No automatic erasure of enforcement |
| First use | New account/device with no history | Cannot self-select weaker requirements |
| Hardware topology | RAID/NVMe/USB, multiple disks, reordering, OEM defaults | Stable collection rules; no false uniqueness |
| Legitimate changes | BIOS update, repairs, component replacement, reinstall | Tested recovery without automatic cheating verdict |
| Collisions | Shared/cloned systems, secondhand hardware, identical models | Weak similarity alone is not permanent-ban proof |
| History poisoning | Rapidly changing or unrelated claimed identifiers | Trusted associations are not automatically overwritten |
| Tickets | Theft, replay, expiry, wrong audience, simultaneous consumers | Defined possession model and atomic consumption |
| Ban races | Ban before/after issuance, during admission, during play | Fresh decision and bounded revocation |
| Time | Wrong client clock, delayed replies, server clock skew | Authoritative expiry with bounded tolerance |
| Storage | Stale cache, replica lag, outage, lock loss, region restart | No accidental authorization on uncertainty |
| Network | DNS/TLS failure, 429/5xx, response loss after success | Bounded, authenticated, idempotent retries |
| Alternate entry | Legacy/direct game login, reconnect, admin/test routes | Same protected-mode authorization |
| Environment | TEST material on PROD, target switch mid-attempt | Trust and credentials stay scoped |
| Platform claims | Linux/Proton/VM, false version/capability claims | Client cannot select an exemption |
| Ongoing session | Stopped launcher, missing/replayed renewals | Agreed server-side session policy |
| Dependency outage | Ban/auth/enrolment/key-service failure | Controlled new-admission failure |
| Overload | Retry storms, expensive proofs, many registrations | Bounded resources and fair limits |
| Deployment | Mixed versions, unknown policy, rollback, key rotation | No silent verification disablement |
| Exceptions | Support access, staff accounts, expired exceptions | Scoped, audited and revocable |
| Diagnostics | Dumps, telemetry, proxy logs, support bundles | Credentials and identifiers protected |

## Information maintainers must provide before integration

1. Authoritative endpoints and owners for admission, enrolment, ban matching and session revocation.
2. Current schemas, policy flags, trust anchors and environment boundaries.
3. Supported hardware/platform policy and intended treatment of shared or repaired devices.
4. Controlled test environment and synthetic accounts, including a banned test identity.
5. Agreed latency, retry, availability and revocation targets, plus the owner of policy exceptions.
