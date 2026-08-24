// Регрессионный тест: CLI `fan mission` находит file-state-manager в
// deployed-окружении (вне монорепо).
//
// Баг: loadFileStateManager() искал модуль только по FAN_MISSION_DIR и
// монорепо-путям (<root>/extensions/fan-mission). У deployed-бинаря в
// произвольном проекте ни один кандидат не существовал →
// MissionExtensionMissingError("file-state-manager module not found").
//
// Фикс: добавлены runtime discovery paths (как в core/extensions/loader.ts):
//   1) project-local <cwd>/.fan/extensions/fan-mission/
//   2) global      <agentDir>/extensions/fan-mission/  (agentDir = FAN_CODING_AGENT_DIR или ~/.fan/agent)
//
// Stub-модуль возвращает маркер "stub-fsm://<slug>" из initMission — это
// доказывает, что загружен именно stub из deployed-кандидата, а не реальный
// file-state-manager из монорепо (монорепо-пути идут позже по приоритету).
//
// fsmCache кешируется на уровне модуля → каждый тест делает vi.resetModules()
// и динамический import, чтобы получить чистый модуль.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ENV_AGENT_DIR } from "../../src/config.js";

/** Минимальный stub file-state-manager с маркером в initMission. */
const STUB_FSM = `export const MISSION_FILES = ["MISSION.md"];
export function validateSlug(slug) {
	if (!slug || slug.includes("..")) throw new Error("Invalid slug");
}
export async function initMission(slug) {
	return "stub-fsm://" + slug;
}
export async function readMission() {
	return { frontmatter: {}, body: "" };
}
export async function readState() {
	return { done: [], blockers: [], nextSteps: [] };
}
export async function writeMissionStatus() {}
export function canTransition() {
	return true;
}
export class InvalidTransitionError extends Error {}
`;

/** Записывает stub file-state-manager.ts в указанный каталог расширения. */
function writeStub(extensionDir: string): void {
	mkdirSync(extensionDir, { recursive: true });
	writeFileSync(join(extensionDir, "file-state-manager.ts"), STUB_FSM, "utf8");
}

describe("mission-command: file-state-manager discovery в deployed-окружении", () => {
	let tmp: string;
	let prevEnv: string | undefined;
	let prevCwd: string;

	beforeEach(() => {
		vi.resetModules();
		tmp = mkdtempSync(join(tmpdir(), "fan-mission-deployed-"));
		prevEnv = process.env[ENV_AGENT_DIR];
		prevCwd = process.cwd();
	});

	afterEach(() => {
		if (prevEnv === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = prevEnv;
		}
		process.chdir(prevCwd);
		rmSync(tmp, { recursive: true, force: true });
	});

	it("global: <agentDir>/extensions/fan-mission загружается вне монорепо", async () => {
		// Deployed-раскладка: agentDir с расширением, cwd — произвольный проект
		// без .fan/ и без extensions/fan-mission.
		const agentDir = join(tmp, "agent");
		writeStub(join(agentDir, "extensions", "fan-mission"));
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(tmp);

		const { missionInit } = await import("../../src/cli/mission-command.js");
		const result = await missionInit("test-mission", { baseDir: join(tmp, "missions") });

		// Маркер stub-модуля: загружен именно deployed-кандидат,
		// MissionExtensionMissingError НЕ брошена.
		expect(result).toBe("stub-fsm://test-mission");
	});

	it("project-local: <cwd>/.fan/extensions/fan-mission загружается", async () => {
		// project-local кандидат; agentDir пустой (монорепо-пути идут позже).
		writeStub(join(tmp, ".fan", "extensions", "fan-mission"));
		process.env[ENV_AGENT_DIR] = join(tmp, "empty-agent");
		process.chdir(tmp);

		const { missionInit } = await import("../../src/cli/mission-command.js");
		const result = await missionInit("test-mission", { baseDir: join(tmp, "missions") });

		expect(result).toBe("stub-fsm://test-mission");
	});
});
