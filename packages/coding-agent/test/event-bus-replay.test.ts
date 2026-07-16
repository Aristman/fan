import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.js";

describe("F-2.3: EventBus lastEvent cache (replay-on-subscribe)", () => {
	it("subscriber receives cached event emitted before subscribe", async () => {
		const bus = createEventBus();
		bus.emit("foo", { a: 1 });
		const handler = vi.fn();
		bus.on("foo", handler);
		// Give microtasks time to flush
		await new Promise((r) => setTimeout(r, 10));
		expect(handler).toHaveBeenCalledWith({ a: 1 });
	});

	it("subscriber receives fresh events after subscribe (live events)", async () => {
		const bus = createEventBus();
		const handler = vi.fn();
		bus.on("foo", handler);
		bus.emit("foo", { b: 2 });
		await new Promise((r) => setTimeout(r, 10));
		expect(handler).toHaveBeenCalledWith({ b: 2 });
	});

	it("cache survives unsubscribe: subsequent subscriber gets cached", async () => {
		const bus = createEventBus();
		const h1 = vi.fn();
		const h2 = vi.fn();
		bus.on("foo", h1);
		bus.emit("foo", { c: 3 });
		await new Promise((r) => setTimeout(r, 10));
		const unsub = bus.on("foo", h1); // second subscriber
		unsub(); // unsubscribe
		bus.on("foo", h2); // third subscriber should still get cached
		await new Promise((r) => setTimeout(r, 10));
		expect(h2).toHaveBeenCalledWith({ c: 3 });
	});

	it("different channels have independent caches", async () => {
		const bus = createEventBus();
		bus.emit("alpha", 1);
		bus.emit("beta", 2);
		const hA = vi.fn();
		const hB = vi.fn();
		bus.on("alpha", hA);
		bus.on("beta", hB);
		await new Promise((r) => setTimeout(r, 10));
		expect(hA).toHaveBeenCalledWith(1);
		expect(hB).toHaveBeenCalledWith(2);
	});

	it("only latest event is cached (no history)", async () => {
		const bus = createEventBus();
		bus.emit("x", 1);
		bus.emit("x", 2);
		bus.emit("x", 3);
		const handler = vi.fn();
		bus.on("x", handler);
		await new Promise((r) => setTimeout(r, 10));
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith(3);
	});

	it("clear() also clears cache", async () => {
		const bus = createEventBus();
		bus.emit("y", { v: 1 });
		bus.clear();
		const handler = vi.fn();
		bus.on("y", handler);
		await new Promise((r) => setTimeout(r, 10));
		expect(handler).not.toHaveBeenCalled();
	});

	it("handler errors during replay don't break subscription", async () => {
		const bus = createEventBus();
		bus.emit("err", { crash: true });
		const badHandler = vi.fn(async () => { throw new Error("handler boom"); });
		bus.on("err", badHandler);
		await new Promise((r) => setTimeout(r, 10));
		expect(badHandler).toHaveBeenCalled();
		// Subsequent emit still works (handler still subscribed)
		bus.emit("err", { ok: true });
		await new Promise((r) => setTimeout(r, 10));
		expect(badHandler).toHaveBeenCalledTimes(2);
	});
});
