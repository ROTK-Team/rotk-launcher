Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$zigName = if ($env:ZIG_EXE) { $env:ZIG_EXE } else { 'zig' }
$zig = (Get-Command -Name $zigName -CommandType Application -ErrorAction Stop).Source
$dist = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$test = Join-Path $dist 'menu-duo-test.exe'
& $zig cc -target x86_64-windows-gnu -O2 -DWIN32_LEAN_AND_MEAN -o $test (Join-Path $PSScriptRoot 'tests/menu_duo_test.c')
if ($LASTEXITCODE -ne 0) { throw 'Native menu test compilation failed' }
& $test
if ($LASTEXITCODE -ne 0) { throw 'Native menu test failed' }
$trioTest = Join-Path $dist 'menu-trio-test.exe'
& $zig cc -target x86_64-windows-gnu -O2 -DWIN32_LEAN_AND_MEAN -o $trioTest (Join-Path $PSScriptRoot 'tests/menu_trio_test.c')
if ($LASTEXITCODE -ne 0) { throw 'Native Trio menu test compilation failed' }
& $trioTest
if ($LASTEXITCODE -ne 0) { throw 'Native Trio menu test failed' }
