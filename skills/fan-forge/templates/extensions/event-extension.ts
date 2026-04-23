/**
 * Event Extension Template
 *
 * Extension that subscribes to lifecycle events with state persistence.
 * Demonstrates: session events, agent events, turn events, state management.
 */

import type { ExtensionAPI } from "@fan/fan-coding-agent";

interface MyState {
	turnCount: number;
	startedAt: number;
	lastEvent: string;
}

export default function (pi: ExtensionAPI) {
	let state: MyState = {
		turnCount: 0,
		startedAt: Date.now(),
		lastEvent: "",
	};

	// --- Restore state from session ---
	pi.on("session_start", async (event, ctx) => {
		state = { turnCount: 0, startedAt: Date.now(), lastEvent: "" };

		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "my-event-state") {
				const saved = entry.data as Partial<MyState> | undefined;
				if (saved) {
					state = { ...state, ...saved };
				}
			}
		}

		if (ctx.hasUI) {
			ctx.ui.notify(
				`Session: ${event.reason} (turns: ${state.turnCount})`,
				"info",
			);
		}
	});

	// --- Track turns ---
	pi.on("turn_start", async (event, ctx) => {
		state.turnCount++;
		state.lastEvent = `turn_start:${event.turnIndex}`;

		if (ctx.hasUI) {
			ctx.ui.setStatus("my-events", `Turn ${state.turnCount}`);
		}
	});

	// --- Inject context before each agent run ---
	pi.on("before_agent_start", async (event) => {
		return {
			message: {
				customType: "my-event-context",
				content: `[my-events] Turn count: ${state.turnCount}. Use this info if relevant.`,
				display: false,
			},
		};
	});

	// --- React to agent completion ---
	pi.on("agent_end", async (event, ctx) => {
		const msgCount = event.messages.length;
		if (ctx.hasUI) {
			ctx.ui.notify(`Agent done: ${msgCount} messages`, "info");
		}
	});

	// --- Clean up and persist state ---
	pi.on("session_shutdown", async () => {
		pi.appendEntry("my-event-state", state);
	});

	// --- Context filtering ---
	pi.on("context", async (event) => {
		// Example: filter out stale custom messages
		return {
			messages: event.messages.filter((m: any) => {
				if (m.customType === "my-event-context") {
					// Keep only recent context (within last 20 messages)
					const idx = event.messages.indexOf(m);
					return idx >= event.messages.length - 20;
				}
				return true;
			}),
		};
	});
}
