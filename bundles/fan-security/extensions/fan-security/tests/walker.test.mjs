/**
 * Unit-тесты lib/walker.ts — лимиты обхода (patch 1.0.1, F-5).
 *
 * Контракт (шапка lib/walker.ts):
 * - константы MAX_FILES = 50_000, MAX_DEPTH = 32;
 * - walkDirectory(dir, {maxFiles?, maxDepth?}) — опции инъекции для тестов
 *   (прод-дефолты — константы);
 * - превышение maxFiles → предупреждение в stderr + остановка обхода
 *   (частичный результат, без падения);
 * - превышение maxDepth → ветки глубже не обходятся (предупреждение в stderr);
 * - флаг усечения в отчёт НЕ добавляется (решение patch 1.0.1) — сигнал
 *   только через stderr;
 * - обычные деревья (в пределах лимитов) обходятся как раньше — без
 *   предупреждений и потерь.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WALKER_URL = "../lib/walker.ts";

const testsDir = path.dirname(fileURLToPath(import.meta.url));

/** Временные директории (auto-cleanup в afterEach). */
const tempDirs = [];
function makeTempDir() {
	const dir = mkdtempSync(path.join(tmpdir(), "fan-walker-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Перехват stderr walker (console.error) с авто-restore. */
function captureStderr() {
	const err = [];
	const errSpy = vi.spyOn(console, "error").mockImplementation((...args) => err.push(args.join(" ")));
	return { err, stderr: () => err.join("\n"), restore: () => errSpy.mockRestore() };
}

describe("F-5 (patch 1.0.1): лимиты walker", () => {
	it("константы: MAX_FILES=50_000, MAX_DEPTH=32", async () => {
		const walker = await import(WALKER_URL);
		expect(walker.MAX_FILES).toBe(50_000);
		expect(walker.MAX_DEPTH).toBe(32);
	});

	it("maxFiles-инъекция: 30 файлов, лимит 10 → ровно 10 файлов, предупреждение в stderr, без падения", async () => {
		const { walkDirectory } = await import(WALKER_URL);
		const dir = makeTempDir();
		for (let i = 0; i < 30; i++) {
			writeFileSync(path.join(dir, `file-${String(i).padStart(2, "0")}.txt`), "x", "utf8");
		}

		const captured = captureStderr();
		const files = walkDirectory(dir, { maxFiles: 10 });
		captured.restore();

		expect(files.length, "обход остановлен на лимите — частичный результат").toBe(10);
		expect(captured.stderr(), "предупреждение о лимите — в stderr").toMatch(/лимит.*10.*файлов|частичный/u);
	});

	it("maxDepth-инъекция: вложенность 40, лимит 5 → глубокие файлы не обходятся, предупреждение, без падения", async () => {
		const { walkDirectory } = await import(WALKER_URL);
		const dir = makeTempDir();
		let deep = dir;
		for (let i = 0; i < 40; i++) {
			deep = path.join(deep, "n");
			mkdirSync(deep);
		}
		writeFileSync(path.join(deep, "deep.txt"), "x", "utf8");
		writeFileSync(path.join(dir, "shallow.txt"), "x", "utf8");

		const captured = captureStderr();
		const files = walkDirectory(dir, { maxDepth: 5 });
		captured.restore();

		expect(files.some((f) => f.endsWith("shallow.txt")), "мелкие файлы обходятся как обычно").toBe(true);
		expect(files.some((f) => f.endsWith("deep.txt")), "ветка глубже лимита не обходится").toBe(false);
		expect(captured.stderr(), "предупреждение о глубине — в stderr").toMatch(/глубин|частичный/u);
	});

	it("дефолты: обычное малое дерево обходится целиком, без предупреждений (лимиты 50 000/32 не мешают)", async () => {
		const { walkDirectory } = await import(WALKER_URL);
		const dir = makeTempDir();
		mkdirSync(path.join(dir, "sub"));
		writeFileSync(path.join(dir, "a.ts"), "x", "utf8");
		writeFileSync(path.join(dir, "sub", "b.ts"), "x", "utf8");

		const captured = captureStderr();
		const files = walkDirectory(dir);
		captured.restore();

		expect(files.length).toBe(2);
		expect(captured.stderr()).toBe("");
	});

	it("maxFiles-инъекция покрывает вложенные директории: лимит суммарный по дереву", async () => {
		const { walkDirectory } = await import(WALKER_URL);
		const dir = makeTempDir();
		mkdirSync(path.join(dir, "sub1"));
		mkdirSync(path.join(dir, "sub2"));
		for (let i = 0; i < 5; i++) {
			writeFileSync(path.join(dir, `root-${i}.txt`), "x", "utf8");
			writeFileSync(path.join(dir, "sub1", `s1-${i}.txt`), "x", "utf8");
			writeFileSync(path.join(dir, "sub2", `s2-${i}.txt`), "x", "utf8");
		}

		const captured = captureStderr();
		const files = walkDirectory(dir, { maxFiles: 7 });
		captured.restore();

		expect(files.length).toBe(7);
		expect(captured.stderr()).toMatch(/лимит/u);
	});
});
