/**
 * F-3.5 adapter-level tests: SessionAdapter.createProject (main.ts).
 *
 * Contract:
 * - With a template: the template structure is applied, the type is
 *   auto-detected and the project is registered in projects.json.
 * - Without a template (documented decision): empty directory (mkdir -p) +
 *   type detection (empty dir → 'unknown') + registration.
 * - Duplicate (path already registered): idempotent — created=false and the
 *   EXISTING registry entry is returned unchanged.
 * - Unknown template: the registry is NOT updated and the
 *   'Unknown template: <name>' error propagates (the HTTP layer maps it to 400).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listProjects } from "../src/core/project-registry.js";
import { createSessionAdapter } from "../src/main.js";

// Minimal runtime stub — createProject() never touches the runtime.
const fakeRuntime = {
	session: { sessionId: "active", sessionFile: null },
};

describe("session adapter createProject (F-3.5)", () => {
	let agentDir: string;
	let rootPath: string;
	let savedAgentDir: string | undefined;

	beforeEach(() => {
		savedAgentDir = process.env.FAN_CODING_AGENT_DIR;
		agentDir = mkdtempSync(join(tmpdir(), "fan-agent-"));
		rootPath = mkdtempSync(join(tmpdir(), "fan-ws-"));
		process.env.FAN_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (savedAgentDir === undefined) {
			delete process.env.FAN_CODING_AGENT_DIR;
		} else {
			process.env.FAN_CODING_AGENT_DIR = savedAgentDir;
		}
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(rootPath, { recursive: true, force: true });
	});

	// TC-F-3.5-1 (adapter level): template 'code' → structure created,
	// metadata returned, project registered with type 'code'.
	it("creates a project from the code template and registers it (TC-F-3.5-1)", async () => {
		const adapter = createSessionAdapter(fakeRuntime as never);
		const result = await adapter.createProject!({ name: "test", template: "code", rootPath });

		expect(result.created).toBe(true);
		expect(result.name).toBe("test");
		expect(result.type).toBe("code");
		expect(result.template).toBe("code");
		expect(result.path).toBe(join(rootPath, "test"));

		// Template structure materialized on disk
		expect(existsSync(join(result.path, ".fan", "settings.json"))).toBe(true);
		expect(existsSync(join(result.path, "src"))).toBe(true);
		expect(existsSync(join(result.path, "package.json"))).toBe(true);

		// Registry updated by the adapter (templates module stays registry-free)
		const registry = listProjects();
		expect(registry).toHaveLength(1);
		expect(registry[0].path).toBe(result.path);
		expect(registry[0].type).toBe("code");
	});

	// TC-F-3.5-2 (adapter level): unknown template → error propagates,
	// registry untouched.
	it("rejects an unknown template without touching the registry (TC-F-3.5-2)", async () => {
		const adapter = createSessionAdapter(fakeRuntime as never);
		await expect(adapter.createProject!({ name: "test", template: "nonexistent", rootPath })).rejects.toThrow(
			"Unknown template: nonexistent",
		);
		expect(listProjects()).toHaveLength(0);
	});

	// TC-F-3.5-3 (adapter level): template 'research' → detected type matches.
	it("creates a research project with type=research (TC-F-3.5-3)", async () => {
		const adapter = createSessionAdapter(fakeRuntime as never);
		const result = await adapter.createProject!({ name: "lab", template: "research", rootPath });
		expect(result.type).toBe("research");
		expect(existsSync(join(result.path, "docs", "research"))).toBe(true);
	});

	// Contract decision: no template → empty directory + detect + register.
	it("without a template creates an empty registered directory (type unknown)", async () => {
		const adapter = createSessionAdapter(fakeRuntime as never);
		const result = await adapter.createProject!({ name: "empty-proj", rootPath });

		expect(result.created).toBe(true);
		expect(result.type).toBe("unknown");
		expect(result.template).toBeUndefined();
		expect(existsSync(result.path)).toBe(true);

		const registry = listProjects();
		expect(registry).toHaveLength(1);
		expect(registry[0].name).toBe("empty-proj");
	});

	// Contract decision: duplicate → created=false + existing entry unchanged.
	it("is idempotent for an already-registered path", async () => {
		const adapter = createSessionAdapter(fakeRuntime as never);
		const first = await adapter.createProject!({ name: "dup", template: "research", rootPath });
		expect(first.created).toBe(true);

		// Second call with a DIFFERENT template: the existing registry entry
		// (type from the first registration) is returned unchanged.
		const second = await adapter.createProject!({ name: "dup", template: "code", rootPath });
		expect(second.created).toBe(false);
		expect(second.type).toBe("research");

		expect(listProjects()).toHaveLength(1);
	});

	// Regression: template application never overwrites existing files
	// (a re-POST against a path whose directory already exists keeps content).
	it("does not overwrite existing files on repeat creation", async () => {
		const adapter = createSessionAdapter(fakeRuntime as never);
		const first = await adapter.createProject!({ name: "keep", template: "code", rootPath });
		const pkgPath = join(first.path, "package.json");
		writeFileSync(pkgPath, '{"name":"custom"}', "utf-8");

		await adapter.createProject!({ name: "keep", template: "code", rootPath });
		expect(readFileSync(pkgPath, "utf-8")).toBe('{"name":"custom"}');
	});
});
