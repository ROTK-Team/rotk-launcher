param([string]$OutputPath = "", [switch]$TestBuild)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root "native\diagnostics\diagnostics.c"
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $output = Join-Path $root "resources\diagnostics\ROTK.Diagnostics.exe"
} else {
    $output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
}
if ($TestBuild -and $output -eq (Join-Path $root "resources\diagnostics\ROTK.Diagnostics.exe")) {
    throw "Test builds must use a separate -OutputPath and must never be packaged."
}
$zig = Get-Command -Name "zig" -CommandType Application -ErrorAction Stop
$version = ([string](& $zig.Source version)).Trim()
if ($LASTEXITCODE -ne 0 -or $version -ne "0.15.2") { throw "Expected Zig 0.15.2, found '$version'." }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $output) | Out-Null
$compilerArgs = @("cc", "-target", "x86_64-windows-gnu", "-std=c11", "-O2", "-s", "-fno-ident", "-Wall", "-Wextra", "-Werror", "-municode", "-Wl,--dynamicbase", "-Wl,--nxcompat", "-Wl,--high-entropy-va")
if ($TestBuild) { $compilerArgs += "-DROTK_DIAGNOSTICS_TEST=1" }
$compilerArgs += @("-o", $output, $source, "-ldbghelp", "-lpsapi", "-lversion")
& $zig.Source @compilerArgs
if ($LASTEXITCODE -ne 0) { throw "Diagnostics helper build failed with exit code $LASTEXITCODE." }
$hasher = [Security.Cryptography.SHA256]::Create()
$stream = [IO.File]::OpenRead($output)
try { $hash = ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
finally { $stream.Dispose(); $hasher.Dispose() }
[IO.File]::WriteAllText("$output.sha256", "$hash  $([IO.Path]::GetFileName($output))`n", [Text.UTF8Encoding]::new($false))
Write-Host "Built diagnostics helper: $output ($hash)"
