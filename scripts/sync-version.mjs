#!/usr/bin/env node

/**
 * sync-version.mjs — Single-source-of-truth version sync for FAN monorepo.
 *
 * Reads version from root package.json and writes it to ALL workspace
 * packages dir package.json files, plus example/extension package.json files.
 *
 * Usage:
 *   node scripts/sync-version.mjs
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const ROOT_PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = ROOT_PKG.version;

if (!VERSION) {
  console.error('❌ No "version" field in root package.json');
  process.exit(1);
}

// Collect all package.json paths to update
const targets = [];

// 1. packages/*/package.json
const packagesDir = join(ROOT, 'packages');
for (const dir of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const pkgPath = join(packagesDir, dir.name, 'package.json');
  try {
    readFileSync(pkgPath, 'utf8'); // verify exists
    targets.push(pkgPath);
  } catch {}
}

// 2. Example / extension package.json files (already workspaces but explicit for clarity)
const extras = [
  'packages/web-ui/example/package.json',
  'packages/coding-agent/examples/extensions/with-deps/package.json',
  'packages/coding-agent/examples/extensions/custom-provider-anthropic/package.json',
  'packages/coding-agent/examples/extensions/custom-provider-qwen-cli/package.json',
  'packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/package.json',
];
for (const rel of extras) {
  const pkgPath = join(ROOT, rel);
  try {
    readFileSync(pkgPath, 'utf8');
    if (!targets.includes(pkgPath)) targets.push(pkgPath);
  } catch {}
}

// Sync versions
let updated = 0;
for (const pkgPath of targets) {
  const raw = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);

  if (pkg.versionSync === false) {
    const rel = pkgPath.replace(ROOT + '/', '');
    console.log(`  ${rel}: skipped (versionSync: false)`);
    continue;
  }

  if (pkg.version === VERSION) continue;

  const rel = pkgPath.replace(ROOT + '/', '');
  console.log(`  ${rel}: ${pkg.version} → ${VERSION}`);
  pkg.version = VERSION;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
  updated++;
}

if (updated === 0) {
  console.log(`✅ All ${targets.length} packages already at v${VERSION}`);
} else {
  console.log(`\n✅ Updated ${updated} package(s) to v${VERSION}`);
}
