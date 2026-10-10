param(
    [string]$OutputPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$source = Join-Path $PSScriptRoot "dinput8_proxy.c"
$definition = Join-Path $PSScriptRoot "dinput8_proxy.def"
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $output = Join-Path $PSScriptRoot "dist\dinput8.dll"
} else {
    $output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
}

foreach ($required in @($source, $definition)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Missing shotgun sprint proxy input: $required"
    }
}

$zig = Get-Command -Name "zig" -CommandType Application -ErrorAction Stop
$version = ([string](& $zig.Source version)).Trim()
if ($LASTEXITCODE -ne 0 -or $version -ne "0.15.2") {
    throw "Expected Zig 0.15.2, found '$version'."
}

function Build-DinputProxy([string]$Destination) {
    $directory = Split-Path -Parent $Destination
    $importLibrary = Join-Path $directory "dinput8_proxy.lib"
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    & $zig.Source @(
        "cc",
        "-target", "x86_64-windows-gnu",
        "-shared",
        "-O2",
        "-s",
        "-fno-ident",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-Wl,--dynamicbase",
        "-Wl,--nxcompat",
        "-Wl,--high-entropy-va",
        "-Wl,--out-implib,$importLibrary",
        "-o", $Destination,
        $source,
        $definition
    )
    if ($LASTEXITCODE -ne 0) {
        throw "Shotgun sprint proxy build failed with exit code $LASTEXITCODE."
    }
    Remove-Item -LiteralPath $importLibrary -Force -ErrorAction SilentlyContinue
}

function Get-Sha256([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha256.ComputeHash($stream)
        return ([System.BitConverter]::ToString($digest)).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

$outputDirectory = Split-Path -Parent $output
$verificationRoot = Join-Path $outputDirectory ".dinput8-repro-$PID"
$verificationOutput = Join-Path $verificationRoot "dinput8.dll"
try {
    Build-DinputProxy $output
    Build-DinputProxy $verificationOutput
    $firstHash = Get-Sha256 $output
    $secondHash = Get-Sha256 $verificationOutput
    if ($firstHash -cne $secondHash) {
        throw "Non-reproducible shotgun sprint proxy build: $firstHash != $secondHash"
    }
    # LF and no BOM, like the committed sidecar; Set-Content would write CRLF.
    [System.IO.File]::WriteAllText("$output.sha256", "$firstHash *dinput8.dll`n", [System.Text.Encoding]::ASCII)
} finally {
    if (Test-Path -LiteralPath $verificationRoot) {
        $resolved = [System.IO.Path]::GetFullPath($verificationRoot)
        $resolvedOutput = [System.IO.Path]::GetFullPath($outputDirectory).TrimEnd('\')
        if (-not $resolved.StartsWith(
            "$resolvedOutput\",
            [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Unsafe build cleanup path: $resolved"
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}

Write-Host "Built deterministic ROTK shotgun sprint proxy:"
Write-Host "  $output"
Write-Host "  SHA256 $firstHash"
