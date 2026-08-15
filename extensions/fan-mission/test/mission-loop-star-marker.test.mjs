// F-XX bug-fix tests: ROADMAP `*`-маркеры (валидный markdown) вызывали ложный
// completed миссии — parseFirstUnchecked/markRoadmapDone/isRoadmapItemChecked
// принимали только `-`-маркеры. + защита: ROADMAP без чеклист-пунктов → failed.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initMission, readState } from "../file-state-manager.js";
import { MissionLoop } from "../mission-loop.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
			return commits.map((c) => ({
				hash: c.hash,
				subject: c.message,
				date: new Date().toISOString(),
			}));
		},
		async status() {
			return { clean: true };
		},
	};
}

function makeMockClock() {
	let n = 0;
	const base = new Date("2026-08-15T10:00:00Z");
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

function makeDeps(overrides = {}) {
	const git = makeMockGit();
	const executor = makeMockExecutor([{ status: "COMPLETE", commitMessage: "iter: tick" }]);
	const clock = makeMockClock();
	const lock = makeMockLock();
	const result = {
		executor,
		git,
		clock,
		lock,
		commits: git.commits,
		...overrides,
	};
	result.executorCalls = result.executor.calls;
	return result;
}

function freshBaseDir() {
	return mkdtempSync(join(tmpdir(), "fan-star-marker-"));
}

function writeRoadmapFile(missionDir, lines) {
	writeFileSync(join(missionDir, "ROADMAP.md"), lines.join("\n"), "utf8");
}

function readMissionStatus(missionDir) {
	const raw = readFileSync(join(missionDir, "MISSION.md"), "utf8");
	const m = /^status:\s*(.+)$/m.exec(raw);
	return m ? m[1].trim() : null;
}

// ════════════════════════════════════════════════════════════════════════════
// ROADMAP `*`-маркеры: ложный completed → корректное выполнение
// ════════════════════════════════════════════════════════════════════════════

describe("ROADMAP `*`-маркеры чеклиста", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir();
		missionDir = await initMission("star-marker-test", { baseDir });
	});

	afterEach(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it("1. ROADMAP с `* [ ]` пунктами → тик берёт первый пункт в работу (НЕ completed)", async () => {
		writeRoadmapFile(missionDir, [
			"# Roadmap",
			"",
			"* [ ] task-alpha",
			"* [ ] task-beta",
			"",
		]);

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).not.toBe("completed");
		expect(result.status).toBe("active");
		expect(result.iteration).toBe(1);
		expect(result.item).toBe("task-alpha");
		expect(deps.executorCalls.length).toBe(1);

		const state = await readState(missionDir);
		expect(state.done).toContain("task-alpha");
	});

	it("2. Смешанный ROADMAP `- [x]` + `* [ ]` → берёт `*`-пункт", async () => {
		writeRoadmapFile(missionDir, [
			"# Roadmap",
			"",
			"- [x] task-alpha",
			"* [ ] task-beta",
			"* [ ] task-gamma",
			"",
		]);

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("active");
		expect(result.item).toBe("task-beta");
		expect(deps.executorCalls.length).toBe(1);
		expect(deps.executorCalls[0].prompt).toContain("task-beta");
	});

	it("3. markRoadmapDone на `*`-строке → `* [x]` (маркер сохранён)", async () => {
		writeRoadmapFile(missionDir, [
			"# Roadmap",
			"",
			"* [ ] task-alpha",
			"* [ ] task-beta",
			"",
		]);

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		await loop.tick();

		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(roadmap).toContain("* [x] task-alpha");
		expect(roadmap).toContain("* [ ] task-beta");
		expect(roadmap).not.toContain("- [x] task-alpha");
	});

	it("4. ROADMAP без чеклист-пунктов (просто текст) → failed с диагностикой, НЕ completed", async () => {
		writeRoadmapFile(missionDir, [
			"# Roadmap",
			"",
			"Просто описание миссии без чеклиста.",
			"Ещё одна строка текста.",
			"",
		]);

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("failed");
		expect(result.status).not.toBe("completed");
		expect(result.item).toContain("ROADMAP contains no parseable checklist items");
		expect(readMissionStatus(missionDir)).toBe("failed");
		// Executor не должен запускаться
		expect(deps.executorCalls.length).toBe(0);
	});

	it("5. ROADMAP все пункты checked (смешанные маркеры) → completed легитимно", async () => {
		writeRoadmapFile(missionDir, [
			"# Roadmap",
			"",
			"- [x] task-alpha",
			"* [x] task-beta",
			"",
		]);

		const deps = makeDeps();
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("completed");
		expect(readMissionStatus(missionDir)).toBe("completed");
		expect(deps.executorCalls.length).toBe(0);
	});
});
