/**
 * F-46 regression: per-iteration budget is OPT-IN in the SDK defaults.
 *
 * Bug: createAgentSession applied roadmap defaults (100k tokens / $5.00 per
 * iteration) when settings.json had no `budget.iterationTokenLimit` /
 * `budget.iterationCostLimit`. In long interactive sessions a single turn can
 * legitimately exceed 100k totalTokens (large context) → the AgentSession
 * turn_end hook fired _onIterationBudgetExceeded → agent.abort() → the run
 * stopped after the FIRST tool call.
 *
 * Fix: when the user has NOT configured iteration limits, the SDK wires 0
 * (unlimited) — the model context window is the effective budget. The mission
 * loop opts in explicitly via settings.json.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { Settings } from "../src/core/settings-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { fauxModel } from "./test-harness.js";
import { createTestResourceLoader } from "./utilities.js";

const tempDirs: string[] = [];

async function createSdkSession(settings?: Settings): Promise<AgentSession> {
	const tempDir = join(tmpdir(), `fan-sdk-budget-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	tempDirs.push(tempDir);

	const settingsManager = SettingsManager.create(tempDir, tempDir);
	if (settings) {
		settingsManager.applyOverrides(settings);
	}

	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir: tempDir,
		model: fauxModel,
		settingsManager,
		sessionManager: SessionManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
	});
	return session;
}

afterEach(() => {
	while (tempDirs.length) {
		const dir = tempDirs.pop()!;
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true });
		}
	}
});

describe("F-46 iteration budget SDK defaults (opt-in)", () => {
	it("no budget settings → unlimited: 500k tokens in one iteration is allowed", async () => {
		const session = await createSdkSession();
		try {
			const modelManager = session.modelManager;
			expect(modelManager).toBeDefined();

			modelManager!.trackIterationUsage(500_000, 10);

			expect(modelManager!.checkIterationBudget().allowed).toBe(true);
		} finally {
			session.dispose();
		}
	});

	it("explicit budget.iterationTokenLimit in settings.json → limit is enforced", async () => {
		const session = await createSdkSession({
			budget: { iterationTokenLimit: 100_000, iterationCostLimit: 5 },
		});
		try {
			const modelManager = session.modelManager;
			expect(modelManager).toBeDefined();

			modelManager!.trackIterationUsage(500_000, 10);

			expect(modelManager!.checkIterationBudget().allowed).toBe(false);
		} finally {
			session.dispose();
		}
	});
});
