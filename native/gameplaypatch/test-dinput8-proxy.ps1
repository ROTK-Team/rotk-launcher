[CmdletBinding()]
param(
    [string]$DllPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$source = Join-Path $root "dinput8_proxy.c"
if ([string]::IsNullOrWhiteSpace($DllPath)) {
    $proxy = Join-Path $root "dist\dinput8.dll"
} else {
    $proxy = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath(
        $DllPath
    )
}
$testRoot = Join-Path $root "dist\tests"
$smokeExe = Join-Path $testRoot "dinput8_proxy_smoke.exe"
$matrixExe = Join-Path $testRoot "protection_matrix_test.exe"
$markerExe = Join-Path $testRoot "marker_parse_test.exe"
$stanceExe = Join-Path $testRoot "weapon_stance_test.exe"

if (-not (Test-Path -LiteralPath $proxy -PathType Leaf)) {
    throw "Shotgun sprint proxy not found: $proxy"
}

$expectedHash = "2C8C7D65F8410A2F05F58318978B44F08860C4F5647B5474A11BF70A0EBC0B3A"
$expectedBytes = 34304
function Get-Sha256([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha256.ComputeHash($stream)
        return ([System.BitConverter]::ToString($digest)).Replace("-", "").ToUpperInvariant()
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

$actualHash = Get-Sha256 $proxy
$actualBytes = (Get-Item -LiteralPath $proxy).Length
if ($actualHash -cne $expectedHash -or $actualBytes -ne $expectedBytes) {
    throw "Unexpected shotgun sprint proxy: $actualHash / $actualBytes bytes"
}

$sourceText = Get-Content -LiteralPath $source -Raw
foreach ($forbidden in @(
    "AddVectoredExceptionHandler",
    "RemoveVectoredExceptionHandler",
    "SetUnhandledExceptionFilter",
    "MiniDumpWriteDump",
    "dbghelp",
    "VirtualAlloc",
    "VirtualFree",
    "GetAsyncKeyState",
    "ROTK_RESUME_HOOK_RVA",
    "ROTK_RESUME_RETURN_RVA",
    "resume_hook",
    "remote_code",
    "state_table",
    "EXCEPTION_BREAKPOINT"
)) {
    if ($sourceText.IndexOf(
            $forbidden,
            [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        throw "Forbidden mechanism remains in shotgun sprint source: $forbidden"
    }
}
foreach ($required in @(
    "ROTK_PATCH_A_SIGNATURE_RVA UINT32_C(0x1046F8D)",
    "ROTK_PATCH_A_OFFSET 11U",
    "ROTK_PATCH_A_STOCK 0x8FU",
    "ROTK_PATCH_A_VALUE 0x82U",
    "ROTK_PATCH_B_SIGNATURE_RVA UINT32_C(0x1046FD6)",
    "ROTK_PATCH_B_OFFSET 15U",
    "ROTK_PATCH_B_STOCK 0x74U",
    "ROTK_PATCH_B_VALUE 0xEBU",
    "ROTK_INITIAL_GRACE_MS 5000U",
    "ROTK_STABLE_READS_REQUIRED 20U",
    "ROTK_WATCH_INTERVAL_MS 2000U",
    "k_marker_name[] = L""rotk-shotgun-sprint.ini""",
    "k_marker_mode[] = ""mode=anti-slow-v3""",
    "k_marker_patch[] = ""patch=1046F98:8f>82,1046FE5:74>eb""",
    "if (!marker_enabled()) {",
    "if (install_patch_pair(image_base)) {",
    "start_watchdog(image_base);",
    "restore_patch_pair(g_image_base)",
    "result = g_direct_input8_create(",
    "start_patch_worker();",
    "return result;"
)) {
    if ($sourceText.IndexOf(
            $required,
            [System.StringComparison]::Ordinal) -lt 0) {
        throw "Required shotgun sprint contract missing: $required"
    }
}
if ($sourceText.Contains("if (SUCCEEDED(result))") -or
    $sourceText.Contains("if (FAILED(result))")) {
    throw "Worker startup must preserve the DirectInput HRESULT contract."
}
$forwardIndex = $sourceText.LastIndexOf("result = g_direct_input8_create(")
$workerIndex = $sourceText.LastIndexOf("start_patch_worker();")
$returnIndex = $sourceText.LastIndexOf("return result;")
if ($forwardIndex -lt 0 -or $workerIndex -le $forwardIndex -or
    $returnIndex -le $workerIndex) {
    throw "DirectInput forwarding must happen before worker startup."
}

$binary = [System.IO.File]::ReadAllBytes($proxy)
$ascii = [System.Text.Encoding]::ASCII.GetString($binary)
foreach ($forbiddenImport in @(
    "AddVectoredExceptionHandler",
    "SetUnhandledExceptionFilter",
    "MiniDumpWriteDump"
)) {
    if ($ascii.Contains($forbiddenImport)) {
        throw "Forbidden binary import/string remains: $forbiddenImport"
    }
}

$zig = Get-Command -Name "zig" -CommandType Application -ErrorAction Stop
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
& $zig.Source @(
    "cc",
    "-target", "x86_64-windows-gnu",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-o", $smokeExe,
    (Join-Path $root "tests\dinput8_proxy_smoke.c")
)
if ($LASTEXITCODE -ne 0) {
    throw "DirectInput proxy smoke-test compilation failed."
}
& $smokeExe ([System.IO.Path]::GetFullPath($proxy))
if ($LASTEXITCODE -ne 0) {
    throw "DirectInput proxy smoke test failed."
}

& $zig.Source @(
    "cc",
    "-target", "x86_64-windows-gnu",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-o", $matrixExe,
    (Join-Path $root "tests\protection_matrix_test.c")
)
if ($LASTEXITCODE -ne 0) {
    throw "Protection-matrix compilation failed."
}
& $matrixExe
if ($LASTEXITCODE -ne 0) {
    throw "Protection-matrix test failed."
}

& $zig.Source @(
    "cc",
    "-target", "x86_64-windows-gnu",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-o", $markerExe,
    (Join-Path $root "tests\marker_parse_test.c")
)
if ($LASTEXITCODE -ne 0) {
    throw "Marker-parse compilation failed."
}
& $markerExe
if ($LASTEXITCODE -ne 0) {
    throw "Marker-parse test failed."
}

# Stance uses a bounded RX trampoline and mouse state reads; neither installs
# an exception handler. Verify the native setter thunk and action lookup too.
& $zig.Source @(
    "cc", "-target", "x86_64-windows-gnu", "-O2", "-Wall", "-Wextra", "-Werror",
    "-o", $stanceExe, (Join-Path $root "tests\weapon_stance_test.c"), "-luser32"
)
if ($LASTEXITCODE -ne 0) { throw "Weapon stance test compilation failed." }
& $stanceExe
if ($LASTEXITCODE -ne 0) { throw "Weapon stance test failed." }

$respawnExe = Join-Path $testRoot "respawn_address_test.exe"
& $zig.Source @(
    "cc", "-target", "x86_64-windows-gnu", "-O2", "-Wall", "-Wextra", "-Werror",
    "-o", $respawnExe, (Join-Path $root "tests\respawn_address_test.c"), "-luser32"
)
if ($LASTEXITCODE -ne 0) { throw "CZ respawn test compilation failed." }
& $respawnExe --unpatched
if ($LASTEXITCODE -ne -1073741819) { throw "CZ native access violation was not reproduced." }
& $respawnExe
if ($LASTEXITCODE -ne 0) { throw "CZ respawn repair test failed." }

Write-Host "Shotgun sprint and weapon stance DirectInput proxy tests passed."
Write-Host "  Size $actualBytes bytes"
Write-Host "  SHA256 $actualHash"
