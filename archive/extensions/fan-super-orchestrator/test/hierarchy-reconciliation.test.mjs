// F-35 / TC-F35-3: startup-reconciliation после crash (реальные PID).
//
// Карточка: docs/features/super-orchestrator/http-hierarchy-2/roadmap.md §F-35
// Спека: docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.3.6
//
// Интеграционный слой: БЕЗ DI-моков processKill — реальный process.kill
// против реальных PID:
//   • мёртвый PID 99999999 → cleaned_dead (порт/запись/PID-файл удалены);
//   • живой orphan (реальный node-процесс, isOwnChild false) → SIGTERM →
//     killed_orphan + orphan_cleanup в tree-journal;
//   • own-child (process.pid, DI isOwnChild) → skipped_own_child: запись
//     и PID-файл не тронуты.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconcile } from "../startup-reconciliation.js";
import { createTreeJournal } from "../tree-journal.js";

// ─── Хелперы ────────────────────────────────────────────────────────────────

const cleanups = [];

afterEach(async () => {
	for (const fn of cleanups.splice(0)) {
		await fn();
	}
});

/** Tempdir + регистрация cleanup. */
function makeTmpDir() {
	const tmp = mkdtempSync(join(tmpdir(), "fan-so-f35-recon-"));
	cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
	return tmp;
}

/** Путь PID-файла: санитизация "/"→"-" как в process-manager. */
function pidFileFor(pidDir, nodeId) {
	return join(pidDir, `child-${nodeId.split("/").join("-")}.pid`);
}

/** PID реально жив (probe signal 0 не бросает). */
function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Запустить реальный живой node-процесс («чужой» по DI isOwnChild). */
async function spawnOrphanProcess() {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	cleanups.push(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			// Уже мёртв — не критично.
		}
	});
	await new Promise((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", reject);
	});
	expect(child.pid).toBeGreaterThan(0);
	return child;
}

// ─── TC-F35-3 ───────────────────────────────────────────────────────────────

describe("TC-F35-3: reconcile() после crash — мёртвый/orphan/own PID", () => {
	it(
		"мёртвый PID → cleaned_dead; живой orphan → killed_orphan + orphan_cleanup в журнале; own не тронут",
		async () => {
			const tmp = makeTmpDir();
			const portsFile = join(tmp, "child-ports.json");
			const pidDir = join(tmp, "pids");
			mkdirSync(pidDir, { recursive: true });
			const journal = createTreeJournal(join(tmp, "tree-journal.jsonl"));

			// Orphan: реальный живой процесс, который reconcile должен убить.
			const orphan = await spawnOrphanProcess();
			const orphanPid = orphan.pid;
			expect(isAlive(orphanPid)).toBe(true);

			// portsFile с 3 записями + PID-файлы.
			writeFileSync(
				portsFile,
				JSON.stringify({ "L1/node-dead": 7041, "L1/node-orphan": 7042, "L1/node-own": 7043 }, null, 2),
				"utf8",
			);
			writeFileSync(pidFileFor(pidDir, "L1/node-dead"), "99999999", "utf8");
			writeFileSync(pidFileFor(pidDir, "L1/node-orphan"), String(orphanPid), "utf8");
			writeFileSync(pidFileFor(pidDir, "L1/node-own"), String(process.pid), "utf8");

			const result = await reconcile({
				portsFile,
				pidDir,
				journal,
				isOwnChild: (pid) => pid === process.pid,
				killGraceMs: 3000,
			});

			// Действия по записям.
			const byId = Object.fromEntries(result.entries.map((entry) => [entry.nodeId, entry]));
			expect(byId["L1/node-dead"].action).toBe("cleaned_dead");
			expect(byId["L1/node-dead"].pid).toBe(99_999_999);
			expect(byId["L1/node-orphan"].action).toBe("killed_orphan");
			expect(byId["L1/node-orphan"].pid).toBe(orphanPid);
			expect(byId["L1/node-own"].action).toBe("skipped_own_child");
			expect(byId["L1/node-own"].pid).toBe(process.pid);

			// Мёртвый очищен: запись и PID-файл удалены, порт освобождён.
			expect(existsSync(pidFileFor(pidDir, "L1/node-dead"))).toBe(false);
			expect(existsSync(pidFileFor(pidDir, "L1/node-orphan"))).toBe(false);

			// Own не тронут: запись осталась в portsFile, PID-файл на месте,
			// процесс жив (мы сами).
			expect(JSON.parse(readFileSync(portsFile, "utf8"))).toEqual({ "L1/node-own": 7043 });
			expect(existsSync(pidFileFor(pidDir, "L1/node-own"))).toBe(true);
			expect(isAlive(process.pid)).toBe(true);

			// Orphan-процесс реально завершён (SIGTERM дошёл).
			expect(isAlive(orphanPid)).toBe(false);

			// orphan_cleanup в журнале с атрибуцией {nodeId, pid, port}.
			const orphanCleanups = journal.readAll().filter((entry) => entry.event === "orphan_cleanup");
			expect(orphanCleanups).toHaveLength(1);
			expect(orphanCleanups[0].nodeId).toBe("L1/node-orphan");
			expect(orphanCleanups[0].pid).toBe(orphanPid);
			expect(orphanCleanups[0].port).toBe(7042);
		},
		30_000,
	);

	it("строгий вариант TC (dead + own, без orphan): orphan_cleanup в журнале НЕ пишется", async () => {
		// Пин поведения модуля: orphan_cleanup журналируется только для
		// живых orphan-процессов (killed_orphan); cleaned_dead журналируется
		// НЕ (см. заголовок startup-reconciliation.ts).
		const tmp = makeTmpDir();
		const portsFile = join(tmp, "child-ports.json");
		const pidDir = join(tmp, "pids");
		mkdirSync(pidDir, { recursive: true });
		const journal = createTreeJournal(join(tmp, "tree-journal.jsonl"));

		writeFileSync(portsFile, JSON.stringify({ "L1/node-dead": 7041, "L1/node-own": 7043 }, null, 2), "utf8");
		writeFileSync(pidFileFor(pidDir, "L1/node-dead"), "99999999", "utf8");
		writeFileSync(pidFileFor(pidDir, "L1/node-own"), String(process.pid), "utf8");

		const result = await reconcile({
			portsFile,
			pidDir,
			journal,
			isOwnChild: (pid) => pid === process.pid,
		});

		expect(result.entries).toHaveLength(2);
		expect(result.entries.map((e) => e.action).sort()).toEqual(["cleaned_dead", "skipped_own_child"]);
		expect(JSON.parse(readFileSync(portsFile, "utf8"))).toEqual({ "L1/node-own": 7043 });
		expect(existsSync(pidFileFor(pidDir, "L1/node-dead"))).toBe(false);
		// orphan_cleanup для cleaned_dead НЕ пишется — журнал пуст.
		expect(journal.readAll().filter((entry) => entry.event === "orphan_cleanup")).toHaveLength(0);
	});
});
