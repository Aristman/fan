// Tests for CLI mission-command missionStart:
// completed + unchecked ROADMAP items → reactivate (active)
// completed without unchecked items → hint message (no InvalidTransitionError)

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Point the dynamic loader to the real extension source (monorepo dev).
// Without this, loadFileStateManager() may not find file-state-manager from
// the coding-agent test context (import.meta.url resolution in vitest).
process.env.FAN_MISSION_DIR = resolve(import.meta.dirname ?? __dirname, "../../../extensions/fan-mission");

// Use dynamic import of the file-state-manager from extensions/ to create
// real mission fixtures (same module that missionStart loads at runtime).
import {
	initMission,
	readMission,
	writeMissionStatus,
	writeRoadmap,
} from "../../../extensions/fan-mission/file-state-manager.js";

import { missionStart } from "../src/cli/mission-command.js";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function freshBaseDir(): string {
	return mkdtempSync(join(tmpdir(), "fan-mission-cmd-"));
}

/** Capture console.log output during a function call. */
async function captureConsole(fn: () => Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	const originalLog = console.log;
	console.log = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	try {
		await fn();
	} finally {
		console.log = originalLog;
	}
	return lines;
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("missionStart: completed mission reactivation", () => {
	let baseDir: string;
	let missionDir: string;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("test-reactivate", { baseDir });
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("completed + unchecked ROADMAP items → status becomes active, reactivation message", async () => {
		await writeMissionStatus(missionDir, "completed");
		await writeRoadmap(missionDir, "# Roadmap\n\n- [x] done item\n- [ ] new unchecked item\n");

		const lines = await captureConsole(() =>
			missionStart(missionDir, { baseDir }),
		);

		// Verify status changed to active
		const { frontmatter } = await readMission(missionDir);
		expect(String(frontmatter.status)).toBe("active");

		// Verify output message
		const text = lines.join("\n");
		expect(text).toContain("Mission reactivated");
		expect(text).toContain("new unchecked items found");
	});

	it("completed without unchecked ROADMAP items → hint message, status stays completed", async () => {
		await writeMissionStatus(missionDir, "completed");
		await writeRoadmap(missionDir, "# Roadmap\n\n- [x] done item 1\n- [x] done item 2\n");

		const lines = await captureConsole(() =>
			missionStart(missionDir, { baseDir }),
		);

		// Verify status stays completed
		const { frontmatter } = await readMission(missionDir);
		expect(String(frontmatter.status)).toBe("completed");

		// Verify hint message (no InvalidTransitionError)
		const text = lines.join("\n");
		expect(text).toMatch(/completed/i);
		expect(text).toContain("ROADMAP.md");
	});

	it("active mission → already active message", async () => {
		// Status is active from init
		const lines = await captureConsole(() =>
			missionStart(missionDir, { baseDir }),
		);

		const text = lines.join("\n");
		expect(text).toMatch(/active/i);
	});

	it("aborted mission → transitions to active", async () => {
		await writeMissionStatus(missionDir, "aborted");

		const lines = await captureConsole(() =>
			missionStart(missionDir, { baseDir }),
		);

		const { frontmatter } = await readMission(missionDir);
		expect(String(frontmatter.status)).toBe("active");

		const text = lines.join("\n");
		expect(text).toContain("Mission started");
	});
});
