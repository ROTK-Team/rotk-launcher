param(
    [string]$OutputPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$sourcePath = Join-Path $PSScriptRoot "steam_api64.c"
$defaultDistDir = Join-Path $PSScriptRoot "dist"
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $outputPath = Join-Path $defaultDistDir "steam_api64.dll"
} else {
    $outputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
}
$distDir = Split-Path -Parent $outputPath
$cacheDir = Join-Path $PSScriptRoot ".zig-cache"
$tmpDir = Join-Path $PSScriptRoot (".zig-tmp-" + [Guid]::NewGuid().ToString("N"))

function Normalize-PeReproducibilityFields {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 256 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
        throw "Le shim compile n'est pas une image PE valide."
    }

    $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
    if ($peOffset -lt 0 -or ($peOffset + 24) -gt $bytes.Length) {
        throw "En-tete PE du shim invalide."
    }
    if ([BitConverter]::ToUInt32($bytes, $peOffset) -ne 0x00004550) {
        throw "Signature PE du shim invalide."
    }

    $numberOfSections = [BitConverter]::ToUInt16($bytes, $peOffset + 6)
    $optionalHeaderSize = [BitConverter]::ToUInt16($bytes, $peOffset + 20)
    $optionalHeaderOffset = $peOffset + 24
    if (($optionalHeaderOffset + $optionalHeaderSize) -gt $bytes.Length) {
        throw "En-tete optionnel PE du shim tronque."
    }

    $optionalMagic = [BitConverter]::ToUInt16($bytes, $optionalHeaderOffset)
    $dataDirectoryOffset = switch ($optionalMagic) {
        0x020B { $optionalHeaderOffset + 112 }
        0x010B { $optionalHeaderOffset + 96 }
        default { throw "Format PE du shim non pris en charge : 0x$($optionalMagic.ToString('X4'))" }
    }
    $debugDirectoryEntryOffset = $dataDirectoryOffset + (6 * 8)
    if (($debugDirectoryEntryOffset + 8) -gt ($optionalHeaderOffset + $optionalHeaderSize)) {
        throw "Repertoire debug PE du shim invalide."
    }

    # LLD derives the COFF timestamp and CodeView build id from absolute build
    # paths. They do not affect execution, but make otherwise identical DLLs
    # differ across machines. Clear only those reproducibility fields.
    [Array]::Clear($bytes, $peOffset + 8, 4)
    [Array]::Clear($bytes, $debugDirectoryEntryOffset, 8)

    $sectionTableOffset = $optionalHeaderOffset + $optionalHeaderSize
    $buildIdSectionFound = $false
    for ($index = 0; $index -lt $numberOfSections; $index++) {
        $sectionOffset = $sectionTableOffset + ($index * 40)
        if (($sectionOffset + 40) -gt $bytes.Length) {
            throw "Table des sections PE du shim tronquee."
        }
        $name = [Text.Encoding]::ASCII.GetString($bytes, $sectionOffset, 8).TrimEnd([char]0)
        if ($name -ne ".buildid") {
            continue
        }

        $rawSize = [BitConverter]::ToUInt32($bytes, $sectionOffset + 16)
        $rawPointer = [BitConverter]::ToUInt32($bytes, $sectionOffset + 20)
        $rawEnd = [int64]$rawPointer + [int64]$rawSize
        if ($rawEnd -gt $bytes.Length) {
            throw "Section .buildid PE du shim invalide."
        }
        [Array]::Clear($bytes, [int]$rawPointer, [int]$rawSize)
        $buildIdSectionFound = $true
    }

    if (-not $buildIdSectionFound) {
        throw "Section .buildid attendue introuvable dans le shim Zig 0.15.2."
    }

    [System.IO.File]::WriteAllBytes($Path, $bytes)
}

$zigCommandName = if ([string]::IsNullOrWhiteSpace($env:ZIG_EXE)) {
    "zig"
} else {
    $env:ZIG_EXE
}
$zigCommand = Get-Command -Name $zigCommandName -CommandType Application -ErrorAction SilentlyContinue
if ($null -eq $zigCommand) {
    throw "Zig introuvable. Renseigne ZIG_EXE avec le chemin de zig.exe ou ajoute zig au PATH."
}
$zigExe = $zigCommand.Source

if (-not (Test-Path -LiteralPath $sourcePath)) {
    throw "Source introuvable : $sourcePath"
}

if (-not (Test-Path -LiteralPath $distDir)) {
    New-Item -ItemType Directory -Path $distDir | Out-Null
}

foreach ($dir in @($cacheDir, $tmpDir)) {
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
}

$previousCache = $env:ZIG_LOCAL_CACHE_DIR
$previousGlobalCache = $env:ZIG_GLOBAL_CACHE_DIR
$previousTemp = $env:TEMP
$previousTmp = $env:TMP

$env:ZIG_LOCAL_CACHE_DIR = $cacheDir
$env:ZIG_GLOBAL_CACHE_DIR = $cacheDir
$env:TEMP = $tmpDir
$env:TMP = $tmpDir

try {
    & $zigExe cc `
        -target x86_64-windows-gnu `
        -shared `
        -O2 `
        -DWIN32_LEAN_AND_MEAN `
        -o $outputPath `
        $sourcePath

    if ($LASTEXITCODE -ne 0) {
        throw "zig cc a echoue avec le code $LASTEXITCODE"
    }
}
finally {
    $env:ZIG_LOCAL_CACHE_DIR = $previousCache
    $env:ZIG_GLOBAL_CACHE_DIR = $previousGlobalCache
    $env:TEMP = $previousTemp
    $env:TMP = $previousTmp

    if (Test-Path -LiteralPath $tmpDir) {
        $resolvedTemp = [System.IO.Path]::GetFullPath($tmpDir)
        $resolvedRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
        if (-not $resolvedTemp.StartsWith("$resolvedRoot\.zig-tmp-", [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Unsafe shim build cleanup path: $resolvedTemp"
        }
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path -LiteralPath $outputPath)) {
    throw "Build termine sans produire le DLL attendu : $outputPath"
}

Normalize-PeReproducibilityFields -Path $outputPath

Write-Host "Built steam shim:"
Write-Host "  $outputPath"
