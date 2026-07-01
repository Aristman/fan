#Requires -Version 5.1
<#
.SYNOPSIS
    fan-store — CLI tool for managing a local FAN package repository (PowerShell port).

.DESCRIPTION
    PowerShell-аналог bash-скрипта fan-store для Windows.
    Использует встроенные средства Windows 10+:
      - tar.exe для .tar.gz
      - ConvertFrom-Json / ConvertTo-Json для JSON
      - Get-FileHash для SHA-256
      - OpenSSH (scp/ssh) для деплоя
      - python3 -m http.server для локального теста

.PARAMETER Command
    Подкоманда (init, add, remove, list, info, publish, serve, set-url, help)

.EXAMPLE
    .\fan-store.ps1 init
    .\fan-store.ps1 add .\fan-orchestrator-1.0.0.tar.gz
    .\fan-store.ps1 list                          # latest-only by default
    .\fan-store.ps1 list --all                     # full rebuild (all versions)
    .\fan-store.ps1 publish
#>

# Default: latest-only mode (only the latest version of each package).
# Use --all or FAN_STORE_FULL_REBUILD=1 for full rebuild (all versions).

param(
    [Parameter(Position=0)]
    [string]$Command = "",

    [Parameter(Position=1, ValueFromRemainingArguments=$true)]
    [string[]]$Rest = @()
)

$ErrorActionPreference = "Stop"

# ─── Config ──────────────────────────────────────────────────────
# SSH config-based alias (recommended). Configure in ~/.ssh/config:
#   Host fan-store-server
#       HostName 185.219.41.46
#       User root
#       IdentityFile ~/.ssh/fan-store-deploy
$DEFAULT_REMOTE_TARGET = "fan-store-server:/opt/repos/fan-store"
# Legacy fallback (if SSH config is not set up):
$REMOTE_HOST = "root@185.219.41.46"
$REMOTE_PATH = "/opt/repos/fan-store"
$REPO_URL    = "https://fan.sea-agents.ru/fan-store"
$REPO_DIR    = ""

# ─── Latest-only flag ──────────────────────────────────────────────
# Default: latest-only ON (only the latest version of each package)
# Use --all or FAN_STORE_FULL_REBUILD=1 for full rebuild (all versions)
$LatestOnly = $true

# If user explicitly wants full rebuild via env vars
if ($env:FAN_STORE_LATEST_ONLY -eq "0" -or $env:FAN_STORE_LATEST_ONLY -eq "false") {
    $LatestOnly = $false
}
if ($env:FAN_STORE_FULL_REBUILD -eq "1" -or $env:FAN_STORE_FULL_REBUILD -eq "true") {
    $LatestOnly = $false
}

# ─── Force upload flag ─────────────────────────────────────────────
# Default: skip existing files on the server (--ignore-existing)
# Use --force or FAN_STORE_FORCE_UPLOAD=1 to re-upload everything
$ForceUpload = $false

if ($env:FAN_STORE_FORCE_UPLOAD -eq "1" -or $env:FAN_STORE_FORCE_UPLOAD -eq "true") {
    $ForceUpload = $true
}

# Parse --latest-only, --all, and --force from remaining args
$RestFiltered = @()
foreach ($arg in $Rest) {
    if ($arg -eq "--latest-only") {
        $LatestOnly = $true
    } elseif ($arg -eq "--all") {
        $LatestOnly = $false
    } elseif ($arg -eq "--force") {
        $ForceUpload = $true
    } else {
        $RestFiltered += $arg
    }
}
$Rest = $RestFiltered

# ─── Colors ──────────────────────────────────────────────────────
function Write-Info($msg)  { Write-Host "==> " -ForegroundColor Blue -NoNewline; Write-Host $msg -ForegroundColor White }
function Write-Ok($msg)    { Write-Host "OK " -ForegroundColor Green -NoNewline; Write-Host $msg }
function Write-Warn($msg)  { Write-Host "Warning: " -ForegroundColor Yellow -NoNewline; Write-Host $msg }
function Write-Err($msg)   { Write-Host "Error: " -ForegroundColor Red -NoNewline; Write-Host $msg -ForegroundColor Red }
function Write-Dim($msg)   { Write-Host $msg -ForegroundColor DarkGray }

# ─── Helpers ─────────────────────────────────────────────────────
function Get-RepoDir {
    if ($env:FAN_REPO_DIR -and (Test-Path (Join-Path $env:FAN_REPO_DIR "index.json"))) {
        return $env:FAN_REPO_DIR
    }
    $dir = (Get-Location).Path
    while ($dir -ne [System.IO.Path]::GetPathRoot($dir)) {
        if (Test-Path (Join-Path $dir "index.json")) {
            return $dir
        }
        $dir = Split-Path -Parent $dir
    }
    Write-Err "Not a fan-store directory (no index.json found). Run 'fan-store.ps1 init' first."
    return $null
}

# Validate index.json integrity
function Test-IndexValid {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $false }

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 2) { return $false }

    # Skip BOM if present
    $start = 0
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        $start = 3
    }

    # First non-BOM character must be '{'
    if ($bytes[$start] -ne 0x7B) {  # 0x7B = '{'
        return $false
    }

    # Try to parse as JSON
    try {
        $content = [System.IO.File]::ReadAllText($Path)
        $null = $content | ConvertFrom-Json -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

# Attempt to repair a corrupted index.json by running Rebuild-Index
function Repair-Index {
    param([string]$RepoDir)
    Write-Host "WARNING: index.json is corrupted, running Rebuild-Index..." -ForegroundColor Yellow
    Rebuild-Index
}

function Assert-RepoClean {
    $script:REPO_DIR = Get-RepoDir
    if (-not $script:REPO_DIR) {
        throw "fan-store: not initialized"
    }

    $banned = @()

    # 1. Проверить корень репы — не должно быть install-скриптов, manifest.json, .env
    $bannedInRoot = @('install.ps1', 'install.sh', 'manifest.json', '.env', '.env.example')
    foreach ($name in $bannedInRoot) {
        if (Test-Path (Join-Path $script:REPO_DIR $name)) {
            $banned += $name
        }
    }

    # 2. Проверить packages/ — не должно быть бинарников FAN (fan-X.Y.Z-*)
    if (Test-Path (Join-Path $script:REPO_DIR "packages")) {
        $fanBinaries = Get-ChildItem (Join-Path $script:REPO_DIR "packages") -Filter "fan-*.tar.gz" -ErrorAction SilentlyContinue
        foreach ($f in $fanBinaries) {
            # Бинарник FAN имеет вид: fan-X.Y.Z-platform.tar.gz (без дополнительных сегментов имени)
            # А пакет стора имеет: <name>-X.Y.Z.tar.gz, где name НЕ равен "fan"
            $baseName = $f.BaseName -replace '\.tar$', ''
            if ($baseName -match '^fan-\d+\.\d+\.\d+-.+') {
                $banned += $f.Name
            }
        }
        # Также fan-X.Y.Z-windows-x64.zip
        $fanZips = Get-ChildItem (Join-Path $script:REPO_DIR "packages") -Filter "fan-*.zip" -ErrorAction SilentlyContinue
        foreach ($f in $fanZips) {
            $banned += $f.Name
        }
    }

    # 3. Проверить корень — не должно быть исходников (.ts, .js, .tsx)
    $sourceFiles = Get-ChildItem $script:REPO_DIR -File -Include "*.ts", "*.js", "*.tsx", "*.cjs", "*.mjs" -ErrorAction SilentlyContinue
    foreach ($f in $sourceFiles) {
        $banned += $f.Name
    }

    if ($banned.Count -gt 0) {
        Write-Host ""
        Write-Host "❌ REFUSED: Repository contains files that don't belong to fan-store:" -ForegroundColor Red
        foreach ($name in $banned) {
            Write-Host "   - $name" -ForegroundColor Yellow
        }
        Write-Host ""
        Write-Host "This usually means the FAN binary release was copied into the store repo," -ForegroundColor Red
        Write-Host "or dev files (.env, .ts, .js) leaked here. Please move them elsewhere and try again." -ForegroundColor Red
        Write-Host ""
        throw "Refusing to publish: repository is dirty. See above."
    }
}

function Require-Repo {
    $script:REPO_DIR = Get-RepoDir
    if (-not $script:REPO_DIR) {
        throw "fan-store: not initialized in current or parent directories. Run 'fan-store.ps1 init' in your fan-store repo first."
    }
    if (-not (Test-Path (Join-Path $script:REPO_DIR "index.json"))) {
        throw "index.json not found in $script:REPO_DIR"
    }
}

function Get-Timestamp {
    return (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
}

# Compute SHA-256 hash of a file
function Get-Sha256($path) {
    return "sha256:" + (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower()
}

# Extract field from package.json inside a tar.gz archive
function Get-TarField {
    param(
        [string]$Archive,
        [string]$Field
    )

    # tar.exe in Windows 10+ misinterprets paths like "C:\..." as remote.
    # Workaround: run tar from the archive's directory using only the filename.
    $archiveFull = (Resolve-Path $Archive).Path
    $archiveDir = Split-Path -Parent $archiveFull
    $archiveFile = Split-Path -Leaf $archiveFull

    $origLocation = Get-Location
    try {
        Set-Location $archiveDir
        $entries = & tar -tzf $archiveFile 2>$null
        if ($LASTEXITCODE -ne 0) { return "" }

        # Look for <dirname>/package.json (root level)
        $pkgPath = $entries | Where-Object { $_ -match '^[^/]+/package\.json$' } | Select-Object -First 1

        # Fallback to any package.json
        if (-not $pkgPath) {
            $pkgPath = $entries | Where-Object { $_ -match 'package\.json' } | Select-Object -First 1
        }

        if (-not $pkgPath) { return "" }

        # Extract package.json to stdout
        $content = & tar -xzOf $archiveFile $pkgPath 2>$null
        if (-not $content) { return "" }

        try {
            $data = $content | ConvertFrom-Json -ErrorAction Stop
            $fan = $data.fan
            if ($fan -and $fan.$Field) { return $fan.$Field }
            if ($data.$Field) { return $data.$Field }
        } catch { }
        return ""
    } finally {
        Set-Location $origLocation
    }
}

# Detect package type from archive contents
function Get-PackageType {
    param([string]$Archive)

    $archiveFull = (Resolve-Path $Archive).Path
    $archiveDir = Split-Path -Parent $archiveFull
    $archiveFile = Split-Path -Leaf $archiveFull

    $origLocation = Get-Location
    try {
        Set-Location $archiveDir
        $entries = & tar -tzf $archiveFile 2>$null | Select-Object -First 20
        if (-not $entries) { return "unknown" }

        $entriesStr = $entries -join "`n"

        # 1. SKILL.md or theme.json at root
        if ($entriesStr -match '^[^/]+/SKILL\.md$') { return "skill" }
        if ($entriesStr -match '^[^/]+/theme\.json$') { return "theme" }

        # 2. Bundle: extensions/skills/themes dirs at top
        if ($entriesStr -match '^[^/]+/(extensions|skills|themes)/') { return "bundle" }

        # 3. SKILL.md / theme.json anywhere
        if ($entriesStr -match 'SKILL\.md') { return "skill" }
        if ($entriesStr -match 'theme\.json') { return "theme" }

        # 4. Extension markers
        if ($entriesStr -match '(index\.ts|index\.js|package\.json)') { return "extension" }

        return "unknown"
    } finally {
        Set-Location $origLocation
    }
}

# Rebuild index.json from packages/ directory
function Rebuild-Index {
    Require-Repo
    $packagesDir = Join-Path $REPO_DIR "packages"
    $ts = Get-Timestamp

    if (-not (Test-Path $packagesDir)) {
        New-Item -ItemType Directory -Path $packagesDir -Force | Out-Null
    }

    $packages = @()

    # Get all archive files (Get-ChildItem -Include requires wildcard in -Path on Windows)
    $archives = @(Get-ChildItem -Path (Join-Path $packagesDir "*") -Include "*.tar.gz", "*.tgz" -File -ErrorAction SilentlyContinue | Sort-Object Name)

    foreach ($archive in $archives) {
        $filename = $archive.Name
        $archivePath = $archive.FullName

        # Extract metadata
        $name = Get-TarField -Archive $archivePath -Field "name"
        $version = Get-TarField -Archive $archivePath -Field "version"
        $description = Get-TarField -Archive $archivePath -Field "description"
        $author = Get-TarField -Archive $archivePath -Field "author"

        # Fallback: name from filename
        if (-not $name) {
            $baseName = $filename -replace '\.tar\.gz$', '' -replace '\.tgz$', ''
            if ($baseName -match '^(.+)-(\d.+)$') {
                $name = $matches[1]
                $version = $matches[2]
            } else {
                $name = $baseName
            }
        }

        # Detect type
        $type = Get-PackageType -Archive $archivePath

        # Compute hash
        $hash = Get-Sha256 $archivePath

        # Build download URL
        $downloadUrl = "$REPO_URL/packages/$filename"

        $packages += [PSCustomObject]@{
            name        = $name
            version     = $version
            type        = $type
            description = $description
            author      = $author
            downloadUrl = $downloadUrl
            hash        = $hash
        }
    }

    # Apply latest-only filter if enabled
    if ($LatestOnly) {
        $before = $packages.Count
        $packages = $packages | Group-Object name | ForEach-Object {
            $_.Group | Sort-Object { [Version]$_.version } -Descending | Select-Object -First 1
        }
        Write-Host "Latest-only mode: $before → $($packages.Count) packages"
    }

    # Read existing index.json to preserve repository block
    $repoBlock = @{
        name      = (Split-Path -Leaf $REPO_DIR)
        url       = $REPO_URL
        updatedAt = $ts
    }

    $existingIndexPath = Join-Path $REPO_DIR "index.json"
    if (Test-Path $existingIndexPath) {
        try {
            $existing = Get-Content $existingIndexPath -Raw | ConvertFrom-Json -ErrorAction Stop
            if ($existing.repository) {
                $repoBlock = @{
                    name      = if ($existing.repository.name) { $existing.repository.name } else { $repoBlock.name }
                    url       = if ($existing.repository.url) { $existing.repository.url } else { $REPO_URL }
                    updatedAt = $ts
                }
            }
        } catch { }
    }

    $newIndex = @{
        repository = $repoBlock
        packages   = $packages
    }

    $json = $newIndex | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($existingIndexPath, $json, [System.Text.UTF8Encoding]::new($false))
}

# ─── Commands ────────────────────────────────────────────────────

function Cmd-Init {
    param([string]$Path = ".")

    $Path = (Resolve-Path $Path).Path
    $indexPath = Join-Path $Path "index.json"

    if (Test-Path $indexPath) {
        Write-Err "Repo already exists at $Path"
    }

    New-Item -ItemType Directory -Path (Join-Path $Path "packages") -Force | Out-Null

    $repoName = Split-Path -Leaf $Path
    $ts = Get-Timestamp

    $initData = @{
        repository = @{
            name      = $repoName
            url       = $REPO_URL
            updatedAt = $ts
        }
        packages   = @()
    }

    $json = $initData | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($indexPath, $json, [System.Text.UTF8Encoding]::new($false))

    Write-Ok "Repository initialized at $Path"
    Write-Host ""
    Write-Dim "  $Path/"
    Write-Dim "  |-- index.json"
    Write-Dim "  \-- packages/"
    Write-Host ""
    Write-Dim "Next: fan-store.ps1 add ./my-extension-1.0.0.tar.gz"
    Write-Dim "      fan-store.ps1 publish"
}

function Cmd-Set-Url {
    param([string]$Url = "")

    if (-not $Url) {
        Write-Host "Current URL: $REPO_URL"
        return
    }
    $script:REPO_URL = $Url.TrimEnd('/') + '/'
    Write-Ok "Repository URL set to $REPO_URL"
}

function Cmd-Add {
    param([string]$Archive = "")

    Assert-RepoClean

    if (-not $Archive) {
        Write-Err "Usage: fan-store.ps1 add <archive.tar.gz>"
    }

    $Archive = (Resolve-Path $Archive).Path
    if (-not (Test-Path $Archive)) {
        Write-Err "File not found: $Archive"
    }

    if ($Archive -notmatch '\.(tar\.gz|tgz)$') {
        Write-Warn "Expected .tar.gz or .tgz archive"
    }

    Require-Repo

    $name = Get-TarField -Archive $Archive -Field "name"
    $version = Get-TarField -Archive $Archive -Field "version"
    $description = Get-TarField -Archive $Archive -Field "description"
    $type = Get-PackageType -Archive $Archive

    if (-not $name) {
        $baseName = (Split-Path -Leaf $Archive) -replace '\.tar\.gz$', '' -replace '\.tgz$', ''
        if ($baseName -match '^(.+)-(\d.+)$') {
            $name = $matches[1]
            $version = $matches[2]
        } else {
            $name = $baseName
        }
    }

    Write-Host ""
    Write-Host ("  {0,-12}{1}" -f "Name:", $name) -ForegroundColor Cyan
    Write-Host ("  {0,-12}{1}" -f "Version:", $version) -ForegroundColor Cyan
    Write-Host ("  {0,-12}{1}" -f "Type:", $type) -ForegroundColor Cyan
    Write-Host ("  {0,-12}{1}" -f "Description:", $description) -ForegroundColor Cyan
    Write-Host ""

    $destFile = Join-Path (Join-Path $REPO_DIR "packages") (Split-Path -Leaf $Archive)
    Copy-Item $Archive $destFile -Force
    Write-Ok "Copied to packages/$([System.IO.Path]::GetFileName($Archive))"

    Rebuild-Index
    Write-Ok "Package '$name' added to repository"
}

function Cmd-Remove {
    param([string]$Name = "")

    if (-not $Name) {
        Write-Err "Usage: fan-store.ps1 remove <name>"
    }

    Require-Repo

    $packagesDir = Join-Path $REPO_DIR "packages"
    $found = $false

    $archives = @(Get-ChildItem -Path (Join-Path $packagesDir "*") -Include "*.tar.gz", "*.tgz" -File -ErrorAction SilentlyContinue)
    foreach ($archive in $archives) {
        $pkgName = Get-TarField -Archive $archive.FullName -Field "name"
        if (-not $pkgName) {
            $baseName = $archive.BaseName -replace '\.tar\.gz$', '' -replace '\.tgz$', ''
            if ($baseName -match '^(.+)-(\d.+)$') {
                $pkgName = $matches[1]
            } else {
                $pkgName = $baseName
            }
        }

        if ($pkgName -eq $Name) {
            Remove-Item $archive.FullName -Force
            Write-Ok "Removed $($archive.Name)"
            $found = $true
        }
    }

    if (-not $found) {
        Write-Err "Package '$Name' not found"
    }

    Rebuild-Index
    Write-Ok "Package '$Name' removed from repository"
}

function Cmd-List {
    Require-Repo

    # When --latest-only is active, rebuild index with filtering
    if ($LatestOnly) {
        Rebuild-Index
    }

    $indexPath = Join-Path $REPO_DIR "index.json"

    Write-Host ""
    Write-Host ("  {0,-15}{1}" -f "Repository:", (Split-Path -Leaf $REPO_DIR)) -ForegroundColor Cyan
    Write-Host ("  {0,-15}{1}" -f "URL:", $REPO_URL) -ForegroundColor Cyan
    Write-Host ("  {0,-15}{1}" -f "Directory:", $REPO_DIR) -ForegroundColor Cyan
    Write-Host ""

    if (-not (Test-Path $indexPath)) {
        Write-Dim "  (no index.json)"
        return
    }

    try {
        $data = Get-Content $indexPath -Raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Write-Warn "Failed to parse index.json"
        return
    }

    $packages = $data.packages
    if (-not $packages -or $packages.Count -eq 0) {
        Write-Dim "  (empty)"
        return
    }

    for ($i = 0; $i -lt $packages.Count; $i++) {
        $pkg = $packages[$i]
        $hashShort = if ($pkg.hash) { $pkg.hash.Substring(0, [Math]::Min(16, $pkg.hash.Length)) } else { "?" }

        Write-Host "  $($i + 1). $($pkg.name)@$($pkg.version)"
        Write-Host ("     {0,-12}{1}" -f "type:", $pkg.type)
        if ($pkg.description) {
            Write-Host ("     {0,-12}{1}" -f "desc:", $pkg.description)
        }
        if ($pkg.author) {
            Write-Host ("     {0,-12}{1}" -f "author:", $pkg.author)
        }
        Write-Host ("     {0,-12}{1}..." -f "hash:", $hashShort)
        Write-Host ""
    }
}

function Cmd-Info {
    param([string]$Name = "")

    if (-not $Name) {
        Write-Err "Usage: fan-store.ps1 info <name>"
    }

    Require-Repo

    $indexPath = Join-Path $REPO_DIR "index.json"
    if (-not (Test-Path $indexPath)) {
        Write-Err "index.json not found"
    }

    $data = Get-Content $indexPath -Raw | ConvertFrom-Json
    $pkg = $data.packages | Where-Object { $_.name -eq $Name } | Select-Object -First 1

    if (-not $pkg) {
        Write-Err "Package not found: $Name"
    }

    $pkg | ConvertTo-Json -Depth 10
}

function Get-RepoFiles {
    param([string]$Path)
    # Get list of all files recursively, relative paths
    $files = Get-ChildItem -Path $Path -Recurse -File | Where-Object { 
        $_.FullName -notmatch '\.git' -and
        $_.Name -notlike '*.bak.*'
    } | ForEach-Object {
        $_.FullName.Substring($Path.Length + 1).Replace('\', '/')
    }
    return $files
}

function Get-ServerFiles {
    param([string]$Remote)
    # Get list of files on server
    $sshOutput = ssh $Remote "cd /opt/repos/fan-store && find . -type f -not -path './.*' | sort" 2>$null
    if (-not $sshOutput) { return @() }
    return $sshOutput
}

function Sync-RepoToRemote {
    param(
        [string]$RepoDir,
        [string]$Remote,
        [bool]$Force
    )
    
    $localFiles = Get-RepoFiles $RepoDir
    Write-Host "Local files: $($localFiles.Count)"
    
    $serverFiles = @()
    if (-not $Force) {
        $serverFiles = Get-ServerFiles $Remote
        Write-Host "Server files: $($serverFiles.Count)"
    }
    
    $toSync = @()
    foreach ($f in $localFiles) {
        $rel = "./" + $f
        if ($Force -or ($serverFiles -notcontains $rel)) {
            $toSync += $f
        }
    }
    
    if ($toSync.Count -eq 0) {
        Write-Host "Nothing to sync — all files already on server"
        return
    }
    
    Write-Host "Syncing $($toSync.Count) new/changed files..."
    
    $copied = 0
    foreach ($f in $toSync) {
        $localPath = Join-Path $RepoDir $f
        $remotePath = "$Remote`:/opt/repos/fan-store/$f"
        & scp $localPath $remotePath 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $copied++
        }
    }
    Write-Host "Copied $copied / $($toSync.Count) files"
    
    # ── index.json integrity validation ──────────────────────────────────────
    Write-Host "Validating index.json integrity..."
    $idx = Join-Path $RepoDir "index.json"
    if (-not (Test-IndexValid $idx)) {
        Write-Host "❌ index.json is corrupted locally!" -ForegroundColor Red
        
        # Попробовать починить через Rebuild-Index
        Repair-Index $RepoDir
        
        # Скопировать обратно
        if (Test-IndexValid $idx) {
            Write-Host "✅ Repaired. Re-syncing to server..." -ForegroundColor Green
            & scp $idx "${remote}:/opt/repos/fan-store/index.json"
        } else {
            Write-Host "❌ Failed to repair. Refusing to publish." -ForegroundColor Red
            throw "index.json is broken"
        }
    }
    
    # Проверить серверную версию
    Write-Host "Verifying server index.json..."
    $serverIdx = ssh $remote "cat /opt/repos/fan-store/index.json" 2>$null
    if ($serverIdx -notmatch '^\s*\{') {
        Write-Host "❌ Server index.json missing '{'! Re-syncing..." -ForegroundColor Red
        & scp $idx "${remote}:/opt/repos/fan-store/index.json"
    }
}

function Cmd-Publish {
    param([string]$Target = "")

    Assert-RepoClean
    Require-Repo

    Rebuild-Index

    if (-not $Target) {
        $Target = $DEFAULT_REMOTE_TARGET
    }

    # S3 protocol
    if ($Target -match '^s3://') {
        if (-not (Get-Command "aws" -ErrorAction SilentlyContinue)) {
            Write-Err "AWS CLI not installed. Install with: pip install awscli"
        }
        Write-Info "Syncing to S3: $Target"
        & aws s3 sync "$REPO_DIR/" "$Target/" --delete
        Write-Ok "Published to S3"
        return
    }

    # HTTP protocol — not supported
    if ($Target -match '^https?://') {
        Write-Err "HTTP publish not yet supported. Use SCP target: user@host:/path"
    }

    # SCP / SSH target: user@host:/path
    Write-Info "Syncing to $Target ..."

    if ($Target -match '^([^:]+):(.+)$') {
        $remoteHost = $matches[1]

        if ($ForceUpload) {
            Write-Dim "  scp: force upload (re-uploading all files)"
        } else {
            Write-Dim "  scp: smart sync — checking server for existing files..."
        }

        Sync-RepoToRemote -RepoDir $REPO_DIR -Remote $remoteHost -Force $ForceUpload
        Write-Ok "Published to $Target"
    } else {
        # Local path: mirror via robocopy /MIR
        if (-not (Test-Path $Target)) {
            New-Item -ItemType Directory -Path $Target -Force | Out-Null
        }

        if ($ForceUpload) {
            & robocopy $REPO_DIR $Target /MIR /XD .git /XF *.bak.* /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
        } else {
            & robocopy $REPO_DIR $Target /MIR /XD .git /XF *.bak.* /NFL /NDL /NJH /NJS /NC /NS /NP /XO | Out-Null
            Write-Dim "  robocopy: skipping older/existing files (/XO flag)"
        }
        $robocopyExitCode = $LASTEXITCODE
        if ($robocopyExitCode -lt 8) {
            Write-Ok "Published to $Target (robocopy exit: $robocopyExitCode)"
        } else {
            Write-Err "Robocopy failed with code $robocopyExitCode"
        }
    }
}

function Cmd-Serve {
    param([string]$Port = "8888")

    Require-Repo

    Write-Info "Serving repository at http://localhost:$Port/"
    Write-Dim "  Press Ctrl+C to stop"
    Write-Host ""

    Set-Location $REPO_DIR

    # On Windows, 'python3' alias in PATH may route to Microsoft Store.
    # Prefer 'python' (real Python) and verify it can actually run.
    $python = $null
    foreach ($candidate in @("python", "python3", "py")) {
        $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($cmd) {
            # Test that this python actually runs (not the Store stub)
            $testOutput = & $cmd.Source -c "import sys; print(sys.version_info[0])" 2>$null
            if ($testOutput -match "^[23]$") {
                $python = $cmd.Source
                break
            }
        }
    }

    if (-not $python) {
        Write-Err "Python not found. Install Python 3 to use 'fan-store serve'"
    }

    Write-Dim "  Using Python: $python"
    & $python -m http.server $Port
}

function Cmd-Help {
    Write-Host ""
    Write-Host "fan-store - FAN package repository CLI (PowerShell)" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Usage:"
    Write-Host "  fan-store.ps1 <command> [args...]"
    Write-Host ""
    Write-Host "Commands:"
    Write-Host "  init [path]            Create a new repository directory"
    Write-Host "  set-url <url>          Override repository base URL"
    Write-Host "  add <archive.tar.gz>   Add package to repo (updates index.json)"
    Write-Host "  remove <name>          Remove package from repo"
    Write-Host "  list                   List all packages"
    Write-Host "  info <name>            Show package details"
    Write-Host "  publish [target]       Deploy repo to server (scp with smart sync)"
    Write-Host "  serve [port]           Local HTTP server for testing (default 8888)"
    Write-Host "  help                   Show this help"
    Write-Host ""
    Write-Host "Aliases:"
    Write-Host "  rm   -> remove"
    Write-Host "  ls   -> list"
    Write-Host "  show -> info"
    Write-Host "  push -> publish"
    Write-Host "  deploy -> publish"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  fan-store.ps1 init"
    Write-Host "  fan-store.ps1 add .\fan-orchestrator-1.0.0.tar.gz"
    Write-Host "  fan-store.ps1 list                               # latest-only by default"
    Write-Host "  fan-store.ps1 list --all                          # full rebuild (all versions)"
    Write-Host "  fan-store.ps1 publish                              # default target (skip existing)"
    Write-Host "  fan-store.ps1 publish --force                      # force re-upload all files"
    Write-Host "  fan-store.ps1 publish user@other:/var/www/repo     # custom target"
    Write-Host "  fan-store.ps1 serve 9000"
    Write-Host ""
    Write-Host "Notes:"
    Write-Host "  By default: latest-only mode (only the latest version of each package)."
    Write-Host "  Use --all or FAN_STORE_FULL_REBUILD=1 for full rebuild (all versions)."
    Write-Host "  By default: publish skips existing files on the server (--ignore-existing)."
    Write-Host "  Use --force or FAN_STORE_FORCE_UPLOAD=1 to force re-upload all files."
    Write-Host ""
}

# ─── Main ────────────────────────────────────────────────────────

$aliases = @{
    "rm"     = "remove"
    "ls"     = "list"
    "show"   = "info"
    "push"   = "publish"
    "deploy" = "publish"
}

if ($aliases.ContainsKey($Command)) {
    $Command = $aliases[$Command]
}

switch ($Command) {
    "init"     { if ($Rest.Count -gt 0) { Cmd-Init $Rest[0] } else { Cmd-Init } }
    "set-url"  { if ($Rest.Count -gt 0) { Cmd-Set-Url $Rest[0] } else { Cmd-Set-Url } }
    "add"      { if ($Rest.Count -gt 0) { Cmd-Add $Rest[0] } else { Cmd-Add } }
    "remove"   { if ($Rest.Count -gt 0) { Cmd-Remove $Rest[0] } else { Cmd-Remove } }
    "list"     { Cmd-List }
    "info"     { if ($Rest.Count -gt 0) { Cmd-Info $Rest[0] } else { Cmd-Info } }
    "publish"  { if ($Rest.Count -gt 0) { Cmd-Publish $Rest[0] } else { Cmd-Publish } }
    "serve"    { if ($Rest.Count -gt 0) { Cmd-Serve $Rest[0] } else { Cmd-Serve } }
    "help"     { Cmd-Help }
    ""         { Cmd-Help }
    default    {
        Write-Err "Unknown command: $Command"
        Write-Host "Run 'fan-store.ps1 help' for available commands."
    }
}