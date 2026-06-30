#Requires -Version 5.1
<#
.SYNOPSIS
    Build FAN (fan) RELEASE binaries for all platforms.
.DESCRIPTION
    Builds FAN binaries for all supported platforms and creates release archives.
    For FAN v1.0.0+ with INDEPENDENT versioning (each package manages its own version).

    Version scheme:
      - FAN_VERSION   = version from root package.json (monorepo workspace root, e.g. 2.0.0)
                         used for archive names, manifest.json, and in-binary version display
      - CODING_AGENT_VERSION = version from packages/coding-agent/package.json (npm package,
                                e.g. 1.0.3) embedded as @seaagents/fan-coding-agent metadata

    Unlike build-binaries.sh (legacy), this script:
      - Reads FAN version from root package.json (not coding-agent/package.json)
      - Reads npm-package version separately from packages/coding-agent/package.json
      - Does NOT synchronize versions across packages
      - Tags archives as RELEASE builds in all output messages

.PARAMETER SkipDeps
    Skip installing cross-platform native bindings.

.PARAMETER Platform
    Build only for a specific platform.
    Valid values: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64

.EXAMPLE
    .\scripts\release-binaries.ps1

.EXAMPLE
    .\scripts\release-binaries.ps1 -Platform windows-x64

.EXAMPLE
    .\scripts\release-binaries.ps1 -SkipDeps
#>

param(
    [switch]$SkipDeps,
    [ValidateSet("darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64")]
    [string]$Platform = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $PSCommandPath
$RootDir = Split-Path -Parent $ScriptDir
Set-Location $RootDir

# ─── Color helpers ─────────────────────────────────────────────
function Write-Info($msg)  { Write-Host "==> " -ForegroundColor Blue -NoNewline; Write-Host $msg -ForegroundColor White }
function Write-Warn($msg)  { Write-Host "Warning: " -ForegroundColor Yellow -NoNewline; Write-Host $msg }
function Write-Err($msg)   { Write-Host "Error: " -ForegroundColor Red -NoNewline; Write-Host $msg }
function Write-Ok($msg)    { Write-Host "Success: " -ForegroundColor Green -NoNewline; Write-Host $msg }

# ─── Ensure bun is installed ──────────────────────────────────
$bunPath = Get-Command "bun" -ErrorAction SilentlyContinue
if (-not $bunPath) {
    $bunHome = "$env:USERPROFILE\.bun\bin\bun"
    $bunLocal = "$env:LOCALAPPDATA\bun\bin\bun"
    if (Test-Path $bunHome) {
        $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
    } elseif (Test-Path $bunLocal) {
        $env:Path = "$env:LOCALAPPDATA\bun\bin;$env:Path"
    } else {
        Write-Info "bun not found, installing..."
        # bun install on Windows via powershell
        powershell -c "irm https://bun.sh/install.ps1 | iex"
        $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
    }
}

$bunVersion = & bun --version
Write-Info "Using bun $bunVersion"

# ─── Read versions ─────────────────────────────────────────
# FAN_VERSION — from root package.json (monorepo release version, e.g. 2.0.0)
$rootPkg = Join-Path $RootDir "package.json"
if (-not (Test-Path $rootPkg)) {
    Write-Err "package.json not found at $rootPkg"
    exit 1
}
$rootPkgJson = Get-Content $rootPkg -Raw | ConvertFrom-Json
$FAN_VERSION = $rootPkgJson.version
if (-not $FAN_VERSION) {
    Write-Err "Could not read version from $rootPkg"
    exit 1
}

# CODING_AGENT_VERSION — from packages/coding-agent/package.json (npm package version, e.g. 1.0.3)
$codingAgentPkg = Join-Path $RootDir "packages\coding-agent\package.json"
if (-not (Test-Path $codingAgentPkg)) {
    Write-Err "package.json not found at $codingAgentPkg"
    exit 1
}
$caPkgJson = Get-Content $codingAgentPkg -Raw | ConvertFrom-Json
$CODING_AGENT_VERSION = $caPkgJson.version
if (-not $CODING_AGENT_VERSION) {
    Write-Err "Could not read version from $codingAgentPkg"
    exit 1
}

Write-Info "Building release binaries for FAN v1.0.0+ with independent versioning..."
Write-Info "FAN (fan) version: $FAN_VERSION"
Write-Info "@seaagents/fan-coding-agent version: $CODING_AGENT_VERSION"

# ─── Determine platforms ──────────────────────────────────────
if ($Platform) {
    $PlatformList = @($Platform)
} else {
    $PlatformList = @("darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64")
}

# ─── Install dependencies ─────────────────────────────────────
Write-Info "Installing dependencies..."
bun install --ignore-scripts
if ($LASTEXITCODE -ne 0) { Write-Warn "bun install exited with code $LASTEXITCODE, continuing..." }

Write-Info "Fixing bun isolated linker symlinks..."
& "$ScriptDir\fix-bun-symlinks.sh"
if ($LASTEXITCODE -ne 0) { Write-Warn "fix-bun-symlinks.sh exited with code $LASTEXITCODE, continuing..." }

# Generate Prisma client (skipped by --ignore-scripts)
Write-Info "Generating Prisma client..."
Push-Location (Join-Path $RootDir "packages\db")
npx prisma generate
if ($LASTEXITCODE -ne 0) { Write-Warn "prisma generate exited with code $LASTEXITCODE, continuing..." }
Pop-Location

if (-not $SkipDeps) {
    Write-Info "Installing cross-platform native bindings..."
    # Use --force to bypass platform checks (os/cpu restrictions in package.json)
    bun add --no-save --ignore-scripts --force `
        @mariozechner/clipboard-darwin-arm64@0.3.0 `
        @mariozechner/clipboard-darwin-x64@0.3.0 `
        @mariozechner/clipboard-linux-x64-gnu@0.3.0 `
        @mariozechner/clipboard-linux-arm64-gnu@0.3.0 `
        @mariozechner/clipboard-win32-x64-msvc@0.3.0 `
        @img/sharp-darwin-arm64@0.34.5 `
        @img/sharp-darwin-x64@0.34.5 `
        @img/sharp-linux-x64@0.34.5 `
        @img/sharp-linux-arm64@0.34.5 `
        @img/sharp-win32-x64@0.34.5 `
        @img/sharp-libvips-darwin-arm64@1.2.4 `
        @img/sharp-libvips-darwin-x64@1.2.4 `
        @img/sharp-libvips-linux-x64@1.2.4 `
        @img/sharp-libvips-linux-arm64@1.2.4
    if ($LASTEXITCODE -ne 0) { Write-Warn "bun add (native bindings) exited with code $LASTEXITCODE, continuing..." }
} else {
    Write-Info "Skipping cross-platform native bindings (--skip-deps)"
}

# ─── Build all packages ───────────────────────────────────────
Write-Info "Building all packages (independent versions preserved)..."
npm run build
if ($LASTEXITCODE -ne 0) { Write-Err "npm run build failed"; exit 1 }

Write-Info "Building dashboard..."
npm run build:dashboard
if ($LASTEXITCODE -ne 0) { Write-Err "npm run build:dashboard failed"; exit 1 }

# ─── Inline version into api-gateway dist ─────────────────────
Write-Info "Inlining version v$FAN_VERSION into api-gateway dist..."
$httpServerPath = Join-Path $RootDir "packages\api-gateway\dist\http-server.js"
if (Test-Path $httpServerPath) {
    $content = Get-Content $httpServerPath -Raw
    # Replace: JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')).version
    $content = $content -replace "JSON\.parse\(readFileSync\(join\(__dirname,\s*'\.\.',\s*'package\.json'\),\s*'utf-8'\)\)\.version", "'$FAN_VERSION'"
    Set-Content -Path $httpServerPath -Value $content -NoNewline
    Write-Info "Version inlined successfully."
} else {
    Write-Warn "http-server.js not found at $httpServerPath, skipping version inlining."
}

# ─── Build FAN binaries ───────────────────────────────────────
Write-Info "Building FAN (fan) binaries..."
Push-Location (Join-Path $RootDir "packages\coding-agent")

# Clean previous builds
if (Test-Path "binaries") {
    Remove-Item -Recurse -Force "binaries"
}
New-Item -ItemType Directory -Path "binaries" -Force | Out-Null

foreach ($platform in $PlatformList) {
    New-Item -ItemType Directory -Path "binaries\$platform" -Force | Out-Null
}

foreach ($platform in $PlatformList) {
    Write-Info "Building for $platform..."
    if ($platform -eq "windows-x64") {
        bun build --compile --external koffi --no-compile-autoload-dotenv --no-compile-autoload-package-json --target="bun-$platform" ./dist/bun/cli.js --outfile "binaries/$platform/fan.exe"
    } else {
        bun build --compile --external koffi --no-compile-autoload-dotenv --no-compile-autoload-package-json --target="bun-$platform" ./dist/bun/cli.js --outfile "binaries/$platform/fan"
    }
    if ($LASTEXITCODE -ne 0) { Write-Err "Failed to build for $platform"; exit 1 }
}

Write-Info "Bundling FAN-specific assets..."

# ─── Copy shared files to each platform directory ─────────────
foreach ($platform in $PlatformList) {
    $destDir = "binaries\$platform"

    Copy-Item "package.json" "$destDir\" -Force
    Copy-Item "README.md" "$destDir\" -Force
    Copy-Item "CHANGELOG.md" "$destDir\" -Force

    # Copy wasm file
    $wasmSrc = "..\..\node_modules\@silvia-odwyer\photon-node\photon_rs_bg.wasm"
    if (Test-Path $wasmSrc) {
        Copy-Item $wasmSrc "$destDir\" -Force
    } else {
        Write-Warn "photon_rs_bg.wasm not found at $wasmSrc"
    }

    # Copy theme files
    $themeSrc = "dist\modes\interactive\theme\*.json"
    if (Test-Path (Join-Path $RootDir "packages\coding-agent\$themeSrc")) {
        New-Item -ItemType Directory -Path "$destDir\theme" -Force | Out-Null
        Copy-Item $themeSrc "$destDir\theme\" -Force
    } else {
        Write-Warn "Theme files not found at $themeSrc"
    }

    # Copy assets
    $assetsSrc = "dist\modes\interactive\assets\*"
    if (Test-Path (Join-Path $RootDir "packages\coding-agent\$assetsSrc")) {
        New-Item -ItemType Directory -Path "$destDir\assets" -Force | Out-Null
        Copy-Item $assetsSrc "$destDir\assets\" -Recurse -Force
    } else {
        Write-Warn "Assets not found at $assetsSrc"
    }

    # Copy export-html
    $exportHtmlSrc = "dist\core\export-html"
    if (Test-Path (Join-Path $RootDir "packages\coding-agent\$exportHtmlSrc")) {
        Copy-Item "$exportHtmlSrc" "$destDir\" -Recurse -Force
    } else {
        Write-Warn "export-html not found at $exportHtmlSrc"
    }

    # Copy dashboard
    Write-Info "  Copying dashboard..."
    $dashboardDist = "..\..\packages\dashboard\dist"
    if (Test-Path (Join-Path $RootDir "packages\coding-agent\$dashboardDist")) {
        New-Item -ItemType Directory -Path "$destDir\dashboard" -Force | Out-Null
        Copy-Item "$dashboardDist\*" "$destDir\dashboard\" -Recurse -Force
    } else {
        Write-Warn "Dashboard dist not found at $dashboardDist"
    }

    # ─── Copy koffi and Prisma engine ─────────────────────────
    if ($platform -eq "windows-x64") {
        # Copy koffi native module for Windows (needed for VT input support)
        New-Item -ItemType Directory -Path "$destDir\node_modules\koffi\build\koffi\win32_x64" -Force | Out-Null
        $koffiRoot = "..\..\node_modules\koffi"
        if (Test-Path "$koffiRoot\index.js")    { Copy-Item "$koffiRoot\index.js" "$destDir\node_modules\koffi\" -Force }
        if (Test-Path "$koffiRoot\package.json") { Copy-Item "$koffiRoot\package.json" "$destDir\node_modules\koffi\" -Force }
        if (Test-Path "$koffiRoot\build\koffi\win32_x64\koffi.node") { Copy-Item "$koffiRoot\build\koffi\win32_x64\koffi.node" "$destDir\node_modules\koffi\build\koffi\win32_x64\" -Force }
        $prisma_engine = "query_engine-windows.dll.node"
    } elseif ($platform -eq "darwin-arm64") {
        $prisma_engine = "libquery_engine-darwin-arm64.dylib.node"
    } elseif ($platform -eq "darwin-x64") {
        $prisma_engine = "libquery_engine-darwin.dylib.node"
    } elseif ($platform -eq "linux-arm64") {
        $prisma_engine = "libquery_engine-linux-arm64-openssl-3.0.x.so.node"
    } elseif ($platform -eq "linux-x64") {
        $prisma_engine = "libquery_engine-debian-openssl-3.0.x.so.node"
    }

    # Copy Prisma query engine for this platform
    $prismaCopied = $false

    # Check bun cache first
    $bunCacheDir = "..\..\node_modules\.bun"
    if (Test-Path $bunCacheDir) {
        $prismaClientDirs = Get-ChildItem -Path $bunCacheDir -Recurse -Directory -ErrorAction SilentlyContinue | Where-Object { $_.FullName -like "*\.prisma\client" }
        foreach ($dir in $prismaClientDirs) {
            $enginePath = Join-Path $dir.FullName $prisma_engine
            if (Test-Path $enginePath) {
                New-Item -ItemType Directory -Path "$destDir\node_modules\.prisma\client" -Force | Out-Null
                Copy-Item $enginePath "$destDir\node_modules\.prisma\client\" -Force
                $prismaCopied = $true
                break
            }
        }
    }

    # Fallback to node_modules/.prisma/client
    if (-not $prismaCopied) {
        $prismaFallback = "..\..\node_modules\.prisma\client\$prisma_engine"
        if (Test-Path $prismaFallback) {
            New-Item -ItemType Directory -Path "$destDir\node_modules\.prisma\client" -Force | Out-Null
            Copy-Item $prismaFallback "$destDir\node_modules\.prisma\client\" -Force
            $prismaCopied = $true
        }
    }

    if (-not $prismaCopied) {
        Write-Warn "Prisma engine '$prisma_engine' not found (checked bun cache and node_modules/.prisma/client/)"
    }
}

# ─── Create release archives ──────────────────────────────────
Write-Info "Creating release archives..."
Push-Location "binaries"

foreach ($platform in $PlatformList) {
    if ($platform -eq "windows-x64") {
        # Windows (zip) - use wrapper directory for consistency with Unix
        Write-Info "Creating fan-$FAN_VERSION-$platform.zip..."
        Rename-Item -Path $platform -NewName "fan"
        Compress-Archive -Path "fan" -DestinationPath "fan-$FAN_VERSION-$platform.zip" -CompressionLevel Optimal
        Rename-Item -Path "fan" -NewName $platform
    } else {
        # Unix platforms (tar.gz) - use wrapper directory for mise compatibility
        Write-Info "Creating fan-$FAN_VERSION-$platform.tar.gz..."
        Rename-Item -Path $platform -NewName "fan"
        tar -czf "fan-$FAN_VERSION-$platform.tar.gz" "fan"
        Rename-Item -Path "fan" -NewName $platform
    }
}

# ─── Extract archives for easy local testing ──────────────────
Write-Info "Extracting archives for testing..."
foreach ($platform in $PlatformList) {
    if (Test-Path $platform) {
        Remove-Item -Recurse -Force $platform
    }

    if ($platform -eq "windows-x64") {
        Expand-Archive -Path "fan-$FAN_VERSION-$platform.zip" -DestinationPath "." -Force
        Rename-Item -Path "fan" -NewName $platform
    } else {
        tar -xzf "fan-$FAN_VERSION-$platform.tar.gz"
        Rename-Item -Path "fan" -NewName $platform
    }
}

Pop-Location  # back to coding-agent (from binaries)

Write-Host ""
Write-Info "FAN RELEASE build complete!"
Write-Host "Archives available in packages/coding-agent/binaries/"
Get-ChildItem -Path "binaries" -Include "*.tar.gz", "*.zip" | ForEach-Object { Write-Host "  $($_.Name)" }
Write-Host ""
Write-Host "Extracted directories for testing:"
foreach ($platform in $PlatformList) {
    Write-Host "  binaries/$platform/fan"
}

# ─── Generate manifest.json ───────────────────────────────────
Write-Info "Generating manifest.json..."
$releasedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

Push-Location "binaries"

$manifestPlatforms = @{}
foreach ($platform in $PlatformList) {
    if ($platform -eq "windows-x64") {
        $archiveName = "fan-$FAN_VERSION-$platform.zip"
    } else {
        $archiveName = "fan-$FAN_VERSION-$platform.tar.gz"
    }

    if (Test-Path $archiveName) {
        $hash = (Get-FileHash -Path $archiveName -Algorithm SHA256).Hash.ToLowerInvariant()
        $size = (Get-Item $archiveName).Length
        $manifestPlatforms[$platform] = @{
            url  = "https://fan.sea-agents.ru/fan-store/dist/$archiveName"
            hash = "sha256:$hash"
            size = $size
        }
    }
}

$manifest = @{
    latest       = $FAN_VERSION
    releasedAt   = $releasedAt
    releaseNotes = ""
    platforms    = $manifestPlatforms
} | ConvertTo-Json -Depth 4

$manifest | Out-File -FilePath "manifest.json" -Encoding utf8 -Force

Write-Info "Manifest: $($manifestPlatforms.Count) platforms, version $FAN_VERSION"
foreach ($name in $manifestPlatforms.Keys | Sort-Object) {
    Write-Host "  $name`: $($manifestPlatforms[$name].size) bytes"
}

Pop-Location  # back to coding-agent (from binaries)

# ─── Copy artifacts to dist repo ──────────────────────────────
$DIST_REPO = "$env:USERPROFILE\fan-store\dist"
if (-not (Test-Path $DIST_REPO)) {
    New-Item -ItemType Directory -Path $DIST_REPO -Force | Out-Null
}

Write-Info "Copying artifacts to $DIST_REPO\..."
Copy-Item -Path "binaries\manifest.json" -Destination "$DIST_REPO\" -Force

foreach ($platform in $PlatformList) {
    if ($platform -eq "windows-x64") {
        $archiveName = "fan-$FAN_VERSION-$platform.zip"
    } else {
        $archiveName = "fan-$FAN_VERSION-$platform.tar.gz"
    }
    $archivePath = "binaries\$archiveName"
    if (Test-Path $archivePath) {
        Copy-Item -Path $archivePath -Destination "$DIST_REPO\" -Force
        Write-Host "  Copied $archiveName"
    }
}

# Copy installer scripts
$installSh = Join-Path $ScriptDir "install.sh"
if (Test-Path $installSh) {
    Copy-Item -Path $installSh -Destination "$DIST_REPO\" -Force
    Write-Host "  Copied install.sh"
}
$installPs1 = Join-Path $ScriptDir "install.ps1"
if (Test-Path $installPs1) {
    Copy-Item -Path $installPs1 -Destination "$DIST_REPO\" -Force
    Write-Host "  Copied install.ps1"
}

Write-Info "Dist repo ready. Run: fan-store publish"
Pop-Location  # back to repo root (from coding-agent)
