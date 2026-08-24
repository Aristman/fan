/**
 * P1 regression: shadow queue must not contain phantom entries after QueueOverflowError.
 *
 * When `agent.steer()` / `agent.followUp()` throws QueueOverflowError,
 * the shadow lists (_steeringMessages / _followUpMessages) must remain clean.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@seaagents/fan-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const QUEUE_LIMIT = 2;

describe("Shadow queue phantom entry (P1)", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-phantom-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const agent = new Agent({
			messageQueueLimit: QUEUE_LIMIT,
			getApiKey: () => "faux-key",
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("faux", "faux-key");
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session.dispose();
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("steer overflow does not leave phantom in shadow list", async () => {
		// Fill the steering queue to the limit
		for (let i = 0; i < QUEUE_LIMIT; i++) {
			await session.steer(`msg-${i}`);
		}

		// This should throw QueueOverflowError
		let threw = false;
		try {
			await session.steer("overflow-msg");
		} catch (err) {
			threw = true;
			expect((err as Error).name).toBe("QueueOverflowError");
		}
		expect(threw).toBe(true);

		// Shadow list must only contain the QUEUE_LIMIT messages, not the overflow
		expect(session.getSteeringMessages().length).toBe(QUEUE_LIMIT);
		expect(session.getSteeringMessages()).not.toContain("overflow-msg");
	});

	it("followUp overflow does not leave phantom in shadow list", async () => {
		// Fill the follow-up queue to the limit
		for (let i = 0; i < QUEUE_LIMIT; i++) {
			await session.followUp(`fu-${i}`);
		}

		// This should throw QueueOverflowError
		let threw = false;
		try {
			await session.followUp("overflow-fu");
		} catch (err) {
			threw = true;
			expect((err as Error).name).toBe("QueueOverflowError");
		}
		expect(threw).toBe(true);

		// Shadow list must only contain the QUEUE_LIMIT messages, not the overflow
		expect(session.getFollowUpMessages().length).toBe(QUEUE_LIMIT);
		expect(session.getFollowUpMessages()).not.toContain("overflow-fu");
	});

	it("pendingMessageCount does not grow after overflow", async () => {
		// Fill both queues
		for (let i = 0; i < QUEUE_LIMIT; i++) {
			await session.steer(`s-${i}`);
			await session.followUp(`f-${i}`);
		}

		const countBefore = session.pendingMessageCount;
		expect(countBefore).toBe(QUEUE_LIMIT * 2);

		// Attempt overflow on both
		try {
			await session.steer("overflow-s");
		} catch {
			// expected
		}
		try {
			await session.followUp("overflow-f");
		} catch {
			// expected
		}

		expect(session.pendingMessageCount).toBe(countBefore);
	});
});
