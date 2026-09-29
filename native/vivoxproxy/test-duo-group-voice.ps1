param()
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$zig = Get-Command zig -CommandType Application -ErrorAction Stop
if (([string](& $zig.Source version)).Trim() -ne "0.15.2") { throw "Expected Zig 0.15.2" }
$outputDirectory = Join-Path $PSScriptRoot "dist\tests"
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
foreach ($test in @("duo_group_voice_test", "session_uri_test", "grant_lock_test")) {
    $output = Join-Path $outputDirectory "$test.exe"
    & $zig.Source cc -target x86_64-windows-gnu -O2 -Wall -Wextra -Werror -o $output (Join-Path $PSScriptRoot "tests\$test.c") -lwinhttp -lshell32 -lws2_32
    if ($LASTEXITCODE -ne 0) { throw "$test build failed" }
    & $output
    if ($LASTEXITCODE -ne 0) { throw "$test failed ($LASTEXITCODE)" }
}
