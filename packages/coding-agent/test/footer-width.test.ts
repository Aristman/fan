import { visibleWidth } from "@seaagents/fan-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import { FooterComponent, formatElapsed } from "../src/modes/interactive/components/footer.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
}): AgentSession {
	const usage = options.usage;
	const entries =
		usage === undefined
			? []
			: [
					{
						type: "message",
						message: {
							role: "assistant",
							usage,
						},
					},
				];

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		modelRegistry: {
			isUsingOAuth: () => false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("renders elapsed timer when sessionStartTime is set", () => {
		const width = 120;
		const session = createSession({
			sessionName: "test",
			modelId: "test-model",
			usage: {
				input: 1000,
				output: 500,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.01 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));
		footer.setSessionStartTime(Date.now() - 12 * 60 * 1000 - 34 * 1000); // 12:34 ago

		const lines = footer.render(width);
		// Stats line (index 1) should contain the elapsed time
		expect(lines[1]).toContain("12:34");
		// Should still fit within width
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("renders H:MM:SS format for long sessions", () => {
		const width = 120;
		const session = createSession({
			sessionName: "test",
			modelId: "test-model",
		});
		const footer = new FooterComponent(session, createFooterData(1));
		footer.setSessionStartTime(Date.now() - 2 * 3600 * 1000 - 5 * 60 * 1000 - 9 * 1000); // 2:05:09 ago

		const lines = footer.render(width);
		expect(lines[1]).toContain("2:05:09");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("does not render timer when sessionStartTime is not set", () => {
		const width = 120;
		const session = createSession({
			sessionName: "test",
			modelId: "test-model",
		});
		const footer = new FooterComponent(session, createFooterData(1));
		// Do NOT call setSessionStartTime

		const lines = footer.render(width);
		// Should not contain any time pattern like MM:SS
		expect(lines[1]).not.toMatch(/\d{2}:\d{2}/);
	});
});

describe("formatElapsed", () => {
	it("formats MM:SS for short durations", () => {
		expect(formatElapsed(0)).toBe("00:00");
		expect(formatElapsed(59_000)).toBe("00:59");
		expect(formatElapsed(60_000)).toBe("01:00");
		expect(formatElapsed(12 * 60_000 + 34_000)).toBe("12:34");
	});

	it("formats H:MM:SS for durations >= 1 hour", () => {
		expect(formatElapsed(3600_000)).toBe("1:00:00");
		expect(formatElapsed(2 * 3600_000 + 5 * 60_000 + 9_000)).toBe("2:05:09");
		expect(formatElapsed(10 * 3600_000 + 30_000)).toBe("10:00:30");
	});
});
