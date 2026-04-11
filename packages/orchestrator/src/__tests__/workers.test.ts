import { describe, it, expect, beforeEach } from "vitest";
import {
    genWorkerId,
    registerWorker,
    getWorker,
    listWorkers,
    activeWorkers,
    hasActiveWriteWorker,
    updateWorker,
    acquireSlot,
    releaseSlot,
    getQueueLength,
    statusIcon,
    statusColor,
    _resetRegistry,
} from "../workers.js";
import type { WorkerHandle, WorkerState } from "../types.js";

describe("workers", () => {
    beforeEach(() => {
        _resetRegistry();
    });

    describe("genWorkerId", () => {
        it("returns unique IDs", () => {
            const ids = new Set<string>();
            for (let i = 0; i < 100; i++) {
                ids.add(genWorkerId());
            }
            expect(ids.size).toBe(100);
        });
    });

    describe("registerWorker / getWorker", () => {
        it("registerWorker and getWorker return same object", () => {
            const handle: WorkerHandle = {
                id: genWorkerId(),
                agentType: "explore",
                status: "running",
                startTime: Date.now(),
                task: "test task",
            };
            registerWorker(handle);
            const retrieved = getWorker(handle.id);
            expect(retrieved).toBe(handle);
            expect(retrieved!.agentType).toBe("explore");
        });
    });

    describe("listWorkers", () => {
        it("returns all workers", () => {
            const w1: WorkerHandle = {
                id: genWorkerId(), agentType: "explore",
                status: "running", startTime: Date.now(),
            };
            const w2: WorkerHandle = {
                id: genWorkerId(), agentType: "implement",
                status: "completed", startTime: Date.now(),
            };
            const w3: WorkerHandle = {
                id: genWorkerId(), agentType: "plan",
                status: "spawning", startTime: Date.now(),
            };
            registerWorker(w1);
            registerWorker(w2);
            registerWorker(w3);

            const all = listWorkers();
            expect(all).toHaveLength(3);
        });
    });

    describe("activeWorkers", () => {
        it("excludes completed/failed/aborted", () => {
            const w1: WorkerHandle = {
                id: genWorkerId(), agentType: "explore",
                status: "running", startTime: Date.now(),
            };
            const w2: WorkerHandle = {
                id: genWorkerId(), agentType: "implement",
                status: "completed", startTime: Date.now(),
            };
            const w3: WorkerHandle = {
                id: genWorkerId(), agentType: "plan",
                status: "failed", startTime: Date.now(),
            };
            const w4: WorkerHandle = {
                id: genWorkerId(), agentType: "verify",
                status: "aborted", startTime: Date.now(),
            };
            const w5: WorkerHandle = {
                id: genWorkerId(), agentType: "explore",
                status: "spawning", startTime: Date.now(),
            };
            registerWorker(w1);
            registerWorker(w2);
            registerWorker(w3);
            registerWorker(w4);
            registerWorker(w5);

            const active = activeWorkers();
            expect(active).toHaveLength(2);
            expect(active.map((w) => w.id)).toContain(w1.id);
            expect(active.map((w) => w.id)).toContain(w5.id);
        });
    });

    describe("hasActiveWriteWorker", () => {
        it("returns true when implement worker is active", () => {
            const w: WorkerHandle = {
                id: genWorkerId(), agentType: "implement",
                status: "running", startTime: Date.now(),
            };
            registerWorker(w);
            expect(hasActiveWriteWorker()).toBe(true);
        });

        it("returns false when only explore worker is active", () => {
            const w: WorkerHandle = {
                id: genWorkerId(), agentType: "explore",
                status: "running", startTime: Date.now(),
            };
            registerWorker(w);
            expect(hasActiveWriteWorker()).toBe(false);
        });
    });

    describe("updateWorker", () => {
        it("modifies existing worker", () => {
            const w: WorkerHandle = {
                id: genWorkerId(), agentType: "explore",
                status: "running", startTime: Date.now(),
            };
            registerWorker(w);
            updateWorker(w.id, { status: "completed", result: "done" });
            const updated = getWorker(w.id)!;
            expect(updated.status).toBe("completed");
            expect(updated.result).toBe("done");
        });
    });

    describe("acquireSlot", () => {
        it("returns immediately when under limit", async () => {
            const start = Date.now();
            await acquireSlot("explore", 2);
            const elapsed = Date.now() - start;
            // Should resolve within 50ms (no waiting)
            expect(elapsed).toBeLessThan(50);
        });

        it("queues when at limit for explore type", async () => {
            // Acquire 2 explore slots (maxParallel=2)
            await acquireSlot("explore", 2);
            await acquireSlot("explore", 2);

            // Third should queue — use a timeout to verify it doesn't resolve immediately
            let resolved = false;
            const promise = acquireSlot("explore", 2).then(() => {
                resolved = true;
            });

            // Give it a tick
            await new Promise((r) => setTimeout(r, 20));
            expect(resolved).toBe(false);
            expect(getQueueLength()).toBe(1);

            // Release and it should resolve
            releaseSlot("explore", 2);
            await promise;
            expect(resolved).toBe(true);
        });

        it("queues for implement when one is already running", async () => {
            // Register a running implement worker so hasActiveWriteWorker() returns true
            const w: WorkerHandle = {
                id: genWorkerId(), agentType: "implement",
                status: "running", startTime: Date.now(),
            };
            registerWorker(w);

            // Even though slotCount for implement is 0, hasActiveWriteWorker() is true
            // so it should queue
            let resolved = false;
            const promise = acquireSlot("implement", 3).then(() => {
                resolved = true;
            });

            await new Promise((r) => setTimeout(r, 20));
            expect(resolved).toBe(false);
            expect(getQueueLength()).toBe(1);

            // Mark worker as completed and release
            updateWorker(w.id, { status: "completed" });
            // The queue check in releaseSlot calls hasActiveWriteWorker which checks activeWorkers
            // We need to actually acquire + release to properly wake
            // Since the worker was never acquired via slot pool, manually trigger wake
            // Actually, we need to release a slot for implement
            // The queued waiter is for implement type. releaseSlot checks hasActiveWriteWorker()
            // Now that the worker is completed, hasActiveWriteWorker() returns false
            // But slotCount for implement is 0, so the waiter should be woken
            releaseSlot("implement", 3);
            await promise;
            expect(resolved).toBe(true);
        });
    });

    describe("releaseSlot", () => {
        it("wakes next waiter (FIFO)", async () => {
            // Acquire 2 explore slots (maxParallel=2)
            await acquireSlot("explore", 2);
            await acquireSlot("explore", 2);

            // Queue two waiters
            const order: number[] = [];
            const p1 = acquireSlot("explore", 2).then(() => order.push(1));
            const p2 = acquireSlot("explore", 2).then(() => order.push(2));

            await new Promise((r) => setTimeout(r, 10));
            expect(getQueueLength()).toBe(2);

            // Release one slot
            releaseSlot("explore", 2);
            await new Promise((r) => setTimeout(r, 10));
            expect(order).toEqual([1]);

            // Release another slot
            releaseSlot("explore", 2);
            await Promise.all([p1, p2]);
            expect(order).toEqual([1, 2]);
        });
    });

    describe("getQueueLength", () => {
        it("returns correct count", async () => {
            expect(getQueueLength()).toBe(0);
            await acquireSlot("explore", 1);

            // Don't await the second acquire — it will queue
            const queuedPromise = acquireSlot("explore", 1);
            // Give microtask queue time
            await new Promise((r) => setTimeout(r, 10));
            expect(getQueueLength()).toBe(1);

            // Release to clean up and prevent hanging
            releaseSlot("explore", 1);
            await queuedPromise;
        });
    });

    describe("statusIcon", () => {
        const cases: [WorkerState, string][] = [
            ["spawning", "⏳"],
            ["running", "▶"],
            ["completed", "✓"],
            ["failed", "✗"],
            ["aborted", "⊘"],
        ];
        it.each(cases)("returns correct emoji for %s", (status, expected) => {
            expect(statusIcon(status)).toBe(expected);
        });
    });

    describe("statusColor", () => {
        it("returns plain text without theme", () => {
            expect(statusColor("running", "test text")).toBe("test text");
        });

        it("calls theme.fg when theme is provided", () => {
            const mockTheme = { fg: (color: string, t: string) => `[${color}:${t}]` };
            expect(statusColor("running", "test", mockTheme as any)).toBe("[accent:test]");
            expect(statusColor("completed", "done", mockTheme as any)).toBe("[success:done]");
            expect(statusColor("failed", "err", mockTheme as any)).toBe("[error:err]");
            expect(statusColor("spawning", "wait", mockTheme as any)).toBe("[warning:wait]");
            expect(statusColor("aborted", "stop", mockTheme as any)).toBe("[muted:stop]");
        });
    });

    describe("_resetRegistry", () => {
        it("clears all state", async () => {
            const w: WorkerHandle = {
                id: genWorkerId(), agentType: "explore",
                status: "running", startTime: Date.now(),
            };
            registerWorker(w);
            await acquireSlot("explore", 2);

            expect(listWorkers()).toHaveLength(1);

            _resetRegistry();

            expect(listWorkers()).toHaveLength(0);
            expect(getQueueLength()).toBe(0);
        });
    });
});
