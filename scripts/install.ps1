#Requires -Version 5.1
<#
.SYNOPSIS
    FAN (fan) installer for Windows.
.DESCRIPTION
    Downloads and installs the latest FAN on Windows.
    Usage:
        irm http://185.219.41.46/fan/dist/install.ps1 | iex
.PARAMETER FAN_INSTALL_DIR
    Custom installation directory (default: $env:LOCALAPPDATA\fan)
.EXAMPLE
    $env:FAN_INSTALL_DIR = "D:\Tools\fan"; irm http://185.219.41.46/fan/dist/install.ps1 | iex
#>

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ─── Color helpers ─────────────────────────────────────────────
function Write-Info($msg)  { Write-Host "==> " -ForegroundColor Blue -NoNewline; Write-Host $msg -ForegroundColor White }
function Write-Warn($msg)  { Write-Host "Warning: " -ForegroundColor Yellow -NoNewline; Write-Host $msg }
function Write-Err($msg)   { Write-Host "Error: " -ForegroundColor Red -NoNewline; Write-Host $msg }
function Write-Ok($msg)    { Write-Host "Success: " -ForegroundColor Green -NoNewline; Write-Host $msg }

# ─── Detect architecture ───────────────────────────────────────
$platform = "windows-x64"
Write-Info "Detected platform: $platform"

# ─── Install directory ─────────────────────────────────────────
# All fan files (binary + assets) live here
$installDir = if ($env:FAN_INSTALL_DIR) { $env:FAN_INSTALL_DIR } else { "$env:LOCALAPPDATA\fan" }
$installBin = Join-Path $installDir "fan.exe"

# ─── Check existing installation ───────────────────────────────
if (Test-Path $installBin) {
    try {
        $existingVersion = & $installBin --version 2>$null
        if (-not $existingVersion) { $existingVersion = "unknown" }
    } catch {
        $existingVersion = "unknown"
    }

    if ($env:CI -eq "true") {
        Write-Info "Reinstalling fan (current: $existingVersion)..."
    } else {
        $answer = Read-Host "fan is already installed at $installDir (version $existingVersion). Reinstall? [y/N]"
        if ($answer -notmatch '^[Yy](es)?$') {
            Write-Host "Aborted."
            exit 0
        }
    }
}

# ─── Create temp directory ─────────────────────────────────────
$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "fan-install-$(Get-Random)"
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

try {
    # ─── Fetch manifest ────────────────────────────────────────
    $manifestUrl = "http://185.219.41.46/fan/dist/manifest.json"
    Write-Info "Fetching manifest..."

    $manifestFile = Join-Path $tmpDir "manifest.json"
    try {
        Invoke-WebRequest -Uri $manifestUrl -OutFile $manifestFile -UseBasicParsing -TimeoutSec 30
    } catch {
        Write-Err "Failed to download manifest from $manifestUrl"
        exit 1
    }

    $manifest = Get-Content $manifestFile -Raw | ConvertFrom-Json
    $latestVersion = $manifest.latest
    if (-not $latestVersion) {
        Write-Err "Failed to parse manifest: could not find latest version"
        exit 1
    }
    Write-Info "Latest version: $latestVersion"

    # ─── Get platform info ─────────────────────────────────────
    $platformInfo = $manifest.platforms."$platform"
    if (-not $platformInfo) {
        Write-Err "Platform '$platform' not found in manifest"
        exit 1
    }

    $expectedHash = $platformInfo.hash -replace '^sha256:', ''
    $archiveUrl = $platformInfo.url
    $archiveName = Split-Path $archiveUrl -Leaf
    $archiveFile = Join-Path $tmpDir $archiveName

    # ─── Download archive ──────────────────────────────────────
    Write-Info "Downloading $archiveName..."
    try {
        $webClient = New-Object System.Net.WebClient
        $webClient.DownloadFile($archiveUrl, $archiveFile)
    } catch {
        Write-Err "Failed to download $archiveUrl"
        exit 1
    }

    # ─── Verify SHA-256 hash ───────────────────────────────────
    if ($expectedHash) {
        Write-Info "Verifying SHA-256 checksum..."
        $actualHash = (Get-FileHash -Path $archiveFile -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash.ToLowerInvariant()) {
            Write-Err "SHA-256 checksum mismatch!"
            Write-Err "  Expected: $expectedHash"
            Write-Err "  Actual:   $actualHash"
            exit 1
        }
        Write-Info "Checksum verified."
    }

    # ─── Extract archive ───────────────────────────────────────
    $extractDir = Join-Path $tmpDir "extract"
    Write-Info "Extracting archive..."

    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($archiveFile, $extractDir)
    } catch {
        Write-Err "Failed to extract archive: $_"
        exit 1
    }

    # Locate the extracted 'fan' directory (wrapper dir in zip)
    $sourceDir = Join-Path $extractDir "fan"
    if (-not (Test-Path $sourceDir)) {
        Write-Err "Archive does not contain expected 'fan' directory"
        exit 1
    }

    $sourceBin = Join-Path $sourceDir "fan.exe"
    if (-not (Test-Path $sourceBin)) {
        Write-Err "Binary not found in archive at $sourceBin"
        exit 1
    }

    # ─── Install: copy entire directory ────────────────────────
    Write-Info "Installing to $installDir\..."

    # Remove old installation contents
    if (Test-Path $installDir) {
        Get-ChildItem -Path $installDir -Exclude "config.json", "models.json" | Remove-Item -Recurse -Force
    } else {
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    }

    # Copy all files from extracted directory
    Copy-Item -Path "$sourceDir\*" -Destination $installDir -Recurse -Force

    # ─── Verify installation ───────────────────────────────────
    try {
        $installedVersion = & $installBin --version 2>$null
        if ($LASTEXITCODE -eq 0 -and $installedVersion) {
            Write-Ok "fan $installedVersion installed successfully!"
            Write-Info "  Data:    $installDir\"
        } else {
            Write-Err "Installation verification failed."
            exit 1
        }
    } catch {
        Write-Err "Installation verification failed: $_"
        exit 1
    }

    # ─── Add to PATH ───────────────────────────────────────────
    $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($currentPath -notlike "*$installDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$currentPath;$installDir", "User")
        $env:Path += ";$installDir"
        Write-Info "Added $installDir to user PATH."
        Write-Warn "Restart your terminal for PATH changes to take effect."
    }

    # ─── Print next steps ──────────────────────────────────────
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor White
    Write-Host "  1. Restart your terminal" -ForegroundColor DarkGray
    Write-Host "  2. " -ForegroundColor DarkGray -NoNewline; Write-Host "Initialize FAN: fan init" -ForegroundColor Green
    Write-Host "  3. " -ForegroundColor DarkGray -NoNewline; Write-Host "Check for updates: fan update" -ForegroundColor Green
    Write-Host ""

} finally {
    Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
