import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let build;
try {
	build = (await import("esbuild")).build;
} catch {
	// esbuild not installed — skip browser smoke check
	console.log("esbuild not available, skipping browser smoke check");
	process.exit(0);
}

const outputPath = join(tmpdir(), "fan-browser-smoke.js");
const errorLogPath = join(tmpdir(), "fan-browser-smoke-errors.log");

try {
	await build({
		entryPoints: ["scripts/browser-smoke-entry.ts"],
		bundle: true,
		platform: "browser",
		format: "esm",
		logLevel: "silent",
		outfile: outputPath,
	});
	process.exit(0);
} catch (error) {
	let detailedErrors = "";
	if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
		detailedErrors = error.errors
			.map((entry) => {
				const location = entry.location
					? `${entry.location.file}:${entry.location.line}:${entry.location.column}`
					: "";
				return [location, entry.text].filter(Boolean).join(" ");
			})
			.join("\n");
	}

	const baseError = error instanceof Error ? (error.stack ?? error.message) : String(error);
	writeFileSync(errorLogPath, [detailedErrors, baseError].filter(Boolean).join("\n\n"), "utf-8");
	console.error(`Browser smoke check failed. See ${errorLogPath}`);
	process.exit(1);
}
