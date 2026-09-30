# ROTK Windows diagnostics helper

`ROTK.Diagnostics.exe` is an external x64 Windows crash collector. The launcher
starts it hidden for the exact `H1Z1.exe` PID it launched, drains stdout, and keeps
stdin open while the game runs. It requires the same user/integrity level as the
game. Failure to attach is reported and must never block game launch.

## Build and verification

Zig **0.15.2** is required, matching the existing native build scripts.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-diagnostics.ps1
node --test native/diagnostics/tests/integration.mjs
```

The production build writes `resources/diagnostics/ROTK.Diagnostics.exe` and
`ROTK.Diagnostics.exe.sha256`. Tests compile a separate helper that also accepts
the dedicated `ROTK.Diagnostics.Fixture.exe`; the production executable refuses
that fixture. Test builds cannot overwrite the packaged executable. All test
executables/dumps are kept under the ignored `native/diagnostics/dist/` directory.

Integration tests exercise real Windows debug events and DbgHelp dumps: fatal
access violation, stack overflow, 100 handled exceptions, manual minidump/full
memory dump, standalone snapshot, unexpected process rejection, existing debugger
rejection, clean stdin EOF detachment and forcibly killed helper survival. Dump
headers and streams are inspected, including the real fatal exception code,
exception address, thread context, thread/module/system lists and full-memory
stream. Optional Debug tests also exercise real CPU, 64 MiB allocation/release,
40 MiB read/write activity, thread counters, attach-denied sampling, crash capture
while sampling, and accelerated rotation/duration limits. No running player
process is used by these tests.

The current Windows fixture suite passes **14/14** native integration tests.
The TypeScript observer suite and opt-in native bridge smoke pass **24/24**,
including sampling behind another debugger and stopping it while the target and
its first debugger remain alive:

```powershell
$env:ROTK_DIAGNOSTICS_SMOKE = '1'
npx vitest run tests/diagnostic-observer.test.ts tests/diagnostic-native-smoke.test.ts
```

## CLI contract, version 1

```text
ROTK.Diagnostics.exe --watch --pid 1234 --output C:\local\session-directory
ROTK.Diagnostics.exe --watch --pid 1234 --output C:\local\session-directory --debug
ROTK.Diagnostics.exe --snapshot --pid 1234 --output C:\local\session-directory
ROTK.Diagnostics.exe --snapshot --pid 1234 --output C:\local\session-directory --full
```

The caller creates the session directory's parent. Only local fixed-drive output
is accepted. UNC/network output is rejected. `--full` is only valid with the
standalone `--snapshot` mode. `--debug` is only valid with `--watch` and must be
chosen before starting the helper. For a watch session, stdin accepts simple UTF-8/ASCII
lines terminated by `\n`: `snapshot`, `full`, `stop`. Unknown/oversized commands
are rejected. These are plain lines, not JSON objects. Pipe EOF and Ctrl+C request
clean detachment. The launcher must keep consuming stdout and must not suspend
the helper while debugging is active. Shell quoting is unnecessary when spawned
with an argument array and `windowsHide: true`.

Stdout and `native-events.jsonl` contain one JSON object per line. The optional
`performance-*` events use a separate journal described below. Every
object has `event`, `at` (UTC ISO timestamp) and `pid`. Important events:

| Event | Additional fields |
| --- | --- |
| `attached` | `helperVersion`, `architecture`, `killOnExit: false`, `firstChancePolicy` |
| `attach-breakpoint` | `threadId`; the synthetic attach breakpoint was consumed |
| `attach-failed` | `reason`, `win32Error` when supplied by Windows |
| `exception` | `firstChance`, hexadecimal `code`/`address`, `flags`, `threadId`, exception `parameters`, `contextAvailable`, x64 integer `registers` |
| `exception-count` | hexadecimal `code`, cumulative `count` of debug exception notifications |
| `module` | filtered `name`, hexadecimal `base`, four-component `version` |
| `module-unloaded` | hexadecimal `base` |
| `thread-created` / `thread-exited` | `threadId`, start address or exit code |
| `sample` | elapsed milliseconds, process working/private/peak memory, CPU percentage normalized across all logical CPUs, CPU time, handle count, physical memory/commit totals and availability, availability booleans |
| `dump-started` | `kind: "fatal" \| "snapshot"`, `full` |
| `dump-retry` | `kind`, `reason`, original `win32Error` |
| `dump-written` | `kind`, `full`, `path` (**basename only**), `bytes`, `exceptionStream`, actual minidump `flags` |
| `dump-failed` | `kind`, `full`, `reason`, optional `win32Error` or `requiredBytes` |
| `exited` | unsigned decimal `exitCode`, `exitCodeHex`, `elapsedMs`, `fatalDumpCount` |
| `detached` | `success`, `win32Error` |
| `debug-error` / `command-rejected` | `reason`, optional `win32Error` |

Success returns exit code 0; malformed arguments/output returns 2; validation or
attach failure returns 3; standalone dump failure returns 4. In Debug mode, a
validated/opened target can keep sampling after an attach failure, so the helper
stays alive and later returns 0; the earlier `attach-failed` remains authoritative
for automatic fatal-dump availability. The game exit code
is reported in the `exited` event, not used as the helper exit code. Manual
snapshots have no fabricated fatal exception stream. All paths reported over
stdout are basenames or `%WINDIR%` relative names, never user profile paths.

## Optional Debug process counters

Without `--debug`, the existing five-second sampler, crash handling and file
contract remain unchanged. With `--debug`, counters for the supplied process are
sampled approximately every second, without additional thread suspension, hooks,
injection, privilege changes or inspection of other processes. Sampling waits
until the synthetic debugger-attach breakpoint has been continued. A fatal
exception requests one last sample before dump generation.

This helper **does not measure frame times, FPS, GPU load or individual
microstutters**. Its process counters contextualize an independently measured
frame-time spike; a one-second average can miss a short pause. Every performance
status/summary says `frameTimesCollected: false` and
`frameTimesStatus: "separate-presentmon-required"`. The launcher's separate
PresentMon collector, when available under the current Windows permissions,
provides its own frame-data status. Native process counters do not claim that the
separate collector succeeded. ETW normally requires administrator or Performance
Log Users permissions; no account/group change or elevation is performed here.

Performance events contain `schemaVersion: 1`, `event`, `pid`, UTC `at`, monotonic
`elapsedMs` and a decimal-string `qpc` value. The initial `performance-status`
also includes `startQpc`, `qpcFrequency`, `logicalProcessors`, requested interval,
duration/storage limits and journal availability. Every durable summary retains
`startQpc` and `qpcFrequency`, alongside its `qpc`/UTC anchor, even after the
initial status has rotated out of the journals. Debug mode adds `monotonicMs`
and string `qpc` to ordinary native events too. Use UTC for server correlation
and monotonic/QPC deltas for local ordering; wall-clock corrections can affect UTC.

Each `performance-sample` reports:

| Data | Interpretation |
| --- | --- |
| `intervalMs`, `cpuPercent`, `cpuOneCorePercent`, `cpuTime100ns` | Actual sampling interval; total CPU normalized across logical processors; CPU where 100% means one logical core; cumulative kernel + user time |
| `privateBytes`, `workingSetBytes`, respective deltas | Private committed bytes and resident working set; these are different memory measurements |
| `pageFaultCount`, `pageFaultDelta`, `pageFaultsPerSecond` | Soft **and** hard faults combined; this cannot establish disk paging |
| `ioReadBytes`, `ioWriteBytes`, `ioOtherBytes`, operation counts, byte deltas/rates | Process I/O counters, including cached/non-disk I/O; these are not physical disk throughput or latency |
| `threadCount`, `threadsCreated`, `threadsExited` | Debug-event-derived current count and changes since the previous sample; no thread enumeration |
| `handleCount` | Count only, without handle names or contents |
| `systemPhysicalAvailableBytes`, `systemCommitAvailableBytes` | Windows available physical memory and available commit |
| `queryCostMs`, `signals` | Time querying counters and threshold annotations, not frame-time measurements |

Availability flags (`cpuAvailable`, `memoryAvailable`, `ioAvailable`,
`threadsAvailable`, `handlesAvailable`, `systemAvailable`) must be honored. Delta
availability flags are false on the first sample or after missing measurements.
An unavailable field serialized as zero is **not** a measured zero. The summary's
`validSamples` counts identify categories with no usable measurements.

The `signals` thresholds mark CPU growth of at least 50 one-core percentage points,
a working-set drop of at least 32 MiB, private-memory growth of at least 64 MiB,
at least 1,000 faults/second, combined read/write I/O of at least 8 MiB/second, or a
sample interval of at least 1,500 ms. These are investigation clues, not proof of
a stutter or its cause. Sixteen `topIntervals` are retained by a simple weighted
score of CPU, faults, I/O, working-set drops and sampler delay; they are not a
complete timeline or a statistical severity classifier.

If debugger attachment is unavailable after process validation/opening, Debug
mode emits `attach-failed` and continues sampling without debugger attachment.
Its explicit fallback handshake is a `performance-status` with
`source: "windows-process-counters"`, `status: "recording"`,
`debuggerAttached: false`, `reason: "debugger-attach-unavailable"` and the target
PID. It never emits a fabricated `attached` event. Thread counts are unavailable
in this mode, and fatal exception streams/dumps cannot be observed by this
helper. `stop`/stdin EOF ends sampling cleanly. The launcher may terminate only
this helper after that handshake; it must never terminate the target PID. An
initial recording status alone is insufficient to authorize forced termination
because attachment could still be in progress.

All performance files are written directly inside the exact `--output`
directory; the helper does not append `native` or `report` subdirectories:

* `performance.jsonl` and `performance.jsonl.1` each retain approximately 16 MiB,
  with at most one-record overshoot. They contain `performance-status`,
  `performance-sample` and `performance-summary` events, also forwarded on stdout.
  Performance events never consume the crash journal's rotation budget.
* `performance-summary.json` is atomically replaced at startup, about every
  30 seconds, and when sampling finishes. It includes all collected totals,
  peaks, category availability counts, sixteen selected intervals, write errors,
  rotation counts and sampler overhead. It stays below 64 KiB in the fixture.
* High-rate sampling stops after **eight hours** and writes
  `reason: "duration-limit"`; crash observation continues. Stop/exit summaries
  use `stopped`/`process-exited`. The two journals retain the newest bounded
  portion, while the summary retains the entire collected period. A forced
  helper termination can lose work since the last periodic summary and leave a
  summary `.tmp` file; import only the completed `.json`.

The export service should include both performance journals and the summary with
their own budget; a generic 2 MiB log tail discards most of the retained timeline.
At roughly 1.3 KiB per sample in the local fixture, 32 MiB preserves several
hours, but actual retention depends on event size. Reading/writing samples and
flushing stdout/files can delay the sampler, particularly on a slow disk or if
the parent stops draining stdout. `intervalMs` reveals delays. This is bounded
storage and duration, not a guarantee of zero timing impact.

On the local Windows synthetic workload, five samples over about 4.2 seconds
reported a maximum sampler operation of **0.763 ms** and about **8.9 KiB** of
performance JSONL. The helper's process CPU counter reported 0% in this short
run; Windows accounting granularity makes that an observation, not evidence of
zero CPU usage. `sampleWorkTotalMs`/`sampleWorkMaxMs` include querying, formatting
and sample writes; they exclude periodic summary writes. Overall helper CPU also
includes debugger/dump work. These fixture measurements are not a game benchmark
or a latency guarantee; the automated thresholds are below 2% normalized helper
CPU and below 100 ms maximum sampler work on that synthetic run.

## Evidence and limits

* `DebugActiveProcess` attaches only to the supplied, validated `H1Z1.exe` PID. No
  `SeDebugPrivilege`, elevation, process enumeration, DLL injection, system crash
  registry settings or networking is used.
* Immediately after attach, the same thread calls
  `DebugSetProcessKillOnExit(FALSE)`. An unsuccessful safety call aborts attach.
  Stopping or killing the helper leaves the game running. Debugging can still
  affect timing or interact with anti-cheat/debugger checks, so the launcher must
  expose capture status and support a manual snapshot fallback.
* First-chance exceptions are always continued with
  `DBG_EXCEPTION_NOT_HANDLED`, so the game's own exception handlers run. Only the
  initial synthetic attach breakpoint at the target's `ntdll!DbgBreakPoint`
  address is consumed. Three detailed notifications per exception code are
  recorded, with counters thereafter (64 tracked codes). Fatal second-chance
  exceptions are always recorded and are never swallowed.
* On second chance, the stopped faulting thread's x64 `CONTEXT` and exception
  record are obtained from the debug event and passed to `MiniDumpWriteDump`
  **from this separate process**, with `ClientPointers = FALSE`. This works when
  the game has exhausted its stack. The dump preserves thread contexts/stacks,
  modules, module versions, unload information when Windows provides it, memory
  layout and indirectly referenced memory. Register details are also JSON text.
* Default dumps request `MiniDumpWithThreadInfo`, `MiniDumpWithUnloadedModules`,
  `MiniDumpWithIndirectlyReferencedMemory`, `MiniDumpWithFullMemoryInfo`,
  `MiniDumpScanMemory`, `MiniDumpFilterModulePaths` and
  `MiniDumpIgnoreInaccessibleMemory`. They do not request full heap, handle names,
  security tokens or arbitrary output-debug strings. The raw dump may still
  contain sensitive in-process data. No dump is safe to post publicly merely
  because textual paths were filtered.
* Automatic minidumps use a DbgHelp cancellation callback with a 256 MiB target
  budget and 45-second deadline. A failed rich dump retries once without indirect
  memory/scan flags with a 15-second deadline. These callback checks are best
  effort, not hard kernel-enforced byte/time limits. The parent may impose an
  additional watchdog; it must allow fatal evidence time to finish.
* A manual full dump requires free space greater than all committed target
  regions plus **512 MiB** (committed mapped/shared memory is counted too). It
  captures all accessible game memory, may be several GiB, and uses a 180-second
  best-effort callback deadline. It can reveal tokens, messages or other data in
  game memory and must be explicitly requested through the diagnostic backend;
  the one-click player UI does not offer full-memory capture. A full
  dump cannot be reconstructed after a process has already exited.
* Every dump uses a unique UTC timestamp/PID/sequence name. A `.partial` file is
  renamed to `.dmp` only on success; incomplete files are deleted on normal
  failure. A forced helper termination may leave `.partial` files, which the
  launcher must not present as completed dumps. Per process: at most ten manual
  successful snapshots, two full dumps and two fatal dumps. Session/report disk
  retention is the launcher's responsibility.
* RAM/CPU/system commit is sampled every five seconds; exception counters every
  30 seconds and at exit. Journal rotation keeps the newest approximately 4 MiB
  and one approximately 4 MiB previous file (`native-events.jsonl.1`). Event size
  can cause a small overshoot. Module and thread event detail is bounded to
  2,048 and 512 events respectively. Module version metadata is only read from
  local fixed-drive files. Missing/unversioned files report `0.0.0.0`.
* Abrupt termination (`TerminateProcess`), power loss, a crash before attach,
  access restrictions, incompatible architecture, a second debugger, or kernel/
  GPU resets may not produce a user-mode fatal exception/dump. Report this gap;
  do not interpret absence of a dump as absence of a crash. Snapshots of a live
  hung process are useful but are not a simultaneous frozen image of all threads.
  Symbols/PDBs matching the exact game/launcher/native build are still required
  to resolve code offsets and recover meaningful source-level call stacks.

## Microsoft references

* [DebugActiveProcess](https://learn.microsoft.com/en-us/windows/win32/api/debugapi/nf-debugapi-debugactiveprocess)
* [DebugSetProcessKillOnExit](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-debugsetprocesskillonexit)
* [MiniDumpWriteDump](https://learn.microsoft.com/en-us/windows/win32/api/minidumpapiset/nf-minidumpapiset-minidumpwritedump)
* [MINIDUMP_EXCEPTION_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/minidumpapiset/ns-minidumpapiset-minidump_exception_information)
* [MINIDUMP_TYPE](https://learn.microsoft.com/en-us/windows/win32/api/minidumpapiset/ne-minidumpapiset-minidump_type)
* [GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)
* [GetProcessIoCounters](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getprocessiocounters)
* [IO_COUNTERS](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-io_counters)
* [PROCESS_MEMORY_COUNTERS_EX](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex)
* [StartTrace permissions](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-starttracew)
* [Intel PresentMon console and prerequisites](https://github.com/GameTechDev/PresentMon/blob/main/README-ConsoleApplication.md)
