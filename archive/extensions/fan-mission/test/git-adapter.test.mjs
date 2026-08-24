// git-adapter — Red-фаза (TDD)
//
// Карточка: git-adapter — реальная shell-обёртка над child_process.exec,
// реализующая интерфейс MissionGit (см. ../mission-loop.ts) для продакшн-сборки
// миссионного контура (вместо in-memory mock'а из mock-mission-env.mjs).
//
// Все тесты ожидают модуль `extensions/fan-mission/git-adapter.ts`,
// компилируемый/резолвящийся в `git-adapter.js`. На момент Red-фазы модуль
// не существует — динамический import в beforeAll выбрасывает
// ERR_MODULE_NOT_FOUND, try/catch глушит его, символ остаётся undefined, и
// каждый `it` падает ИНДИВИДУАЛЬНО на вызове undefined (правильный TDD Red:
// тесты запускаются и падают, а не «файл не загрузился»). После реализации
// модуля по контракту ниже тесты должны проходить.
//
// ─── Точный интерфейс MissionGit (из mission-loop.ts) ───────────────────────
//
//   export interface MissionGit {
//     commit(opts: { cwd: string; message: string; files: string[] }): Promise<{ hash: string }>;
//     log(opts: { cwd: string; maxCount?: number }): Promise<Array<{ hash: string; subject: string; date: string }>>;
//     status(opts: { cwd: string }): Promise<{ clean: boolean }>;
//   }
//
// ─── Контракт createGitAdapter (для Green-фазы) ──────────────────────────────
//
//   createGitAdapter(opts?: {
//     exec?: (command: string, options: { cwd: string })
//       => Promise<{ stdout: string; stderr: string; exitCode: number }>,
//   }): MissionGit
//
// DI `exec` для тестируемости; дефолт — реальный child_process.exec (на проде).
// Методы реализуют MissionGit (см. точный интерфейс выше). Ожидаемое поведение:
//
//   commit:
//     - выполняет `git add <files>` + `git commit -m "<message>"` (2 вызова exec);
//     - hash извлекается из stdout команды `git commit` (стандартный вывод git:
//       "[<branch> <short-hash>] <subject>\n<stats...>") → { hash: "<short-hash>" };
//     - при exitCode != 0 ЛЮБОЙ из двух команд бросает Error, message содержит
//       stderr провалившейся команды.
//
//   log:
//     - выполняет `git log` (pretty-формат, oneline-подобный: одна запись на
//       строку, поля разделены `|`: "<hash>|<subject>|<date>");
//     - парсит stdout в Array<{ hash, subject, date }> (пустые строки/хвост
//       без завершающего перевода строки корректно обрабатываются);
//     - при exitCode != 0 возвращает [] (НЕ бросает).
//
//   status:
//     - выполняет `git status --porcelain`;
//     - пустой stdout (exitCode 0) → { clean: true };
//     - непустой stdout → { clean: false };
//     - при exitCode != 0 возвращает { clean: false } (НЕ бросает, без краха).
//
// Все тесты используют injected mock exec — реальный git НЕ запускается.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ────────────────────────────────────────────────────────────────────────────
// Импорт SUT. На Red-фазе модуля нет — dynamic import выбрасывает, try/catch
// глушит, символ остаётся undefined. Файл теста при этом ЗАГРУЖАЕТСЯ, все
// it-блоки собираются и падают ИНДИВИДУАЛЬНО. На Green-фазе модуль появится —
// import подтянет символ, тесты пройдут.
// ────────────────────────────────────────────────────────────────────────────

let createGitAdapter;

beforeAll(async () => {
	try {
		({ createGitAdapter } = await import("../git-adapter.js"));
	} catch {
		// Red: git-adapter.ts ещё не реализован.
	}
});

// ────────────────────────────────────────────────────────────────────────────
// Хелперы: mock exec (DI) с записью вызовов, временный missionDir
// ────────────────────────────────────────────────────────────────────────────

/**
 * Создаёт mock exec (DI) с записью вызовов (calls).
 *
 * handler — функция (command, options) => { stdout, stderr, exitCode }
 *   (динамическое ветвление по команде) либо готовый объект-результат
 *   (возвращается для всех вызовов). Реальный git НЕ запускается — exec
 *   чисто детерминированная заглушка.
 *
 * Возвращаемая функция имеет поле .calls[] = [{ command, cwd }] для assertions.
 */
function makeExec(handler) {
	const calls = [];
	const fn = async (command, options) => {
		calls.push({ command, cwd: options.cwd });
		return typeof handler === "function" ? handler(command, options) : handler;
	};
	fn.calls = calls;
	return fn;
}

/** Успешный результат exec по умолчанию (exitCode 0, пустой вывод). */
const OK = { stdout: "", stderr: "", exitCode: 0 };

/** Найти первый вызов exec, чья команда содержит substr. */
function findCall(calls, substr) {
	return calls.find((c) => c.command.includes(substr));
}

// Временный missionDir для каждого теста. Реальные команды НЕ запускаются
// (exec замокан), но настоящий каталог передаётся как cwd и страхует от impl,
// который может stat()'нуть директорию.

let missionDir;

beforeEach(() => {
	missionDir = mkdtempSync(join(tmpdir(), "fan-ga-red-"));
});

afterEach(() => {
	rmSync(missionDir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────────
// TC-GA-1: commit — вызывает exec с правильными командами (git add, git commit -m) и cwd
// ────────────────────────────────────────────────────────────────────────────

describe("GA / TC-GA-1: commit — команды git add + git commit -m, файлы и cwd", () => {
	it("exec вызывается с `git add <files>` и `git commit -m \"<message>\"`; cwd передан", async () => {
		const exec = makeExec((command) => {
			if (command.includes("commit")) {
				return { stdout: "[main abc1234] mission: item a", stderr: "", exitCode: 0 };
			}
			return OK;
		});
		const git = createGitAdapter({ exec });

		await git.commit({
			cwd: missionDir,
			message: "mission: item a",
			files: ["STATE.md", "ROADMAP.md"],
		});

		// Минимум 2 вызова: git add + git commit.
		expect(exec.calls.length).toBeGreaterThanOrEqual(2);

		// git add <files>: команда содержит "git add" и имена файлов.
		const addCall = findCall(exec.calls, "git add");
		expect(addCall).toBeDefined();
		expect(addCall.command).toContain("STATE.md");
		expect(addCall.command).toContain("ROADMAP.md");
		expect(addCall.cwd).toBe(missionDir);

		// git commit -m "<message>": команда содержит "git commit" и текст message.
		const commitCall = findCall(exec.calls, "git commit");
		expect(commitCall).toBeDefined();
		expect(commitCall.command).toContain("mission: item a");
		expect(commitCall.cwd).toBe(missionDir);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-GA-2: commit — возвращает hash из stdout mock'а
// ────────────────────────────────────────────────────────────────────────────

describe("GA / TC-GA-2: commit — возвращает { hash } из stdout команды git commit", () => {
	it("stdout '[main abc1234] ...' → result.hash === 'abc1234'", async () => {
		const exec = makeExec((command) => {
			if (command.includes("commit")) {
				return {
					stdout: "[main abc1234] mission: item a\n 1 file changed, 2 insertions(+)",
					stderr: "",
					exitCode: 0,
				};
			}
			return OK;
		});
		const git = createGitAdapter({ exec });

		const result = await git.commit({
			cwd: missionDir,
			message: "mission: item a",
			files: ["STATE.md"],
		});

		expect(result).toEqual({ hash: "abc1234" });
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-GA-3: commit — бросает Error при exitCode != 0 (message содержит stderr)
// ────────────────────────────────────────────────────────────────────────────

describe("GA / TC-GA-3: commit — exitCode != 0 → бросает Error с stderr", () => {
	it("git commit exitCode 1 → rejects с Error, message содержит stderr", async () => {
		const exec = makeExec((command) => {
			if (command.includes("commit")) {
				return {
					stdout: "",
					stderr: "error: pathspec 'STATE.md' did not match any files",
					exitCode: 1,
				};
			}
			return OK;
		});
		const git = createGitAdapter({ exec });

		await expect(
			git.commit({ cwd: missionDir, message: "mission: item a", files: ["STATE.md"] }),
		).rejects.toThrow(/pathspec/);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-GA-4: log — вызывает git log с cwd, парсит stdout в массив
// ────────────────────────────────────────────────────────────────────────────

describe("GA / TC-GA-4: log — команда git log + cwd, парсинг stdout в массив", () => {
	it("stdout '<hash>|<subject>|<date>' (2 строки) → массив из 2 элементов", async () => {
		const logStdout =
			"abc1234|mission: item a|2026-08-13T10:00:00Z\n" +
			"def5678|mission: item b|2026-08-13T11:00:00Z";
		const exec = makeExec((command) => {
			if (command.includes("log")) {
				return { stdout: logStdout, stderr: "", exitCode: 0 };
			}
			return OK;
		});
		const git = createGitAdapter({ exec });

		const result = await git.log({ cwd: missionDir, maxCount: 10 });

		// Команда содержит "git log"; maxCount (10) доходит до команды; cwd передан.
		const logCall = findCall(exec.calls, "git log");
		expect(logCall).toBeDefined();
		expect(logCall.command).toContain("10");
		expect(logCall.cwd).toBe(missionDir);

		// Парсинг stdout → структурированный массив.
		expect(result).toEqual([
			{ hash: "abc1234", subject: "mission: item a", date: "2026-08-13T10:00:00Z" },
			{ hash: "def5678", subject: "mission: item b", date: "2026-08-13T11:00:00Z" },
		]);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-GA-5: log — exitCode != 0 → [] (не бросает)
// ────────────────────────────────────────────────────────────────────────────

describe("GA / TC-GA-5: log — exitCode != 0 → пустой массив (не бросает)", () => {
	it("git log exitCode 128 → resolves в []", async () => {
		const exec = makeExec(() => ({
			stdout: "",
			stderr: "fatal: not a git repository",
			exitCode: 128,
		}));
		const git = createGitAdapter({ exec });

		const result = await git.log({ cwd: missionDir });

		expect(result).toEqual([]);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-GA-6: status — git status --porcelain, чистый вывод (пустой stdout) → clean=true
// ────────────────────────────────────────────────────────────────────────────

describe("GA / TC-GA-6: status — пустой stdout → clean=true", () => {
	it("git status --porcelain exitCode 0, stdout='' → { clean: true }", async () => {
		const exec = makeExec(() => OK);
		const git = createGitAdapter({ exec });

		const result = await git.status({ cwd: missionDir });

		// Команда содержит "git status" и "--porcelain"; cwd передан.
		const statusCall = findCall(exec.calls, "git status");
		expect(statusCall).toBeDefined();
		expect(statusCall.command).toContain("--porcelain");
		expect(statusCall.cwd).toBe(missionDir);

		expect(result).toEqual({ clean: true });
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-GA-7: status — непустой stdout → clean=false
// ────────────────────────────────────────────────────────────────────────────

describe("GA / TC-GA-7: status — непустой stdout → clean=false", () => {
	it("git status stdout=' M file.ts\\n?? other.ts' → { clean: false }", async () => {
		const exec = makeExec(() => ({
			stdout: " M file.ts\n?? other.ts",
			stderr: "",
			exitCode: 0,
		}));
		const git = createGitAdapter({ exec });

		const result = await git.status({ cwd: missionDir });

		expect(result).toEqual({ clean: false });
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-GA-8: status — exitCode != 0 → clean=false (не бросает)
// ────────────────────────────────────────────────────────────────────────────

describe("GA / TC-GA-8: status — exitCode != 0 → clean=false (не бросает)", () => {
	it("git status exitCode 128 → resolves в { clean: false }", async () => {
		const exec = makeExec(() => ({
			stdout: "",
			stderr: "fatal: not a git repository",
			exitCode: 128,
		}));
		const git = createGitAdapter({ exec });

		const result = await git.status({ cwd: missionDir });

		expect(result).toEqual({ clean: false });
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-GA-9: DI — дефолтный exec и инъекция spy-exec
// ────────────────────────────────────────────────────────────────────────────

describe("GA / TC-GA-9: DI exec — дефолт и инъекция spy", () => {
	it("createGitAdapter() без opts возвращает MissionGit с методами commit/log/status", () => {
		// Без opts.exec используется реальный child_process.exec (не undefined):
		// конструктор не падает и возвращает полный интерфейс MissionGit.
		const git = createGitAdapter();

		expect(typeof git.commit).toBe("function");
		expect(typeof git.log).toBe("function");
		expect(typeof git.status).toBe("function");
	});

	it("переданный opts.exec (spy) используется при вызове методов", async () => {
		const exec = makeExec(() => OK);
		const git = createGitAdapter({ exec });

		await git.status({ cwd: missionDir });

		expect(exec.calls.length).toBe(1);
		expect(exec.calls[0].cwd).toBe(missionDir);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-GA-10: экранирование кавычек в commit message
// ────────────────────────────────────────────────────────────────────────────

describe("GA / TC-GA-10: экранирование кавычек в commit message (\" и ')", () => {
	it("message с двойными и одинарными кавычками не ломает команду и доходит до exec", async () => {
		const message = `fix: handle "quoted" and 'apos' case`;
		const exec = makeExec((command) => {
			if (command.includes("commit")) {
				return { stdout: "[main f00d123] fix: handle quoted", stderr: "", exitCode: 0 };
			}
			return OK;
		});
		const git = createGitAdapter({ exec });

		// Не бросает — команда собирается корректно даже с кавычками в message.
		const result = await git.commit({ cwd: missionDir, message, files: ["STATE.md"] });

		expect(result).toEqual({ hash: "f00d123" });

		// Содержимое message (слова без самих кавычек) дошло до команды git commit —
		// экранирование не разрушило текст.
		const commitCall = findCall(exec.calls, "git commit");
		expect(commitCall).toBeDefined();
		expect(commitCall.command).toContain("handle");
		expect(commitCall.command).toContain("quoted");
		expect(commitCall.command).toContain("apos");
		expect(commitCall.command).toContain("case");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-GA-11: cwd передаётся во все exec-вызовы (commit + log + status)
// ────────────────────────────────────────────────────────────────────────────

describe("GA / TC-GA-11: cwd передаётся во все exec-вызовы", () => {
	it("commit (add+commit), log, status — каждый вызов exec получает opts.cwd === missionDir", async () => {
		const exec = makeExec((command) => {
			if (command.includes("commit")) {
				return { stdout: "[main abc1234] msg", stderr: "", exitCode: 0 };
			}
			if (command.includes("log")) {
				return { stdout: "abc1234|subject|2026-08-13T10:00:00Z", stderr: "", exitCode: 0 };
			}
			return OK;
		});
		const git = createGitAdapter({ exec });

		await git.commit({ cwd: missionDir, message: "msg", files: ["STATE.md"] });
		await git.log({ cwd: missionDir });
		await git.status({ cwd: missionDir });

		// add + commit + log + status = минимум 4 вызова.
		expect(exec.calls.length).toBeGreaterThanOrEqual(4);
		for (const call of exec.calls) {
			expect(call.cwd).toBe(missionDir);
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-GA-12: parseCommitHash — root-commit format `[master (root-commit) <hash>]`
// ────────────────────────────────────────────────────────────────────────────

describe("GA / TC-GA-12: parseCommitHash — root-commit hash parsing", () => {
	it("stdout '[master (root-commit) fd8ccb4] Initial commit' → hash 'fd8ccb4'", async () => {
		const exec = makeExec((command) => {
			if (command.includes("commit")) {
				return {
					stdout: "[master (root-commit) fd8ccb4] Initial commit",
					stderr: "",
					exitCode: 0,
				};
			}
			return OK;
		});
		const git = createGitAdapter({ exec });

		const result = await git.commit({
			cwd: missionDir,
			message: "Initial commit",
			files: ["STATE.md"],
		});

		expect(result).toEqual({ hash: "fd8ccb4" });
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-GA-13: shell injection — $(), backticks, ! in commit message
// ────────────────────────────────────────────────────────────────────────────

describe("GA / TC-GA-13: shell injection — metacharacters escaped in commit message", () => {
	it("$(cmd) in message is escaped — no command substitution in exec call", async () => {
		const message = "$(touch /tmp/pwned)";
		const exec = makeExec((command) => {
			if (command.includes("commit")) {
				return { stdout: "[main abc1234] msg", stderr: "", exitCode: 0 };
			}
			return OK;
		});
		const git = createGitAdapter({ exec });

		await git.commit({ cwd: missionDir, message, files: ["STATE.md"] });

		const commitCall = findCall(exec.calls, "git commit");
		expect(commitCall).toBeDefined();
		// $ must be escaped: command contains backslash-dollar-touch sequence.
		expect(commitCall.command).toContain("\\$(touch");
		// Raw $ without preceding backslash must not start the injection.
		// (The only $ in the command is the escaped one.)
		const dollarIdx = commitCall.command.indexOf("$(touch");
		expect(dollarIdx > 0 && commitCall.command[dollarIdx - 1] === "\\").toBe(true);
	});

	it("backtick-cmd-backtick in message is escaped — no command substitution", async () => {
		// message contains literal backticks around `touch /tmp/pwned`
		const message = "`touch /tmp/pwned`";
		const exec = makeExec((command) => {
			if (command.includes("commit")) {
				return { stdout: "[main abc1234] msg", stderr: "", exitCode: 0 };
			}
			return OK;
		});
		const git = createGitAdapter({ exec });

		await git.commit({ cwd: missionDir, message, files: ["STATE.md"] });

		const commitCall = findCall(exec.calls, "git commit");
		expect(commitCall).toBeDefined();
		// Backtick before 'touch' must be escaped with a preceding backslash.
		const btIdx = commitCall.command.indexOf("`touch");
		expect(btIdx > 0 && commitCall.command[btIdx - 1] === "\\").toBe(true);
	});

	it("!(cmd) in message passes through without backslash (POSIX: ! is not DQ-special)", async () => {
		const message = "!(echo pwned)";
		const exec = makeExec((command) => {
			if (command.includes("commit")) {
				return { stdout: "[main abc1234] msg", stderr: "", exitCode: 0 };
			}
			return OK;
		});
		const git = createGitAdapter({ exec });

		await git.commit({ cwd: missionDir, message, files: ["STATE.md"] });

		const commitCall = findCall(exec.calls, "git commit");
		expect(commitCall).toBeDefined();
		// ! is NOT escaped (POSIX: backslash before ! inside DQ is literal,
		// and bash history expansion is off in non-interactive shells).
		// The message !(echo must appear without a preceding backslash.
		expect(commitCall.command).toContain("!(echo");
		const bangIdx = commitCall.command.indexOf("!(echo");
		expect(bangIdx === 0 || commitCall.command[bangIdx - 1] !== "\\").toBe(true);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TC-GA-14: regression — normal commit hash still parses after regex change
// ────────────────────────────────────────────────────────────────────────────

describe("GA / TC-GA-14: regression — normal [branch hash] still parses", () => {
	it("stdout '[main abc1234] regular commit' → hash 'abc1234' (not broken by root-commit fix)", async () => {
		const exec = makeExec((command) => {
			if (command.includes("commit")) {
				return {
					stdout: "[main abc1234] regular commit\n 1 file changed, 1 insertion(+)",
					stderr: "",
					exitCode: 0,
				};
			}
			return OK;
		});
		const git = createGitAdapter({ exec });

		const result = await git.commit({
			cwd: missionDir,
			message: "regular commit",
			files: ["STATE.md"],
		});

		expect(result).toEqual({ hash: "abc1234" });
	});
});
