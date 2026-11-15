import { execFile } from "node:child_process";
import { arch, cpus, freemem, platform, release, totalmem, uptime } from "node:os";
import { join } from "node:path";

/** Fixed PowerShell code and numeric/time inputs only; no renderer text reaches a command. */
function powershellJson(script: string, timeout = 12_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      windowsHide: true, timeout, maxBuffer: 512 * 1024, encoding: "utf8",
    }, (error, stdout) => {
      if (error) return reject(new Error("Windows diagnostic query unavailable"));
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, "").trim() || "null")); }
      catch { reject(new Error("Windows diagnostic query returned invalid data")); }
    });
  });
}

export async function collectDiagnosticSystemInfo(): Promise<Record<string, unknown>> {
  const processors = cpus();
  const basic: Record<string, unknown> = {
    os: { platform: platform(), release: release(), architecture: arch() },
    cpu: { model: processors[0]?.model ?? "unknown", logicalProcessors: processors.length },
    memory: { totalBytes: totalmem(), availableBytes: freemem() },
    uptimeSeconds: Math.round(uptime()),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    utcOffsetMinutes: -new Date().getTimezoneOffset(),
    capturedAt: new Date().toISOString(),
  };
  if (platform() !== "win32") return basic;
  try {
    basic.windows = await powershellJson(`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$osInfo = Get-CimInstance Win32_OperatingSystem
$videoInfo = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, DriverDate, AdapterRAM, CurrentHorizontalResolution, CurrentVerticalResolution)
$pageInfo = @(Get-CimInstance Win32_PageFileUsage | Select-Object AllocatedBaseSize, CurrentUsage, PeakUsage)
[pscustomobject]@{ caption=$osInfo.Caption; version=$osInfo.Version; build=$osInfo.BuildNumber; freePhysicalMemoryKiB=$osInfo.FreePhysicalMemory; freeVirtualMemoryKiB=$osInfo.FreeVirtualMemory; totalVirtualMemoryKiB=$osInfo.TotalVirtualMemorySize; video=$videoInfo; pageFiles=$pageInfo } | ConvertTo-Json -Depth 6 -Compress
`);
  } catch { basic.windowsQueryStatus = "unavailable"; }
  return basic;
}

/** Only Application Error/Hang/WER records matching this game's PID and launch window. */
export async function collectGameWindowsEvents(pid: number | null, startedAt: string, endedAt = new Date().toISOString()): Promise<Record<string, unknown>> {
  if (platform() !== "win32") return { status: "unsupported", events: [] };
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !Number.isSafeInteger(pid) || (pid ?? 0) <= 0) {
    return { status: "unavailable", events: [] };
  }
  // Interpolate only validated integer literals. Never include paths, names or text in code.
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$from = [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.floor(start - 2000)}).LocalDateTime
$until = [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.floor(end + 30000)}).LocalDateTime
$gameProcessId = [uint32]${pid}
$records = @(Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000,1001,1002; StartTime=$from; EndTime=$until} -MaxEvents 100 -ErrorAction SilentlyContinue)
$result = @()
foreach ($record in $records) {
  $xml = [xml]$record.ToXml()
  $fields = @{}
  foreach ($entry in $xml.Event.EventData.Data) { if ($entry.Name) { $fields[[string]$entry.Name] = [string]$entry.'#text' } }
  $xmlText = $xml.OuterXml
  if ($xmlText -notmatch '(?i)H1Z1\\.exe') { continue }
  $eventPid = $null
  foreach ($name in @('ProcessId','ProcessID','FaultingProcessId')) {
    if ($fields.ContainsKey($name)) {
      try { $rawPid = $fields[$name]; $eventPid = if ($rawPid.StartsWith('0x')) { [Convert]::ToUInt32($rawPid.Substring(2),16) } else { [uint32]$rawPid } } catch {}
      break
    }
  }
  if ($eventPid -ne $null -and $eventPid -ne $gameProcessId) { continue }
  # Keep structured fault information only, never rendered messages/command lines.
  $selected = @{}
  foreach ($name in @('AppName','AppVersion','AppTimeStamp','ModuleName','ModuleVersion','ModuleTimeStamp','ExceptionCode','FaultingOffset','ProcessId','ProcessCreationTime','ReportId','IntegratorReportId','EventName','Response','CabId','P1','P2','P3','P4','P5','P6','P7','P8','P9','P10','HangType')) {
    if ($fields.ContainsKey($name)) { $selected[$name] = $fields[$name] }
  }
  $result += [pscustomobject]@{ at=$record.TimeCreated.ToUniversalTime().ToString('o'); eventId=$record.Id; provider=$record.ProviderName; correlation= $(if ($eventPid -ne $null) {'pid-and-time'} else {'executable-and-time-only'}); data=$selected }
}
ConvertTo-Json -InputObject @($result) -Depth 6 -Compress
`;
  try { return { status: "queried", events: await powershellJson(script) }; }
  catch { return { status: "unavailable", events: [], issue: "Windows Application log could not be read" }; }
}
