import type { FileEntry } from "@seaagents/fan-coding-agent";
import type { Trajectory, TrajectoryStep, WorkerSpawn } from "./types.js";
import type { ParsedSession } from "./parser.js";

interface EntryWithId {
	id: string;
	parentId: string | null;
	timestamp: string;
	type: string;
	[key: string]: unknown;
}

/** Default idle threshold in minutes. */
const DEFAULT_IDLE_THRESHOLD_MIN = 15;

/**
 * Build main branch trajectory from entries by following id/parentId chain
 * from root to the last leaf.
 *
 * @param idleThresholdMin  Minutes after which a gap is treated as user-idle (default 15).
 */
export function buildTrajectory(session: ParsedSession, idleThresholdMin?: number): Trajectory {
	const entries = session.entries;
	if (entries.length === 0) {
		return emptyTrajectory(session);
	}

	// Extract header info
	const header = entries.find((e) => (e as any).type === "session") as any;
	const sessionId = header?.id || "unknown";
	const cwd = header?.cwd || "";

	// Index all entries by id for parent lookups
	const entryMap = new Map<string, EntryWithId>();
	for (const entry of entries) {
		const e = entry as any;
		if (e.id) {
			entryMap.set(e.id, e as EntryWithId);
		}
	}

	// Find the last leaf entry (entry with no children)
	const childIds = new Set<string>();
	for (const entry of entries) {
		const e = entry as any;
		if (e.parentId) childIds.add(e.parentId);
	}

	let lastLeaf: EntryWithId | null = null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as any;
		if (e.id && !childIds.has(e.id) && e.type !== "session") {
			lastLeaf = e as EntryWithId;
			break;
		}
	}

	// If no leaf found, use last entry
	if (!lastLeaf && entries.length > 1) {
		lastLeaf = entries[entries.length - 1] as any as EntryWithId;
	}

	// Build main branch by walking from leaf to root via parentId
	const branchIds: string[] = [];
	if (lastLeaf) {
		let current: EntryWithId | undefined = lastLeaf;
		const visited = new Set<string>();
		while (current && !visited.has(current.id)) {
			visited.add(current.id);
			branchIds.unshift(current.id);
			if (current.parentId) {
				current = entryMap.get(current.parentId);
			} else {
				break;
			}
		}
	}

	// Convert branch entries to trajectory steps
	const steps: TrajectoryStep[] = [];
	const skillsActivated: string[] = [];
	const workersSpawned: WorkerSpawn[] = [];
	const delegateTaskResults = new Map<string, { verdict: string; agentType: string }>();
	let compactions = 0;
	const idleThresholdMs = (idleThresholdMin ?? DEFAULT_IDLE_THRESHOLD_MIN) * 60 * 1000;
	let prevTs = 0;

	for (const id of branchIds) {
		const entry = entryMap.get(id);
		if (!entry) continue;

		const ts = new Date(entry.timestamp).getTime() || 0;
		const durationMs = prevTs > 0 ? ts - prevTs : 0;
		prevTs = ts;

		// Classify interval: agent-controlled vs user-idle
		const durationKind = classifyInterval(entry, durationMs, idleThresholdMs);

		// FIX CRITICAL 2: entryToSteps returns TrajectoryStep[] (one step per toolCall)
		const entrySteps = entryToSteps(entry, ts, durationMs, durationKind);
		steps.push(...entrySteps);

		// Extract side-effects from message entries
		if (entry.type === "message") {
			const msg = (entry as any).message;
			if (msg?.role === "user") {
				// Detect skills in user messages
				const content = typeof msg.content === "string"
					? msg.content
					: Array.isArray(msg.content)
						? msg.content.map((b: any) => b.text || b.type === "text" ? b.text : "").join("")
						: "";
				const skillMatch = content.match(/<skill\s+name="([^"]+)"/g);
				if (skillMatch) {
					for (const m of skillMatch) {
						const nameMatch = m.match(/name="([^"]+)"/);
						if (nameMatch?.[1]) skillsActivated.push(nameMatch[1]);
					}
				}
			}

			if (msg?.role === "assistant" && Array.isArray(msg.content)) {
				for (const block of msg.content) {
					// Detect skill activation via read of SKILL.md
					if (block?.type === "toolCall" && block?.name === "read") {
						const path = block.arguments?.path || "";
						if (typeof path === "string" && path.includes("SKILL.md")) {
							const skillName = extractSkillNameFromPath(path);
							if (skillName && !skillsActivated.includes(skillName)) {
								skillsActivated.push(skillName);
							}
						}
					}

					// Detect workers spawned via delegate_task
					if (block?.type === "toolCall" && block?.name === "delegate_task") {
						const args = block.arguments || {};
						// Handle chain mode
						if (args.mode === "chain" && Array.isArray(args.chain)) {
							for (const item of args.chain) {
								workersSpawned.push({
									type: item.agent || "unknown",
									task: typeof item.task === "string" ? item.task.slice(0, 200) : undefined,
								});
							}
						}
						// Handle single agent mode
						if (args.agent) {
							workersSpawned.push({
								type: args.agent,
								task: typeof args.task === "string" ? args.task.slice(0, 200) : undefined,
							});
						}
					}
				}
			}

			// Detect worker verdicts from delegate_task toolResult
			if (msg?.role === "toolResult" && msg.toolName === "delegate_task") {
				const details = msg.details;
				if (details?.results && Array.isArray(details.results)) {
					for (const result of details.results) {
						const workerType = result.agent || "unknown";
						const text = result.text || "";
						const verdictMatch = text.match(/VERDICT:\s*(PASS|FAIL|PARTIAL)/i);
						const verdict = verdictMatch?.[1] || "unknown";
						const existing = workersSpawned.find(
							(w) => w.type === workerType && !w.verdict
						);
						if (existing) {
							existing.verdict = verdictMatch?.[1] || undefined;
						}
						// Store delegate task result for D13
						if (msg.toolCallId) {
							delegateTaskResults.set(msg.toolCallId, {
								verdict,
								agentType: workerType,
							});
						}
					}
				}
			}
		}

		// Count compactions
		if (entry.type === "compaction") {
			compactions++;
		}
	}

	// Also scan ALL entries (not just main branch) for skills via SKILL.md reads
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = (entry as any).message;
		if (msg?.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block?.type === "toolCall" && block?.name === "read") {
					const path = block.arguments?.path || "";
					if (typeof path === "string" && path.includes("SKILL.md")) {
						const skillName = extractSkillNameFromPath(path);
						if (skillName && !skillsActivated.includes(skillName)) {
							skillsActivated.push(skillName);
						}
					}
				}
			}
		}
	}

	// Also scan ALL entries for delegate_task verdicts (not just main branch)
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = (entry as any).message;
		if (msg?.role === "toolResult" && msg.toolName === "delegate_task") {
			const details = msg.details;
			if (details?.results && Array.isArray(details.results)) {
				for (const result of details.results) {
					const workerType = result.agent || "unknown";
					const text = result.text || "";
					const verdictMatch = text.match(/VERDICT:\s*(PASS|FAIL|PARTIAL)/i);
					const verdict = verdictMatch?.[1] || "unknown";
					const existing = workersSpawned.find(
						(w) => w.type === workerType && !w.verdict
					);
					if (existing) {
						existing.verdict = verdictMatch?.[1] || undefined;
					}
					if (msg.toolCallId && !delegateTaskResults.has(msg.toolCallId)) {
						delegateTaskResults.set(msg.toolCallId, {
							verdict,
							agentType: workerType,
						});
					}
				}
			}
		}
	}

	const timestamps = steps
		.map((s) => s.ts)
		.filter((t) => t > 0);
	const startedAt = timestamps.length > 0 ? Math.min(...timestamps) : 0;
	const endedAt = timestamps.length > 0 ? Math.max(...timestamps) : 0;

	return {
		sessionId,
		path: session.path,
		cwd,
		startedAt,
		endedAt,
		steps,
		skillsActivated,
		workersSpawned,
		compactions,
		truncated: session.truncated,
		invalidLines: session.invalidLines,
		totalLines: session.totalLines,
		delegateTaskResults,
	};
}

/**
 * Convert a single entry to one or more trajectory steps.
 * Returns an array to handle assistant messages with multiple toolCalls (FIX CRITICAL 2).
 */
/**
 * Classify a duration interval based on the current entry type and idle threshold.
 * - tool_exec: interval before a toolResult (agent tool execution)
 * - generation: interval before an assistant message (agent response generation)
 * - user_idle: interval before a user message, idle gap, or non-agent entry
 */
function classifyInterval(entry: EntryWithId, durationMs: number, idleThresholdMs: number): "tool_exec" | "generation" | "user_idle" {
	// Idle gap exceeds threshold
	if (durationMs > idleThresholdMs) return "user_idle";

	if (entry.type === "message") {
		const msg = (entry as any).message;
		if (msg?.role === "user") return "user_idle";
		if (msg?.role === "assistant") return "generation";
		if (msg?.role === "toolResult") return "tool_exec";
	}

	return "user_idle";
}

function entryToSteps(entry: EntryWithId, ts: number, durationMs: number, durationKind: "tool_exec" | "generation" | "user_idle"): TrajectoryStep[] {
	const base: TrajectoryStep = {
		entryId: entry.id,
		ts,
		kind: "other",
		durationMs: durationMs > 0 ? durationMs : undefined,
		durationKind,
	};

	switch (entry.type) {
		case "message": {
			const msg = (entry as any).message;
			if (!msg) return [];

			if (msg.role === "user") {
				base.kind = "user";
				// Extract user message text for batcher/compression
				const content = msg.content;
				let userText = "";
				if (typeof content === "string") {
					userText = content;
				} else if (Array.isArray(content)) {
					userText = content.map((b: any) => b.text || (b.type === "text" ? b.text : "")).join("");
				}
				if (userText) {
					base.args = { text: userText.slice(0, 500) };
				}
				return [base];
			}

			if (msg.role === "assistant") {
				const content = msg.content;
				const result: TrajectoryStep[] = [];

				if (Array.isArray(content)) {
					for (const block of content) {
						if (block?.type === "toolCall") {
							// FIX MAJOR 5: include cacheRead/cacheWrite in tokens
							result.push({
								entryId: entry.id,
								ts,
								kind: "tool_call",
								toolName: block.name,
								toolCallId: block.id,
								args: block.arguments,
								model: msg.model,
								tokens: msg.usage
									? {
											input: msg.usage.input || 0,
											output: msg.usage.output || 0,
											total: msg.usage.totalTokens || 0,
											cacheRead: msg.usage.cacheRead || 0,
											cacheWrite: msg.usage.cacheWrite || 0,
										}
									: undefined,
								cost: msg.usage?.cost?.total || 0,
								durationMs: durationMs > 0 ? durationMs : undefined,
								durationKind,
							});
						} else if (block?.type === "text" && block.text?.trim()) {
							result.push({
								entryId: entry.id,
								ts,
								kind: "assistant_text",
								model: msg.model,
								tokens: msg.usage
									? {
											input: msg.usage.input || 0,
											output: msg.usage.output || 0,
											total: msg.usage.totalTokens || 0,
											cacheRead: msg.usage.cacheRead || 0,
											cacheWrite: msg.usage.cacheWrite || 0,
										}
									: undefined,
								cost: msg.usage?.cost?.total || 0,
								durationMs: durationMs > 0 ? durationMs : undefined,
								durationKind,
							});
						}
					}
				}

				if (result.length === 0) {
					base.kind = "assistant_text";
					base.model = msg.model;
					return [base];
				}
				return result;
			}

			if (msg.role === "toolResult") {
				base.kind = "tool_result";
				base.toolName = msg.toolName;
				base.toolCallId = msg.toolCallId;
				base.isError = msg.isError || false;
				return [base];
			}

			return [base];
		}

		case "model_change": {
			base.kind = "model_change";
			base.model = (entry as any).modelId;
			return [base];
		}

		case "thinking_level_change": {
			base.kind = "thinking_level_change";
			return [base];
		}

		case "compaction": {
			base.kind = "compaction";
			return [base];
		}

		case "branch_summary": {
			base.kind = "branch_summary";
			return [base];
		}

		default:
			return [base];
	}
}

function extractSkillNameFromPath(path: string): string | null {
	// e.g., C:\Users\User\.fan\agent\skills\research-spec-generator\SKILL.md
	const match = path.match(/skills[/\\]([^/\\]+)[/\\]SKILL\.md/i);
	return match?.[1] || null;
}

function emptyTrajectory(session: ParsedSession): Trajectory {
	return {
		sessionId: "unknown",
		path: session.path,
		cwd: "",
		startedAt: 0,
		endedAt: 0,
		steps: [],
		skillsActivated: [],
		workersSpawned: [],
		compactions: 0,
		truncated: session.truncated,
		invalidLines: session.invalidLines,
		totalLines: session.totalLines,
		delegateTaskResults: new Map(),
	};
}
