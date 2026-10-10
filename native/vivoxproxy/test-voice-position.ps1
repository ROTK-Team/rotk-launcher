param([string]$ProxyPath = "")
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$zig = Get-Command zig -CommandType Application -ErrorAction Stop
if (([string](& $zig.Source version)).Trim() -ne "0.15.2") { throw "Expected Zig 0.15.2" }
$outputDirectory = Join-Path $PSScriptRoot "dist\tests"
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$output = Join-Path $outputDirectory "voice_position_test.exe"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if ([string]::IsNullOrWhiteSpace($ProxyPath)) { $ProxyPath = Join-Path $root "resources\patches\vivoxsdk_x64.dll" }
$sdk = Join-Path $root "resources\patches\vivoxsdk_x64_v5.dll"
if (-not [string]::IsNullOrWhiteSpace($ProxyPath)) {
    $ProxyPath = (Resolve-Path -LiteralPath $ProxyPath).Path
    $sdk = Join-Path (Split-Path -Parent $ProxyPath) "vivoxsdk_x64_v5.dll"
    if (-not (Test-Path -LiteralPath $sdk -PathType Leaf)) { throw "Candidate must have the Vivox SDK alongside it" }
}
& $zig.Source cc -target x86_64-windows-gnu -O2 -Wall -Wextra -Werror -o $output (Join-Path $PSScriptRoot "tests\voice_position_test.c") -lwinhttp -lshell32
if ($LASTEXITCODE -ne 0) { throw "Voice position test build failed" }
if ([string]::IsNullOrWhiteSpace($ProxyPath)) { & $output $sdk }
else { & $output $sdk $ProxyPath }
if ($LASTEXITCODE -ne 0) { throw "Voice position test failed ($LASTEXITCODE)" }
