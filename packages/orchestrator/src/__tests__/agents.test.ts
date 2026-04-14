import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock fs module
vi.mock("node:fs", () => ({
	default: {
		existsSync: vi.fn(() => false),
		readFileSync: vi.fn(() => ""),
		readdirSync: vi.fn(() => []),
		statSync: vi.fn(() => ({ isDirectory: () => false })),
	},
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ""),
	readdirSync: vi.fn(() => []),
	statSync: vi.fn(() => ({ isDirectory: () => false })),
}));

vi.mock("node:path", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:path")>();
	return {
		...actual,
		join: (...args: string[]) => args.join("/"),
		dirname: (p: string) => p.split("/").slice(0, -1).join("/") || ".",
		basename: (p: string) => p.split("/").pop() || "",
	};
});

vi.mock("@itone/fan-coding-agent", () => ({
	getAgentDir: () => "/home/user/.fan/agent",
	parseFrontmatter: (content: string) => {
		if (!content.startsWith("---")) return { frontmatter: {}, body: content };
		const end = content.indexOf("---", 3);
		if (end === -1) return { frontmatter: {}, body: content };
		const yaml = content.slice(3, end).trim();
		const frontmatter: Record<string, string> = {};
		for (const line of yaml.split("\n")) {
			const colon = line.indexOf(":");
			if (colon > 0) {
				frontmatter[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
			}
		}
		return { frontmatter, body: content.slice(end + 3).trim() };
	},
}));

describe("Agent Discovery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns empty agents when no directories exist", async () => {
		const { discoverAgents } = await import("../agents.js");
		const result = discoverAgents("/project", "user");
		expect(result.agents).toHaveLength(0);
	});
});
