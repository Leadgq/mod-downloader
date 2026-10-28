param(
  [string]$Version = '9.0.2',
  [string]$Sha256 = '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$binaryDir = Join-Path $repoRoot 'resources/bin/win32'
$archivePath = Join-Path $binaryDir "ffmpeg-$Version-essentials_build.zip"
$sourceUrl = "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-$Version-essentials_build.zip"
New-Item -ItemType Directory -Force -Path $binaryDir | Out-Null
if (!(Test-Path -LiteralPath $archivePath)) {
  Invoke-WebRequest -Uri $sourceUrl -OutFile $archivePath -UseBasicParsing
}
$actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $Sha256.ToLowerInvariant()) { throw 'FFmpeg SHA-256 verification failed' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  foreach ($name in @('ffmpeg.exe', 'ffprobe.exe', 'LICENSE')) {
    $entry = $archive.Entries | Where-Object { $_.Name -eq $name } | Select-Object -First 1
    if (!$entry) { throw "Missing archive entry: $name" }
    $outputName = if ($name -eq 'LICENSE') { 'LICENSE.ffmpeg.txt' } else { $name }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $binaryDir $outputName), $true)
  }
} finally { $archive.Dispose() }
@{
  version = $Version
  archiveSha256 = $actualHash
  download = $sourceUrl
  source = "https://ffmpeg.org/releases/ffmpeg-$Version.tar.xz"
  buildProvider = 'https://www.gyan.dev/ffmpeg/builds/'
  license = 'GPL-3.0-or-later (see LICENSE.ffmpeg.txt and ffmpeg -L)'
  binaries = @{
    'ffmpeg.exe' = (Get-FileHash -LiteralPath (Join-Path $binaryDir 'ffmpeg.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
    'ffprobe.exe' = (Get-FileHash -LiteralPath (Join-Path $binaryDir 'ffprobe.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
  }
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $binaryDir 'ffmpeg-build.json') -Encoding UTF8
& (Join-Path $binaryDir 'ffmpeg.exe') -version | Select-Object -First 1
& (Join-Path $binaryDir 'ffprobe.exe') -version | Select-Object -First 1
