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
    .\fan-store.ps1 list
    .\fan-store.ps1 publish
#>

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
}

function Require-Repo {
    $script:REPO_DIR = Get-RepoDir
    if (-not (Test-Path (Join-Path $REPO_DIR "index.json"))) {
        Write-Err "index.json not found in $REPO_DIR"
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

    $newIndex | ConvertTo-Json -Depth 10 | Set-Content -Path $existingIndexPath -Encoding UTF8
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

    $initData | ConvertTo-Json -Depth 10 | Set-Content -Path $indexPath -Encoding UTF8

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

function Cmd-Publish {
    param([string]$Target = "")

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
    # Use scp -r to copy contents. rsync is not available on Windows by default.
    Write-Info "Syncing to $Target ..."

    # Parse target
    if ($Target -match '^([^:]+):(.+)$') {
        $remoteHost = $matches[1]
        $remotePath = $matches[2]

        # scp -r on Windows misbehaves when source contains "C:\" — the colon
        # in the path is interpreted as remote-host syntax.
        # Workaround: stage to a clean temp dir first, then scp that dir's contents.
        $tempDir = Join-Path $env:TEMP "fan-store-publish-$([System.DateTime]::Now.Ticks)"
        try {
            New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

            # Use robocopy to mirror REPO_DIR → tempDir (handles subdirs cleanly,
            # unlike Copy-Item with wildcard + Recurse which fails on leaf nodes).
            # robocopy exit codes: 0=ok, 1=files copied, 2=extra files, 3+=warning/error.
            # We treat codes < 8 as success (per robocopy convention).
            & robocopy $REPO_DIR $tempDir /MIR /XD .git /XF *.bak.* /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
            $robocopyCode = $LASTEXITCODE
            if ($robocopyCode -ge 8) {
                Write-Err "robocopy staging failed with code $robocopyCode"
            }

            # scp with "/." suffix copies CONTENTS of the source dir, not the
            # dir itself (otherwise a subdirectory would be created on the remote).
            # Trailing slash on remote path ensures files land directly in remotePath.
            $remotePathWithSlash = if ($remotePath.EndsWith('/')) { $remotePath } else { $remotePath + '/' }
            & scp -r "${tempDir}/." "$remoteHost`:$remotePathWithSlash"
            $scpCode = $LASTEXITCODE
            if ($scpCode -ne 0) {
                Write-Err "scp failed with code $scpCode"
            }
        } finally {
            if (Test-Path $tempDir) {
                Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        Write-Ok "Published to $Target"
    } else {
        # Local path: mirror via robocopy /MIR
        if (-not (Test-Path $Target)) {
            New-Item -ItemType Directory -Path $Target -Force | Out-Null
        }
        & robocopy $REPO_DIR $Target /MIR /XD .git /XF *.bak.* /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
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
    Write-Host "  publish [target]       Deploy repo to server (scp/ssh)"
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
    Write-Host "  fan-store.ps1 list"
    Write-Host "  fan-store.ps1 publish                              # default target"
    Write-Host "  fan-store.ps1 publish user@other:/var/www/repo     # custom target"
    Write-Host "  fan-store.ps1 serve 9000"
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