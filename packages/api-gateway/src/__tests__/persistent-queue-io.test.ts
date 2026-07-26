import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock fs/promises so we can force rename() to fail without touching real disk
// permissions. Everything else uses the original implementation.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rename: vi.fn(actual.rename),
	};
});

const { PersistentMessageQueue } = await import("../message-queue.js");

describe("PersistentMessageQueue I/O safety", () => {
	let queuesDir: string;

	beforeEach(async () => {
		queuesDir = await mkdtemp(join(tmpdir(), "fan-pq-io-"));
	});

	afterEach(async () => {
		await rm(queuesDir, { recursive: true, force: true });
	});

	it("TC-F-5.5-F2b: writeFileAtomic removes the temp file when rename fails", async () => {
		const fs = await import("node:fs/promises");
		const queue = new PersistentMessageQueue<string>({ queuesDir, retryDelayMs: 0 });
		await queue.enqueue("sess-1", "A");
		await queue.enqueue("sess-1", "B");

		// Force every rename() to fail. The dequeue rewrite is done via
		// writeFileAtomic(tmp, rename), so this exercises the cleanup path.
		const mockedRename = vi.mocked(fs.rename);
		mockedRename.mockRejectedValue(new Error("rename failed"));

		await expect(queue.dequeue("sess-1")).rejects.toThrow("rename failed");

		mockedRename.mockRestore();

		// No leftover .tmp-<pid>-<n> files should remain after the failure.
		const files = await readdir(queuesDir);
		expect(files.some((f) => f.includes(".tmp-"))).toBe(false);

		// The original queue file is untouched because the rewrite failed.
		const raw = await fs.readFile(join(queuesDir, "sess-1.queue.jsonl"), "utf-8");
		expect(raw.trim().split("\n")).toHaveLength(2);
	});
});
