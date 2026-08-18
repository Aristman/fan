// prompt-builder tests: enriched step-4 execution prompt (mission context,
// roadmap marking, state, backlog, `<promise>` protocol, steer, truncation)
// + integration with MissionLoop.tick() via a mock executor.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initMission } from "../file-state-manager.js";
import { MissionLoop } from "../mission-loop.js";
import {
	BOOTSTRAP_PLANNING_GUIDANCE,
	buildExecutionPrompt,
	FRESH_SESSION_SECTION,
	isBootstrapItem,
	MAX_PROMPT_CHARS,
	MAX_SECTION_CHARS,
	PLANNING_ITEM_TEXT,
} from "../prompt-builder.js";

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
		// 0.8.0: continuous loop processes items + planning cap
		expect(executor.calls.length).toBeGreaterThanOrEqual(1);
		const prompt = executor.calls[0].prompt;
		expect(prompt.split("\n")[0]).toBe("Execute mission item: item a");
		expect(prompt).toContain("Mission context");
		expect(prompt).toContain("## Reporting protocol");
		// steer не задан → секции Operator steer нет, но opts.steer пробрасывается как раньше
		expect(prompt).not.toContain("## Operator steer");
		expect(executor.calls[0].steer).toBeUndefined();
	});
});

// ─── 0.7.0: bootstrap-planning guidance ───────────────────────────────────

describe("prompt-builder: bootstrap planning guidance (0.7.0)", () => {
	const BOOTSTRAP_ROADMAP = "# Roadmap\n\n- [ ] Bootstrap mission: context-mission\n- [ ] item b\n";
	const BOOTSTRAP_INDEX = 2; // строка "- [ ] Bootstrap mission: …"

	it("isBootstrapItem: первый пункт 'Bootstrap mission:…' → true", () => {
		expect(isBootstrapItem(BOOTSTRAP_ROADMAP, BOOTSTRAP_INDEX, "Bootstrap mission: context-mission")).toBe(true);
	});

	it("isBootstrapItem: не первый пункт → false", () => {
		const raw = "# Roadmap\n\n- [ ] item a\n- [ ] Bootstrap mission: x\n";
		expect(isBootstrapItem(raw, 3, "Bootstrap mission: x")).toBe(false);
	});

	it("isBootstrapItem: другой текст → false", () => {
		expect(isBootstrapItem(BOOTSTRAP_ROADMAP, BOOTSTRAP_INDEX, "item b")).toBe(false);
	});

	it("bootstrap-пункт + непустой Goal → в Guidance строка про декомпозицию Goal", async () => {
		// beforeEach уже записал body с ## Goal (GOAL_MARKER_123)
		writeFileSync(join(missionDir, "ROADMAP.md"), BOOTSTRAP_ROADMAP, "utf8");
		const prompt = await buildExecutionPrompt({
			missionDir,
			itemText: "Bootstrap mission: context-mission",
			index: BOOTSTRAP_INDEX,
			roadmapRaw: BOOTSTRAP_ROADMAP,
			state: { done: [], blockers: [], nextSteps: [] },
		});
		expect(prompt).toContain(BOOTSTRAP_PLANNING_GUIDANCE);
		expect(prompt).toContain("decompose the mission Goal");
	});

	it("bootstrap-пункт + пустой Goal → guidance НЕТ", async () => {
		writeMissionBody(missionDir, "\n# Mission: context-mission\n\n## Goal\n\n## Scope\n");
		writeFileSync(join(missionDir, "ROADMAP.md"), BOOTSTRAP_ROADMAP, "utf8");
		const prompt = await buildExecutionPrompt({
			missionDir,
			itemText: "Bootstrap mission: context-mission",
			index: BOOTSTRAP_INDEX,
			roadmapRaw: BOOTSTRAP_ROADMAP,
			state: { done: [], blockers: [], nextSteps: [] },
		});
		expect(prompt).not.toContain(BOOTSTRAP_PLANNING_GUIDANCE);
	});

	it("обычный пункт + непустой Goal → guidance НЕТ", async () => {
		const prompt = await buildExecutionPrompt({
			missionDir,
			itemText: "item a",
			index: ITEM_A_INDEX,
			roadmapRaw: ROADMAP_RAW,
			state: { done: [], blockers: [], nextSteps: [] },
		});
		expect(prompt).not.toContain(BOOTSTRAP_PLANNING_GUIDANCE);
	});

	it("синтетический planning-пункт + непустой Goal → guidance есть", async () => {
		const prompt = await buildExecutionPrompt({
			missionDir,
			itemText: PLANNING_ITEM_TEXT,
			index: -1,
			roadmapRaw: "# Roadmap\n\n- [x] Bootstrap mission: context-mission\n",
			state: { done: ["Bootstrap mission: context-mission"], blockers: [], nextSteps: [] },
		});
		expect(prompt.split("\n")[0]).toBe(`Execute mission item: ${PLANNING_ITEM_TEXT}`);
		expect(prompt).toContain(BOOTSTRAP_PLANNING_GUIDANCE);
	});

	it("Guidance содержит требование к точным русским именам секций STATE.md", async () => {
		const prompt = await buildExecutionPrompt({
			missionDir,
			itemText: "Test item",
			index: 0,
			roadmapRaw: "- [ ] Test item",
			state: { done: [], blockers: [], nextSteps: [] },
		});
		expect(prompt).toContain("## Сделано");
		expect(prompt).toContain("## Блокеры");
		expect(prompt).toContain("## Следующие шаги");
		expect(prompt).toContain("EXACT Russian names");
	});
});

// ─── ralph-loop (S4): fresh-session section ───────────────────────────────

describe("prompt-builder: freshSession section (ralph-loop S4)", () => {
	it("freshSession=true → секция «Session mode» присутствует (точный текст §5)", async () => {
		const prompt = await buildExecutionPrompt({
			missionDir,
			itemText: "item a",
			index: ITEM_A_INDEX,
			roadmapRaw: ROADMAP_RAW,
			state: { done: [], blockers: [], nextSteps: [] },
			freshSession: true,
		});
		expect(prompt).toContain("## Session mode");
		expect(prompt).toContain(FRESH_SESSION_SECTION);
		expect(prompt).toContain("FRESH session (ralph loop)");
		expect(prompt).toContain("Do NOT search for prior chat context.");
		expect(prompt).toContain("the next session will not remember this one.");
	});

	it("freshSession=false → секции «Session mode» нет", async () => {
		const prompt = await buildExecutionPrompt({
			missionDir,
			itemText: "item a",
			index: ITEM_A_INDEX,
			roadmapRaw: ROADMAP_RAW,
			state: { done: [], blockers: [], nextSteps: [] },
			freshSession: false,
		});
		expect(prompt).not.toContain("## Session mode");
		expect(prompt).not.toContain("FRESH session (ralph loop)");
	});

	it("freshSession=undefined → секции «Session mode» нет", async () => {
		const prompt = await buildExecutionPrompt({
			missionDir,
			itemText: "item a",
			index: ITEM_A_INDEX,
			roadmapRaw: ROADMAP_RAW,
			state: { done: [], blockers: [], nextSteps: [] },
		});
		expect(prompt).not.toContain("## Session mode");
	});

	it("freshSession=true + большие секции → бюджет промпта ≤ MAX_PROMPT_CHARS не превышен", async () => {
		writeFileSync(
			join(missionDir, "BACKLOG.md"),
			`# Backlog\n\n${"backlog line with content\n".repeat(400)}`,
			"utf8",
		);
		const prompt = await buildExecutionPrompt({
			missionDir,
			itemText: "item a",
			index: ITEM_A_INDEX,
			roadmapRaw: ROADMAP_RAW,
			state: { done: ["x".repeat(3900)], blockers: [], nextSteps: [] },
			steer: "s".repeat(3900),
			freshSession: true,
		});
		expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
	});
});
