// prompt-builder tests: enriched step-4 execution prompt (mission context,
// roadmap marking, state, backlog, `<promise>` protocol, steer, truncation)
// + integration with MissionLoop.tick() via a mock executor.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initMission } from "../file-state-manager.js";
import { MissionLoop } from "../mission-loop.js";
import { buildExecutionPrompt, MAX_PROMPT_CHARS, MAX_SECTION_CHARS } from "../prompt-builder.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ROADMAP_RAW = "# Roadmap\n\n- [ ] item a\n- [ ] item b\n- [x] item c\n";
const ITEM_A_INDEX = 2; // line of "- [ ] item a" in ROADMAP_RAW

/** Replace MISSION.md body, preserving the frontmatter. */
function writeMissionBody(missionDir, body) {
	const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
	const endIdx = raw.indexOf("\n---\n", 4);
	writeFileSync(join(missionDir, "MISSION.md"), raw.slice(0, endIdx + 5) + body, "utf8");
}

function makeMockExecutor(iterationResults) {
	const calls = [];
	let idx = 0;
	return {
		calls,
		async runIteration(opts) {
			calls.push({ ...opts });
			const result = iterationResults[Math.min(idx, iterationResults.length - 1)];
			idx++;
			return { ...result };
		},
	};
}

function makeMockGit() {
	const commits = [];
	return {
		commits,
		async commit({ cwd, message, files }) {
			const hash = `hash-${commits.length + 1}-${Date.now().toString(36)}`;
			commits.push({ cwd, message, files, hash });
			return { hash };
		},
		async log() {
			return commits.map((c) => ({ hash: c.hash, subject: c.message, date: new Date().toISOString() }));
		},
		async status() {
			return { clean: true };
		},
	};
}

function makeMockClock() {
	let n = 0;
	const base = new Date("2026-08-10T10:00:00Z");
	return {
		async now() {
			return new Date(base.getTime() + n++ * 60_000);
		},
	};
}

function makeMockLock() {
	let held = false;
	return {
		async acquire() {
			if (held) return false;
			held = true;
			return true;
		},
		async release() {
			held = false;
		},
	};
}

/** Extract the content of a `## <header>` section (up to the next `## `). */
function extractSection(prompt, header) {
	const marker = `## ${header}`;
	const start = prompt.indexOf(marker);
	if (start < 0) return null;
	const contentStart = start + marker.length + 1; // + "\n"
	const end = prompt.indexOf("\n## ", contentStart);
	return prompt.slice(contentStart, end === -1 ? undefined : end).replace(/\n+$/, "");
}

// ─── Setup ───────────────────────────────────────────────────────────────────

let baseDir;
let missionDir;

beforeEach(async () => {
	baseDir = mkdtempSync(join(tmpdir(), "fan-prompt-builder-"));
	missionDir = await initMission("context-mission", { baseDir });
	writeFileSync(join(missionDir, "ROADMAP.md"), ROADMAP_RAW, "utf8");
	writeMissionBody(
		missionDir,
		"\n# Mission: context-mission\n\n## Goal\nShip the context feature GOAL_MARKER_123\n",
	);
});

afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("prompt-builder: buildExecutionPrompt", () => {
	it("1. Полный контекст: item, mission body, roadmap с ▶, state, протокол <promise>", async () => {
		writeFileSync(
			join(missionDir, "BACKLOG.md"),
			"# Backlog\n\n| id | idea |\n|---|---|\n| b1 | backlog idea marker |\n",
			"utf8",
		);
		const prompt = await buildExecutionPrompt({
			missionDir,
			itemText: "item a",
			index: ITEM_A_INDEX,
			roadmapRaw: ROADMAP_RAW,
			state: { done: ["prev thing"], blockers: [], nextSteps: ["do item a"] },
		});

		// Первая строка стабильна (совместимость с executor/тестами)
		expect(prompt.split("\n")[0]).toBe("Execute mission item: item a");
		// Mission context: slug, dir, body без frontmatter
		expect(prompt).toContain("## Mission context (provided — do NOT re-read these files)");
		expect(prompt).toContain(`Mission: context-mission (dir: ${missionDir})`);
		expect(prompt).toContain("GOAL_MARKER_123");
		expect(prompt).not.toContain("mission_id:");
		// Roadmap: текущий пункт помечен ▶, остальные — нет
		expect(prompt).toContain("▶ - [ ] item a");
		expect(prompt).not.toContain("▶ - [ ] item b");
		expect(prompt).not.toContain("▶ - [x] item c");
		// State
		expect(prompt).toContain("- prev thing");
		expect(prompt).toContain("- do item a");
		// Backlog (непустой)
		expect(prompt).toContain("## Backlog");
		expect(prompt).toContain("backlog idea marker");
		// Протокол отчёта + guidance
		expect(prompt).toContain("## Reporting protocol");
		expect(prompt).toContain("<promise>COMPLETE</promise>");
		expect(prompt).toContain("<promise>BLOCKED</promise>");
		expect(prompt).toContain("<promise>DECIDE</promise>");
		expect(prompt).toContain("<promise>FAILED</promise>");
		expect(prompt).toContain("## Guidance");
	});

	it("2. Пустой state → \"No prior state yet.\"", async () => {
		const prompt = await buildExecutionPrompt({
			missionDir,
			itemText: "item a",
			index: ITEM_A_INDEX,
			roadmapRaw: ROADMAP_RAW,
			state: { done: [], blockers: [], nextSteps: [] },
		});
		expect(prompt).toContain("## State");
		expect(prompt).toContain("No prior state yet.");
	});

	it("3. Пустой backlog → секции Backlog нет", async () => {
		// Дефолтный шаблон BACKLOG.md = "# Backlog\n" (только заголовок)
		const prompt = await buildExecutionPrompt({
			missionDir,
			itemText: "item a",
			index: ITEM_A_INDEX,
			roadmapRaw: ROADMAP_RAW,
			state: { done: [], blockers: [], nextSteps: [] },
		});
		expect(prompt).not.toContain("## Backlog");
	});

	it("4. Обрезка: state 10000 символов → секция ≤ 4000 + \"...[truncated]\", общий ≤ 20000", async () => {
		const prompt = await buildExecutionPrompt({
			missionDir,
			itemText: "item a",
			index: ITEM_A_INDEX,
			roadmapRaw: ROADMAP_RAW,
			state: { done: ["x".repeat(10000)], blockers: [], nextSteps: [] },
		});
		const section = extractSection(prompt, "State");
		expect(section).not.toBeNull();
		expect(section.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
		expect(section).toContain("...[truncated]");
		expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
	});

	it("5. steer передаётся блоком \"## Operator steer\"", async () => {
		const prompt = await buildExecutionPrompt({
			missionDir,
			itemText: "item a",
			index: ITEM_A_INDEX,
			roadmapRaw: ROADMAP_RAW,
			state: { done: [], blockers: [], nextSteps: [] },
			steer: "Focus on the auth module",
		});
		expect(prompt).toContain("## Operator steer");
		expect(prompt).toContain("Focus on the auth module");
	});

	it("6. Интеграция: mission-loop tick → executor получает промпт с \"Mission context\"", async () => {
		const executor = makeMockExecutor([
			{ status: "COMPLETE", commitMessage: "iter: done", response: "<promise>COMPLETE</promise>" },
		]);
		const loop = new MissionLoop({
			missionDir,
			deps: { executor, git: makeMockGit(), clock: makeMockClock(), lock: makeMockLock() },
		});

		const result = await loop.tick();

		expect(result.steps.iterate).toBe(true);
		expect(executor.calls.length).toBe(1);
		const prompt = executor.calls[0].prompt;
		expect(prompt.split("\n")[0]).toBe("Execute mission item: item a");
		expect(prompt).toContain("Mission context");
		expect(prompt).toContain("## Reporting protocol");
		// steer не задан → секции Operator steer нет, но opts.steer пробрасывается как раньше
		expect(prompt).not.toContain("## Operator steer");
		expect(executor.calls[0].steer).toBeUndefined();
	});
});
