// 0.7.0: bootstrap-планирование в mission-loop (задача B, вариант 1).
//
// Если в ROADMAP не осталось unchecked-пунктов, миссия НЕ завершается
// completed, когда Goal непуст и ROADMAP валиден (есть checked-пункты):
// тик запускает planning-итерацию на синтетическом пункте
// PLANNING_ITEM_TEXT — executor должен декомпозировать Goal в unchecked-
// пункты ROADMAP.md. Пустой Goal → completed как раньше; ROADMAP без
// парсящихся пунктов → failed как в 0.4.1; unchecked-пункты → обычный путь.
//
// Дополнительно: правки ROADMAP.md, сделанные executor'ом за итерацию
// (bootstrap/planning добавляет пункты), не затираются шагом 6 — шаг
// перечитывает ROADMAP с диска перед отметкой пункта.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initMission, readMission } from "../file-state-manager.js";
import { MissionLoop } from "../mission-loop.js";
import { BOOTSTRAP_PLANNING_GUIDANCE, PLANNING_ITEM_TEXT } from "../prompt-builder.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Мок executor'а. `onRun(opts)` вызывается внутри runIteration (может
 * редактировать файлы миссии, как это делает реальный агент).
 */
function makeMockExecutor(results, onRun) {
	const calls = [];
	let idx = 0;
	return {
		calls,
		async runIteration(opts) {
			calls.push({ ...opts });
			if (onRun) await onRun(opts, calls.length);
			const result = results[Math.min(idx, results.length - 1)];
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
			const hash = `hash-${commits.length + 1}`;
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
	const base = new Date("2026-08-16T10:00:00Z");
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
	const result = {
		git,
		clock: makeMockClock(),
		lock: makeMockLock(),
		...overrides,
	};
	result.commits = git.commits;
	return result;
}

function freshBaseDir() {
	return mkdtempSync(join(tmpdir(), "fan-planning-"));
}

function writeRoadmap(missionDir, lines) {
	writeFileSync(join(missionDir, "ROADMAP.md"), lines.join("\n"), "utf8");
}

// ─── Setup ──────────────────────────────────────────────────────────────────

let baseDir;

beforeEach(() => {
	baseDir = freshBaseDir();
});

afterEach(() => {
	rmSync(baseDir, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("mission-loop planning (0.7.0): decide-шаг", () => {
	it("1. ROADMAP только checked + Goal непуст → planning-итерация вместо completed", async () => {
		const missionDir = await initMission("planning-goal", {
			baseDir,
			description: "Build a CLI dashboard for mission metrics",
		});
		// bootstrap выполнен (checked), unchecked-пунктов нет
		writeRoadmap(missionDir, ["# Roadmap", "", "- [x] Bootstrap mission: planning-goal", ""]);

		const deps = makeDeps({
			executor: makeMockExecutor([{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" }]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		// НЕ completed — планирование
		expect(result.status).toBe("active");
		expect(result.steps.iterate).toBe(true);
		expect(result.item).toBe(PLANNING_ITEM_TEXT);
		expect(deps.executor.calls.length).toBe(1);
		// Промпт planning-итерации: синтетический пункт + guidance декомпозиции
		const prompt = deps.executor.calls[0].prompt;
		expect(prompt.split("\n")[0]).toBe(`Execute mission item: ${PLANNING_ITEM_TEXT}`);
		expect(prompt).toContain(BOOTSTRAP_PLANNING_GUIDANCE);
		// MISSION.md остался active
		const mission = await readMission(missionDir);
		expect(String(mission.frontmatter.status)).toBe("active");
	});

	it("2. ROADMAP только checked + Goal пуст → completed как раньше", async () => {
		const missionDir = await initMission("planning-nogoal", { baseDir }); // без описания
		writeRoadmap(missionDir, ["# Roadmap", "", "- [x] Bootstrap mission: planning-nogoal", ""]);

		const deps = makeDeps({
			executor: makeMockExecutor([{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" }]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("completed");
		expect(deps.executor.calls.length).toBe(0); // executor не запускался
		const mission = await readMission(missionDir);
		expect(String(mission.frontmatter.status)).toBe("completed");
	});

	it("3. есть unchecked-пункты → обычный путь (не planning)", async () => {
		const missionDir = await initMission("planning-unchecked", {
			baseDir,
			description: "Some goal",
		});
		writeRoadmap(missionDir, [
			"# Roadmap",
			"",
			"- [x] Bootstrap mission: planning-unchecked",
			"- [ ] implement feature A",
			"",
		]);

		const deps = makeDeps({
			executor: makeMockExecutor([{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" }]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("active");
		expect(result.item).toBe("implement feature A");
		expect(deps.executor.calls[0].prompt.split("\n")[0]).toBe("Execute mission item: implement feature A");
		expect(deps.executor.calls[0].prompt).not.toContain(BOOTSTRAP_PLANNING_GUIDANCE);
	});

	it("4. ROADMAP без парсящихся пунктов + Goal непуст → failed (фикс 0.4.1 сохранён)", async () => {
		const missionDir = await initMission("planning-invalid", {
			baseDir,
			description: "Goal present but roadmap invalid",
		});
		writeRoadmap(missionDir, ["# Roadmap", "", "just some text without checklist", ""]);

		const deps = makeDeps({
			executor: makeMockExecutor([{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" }]),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("failed");
		expect(deps.executor.calls.length).toBe(0);
	});
});

describe("mission-loop planning (0.7.0): сохранение правок ROADMAP executor'ом", () => {
	it("5. planning-итерация: executor добавил unchecked-пункты → они переживают шаг 6", async () => {
		const missionDir = await initMission("planning-persist", {
			baseDir,
			description: "Ship the reporting module",
		});
		writeRoadmap(missionDir, ["# Roadmap", "", "- [x] Bootstrap mission: planning-persist", ""]);

		// executor во время итерации декомпозирует Goal в ROADMAP.md
		const deps = makeDeps({
			executor: makeMockExecutor([{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" }], (opts) => {
				const roadmapPath = join(opts.missionDir, "ROADMAP.md");
				const raw = readFileSync(roadmapPath, "utf8");
				writeFileSync(
					roadmapPath,
					`${raw.trimEnd()}\n- [ ] design report schema\n- [ ] implement report endpoint\n`,
					"utf8",
				);
			}),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("active");
		// Пункты executor'а на диске, git-commit сделан
		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(roadmap).toContain("- [ ] design report schema");
		expect(roadmap).toContain("- [ ] implement report endpoint");
		expect(deps.commits.length).toBe(1);

		// Следующий тик берёт в работу первый добавленный пункт (не planning)
		const result2 = await loop.tick();
		expect(result2.item).toBe("design report schema");
		expect(result2.status).toBe("active");
	});

	it("6. planning-итерация без правок ROADMAP → без git-commit, без падения, снова active", async () => {
		const missionDir = await initMission("planning-noop", {
			baseDir,
			description: "Goal without decomposition",
		});
		writeRoadmap(missionDir, ["# Roadmap", "", "- [x] Bootstrap mission: planning-noop", ""]);

		const deps = makeDeps({
			executor: makeMockExecutor([{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" }]),
		});
		const loop = new MissionLoop({ missionDir, deps });

		// Первый тик: planning (STATE.md получает пункт, ROADMAP без изменений → без commit)
		const result1 = await loop.tick();
		expect(result1.status).toBe("active");
		expect(result1.item).toBe(PLANNING_ITEM_TEXT);
		expect(deps.commits.length).toBe(0);

		// Второй тик: снова planning, ничего не меняется — цикл не падает
		const result2 = await loop.tick();
		expect(result2.status).toBe("active");
		expect(deps.executor.calls.length).toBe(2);
		expect(deps.commits.length).toBe(0);
	});

	it("7. bootstrap-итерация: пункт 'Bootstrap mission:…' + Goal → guidance в промпте, правки ROADMAP сохраняются", async () => {
		const missionDir = await initMission("bootstrap-int", {
			baseDir,
			description: "Build the integration layer",
		});
		// дефолтный шаблон ROADMAP: "- [ ] Bootstrap mission: bootstrap-int"

		const deps = makeDeps({
			executor: makeMockExecutor([{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" }], (opts) => {
				const roadmapPath = join(opts.missionDir, "ROADMAP.md");
				const raw = readFileSync(roadmapPath, "utf8");
				writeFileSync(roadmapPath, `${raw.trimEnd()}\n- [ ] scaffold integration module\n`, "utf8");
			}),
		});
		const loop = new MissionLoop({ missionDir, deps });
		const result = await loop.tick();

		expect(result.status).toBe("active");
		const prompt = deps.executor.calls[0].prompt;
		expect(prompt.split("\n")[0]).toBe("Execute mission item: Bootstrap mission: bootstrap-int");
		expect(prompt).toContain(BOOTSTRAP_PLANNING_GUIDANCE);
		expect(prompt).toContain("Build the integration layer");

		// bootstrap отмечен, пункт executor'а сохранён
		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(roadmap).toContain("- [x] Bootstrap mission: bootstrap-int");
		expect(roadmap).toContain("- [ ] scaffold integration module");
	});
});
