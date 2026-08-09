#!/usr/bin/env node
/**
 * Temp benchmark: measure context-file walk from cwd → root.
 * Usage: node scripts/bench-context-walk.mjs [startDir]
 *
 * Reports per-level timing and total, with and without git-root stop.
 * NOT part of src — safe to delete after task.
 */
import { existsSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";

const startDir = process.argv[2] || process.cwd();

async function findGitRepoRoot(startDir) {
	let dir = resolve(startDir);
	while (true) {
		try {
			await access(join(dir, ".git"));
			return dir;
		} catch {
			// not found
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

async function walkOld(cwd) {
	// Old behavior: walk to FS root
	const files = [];
	let currentDir = resolve(cwd);
	const root = resolve("/");
	const levels = [];

	while (true) {
		const t0 = performance.now();
		const candidates = ["AGENTS.md", "CLAUDE.md"];
		for (const filename of candidates) {
			const filePath = join(currentDir, filename);
			if (existsSync(filePath)) {
				files.push(filePath);
			}
		}
		const elapsed = performance.now() - t0;
		levels.push({ dir: currentDir, ms: elapsed, found: files.length });

		if (currentDir === root) break;
		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}
	return { files, levels };
}

async function walkNew(cwd) {
	// New behavior: stop at git-root
	const files = [];
	let currentDir = resolve(cwd);
	const root = resolve("/");
	const gitRoot = await findGitRepoRoot(cwd);
	const levels = [];

	while (true) {
		const t0 = performance.now();
		const candidates = ["AGENTS.md", "CLAUDE.md"];
		for (const filename of candidates) {
			const filePath = join(currentDir, filename);
			if (existsSync(filePath)) {
				files.push(filePath);
			}
		}
		const elapsed = performance.now() - t0;
		levels.push({ dir: currentDir, ms: elapsed, found: files.length });

		if (currentDir === root) break;
		if (gitRoot && currentDir === gitRoot) break;
		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}
	return { files, levels };
}

// Warm up
await walkOld(startDir);

// Run 5 iterations each
const RUNS = 5;
let oldTotal = 0, newTotal = 0;

for (let i = 0; i < RUNS; i++) {
	const t0 = performance.now();
	const old = await walkOld(startDir);
	oldTotal += performance.now() - t0;

	const t1 = performance.now();
	const nw = await walkNew(startDir);
	newTotal += performance.now() - t1;

	if (i === 0) {
		console.log(`\n=== Anatomy (cwd = ${startDir}) ===`);
		console.log(`Old walk: ${old.levels.length} levels, ${old.files.length} context files`);
		for (const l of old.levels) {
			console.log(`  ${l.dir}  ${l.ms.toFixed(2)}ms  (found so far: ${l.found})`);
		}
		console.log(`\nNew walk (git-root stop): ${nw.levels.length} levels, ${nw.files.length} context files`);
		for (const l of nw.levels) {
			console.log(`  ${l.dir}  ${l.ms.toFixed(2)}ms  (found so far: ${l.found})`);
		}

		const gitRoot = await findGitRepoRoot(startDir);
		console.log(`\nGit root: ${gitRoot ?? "(not found)"}`);
		console.log(`Levels eliminated: ${old.levels.length - nw.levels.length}`);

		// Check for context files above git root
		if (gitRoot) {
			const aboveGitRoot = old.levels.filter(l => {
				const rel = l.dir.replace(gitRoot, "");
				return rel.startsWith("/") || rel.startsWith("\\") || (l.dir !== gitRoot && !l.dir.startsWith(gitRoot + "/") && !l.dir.startsWith(gitRoot + "\\"));
			}).filter(l => l.found > 0);
			if (aboveGitRoot.length > 0) {
				console.log(`\n⚠ Context files found ABOVE git-root (would be skipped with new behavior):`);
				for (const l of aboveGitRoot) console.log(`  ${l.dir}`);
			} else {
				console.log(`\n✓ No context files above git-root — behavior identical.`);
			}
		}
	}
}

console.log(`\n=== Timing (${RUNS} runs) ===`);
console.log(`Old (FS root):  ${(oldTotal / RUNS).toFixed(1)}ms avg`);
console.log(`New (git root): ${(newTotal / RUNS).toFixed(1)}ms avg`);
console.log(`Speedup:        ${((oldTotal / RUNS) - (newTotal / RUNS)).toFixed(1)}ms (${(((oldTotal - newTotal) / oldTotal) * 100).toFixed(0)}%)`);
