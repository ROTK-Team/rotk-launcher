param(
    [string]$ProxyPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# The proxy must load rotkc.dll from its own directory by absolute path and
# never through the DLL search order. A tiny test double stands in for the
# module: the real resources\patches\rotkc.dll is never copied or loaded here.
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
if ([string]::IsNullOrWhiteSpace($ProxyPath)) {
    $ProxyPath = Join-Path $repoRoot "resources\patches\vivoxsdk_x64.dll"
}
$testSource = Join-Path $PSScriptRoot "tests\rotkc_load_test.c"
$stubSource = Join-Path $PSScriptRoot "tests\rotkc_stub.c"
$dependencySource = Join-Path $PSScriptRoot "tests\rotkc_test_dep.c"
$outputDirectory = Join-Path $PSScriptRoot "dist\tests"
$test = Join-Path $outputDirectory "rotkc_load_test.exe"
$stub = Join-Path $outputDirectory "rotkc_stub.dll"
$dependency = Join-Path $outputDirectory "rotkc_test_dep.dll"
$dependencyLibrary = Join-Path $outputDirectory "rotkc_test_dep.lib"
$stubWithDependency = Join-Path $outputDirectory "rotkc_stub_dep.dll"

$zig = Get-Command -Name "zig" -CommandType Application -ErrorAction Stop
$version = ([string](& $zig.Source version)).Trim()
if ($LASTEXITCODE -ne 0 -or $version -ne "0.15.2") {
    throw "Expected Zig 0.15.2, found '$version'."
}
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
& $zig.Source cc -target x86_64-windows-gnu -shared -O2 -Wall -Wextra -Werror -o $stub $stubSource
if ($LASTEXITCODE -ne 0) { throw "rotkc.dll test double build failed with exit code $LASTEXITCODE." }
& $zig.Source cc -target x86_64-windows-gnu -shared -O2 -Wall -Wextra -Werror "-Wl,--out-implib,$dependencyLibrary" -o $dependency $dependencySource
if ($LASTEXITCODE -ne 0) { throw "rotkc.dll test dependency build failed with exit code $LASTEXITCODE." }
& $zig.Source cc -target x86_64-windows-gnu -shared -O2 -Wall -Wextra -Werror -DROTKC_STUB_WITH_DEPENDENCY=1 -o $stubWithDependency $stubSource $dependencyLibrary
if ($LASTEXITCODE -ne 0) { throw "rotkc.dll test double (with dependency) build failed with exit code $LASTEXITCODE." }
& $zig.Source cc -target x86_64-windows-gnu -O2 -municode -Wall -Wextra -Werror -o $test $testSource
if ($LASTEXITCODE -ne 0) { throw "rotkc.dll load test build failed with exit code $LASTEXITCODE." }
foreach ($double in @($stub, $stubWithDependency)) {
    if ((Get-Item -LiteralPath $double).Length -ge 1MB) {
        throw "Refusing to run: the rotkc.dll test double $double is unexpectedly large."
    }
}

# Private copies: loaded modules stay mapped until each test process exits.
$work = Join-Path $outputDirectory ("rotkc-load\" + [guid]::NewGuid().ToString("N"))
$withModule = Join-Path $work "with-module"
$withoutModule = Join-Path $work "without-module"
$decoy = Join-Path $work "decoy"
$legacy = Join-Path $work "legacy-imports"
$pathOnly = Join-Path $work "path-only-imports"
foreach ($directory in @($withModule, $withoutModule, $decoy, $legacy, $pathOnly)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
Copy-Item -LiteralPath $ProxyPath -Destination (Join-Path $withModule "vivoxsdk_x64.dll")
Copy-Item -LiteralPath $stub -Destination (Join-Path $withModule "rotkc.dll")
Copy-Item -LiteralPath $ProxyPath -Destination (Join-Path $withoutModule "vivoxsdk_x64.dll")
Copy-Item -LiteralPath $test -Destination (Join-Path $decoy "rotkc_load_test.exe")
Copy-Item -LiteralPath $stub -Destination (Join-Path $decoy "rotkc.dll")
Copy-Item -LiteralPath $ProxyPath -Destination (Join-Path $legacy "vivoxsdk_x64.dll")
Copy-Item -LiteralPath $stubWithDependency -Destination (Join-Path $legacy "rotkc.dll")
Copy-Item -LiteralPath $dependency -Destination (Join-Path $pathOnly "rotkc_test_dep.dll")

& $test (Join-Path $withModule "vivoxsdk_x64.dll") loaded
if ($LASTEXITCODE -ne 0) {
    throw "The Vivox proxy did not load rotkc.dll from its own directory (exit $LASTEXITCODE)."
}

$savedPath = $env:Path
# An import only PATH provides (as the VC++ runtime can be on some machines)
# must not stop the module from loading where the bare-name load used to.
try {
    $env:Path = "$pathOnly;$savedPath"
    & $test (Join-Path $legacy "vivoxsdk_x64.dll") legacy
    $legacyExit = $LASTEXITCODE
} finally {
    $env:Path = $savedPath
}
if ($legacyExit -ne 0) {
    throw "The Vivox proxy did not retry rotkc.dll with the legacy import search (exit $legacyExit)."
}

# Application directory, current directory and PATH all offer the double.
Push-Location -LiteralPath $decoy
try {
    $env:Path = "$decoy;$savedPath"
    & (Join-Path $decoy "rotkc_load_test.exe") (Join-Path $withoutModule "vivoxsdk_x64.dll") absent
    $absentExit = $LASTEXITCODE
} finally {
    $env:Path = $savedPath
    Pop-Location
}
if ($absentExit -ne 0) {
    throw "The Vivox proxy resolved rotkc.dll through the DLL search order (exit $absentExit)."
}
