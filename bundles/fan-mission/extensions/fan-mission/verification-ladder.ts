// F-18: Лестница верификации — последовательный прогон ступеней верификации.
//
// Карточка: docs/features/super-orchestrator/mission-validation-1/roadmap.md §F-18
// Спека:    docs/specs/spec_super-orchestrator_v3_2026-08-10.md §3.1.3 (шаг 4
//           «Верификация»). Ступени выполняются последовательно; провал
//           required-ступени останавливает лестницу, required:false — нет.
//
// DI: runCommand подменяется в тестах (mock), реальный spawn — только дефолт.

import { exec, spawn } from "node:child_process";
import { DEFAULT_STEPS, type VerificationStep } from "./verification-config.js";

// ─── Типы ───────────────────────────────────────────────────────────────────

/** Ступень лестницы; timeoutMs может отсутствовать — применится дефолтный. */
export type LadderStep = Omit<VerificationStep, "timeoutMs"> & { timeoutMs?: number };

export interface RunCommandResult {
	exitCode: number;
	output: string;
}

export type RunCommand = (command: string, opts: { cwd: string; timeoutMs: number }) => Promise<RunCommandResult>;

export interface VerificationLadderResult {
	passed: boolean;
	failedStep: string | null;
	diagnosis: string | null;
}

export interface CreateVerificationLadderOptions {
	steps?: LadderStep[];
	runCommand?: RunCommand;
	defaultTimeoutMs?: number;
}

export interface VerificationLadder {
	run(missionDir: string): Promise<VerificationLadderResult>;
}

// ─── Константы ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 300_000;
const DIAGNOSIS_TAIL_CHARS = 2_000; // хвост output для diagnosis (суть ошибки — в конце)

// ─── Дефолтный runCommand: реальный spawn с таймаутом ───────────────────────

function defaultRunCommand(command: string, opts: { cwd: string; timeoutMs: number }): Promise<RunCommandResult> {
	return new Promise((resolve, reject) => {
		const isWindows = process.platform === "win32";
		const child = spawn(command, {
			cwd: opts.cwd,
			shell: true,
			detached: !isWindows,
			windowsHide: true,
		});
		let output = "";
		let timedOut = false;
		let settled = false;

		child.stdout.on("data", (chunk) => {
			output += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			output += String(chunk);
		});

		// Ручной таймаут: spawn() не поддерживает опцию timeout (только exec/execFile).
		const timer = setTimeout(() => {
			timedOut = true;
			killProcessTree(child.pid, isWindows);
			if (!settled) {
				settled = true;
				reject(new Error(`timeout after ${opts.timeoutMs}ms: ${command}`));
			}
		}, opts.timeoutMs);

		child.on("error", (error) => {
			clearTimeout(timer);
			if (!settled) {
				settled = true;
				reject(error);
			}
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			if (!settled) {
				settled = true;
				if (timedOut) {
					reject(new Error(`timeout after ${opts.timeoutMs}ms: ${command}`));
				} else {
					resolve({ exitCode: code ?? 1, output });
				}
			}
		});
	});
}

/** Убийство дерева процессов: Windows — taskkill /T, POSIX — process group, fallback — child.kill. */
function killProcessTree(pid: number | undefined, isWindows: boolean): void {
	if (pid === undefined) return;
	try {
		if (isWindows) {
			exec(`taskkill /pid ${pid} /T /F`);
		} else {
			process.kill(-pid, "SIGKILL");
		}
	} catch {
		// Fallback: если tree kill не удался — хотя бы убить shell.
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Процесс уже мёртв — игнорируем.
		}
	}
}

// ─── Хелперы ────────────────────────────────────────────────────────────────

function tailOutput(output: string): string {
	if (output.length <= DIAGNOSIS_TAIL_CHARS) return output;
	return `...${output.slice(-DIAGNOSIS_TAIL_CHARS)}`;
}

// ─── Фабрика ────────────────────────────────────────────────────────────────

export function createVerificationLadder(opts: CreateVerificationLadderOptions = {}): VerificationLadder {
	const steps = opts.steps ?? DEFAULT_STEPS;
	const runCommand = opts.runCommand ?? defaultRunCommand;
	const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

	return {
		async run(missionDir: string): Promise<VerificationLadderResult> {
			for (const step of steps) {
				const timeoutMs = step.timeoutMs ?? defaultTimeoutMs;

				let result: RunCommandResult;
				try {
					result = await runCommand(step.command, { cwd: missionDir, timeoutMs });
				} catch (error) {
					// Timeout или неожиданная ошибка runCommand → диагностика (не crash).
					const message = error instanceof Error ? error.message : String(error);
					if (step.required) {
						return { passed: false, failedStep: step.name, diagnosis: `${step.name}: ${message}` };
					}
					// required:false — лог-маркер, лестница продолжается.
					continue;
				}

				if (result.exitCode !== 0) {
					const diagnosis = `${step.name}: ${tailOutput(result.output ?? "")}`;
					if (step.required) {
						return { passed: false, failedStep: step.name, diagnosis };
					}
					// required:false — лог-маркер, лестница продолжается.
				}
			}
			return { passed: true, failedStep: null, diagnosis: null };
		},
	};
}
