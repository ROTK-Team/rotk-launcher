<#
.SYNOPSIS
Packages game asset files into one zip per file and emits the matching
feed.json for the h1z1rotk/assets repository.

.DESCRIPTION
Each input file becomes its own release payload so launcher updates only
re-download the packs that actually changed (the launcher diffs by sha256).
Archives are written with the .NET ZipArchive API, which stays on the classic
zip format for entries below 4 GiB - the launcher zip reader rejects Zip64.

.EXAMPLE
./scripts/package-asset-packs.ps1 `
  -SourceDirectory ../assets/assets `
  -OutputDirectory ./out/asset-release `
  -PackVersion 1.1.0
Then create the GitHub release (tag printed at the end), upload the .payload
files and commit feed.json and asset-payloads.v1.json to h1z1rotk/assets main.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SourceDirectory,

  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$PackVersion,

  # Directory inside the game installation where the packs are extracted.
  [string]$InstallPath = "Resources/Assets",

  [string]$ReleaseTag = "",

  [string]$RepositorySlug = "h1z1rotk/assets"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if ($ReleaseTag -eq "") { $ReleaseTag = "assets-v$PackVersion" }

# Windows PowerShell's Out-File -Encoding utf8 emits a BOM, and JSON.parse
# rejects a leading BOM: the launcher would refuse the feed outright.
function Write-JsonNoBom {
  param([string]$Path, $Value)
  $json = $Value | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$source = Resolve-Path $SourceDirectory
$files = Get-ChildItem -Path $source -File | Sort-Object Name
if ($files.Count -eq 0) { throw "No files found in $source." }
if ($files.Count -gt 64) { throw "The launcher accepts at most 64 assets per feed." }

$maxEntryBytes = 3GB
foreach ($file in $files) {
  if ($file.Length -gt $maxEntryBytes) {
    throw "$($file.Name) is $([math]::Round($file.Length / 1GB, 2)) GB - above the launcher per-asset cap (3 GB)."
  }
  if ($file.Extension -match '^\.(exe|dll|sys|bat|cmd|ps1|msi|scr|com|vbs|lnk)$') {
    throw "$($file.Name) has a blocked extension - executable content ships in the signed launcher, never in the feed."
  }
}

New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
$output = Resolve-Path $OutputDirectory

$assets = @()
$payloads = @()
$totalUncompressed = 0
foreach ($file in $files) {
  $baseName = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
  # .payload, not .zip: launchers up to 2.0.23 install any .zip of the latest
  # release on their own, before feed.json and the attestation policy agree.
  $zipName = "$baseName.payload"
  $zipPath = Join-Path $output $zipName
  if (Test-Path $zipPath) { Remove-Item -Force $zipPath }

  Write-Host "Compressing $($file.Name) ($([math]::Round($file.Length / 1MB, 1)) MB)..."
  $archive = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive, $file.FullName, $file.Name,
      [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  } finally {
    $archive.Dispose()
  }

  $zipItem = Get-Item $zipPath
  $hash = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToLowerInvariant()
  $totalUncompressed += $file.Length

  # Hash of the file as it lands in the game install (uncompressed), used by
  # the server to fold asset payloads into the attestation expectedRoot. This
  # is the same value the launcher records in asset-state.v1.json, so both
  # sides derive the same root.
  $payloads += [ordered]@{
    path   = "$InstallPath/$($file.Name)"
    size   = $file.Length
    sha256 = (Get-FileHash -Algorithm SHA256 $file.FullName).Hash.ToLowerInvariant()
  }

  $assets += [ordered]@{
    name        = $baseName.ToLowerInvariant()
    version     = $PackVersion
    url         = "https://github.com/$RepositorySlug/releases/download/$ReleaseTag/$zipName"
    sha256      = $hash
    size        = $zipItem.Length
    installPath = $InstallPath
    type        = "zip"
  }
  Write-Host "  -> $zipName : $([math]::Round($zipItem.Length / 1MB, 1)) MB, sha256 $hash"
}

if ($totalUncompressed -gt 8GB) {
  throw "Uncompressed payload total exceeds the launcher 8 GB cap."
}

$feed = [ordered]@{
  manifestVersion = 1
  packVersion     = $PackVersion
  assets          = $assets
}
$feedPath = Join-Path $output "feed.json"
Write-JsonNoBom -Path $feedPath -Value $feed

# Consumed by rotk-web/scripts/publish-attestation-policy.mjs so the server's
# expectedRoot covers the asset files, not just the base game tree.
$payloadManifest = [ordered]@{
  schemaVersion = 1
  kind          = "asset-payloads"
  packVersion   = $PackVersion
  files         = $payloads
}
$payloadPath = Join-Path $output "asset-payloads.v1.json"
Write-JsonNoBom -Path $payloadPath -Value $payloadManifest

Write-Host ""
Write-Host "Wrote $($assets.Count) payload(s), feed.json and asset-payloads.v1.json to $output"
Write-Host "Next steps:"
Write-Host "  1. Create release '$ReleaseTag' on $RepositorySlug and attach the zips."
Write-Host "  2. Commit BOTH feed.json AND asset-payloads.v1.json to $RepositorySlug main,"
Write-Host "     in the same commit. They are generated together and MUST stay in lockstep:"
Write-Host "     the launcher reads the feed, the attestation policy reads the payloads, and"
Write-Host "     a feed committed without its matching payloads ships a policy whose root no"
Write-Host "     honest launcher can match (the 2026-08-12 root_mismatch incident)."
Write-Host "  3. Build the policy with publish-attestation-policy.mjs, passing BOTH"
Write-Host "     --asset-feed feed.json AND --asset-payloads asset-payloads.v1.json. It"
Write-Host "     cross-checks them and verifies the feed against the live one; a mismatch"
Write-Host "     aborts before a bad policy can be written."
