// F-22: Промоушн одобренных идей BACKLOG→ROADMAP — тесты.
//
// Карточка: docs/features/super-orchestrator/mission-validation-1/roadmap.md §F-22
//
// Сценарии:
//   1. Промоушн ROADMAP-идеи (текст + idea-id маркер)
//   2. Дедупликация (второй вызов не дублирует)
//   3. Кап 3 за тик
//   4. Кап 50 пунктов в ROADMAP
//   5. Статус PROMOTED не промоутится повторно
//   6. DECIDE→accept→промоушн на следующем тике (интеграция с resolveDecision)
//   7. Интеграция шага 7 (мок scorer → ROADMAP → после тика пункт в ROADMAP.md)

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	appendBacklog,
	initMission,
	readBacklog,
	readRoadmap,
	updateBacklogEntry,
} from "../file-state-manager.js";
import { MissionLoop } from "../mission-loop.js";
import { promoteAcceptedIdeas } from "../idea-promoter.js";
import { createIdeaScorer } from "../idea-scorer.js";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function freshBaseDir(prefix = "fan-f22-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

async function makeMission(baseDir) {
	return initMission("f22-test", { baseDir });
}

function writeRoadmapFile(missionDir, lines) {
	writeFileSync(join(missionDir, "ROADMAP.md"), lines.join("\n"), "utf8");
}

async function seedIdea(missionDir, { id, idea, source = "test", status = "ROADMAP" }) {
	await appendBacklog(missionDir, {
		id,
		date: "2026-08-16",
		idea,
		source,
		fit: 0.9,
		value: 0.8,
		risk: 0.3,
		cost: 0.4,
		score: 0.75,
		status,
	});
}

// ────────────────────────────────────────────────────────────────────────────
// TC-F22-1: Промоушн ROADMAP-идеи
// ────────────────────────────────────────────────────────────────────────────

describe("F-22 / TC-F22-1: промоушн ROADMAP-идеи в ROADMAP.md", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f22-tc1-");
		missionDir = await makeMission(baseDir);
		writeRoadmapFile(missionDir, ["# Roadmap", "", "- [ ] existing item", ""]);
	});

	afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

	it("ROADMAP-идея добавлена как unchecked-пункт с маркером (idea:<id>)", async () => {
		await seedIdea(missionDir, { id: "idea-001", idea: "Добавить кэширование Redis" });

		const result = await promoteAcceptedIdeas(missionDir);

		expect(result.promoted).toEqual(["idea-001"]);

		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(roadmap).toContain("- [ ] Добавить кэширование Redis (idea:idea-001)");
	});

	it("BACKLOG-запись обновлена: status = PROMOTED", async () => {
		await seedIdea(missionDir, { id: "idea-001", idea: "Добавить кэширование Redis" });
		await promoteAcceptedIdeas(missionDir);

		const entries = await readBacklog(missionDir);
		const entry = entries.find((e) => e.id === "idea-001");
		expect(entry).toBeTruthy();
		expect(entry.status).toBe("PROMOTED");
	});

	it("несколько ROADMAP-идей промоутятся за один вызов", async () => {
		await seedIdea(missionDir, { id: "idea-001", idea: "Идея A" });
		await seedIdea(missionDir, { id: "idea-002", idea: "Идея B" });

		const result = await promoteAcceptedIdeas(missionDir);

		expect(result.promoted).toHaveLength(2);
		expect(result.promoted).toContain("idea-001");
		expect(result.promoted).toContain("idea-002");

		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(roadmap).toContain("(idea:idea-001)");
		expect(roadmap).toContain("(idea:idea-002)");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F22-2: Дедупликация
// ────────────────────────────────────────────────────────────────────────────

describe("F-22 / TC-F22-2: дедупликация (второй вызов не дублирует)", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f22-tc2-");
		missionDir = await makeMission(baseDir);
		writeRoadmapFile(missionDir, ["# Roadmap", "", "- [ ] existing item", ""]);
	});

	afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

	it("второй вызов promoteAcceptedIdeas не дублирует пункт в ROADMAP.md", async () => {
		await seedIdea(missionDir, { id: "idea-001", idea: "Добавить кэширование" });

		await promoteAcceptedIdeas(missionDir);
		const roadmap1 = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");

		// Reset status to ROADMAP to test dedup by marker (not status).
		await updateBacklogEntry(missionDir, "idea-001", { status: "ROADMAP" });
		await promoteAcceptedIdeas(missionDir);
		const roadmap2 = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");

		// Content should be identical — no duplicate lines.
		expect(roadmap2).toBe(roadmap1);

		// Count occurrences of idea-001 marker.
		const matches = [...roadmap2.matchAll(/idea:idea-001/g)];
		expect(matches).toHaveLength(1);
	});

	it("идея с маркером уже в ROADMAP (но status ROADMAP в BACKLOG) — не промоутится", async () => {
		await seedIdea(missionDir, { id: "idea-001", idea: "Уже промоучена" });

		// Manually add the marker to ROADMAP before promoting.
		const existing = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		writeFileSync(
			join(missionDir, "ROADMAP.md"),
			`${existing}- [ ] Уже промоучена (idea:idea-001)\n`,
			"utf8",
		);

		const result = await promoteAcceptedIdeas(missionDir);
		expect(result.promoted).toHaveLength(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F22-3: Кап 3 за тик
// ────────────────────────────────────────────────────────────────────────────

describe("F-22 / TC-F22-3: кап ≤3 промоушна за тик", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f22-tc3-");
		missionDir = await makeMission(baseDir);
		writeRoadmapFile(missionDir, ["# Roadmap", "", "- [ ] existing item", ""]);
	});

	afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

	it("5 ROADMAP-идей → промоутятся только 3 за один вызов", async () => {
		for (let i = 1; i <= 5; i++) {
			await seedIdea(missionDir, { id: `idea-${String(i).padStart(3, "0")}`, idea: `Идея ${i}` });
		}

		const result = await promoteAcceptedIdeas(missionDir);
		expect(result.promoted).toHaveLength(3);
	});

	it("второй вызов промоутит оставшиеся 2", async () => {
		for (let i = 1; i <= 5; i++) {
			await seedIdea(missionDir, { id: `idea-${String(i).padStart(3, "0")}`, idea: `Идея ${i}` });
		}

		await promoteAcceptedIdeas(missionDir);
		// Reset remaining ROADMAP entries (promoter set them to PROMOTED).
		const entries = await readBacklog(missionDir);
		for (const e of entries) {
			if (e.status === "PROMOTED") continue; // already promoted, skip
			if (e.status === "ROADMAP") continue; // not yet promoted, will be picked up
		}
		// Re-seed 2 more ROADMAP ideas (simulating new scorer results).
		await seedIdea(missionDir, { id: "idea-006", idea: "Идея 6" });
		await seedIdea(missionDir, { id: "idea-007", idea: "Идея 7" });

		const result2 = await promoteAcceptedIdeas(missionDir);
		// The first call promoted 3, set them to PROMOTED. The remaining 2 from
		// the original 5 are still ROADMAP (never got promoted because of cap),
		// plus 2 new ones = up to 4 candidates, but cap = 3.
		expect(result2.promoted.length).toBeLessThanOrEqual(3);
		expect(result2.promoted.length).toBeGreaterThanOrEqual(2);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F22-4: Кап 50 пунктов
// ────────────────────────────────────────────────────────────────────────────

describe("F-22 / TC-F22-4: кап 50 пунктов в ROADMAP", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f22-tc4-");
		missionDir = await makeMission(baseDir);
	});

	afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

	it("ROADMAP ≥50 пунктов → промоушн блокируется", async () => {
		// Seed 50 items in ROADMAP.
		const lines = ["# Roadmap", ""];
		for (let i = 1; i <= 50; i++) {
			lines.push(`- [ ] item ${i}`);
		}
		lines.push("");
		writeRoadmapFile(missionDir, lines);

		await seedIdea(missionDir, { id: "idea-001", idea: "Не пройдёт" });

		const result = await promoteAcceptedIdeas(missionDir);
		expect(result.promoted).toHaveLength(0);

		// BACKLOG status unchanged (still ROADMAP, not PROMOTED).
		const entries = await readBacklog(missionDir);
		const entry = entries.find((e) => e.id === "idea-001");
		expect(entry.status).toBe("ROADMAP");
	});

	it("ROADMAP 49 пунктов → промоушн проходит (1 идея)", async () => {
		const lines = ["# Roadmap", ""];
		for (let i = 1; i <= 49; i++) {
			lines.push(`- [ ] item ${i}`);
		}
		lines.push("");
		writeRoadmapFile(missionDir, lines);

		await seedIdea(missionDir, { id: "idea-001", idea: "Пройдёт" });

		const result = await promoteAcceptedIdeas(missionDir);
		expect(result.promoted).toEqual(["idea-001"]);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F22-5: PROMOTED не промоутится
// ────────────────────────────────────────────────────────────────────────────

describe("F-22 / TC-F22-5: статус PROMOTED не промоутится повторно", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f22-tc5-");
		missionDir = await makeMission(baseDir);
		writeRoadmapFile(missionDir, ["# Roadmap", "", "- [ ] existing item", ""]);
	});

	afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

	it("идея со статусом PROMOTED в BACKLOG не промоутится", async () => {
		await seedIdea(missionDir, {
			id: "idea-001",
			idea: "Уже промоучена",
			status: "PROMOTED",
		});

		const result = await promoteAcceptedIdeas(missionDir);
		expect(result.promoted).toHaveLength(0);
	});

	it("только ROADMAP-идеи промоутятся (смешанные статусы)", async () => {
		await seedIdea(missionDir, { id: "idea-001", idea: "ROADMAP идея", status: "ROADMAP" });
		await seedIdea(missionDir, { id: "idea-002", idea: "PROMOTED идея", status: "PROMOTED" });
		await seedIdea(missionDir, { id: "idea-003", idea: "REJECTED идея", status: "REJECTED" });
		await seedIdea(missionDir, { id: "idea-004", idea: "IDEA идея", status: "IDEA" });

		const result = await promoteAcceptedIdeas(missionDir);
		expect(result.promoted).toEqual(["idea-001"]);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F22-6: DECIDE→accept→промоушн на следующем тике
// ────────────────────────────────────────────────────────────────────────────

describe("F-22 / TC-F22-6: DECIDE→accept→промоушн на следующем тике", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f22-tc6-");
		missionDir = await makeMission(baseDir);
	});

	afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

	it("resolveDecision с accept обновляет DECIDE→ROADMAP в BACKLOG", async () => {
		// Setup: mission in awaiting_decision with a DECIDE idea.
		writeRoadmapFile(missionDir, [
			"# Roadmap",
			"",
			"- [ ] item one",
			"- [ ] item two",
			"- [ ] item three",
			"",
		]);

		await seedIdea(missionDir, {
			id: "idea-001",
			idea: "Спорная идея",
			status: "DECIDE",
		});

		// Manually set mission to awaiting_decision with pendingDecisionIdeaId.
		const { writeMissionStatus } = await import("../file-state-manager.js");
		await writeMissionStatus(missionDir, "awaiting_decision");

		// Write loop state with pendingDecisionIdeaId.
		const loopStatePath = join(missionDir, ".mission-loop.json");
		writeFileSync(
			loopStatePath,
			JSON.stringify({
				currentIteration: 1,
				lastStep: 0,
				interrupted: false,
				budgetUsed: { tokens: 0, usd: 0 },
				pendingDecision: { question: "Спорная идея (score: 0.62)", date: "2026-08-16T10:00:00Z" },
				pendingDecisionIdeaId: "idea-001",
			}),
			"utf8",
		);

		// Create a MissionLoop to call resolveDecision.
		const loop = new MissionLoop({
			missionDir,
			deps: {
				executor: { async runIteration() { return { status: "COMPLETE" }; } },
				git: {
					async commit() { return { hash: "h1" }; },
					async log() { return []; },
					async status() { return { clean: true }; },
				},
				clock: { async now() { return new Date(); } },
				lock: {
					async acquire() { return true; },
					async release() {},
				},
			},
			ideaPromoter: { promote: (dir) => promoteAcceptedIdeas(dir) },
		});

		// Resolve with "accept" → should update BACKLOG DECIDE→ROADMAP.
		await loop.resolveDecision("да, принять идею");

		const entries = await readBacklog(missionDir);
		const entry = entries.find((e) => e.id === "idea-001");
		expect(entry.status).toBe("ROADMAP");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-F22-7: Интеграция шага 7 — мок scorer ROADMAP → пункт в ROADMAP.md
// ────────────────────────────────────────────────────────────────────────────

describe("F-22 / TC-F22-7: интеграция шага 7 (мок scorer→ROADMAP→после тика пункт в ROADMAP)", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f22-tc7-");
		missionDir = await makeMission(baseDir);
	});

	afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

	function makeMockExecutor(results) {
		const calls = [];
		let idx = 0;
		return {
			calls,
			async runIteration(opts) {
				calls.push(opts);
				return results[Math.min(idx++, results.length - 1)];
			},
		};
	}

	function makeMockGit() {
		return {
			async commit({ cwd, message, files }) { return { hash: `h-${Date.now()}` }; },
			async log() { return []; },
			async status() { return { clean: true }; },
		};
	}

	function makeMockClock() {
		let n = 0;
		const base = new Date("2026-08-16T10:00:00Z");
		return { async now() { return new Date(base.getTime() + n++ * 60_000); } };
	}

	function makeMockLock() {
		let held = false;
		return {
			async acquire() { if (held) return false; held = true; return true; },
			async release() { held = false; },
		};
	}

	/**
	 * Mock generator that adds ideas on the 3rd call (threshold = 3 iterations).
	 */
	function makeMockGenerator(ideas, triggerOnCall = 3) {
		let count = 0;
		return {
			async generate(dir) {
				count++;
				if (count === triggerOnCall) {
					for (const idea of ideas) {
						await appendBacklog(dir, {
							id: idea.id,
							date: "2026-08-16",
							idea: idea.idea,
							source: idea.source,
							fit: 0, value: 0, risk: 0, cost: 0, score: 0,
							status: "IDEA",
						});
					}
					return { added: ideas.length, skippedDuplicates: 0 };
				}
				return { added: 0, skippedDuplicates: 0 };
			},
		};
	}

	function makeMockScorer(results) {
		return {
			async scoreIdea(dir, idea) {
				const r = results[idea.id];
				return r ? { id: idea.id, score: r.score, status: r.status } : { id: idea.id, score: 0.5, status: "DECIDE" };
			},
		};
	}

	/**
	 * Create a real ideaScorer (createIdeaScorer) with a mock LLM.
	 * The mock LLM returns different JSON based on the prompt content.
	 * This ensures the scorer actually updates the BACKLOG file (unlike
	 * the simple mock above which only returns a result object).
	 */
	function makeRealScorer(llmResponses) {
		const llm = async (prompt) => {
			for (const [key, response] of Object.entries(llmResponses)) {
				if (prompt.includes(key)) return JSON.stringify(response);
			}
			// Default: low score (REJECTED).
			return JSON.stringify({ relevance: 0.3, value: 0.3, risk: 0.6, cost: 0.6 });
		};
		return createIdeaScorer({ llm, now: () => new Date("2026-08-16T12:00:00Z") });
	}

	it("полный E2E: generate→score(ROADMAP)→promote за 3 тика", async () => {
		writeRoadmapFile(missionDir, [
			"# Roadmap",
			"",
			"- [ ] item one",
			"- [ ] item two",
			"- [ ] item three",
			"- [ ] item four",
			"- [ ] item five",
			"",
		]);

		const ideas = [
			{ id: "idea-001", idea: "Кэширование Redis", source: "итерация #3" },
		];

		const executor = makeMockExecutor([
			{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" },
			{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" },
			{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" },
		]);

		const generator = makeMockGenerator(ideas, 3);
		// Real scorer with mock LLM: Redis → high scores → ROADMAP (0.75).
		const scorer = makeRealScorer({
			"Redis": { relevance: 0.9, value: 0.8, risk: 0.3, cost: 0.4 },
		});

		const loop = new MissionLoop({
			missionDir,
			deps: {
				executor,
				git: makeMockGit(),
				clock: makeMockClock(),
				lock: makeMockLock(),
			},
			ideaGenerator: generator,
			ideaScorer: scorer,
			ideaPromoter: { promote: (dir) => promoteAcceptedIdeas(dir) },
		});

		// 3 тика: на 3-м генератор добавляет идею, скорер ставит ROADMAP, промоушн.
		await loop.tick();
		await loop.tick();
		await loop.tick();

		// Проверяем: идея промоучена — пункт в ROADMAP.md.
		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(roadmap).toContain("(idea:idea-001)");
		expect(roadmap).toContain("Redis");

		// BACKLOG: статус PROMOTED.
		const entries = await readBacklog(missionDir);
		const entry = entries.find((e) => e.id === "idea-001");
		expect(entry).toBeTruthy();
		expect(entry.status).toBe("PROMOTED");
	});

	it("DECIDE-идея НЕ промоутится (только ROADMAP)", async () => {
		writeRoadmapFile(missionDir, [
			"# Roadmap",
			"",
			"- [ ] item one",
			"- [ ] item two",
			"- [ ] item three",
			"- [ ] item four",
			"- [ ] item five",
			"",
		]);

		const ideas = [
			{ id: "idea-001", idea: "Спорная идея", source: "s" },
		];

		const executor = makeMockExecutor([
			{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" },
			{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" },
			{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" },
		]);

		const generator = makeMockGenerator(ideas, 3);
		// Real scorer with mock LLM: Спорная → borderline scores → DECIDE (0.50).
		const scorer = makeRealScorer({
			"Спорная": { relevance: 0.6, value: 0.5, risk: 0.5, cost: 0.6 },
		});

		const loop = new MissionLoop({
			missionDir,
			deps: {
				executor,
				git: makeMockGit(),
				clock: makeMockClock(),
				lock: makeMockLock(),
			},
			ideaGenerator: generator,
			ideaScorer: scorer,
			ideaPromoter: { promote: (dir) => promoteAcceptedIdeas(dir) },
		});

		await loop.tick();
		await loop.tick();
		await loop.tick(); // 3rd: generate→score(DECIDE)→awaiting_decision

		// DECIDE → миссия в awaiting_decision, промоушн НЕ произошёл.
		expect(await loop.status()).toBe("awaiting_decision");

		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(roadmap).not.toContain("(idea:idea-001)");

		// BACKLOG: статус DECIDE (не PROMOTED).
		const entries = await readBacklog(missionDir);
		const entry = entries.find((e) => e.id === "idea-001");
		expect(entry.status).toBe("DECIDE");
	});

	it("без ideaPromoter инъекции → поведение не меняется (backward compat)", async () => {
		writeRoadmapFile(missionDir, [
			"# Roadmap",
			"",
			"- [ ] item one",
			"- [ ] item two",
			"- [ ] item three",
			"",
		]);

		await seedIdea(missionDir, { id: "idea-001", idea: "Старая идея" });

		const executor = makeMockExecutor([
			{ status: "COMPLETE", response: "<promise>COMPLETE</promise>" },
		]);

		// Без ideaPromoter.
		const loop = new MissionLoop({
			missionDir,
			deps: {
				executor,
				git: makeMockGit(),
				clock: makeMockClock(),
				lock: makeMockLock(),
			},
		});

		const result = await loop.tick();
		expect(result.status).toBe("active");

		// ROADMAP.md unchanged (no idea-001 marker).
		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(roadmap).not.toContain("(idea:idea-001)");

		// BACKLOG: status ROADMAP unchanged (no promoter to set PROMOTED).
		const entries = await readBacklog(missionDir);
		const entry = entries.find((e) => e.id === "idea-001");
		expect(entry.status).toBe("ROADMAP");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// EDGE cases
// ────────────────────────────────────────────────────────────────────────────

describe("F-22 / EDGE: особые случаи", () => {
	let baseDir;
	let missionDir;

	beforeEach(async () => {
		baseDir = freshBaseDir("fan-f22-edge-");
		missionDir = await makeMission(baseDir);
		writeRoadmapFile(missionDir, ["# Roadmap", "", "- [ ] existing item", ""]);
	});

	afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

	it("пустой BACKLOG → промоушн возвращает пустой результат", async () => {
		const result = await promoteAcceptedIdeas(missionDir);
		expect(result.promoted).toHaveLength(0);
	});

	it("кириллица и спецсимволы в идее → корректный пункт в ROADMAP", async () => {
		await seedIdea(missionDir, {
			id: "idea-001",
			idea: "Рефакторинг аутентификации 🔐 — JWT + кириллица №1",
		});

		const result = await promoteAcceptedIdeas(missionDir);
		expect(result.promoted).toEqual(["idea-001"]);

		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(roadmap).toContain("Рефакторинг аутентификации 🔐 — JWT + кириллица №1");
		expect(roadmap).toContain("(idea:idea-001)");
	});

	it("ROADMAP.md без завершающего \\n → промоушн добавляет пункт корректно", async () => {
		// Write ROADMAP without trailing newline.
		writeFileSync(join(missionDir, "ROADMAP.md"), "# Roadmap\n\n- [ ] item one", "utf8");

		await seedIdea(missionDir, { id: "idea-001", idea: "Новая идея" });

		const result = await promoteAcceptedIdeas(missionDir);
		expect(result.promoted).toEqual(["idea-001"]);

		const roadmap = readFileSync(join(missionDir, "ROADMAP.md"), "utf8");
		expect(roadmap).toContain("- [ ] Новая идея (idea:idea-001)");
		// Existing item preserved.
		expect(roadmap).toContain("- [ ] item one");
	});

	it("custom opts: maxPerTick=1 → промоутится только 1 идея", async () => {
		await seedIdea(missionDir, { id: "idea-001", idea: "Идея A" });
		await seedIdea(missionDir, { id: "idea-002", idea: "Идея B" });
		await seedIdea(missionDir, { id: "idea-003", idea: "Идея C" });

		const result = await promoteAcceptedIdeas(missionDir, { maxPerTick: 1 });
		expect(result.promoted).toHaveLength(1);
	});

	it("custom opts: maxRoadmapItems=2 → промоушн при 2 пунктах блокируется", async () => {
		writeRoadmapFile(missionDir, [
			"# Roadmap",
			"",
			"- [ ] item one",
			"- [ ] item two",
			"",
		]);

		await seedIdea(missionDir, { id: "idea-001", idea: "Не пройдёт" });

		const result = await promoteAcceptedIdeas(missionDir, { maxRoadmapItems: 2 });
		expect(result.promoted).toHaveLength(0);
	});
});
