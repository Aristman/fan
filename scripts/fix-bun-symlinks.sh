#!/usr/bin/env bash
#
# Fix bun isolated linker issues for tsgo and bun build --compile.
#
# Bun's isolated linker stores all packages in node_modules/.bun/ but
# doesn't create symlinks in the root node_modules for transitive deps.
# tsgo (TypeScript Go compiler) uses standard Node resolution and can't
# resolve packages that only exist in bun's cache.
#
# This script finds packages in bun's cache and creates symlinks in
# node_modules so tsgo and bun build --compile can find them.

set -euo pipefail

cd "$(dirname "$0")/.."

BUN_CACHE="node_modules/.bun"

if [[ ! -d "$BUN_CACHE" ]]; then
    echo "==> No bun cache at $BUN_CACHE, skipping"
    exit 0
fi

echo "==> Fixing bun isolated linker symlinks..."

node -e "
const fs = require('fs');
const path = require('path');

const bunCache = path.join(process.cwd(), '$BUN_CACHE');
const nodeModules = path.join(process.cwd(), 'node_modules');
let fixed = 0;

try {
    const entries = fs.readdirSync(bunCache);
    for (const entry of entries) {
        const cacheDir = path.join(bunCache, entry, 'node_modules');
        if (!fs.existsSync(cacheDir)) continue;

        // Convert bun cache dir name to npm package name
        // e.g. '@smithy+node-http-handler@4.5.3' -> '@smithy/node-http-handler'
        // e.g. 'ajv@8.18.0' -> 'ajv'
        let pkgName;
        const atIndex = entry.indexOf('@');
        const plusIndex = entry.indexOf('+');
        const versionIndex = entry.lastIndexOf('@');

        if (atIndex === 0 && plusIndex > 0) {
            // Scoped package: @scope+name@version
            const scope = entry.substring(0, plusIndex);
            const name = entry.substring(plusIndex + 1, versionIndex);
            pkgName = scope + '/' + name;
        } else if (versionIndex > 0) {
            // Unscoped: name@version
            pkgName = entry.substring(0, versionIndex);
        } else {
            continue;
        }

        // Check if already exists in node_modules
        const targetPath = path.join(nodeModules, pkgName);
        if (fs.existsSync(targetPath)) continue;

        // Find the actual package in bun cache
        const cachePkgPath = path.join(cacheDir, pkgName);
        if (!fs.existsSync(cachePkgPath)) continue;

        // Create parent scope dir if needed
        const parentDir = path.dirname(targetPath);
        fs.mkdirSync(parentDir, { recursive: true });

        // Create symlink
        fs.symlinkSync(path.resolve(cachePkgPath), targetPath);
        fixed++;
    }

    // Also fix broken symlinks in workspace node_modules
    const wsDirs = fs.readdirSync('packages');
    for (const ws of wsDirs) {
        const wsNM = path.join('packages', ws, 'node_modules');
        if (!fs.existsSync(wsNM)) continue;
        
        const scopeDirs = fs.readdirSync(wsNM);
        for (const sd of scopeDirs) {
            const entryPath = path.join(wsNM, sd);
            if (!fs.lstatSync(entryPath).isSymbolicLink()) continue;
            if (fs.existsSync(entryPath)) continue; // not broken
            
            // Try to resolve from bun cache
            try {
                const realTarget = fs.readlinkSync(entryPath);
                // Extract package name from broken symlink target
                // e.g. '../../../node_modules/.bun/ajv@8.18.0/node_modules/ajv'
                const match = realTarget.match(/node_modules\/(.+)$/);
                if (!match) continue;
                const pkg = match[1];
                
                // Find in bun cache
                for (const ce of fs.readdirSync(bunCache)) {
                    const tryPath = path.join(bunCache, ce, 'node_modules', pkg);
                    if (fs.existsSync(tryPath)) {
                        fs.symlinkSync(path.resolve(tryPath), entryPath);
                        fixed++;
                        break;
                    }
                }
            } catch { /* skip */ }
        }
    }
    // Create symlinks for workspace packages in root node_modules
    // bun isolated linker only links them in packages/*/node_modules
    const pkgJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    const workspaces = pkgJson.workspaces || [];
    for (const ws of workspaces) {
        if (ws.startsWith('!')) continue;
        // Resolve glob patterns manually
        const wsDir = ws.replace(/\/\*$/, '');
        const absWsDir = path.resolve(wsDir);
        if (!fs.existsSync(absWsDir)) continue;
        const entries = fs.statSync(absWsDir).isDirectory() ? fs.readdirSync(absWsDir) : [path.basename(absWsDir)];
        for (const entry of entries) {
            const dir = path.join(absWsDir, entry);
            if (!fs.statSync(dir).isDirectory()) continue;
            const wsPkgPath = path.join(dir, 'package.json');
            if (!fs.existsSync(wsPkgPath)) continue;
            try {
                const wsPkg = JSON.parse(fs.readFileSync(wsPkgPath, 'utf-8'));
                const name = wsPkg.name;
                if (!name) continue;
                const target = path.join(nodeModules, name);
                if (fs.existsSync(target)) continue;
                const parentDir = path.dirname(target);
                fs.mkdirSync(parentDir, { recursive: true });
                fs.symlinkSync(dir, target);
                fixed++;
            } catch { /* skip */ }
        }
    }
} catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
}

console.log('==> Fixed ' + fixed + ' symlink(s)');
"