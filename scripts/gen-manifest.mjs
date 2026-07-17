/**
 * Generate manifest.json for FAN release artifacts.
 *
 * Cross-platform replacement for the previous Python heredoc.
 * Reads FAN_VERSION from environment, scans for fan-<version>-*.{tar.gz,zip}
 * in the current directory, computes SHA256 + size for each, and writes
 * manifest.json with the FAN Store schema.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

const version = process.env.FAN_VERSION;
if (!version) {
	console.error("FAN_VERSION env var is required");
	process.exit(1);
}

const releasedAt = new Date().toISOString();

const prefix = `fan-${version}-`;
const files = readdirSync(".")
	.filter((f) => {
		if (!f.startsWith(prefix)) return false;
		return f.endsWith(".tar.gz") || f.endsWith(".zip");
	})
	.sort();

const platforms = {};
for (const f of files) {
	let name;
	let ext;
	if (f.endsWith(".tar.gz")) {
		ext = ".tar.gz";
	} else {
		ext = ".zip";
	}
	name = f.slice(prefix.length, -ext.length);

	const data = readFileSync(f);
	const hash = createHash("sha256").update(data).digest("hex");
	const size = data.length;
	platforms[name] = {
		url: `https://fan.sea-agents.ru/fan-store/dist/${f}`,
		hash: `sha256:${hash}`,
		size,
	};
}

const manifest = {
	latest: version,
	releasedAt,
	releaseNotes: "",
	platforms,
};

writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Manifest: ${Object.keys(platforms).length} platforms, version ${version}`);
for (const [name, p] of Object.entries(platforms).sort()) {
	console.log(`  ${name}: ${p.size} bytes`);
}

