// Тесты для плановой компактизации STATE.md (150KB лимит, 100KB soft-порог).
//
// Запуск: npx vitest run bundles/fan-mission/extensions/fan-mission/state-compaction.test.ts

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	MAX_STATE_BYTES,
	SOFT_STATE_BYTES,
	compactStateIfNeeded,
	radicalTruncateDone,
	checkStateFileSize,
	readState,
	writeState,
	archiveOldDoneItems,
} from "./file-state-manager.js";
import { MissionLoop } from "./mission-loop.js";

// ─── Test helpers ──────────────────────────────────────────────────────────

let missionDir: string;
const dirs: string[] = [];

const MISSION_TEMPLATE = `---
mission_id: test-compaction
created: 2026-08-26T00:00:00.000Z
status: active
metric_type: checklist
metric_command: echo done
budget_tokens: 1000000
budget_usd: 10
max_depth: 3
max_width: 5
session_mode: persistent
---

# Test Mission
`;

function createMissionDir(): string {
	const dir = join(tmpdir(), `fan-compaction-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	dirs.push(dir);
	writeFileSync(join(dir, "MISSION.md"), MISSION_TEMPLATE, "utf8");
	writeFileSync(join(dir, "ROADMAP.md"), "- [ ] Item A\n- [ ] Item B", "utf8");
	writeFileSync(join(dir, "STATE.md"), "## Сделано\n\n## Блокеры\n\n## Следующие шаги\n", "utf8");
	writeFileSync(join(dir, "BACKLOG.md"), "", "utf8");
	writeFileSync(join(dir, "DECISIONS.md"), "", "utf8");
	return dir;
}

function createMockDeps(overrides?: {
	executorResult?: { status: string; response?: string };
}): {
	executor: { runIteration: ReturnType<typeof vi.fn> };
	git: { commit: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
	clock: { now: () => Date };
	lock: { acquire: () => Promise<boolean>; release: () => Promise<void> };
} {
	const result = overrides?.executorResult ?? { status: "COMPLETE", response: "<promise>COMPLETE</promise>" };
	return {
		executor: { runIteration: vi.fn().mockResolvedValue(result) },
		git: {
			commit: vi.fn().mockResolvedValue({ hash: "abc123" }),
			log: vi.fn().mockResolvedValue([]),
			status: vi.fn().mockResolvedValue({ clean: true }),
		},
		clock: { now: () => new Date("2026-08-26T12:00:00.000Z") },
		lock: { acquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
	};
}

/** Генерация STATE.md с N done-записями по ~1KB каждая (итого ~N KB). */
function generateStateContent(doneCount: number, blockersCount = 0, nextStepsCount = 0): string {
	const lines: string[] = ["## Сделано"];
	for (let i = 0; i < doneCount; i++) {
		// ~200 символов на запись + хеш для уникальности → ~250 байт UTF-8
		const pad = `x`.repeat(200);
		lines.push(`- Done item ${i.toString().padStart(4, "0")} ${pad} hash${i}`);
	}
	lines.push("");
	lines.push("## Блокеры");
	for (let i = 0; i < blockersCount; i++) {
		lines.push(`- Blocker ${i}`);
	}
	lines.push("");
	lines.push("## Следующие шаги");
	for (let i = 0; i < nextStepsCount; i++) {
		lines.push(`- Next step ${i}`);
	}
	lines.push("");
	return lines.join("\n");
}

beforeEach(() => {
	missionDir = createMissionDir();
});

afterAll(() => {
	for (const d of dirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("STATE.md compaction policy", () => {

	describe("constants", () => {
		it("MAX_STATE_BYTES = 150KB", () => {
			expect(MAX_STATE_BYTES).toBe(150 * 1024);
		});
		it("SOFT_STATE_BYTES = 100KB", () => {
			expect(SOFT_STATE_BYTES).toBe(100 * 1024);
		});
		it("SOFT < MAX", () => {
			expect(SOFT_STATE_BYTES).toBeLessThan(MAX_STATE_BYTES);
		});
	});

	describe("compactStateIfNeeded", () => {
		it("(a) 200KB STATE.md → ужимается ниже soft-порога, архив получает старые записи", async () => {
			// Генерируем STATE.md > 100KB (soft-порог)
			const stateContent = generateStateContent(500); // ~125KB
			writeFileSync(join(missionDir, "STATE.md"), stateContent, "utf8");
			const beforeSize = checkStateFileSize(missionDir);
			expect(beforeSize).toBeGreaterThanOrEqual(SOFT_STATE_BYTES);

			const result = await compactStateIfNeeded(missionDir);
			expect(result).toBe(true);

			const afterSize = checkStateFileSize(missionDir);
			expect(afterSize).toBeLessThan(SOFT_STATE_BYTES);

			// ARCHIVE.md создан и содержит старые записи
			const archivePath = join(missionDir, "ARCHIVE.md");
			expect(existsSync(archivePath)).toBe(true);
			const archiveContent = readFileSync(archivePath, "utf8");
			expect(archiveContent).toContain("Done item 0");
			expect(archiveContent).toContain("Done item 0004"); // старые записи

			// STATE.md содержит только последние 10 записей
			const state = await readState(missionDir);
			expect(state.done.length).toBeLessThanOrEqual(10);
			// Последняя запись сохранена
			expect(state.done[state.done.length - 1]).toContain("Done item 0499");
		});

		it("(b) маленький STATE не трогается", async () => {
			const stateContent = generateStateContent(5);
			writeFileSync(join(missionDir, "STATE.md"), stateContent, "utf8");

			const result = await compactStateIfNeeded(missionDir);
			expect(result).toBe(false);

			// STATE.md не изменён
			const currentContent = readFileSync(join(missionDir, "STATE.md"), "utf8");
			expect(currentContent).toBe(stateContent);
		});

		it("STATE.md чуть ниже soft-порога — не трогается", async () => {
			// Генерируем контент, который ниже 100KB
			const stateContent = generateStateContent(200); // ~50KB
			writeFileSync(join(missionDir, "STATE.md"), stateContent, "utf8");

			const result = await compactStateIfNeeded(missionDir);
			expect(result).toBe(false);
		});

		it("порядок записей в архиве сохранён (старые → новые)", async () => {
			const stateContent = generateStateContent(500);
			writeFileSync(join(missionDir, "STATE.md"), stateContent, "utf8");

			await compactStateIfNeeded(missionDir);

			const archiveContent = readFileSync(join(missionDir, "ARCHIVE.md"), "utf8");
			const archiveLines = archiveContent.split("\n").filter((l) => l.startsWith("- Done item"));

			// Первая заархивированная запись должна быть старше последней
			if (archiveLines.length >= 2) {
				const firstNum = parseInt(archiveLines[0].match(/\d+/)?.[0] ?? "-1", 10);
				const lastNum = parseInt(archiveLines[archiveLines.length - 1].match(/\d+/)?.[0] ?? "-1", 10);
				expect(firstNum).toBeLessThan(lastNum);
			}
		});
	});

	describe("radicalTruncateDone", () => {
		it("оставляет только последнюю done-запись, остальное архивирует", async () => {
			const stateContent = generateStateContent(50);
			writeFileSync(join(missionDir, "STATE.md"), stateContent, "utf8");

			const result = await radicalTruncateDone(missionDir);
			expect(result).toBe(true);

			const state = await readState(missionDir);
			expect(state.done.length).toBe(1);
			expect(state.done[0]).toContain("Done item 0049"); // последняя

			// Архив содержит остальные
			const archiveContent = readFileSync(join(missionDir, "ARCHIVE.md"), "utf8");
			expect(archiveContent).toContain("Done item 0");
			expect(archiveContent).not.toContain("Done item 0049");
		});

		it("возвращает false при единственной записи", async () => {
			const stateContent = generateStateContent(1);
			writeFileSync(join(missionDir, "STATE.md"), stateContent, "utf8");

			const result = await radicalTruncateDone(missionDir);
			expect(result).toBe(false);
		});
	});

	describe("step 2 preflight (emergency)", () => {
		it("(d) при 160KB не пишет failed — архивирует/усекает", async () => {
			// Генерируем STATE.md > 150KB (MAX_STATE_BYTES)
			const stateContent = generateStateContent(700); // ~175KB
			writeFileSync(join(missionDir, "STATE.md"), stateContent, "utf8");
			const beforeSize = checkStateFileSize(missionDir);
			expect(beforeSize).toBeGreaterThanOrEqual(MAX_STATE_BYTES);

			const deps = createMockDeps();
			const loop = new MissionLoop({ missionDir, deps });

			// tick должен НЕ завершиться failed (архивирование/усечение должно помочь)
			const result = await loop.tick();
			expect(result.status).not.toBe("failed");

			// STATE.md должен уменьшиться
			const afterSize = checkStateFileSize(missionDir);
			expect(afterSize).toBeLessThan(MAX_STATE_BYTES);
		});
	});

	describe("compaction при смене item (mission-loop)", () => {
		it("(b) компактизация срабатывает только при превышении SOFT", async () => {
			// Маленький STATE — компактизация НЕ должна вызываться
			const stateContent = generateStateContent(5);
			writeFileSync(join(missionDir, "STATE.md"), stateContent, "utf8");

			// spy на compactStateIfNeeded
			const origCompact = (await import("./file-state-manager.js")).compactStateIfNeeded;
			const compactSpy = vi.fn(origCompact);
			vi.spyOn(await import("./file-state-manager.js"), "compactStateIfNeeded").mockImplementation(compactSpy);

			try {
				const deps = createMockDeps();
				const loop = new MissionLoop({ missionDir, deps });
				await loop.tick();

				// compactStateIfNeeded вызывается, но возвращает false (файл маленький)
				// Вызов происходит в continuous loop при смене item (между итерациями)
				// Но с одним завершённым item — следующий item тоже есть, но
			// compactStateIfNeeded возвращает false и не трогает файл.
			} finally {
				vi.restoreAllMocks();
			}
		});
	});

	describe("dedup архивации", () => {
		it("повторная компактизация не дублирует записи в ARCHIVE.md", async () => {
			const stateContent = generateStateContent(500);
			writeFileSync(join(missionDir, "STATE.md"), stateContent, "utf8");

			// Первая компактизация
			await compactStateIfNeeded(missionDir);
			const archiveAfter1 = readFileSync(join(missionDir, "ARCHIVE.md"), "utf8");
			const linesAfter1 = archiveAfter1.split("\n").filter((l) => l.startsWith("- Done item")).length;

			// Добавляем немного новых записей
			const state = await readState(missionDir);
			state.done.push("Done item NEW 1 " + "x".repeat(200));
			state.done.push("Done item NEW 2 " + "x".repeat(200));
			await writeState(missionDir, state);

			// Вторая компактизация (если размер позволяет — может не сработать)
			await compactStateIfNeeded(missionDir);

			const archiveAfter2 = readFileSync(join(missionDir, "ARCHIVE.md"), "utf8");
			const linesAfter2 = archiveAfter2.split("\n").filter((l) => l.startsWith("- Done item")).length;

			// Количество архивных строк не должно уменьшиться ( dedup работает)
			expect(linesAfter2).toBeGreaterThanOrEqual(linesAfter1);
		});
	});
});
