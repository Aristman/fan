import type { AnalyticsConfig, DetectFn, Finding } from "../types.js";

/**
 * D13: Empty Retries — repeated delegate_task after FAIL with near-identical prompt.
 * FIX MAJOR 4: only emit finding if the previous worker ended with FAIL verdict
 * (or absent result / isError), not for any similar re-delegation.
 */
export const detectEmptyRetries: DetectFn = (t, cfg) => {
	const findings: Finding[] = [];

	// Collect all delegate_task calls in order
	const delegateCalls: Array<{
		entryId: string;
		toolCallId: string;
		task: string;
		agentType: string;
		idx: number;
	}> = [];

	for (let i = 0; i < t.steps.length; i++) {
		const step = t.steps[i];

		if (step.kind === "tool_call" && step.toolName === "delegate_task") {
			const args = step.args || {};

			if (args.mode === "chain" && Array.isArray(args.chain)) {
				for (const item of args.chain) {
					delegateCalls.push({
						entryId: step.entryId,
						toolCallId: step.toolCallId || "",
						task: typeof item.task === "string" ? item.task : "",
						agentType: String(item.agent || "unknown"),
						idx: i,
					});
				}
			} else if (args.agent) {
				delegateCalls.push({
					entryId: step.entryId,
					toolCallId: step.toolCallId || "",
					task: typeof args.task === "string" ? args.task : "",
					agentType: String(args.agent),
					idx: i,
				});
			}
		}
	}

	if (delegateCalls.length < 2) return findings;

	// Determine which delegate_task toolCallIds had FAIL verdicts.
	// Uses delegateTaskResults from the normalizer (preferred), with fallback to workersSpawned.
	const failedToolCallIds = new Set<string>();

	if (t.delegateTaskResults && t.delegateTaskResults.size > 0) {
		for (const [tcId, info] of t.delegateTaskResults) {
			if (info.verdict === "FAIL" || info.verdict === "unknown") {
				failedToolCallIds.add(tcId);
			}
		}
	} else {
		// Fallback: match tool_result steps to workersSpawned by agent type order
		const toolCallToAgent = new Map<string, string>();
		for (const call of delegateCalls) {
			if (call.toolCallId) {
				toolCallToAgent.set(call.toolCallId, call.agentType);
			}
		}

		for (const step of t.steps) {
			if (step.kind === "tool_result" && step.toolName === "delegate_task") {
				const tcId = step.toolCallId || "";
				const agentType = toolCallToAgent.get(tcId);
				if (agentType) {
					const worker = t.workersSpawned.find(
						(w) => w.type === agentType
					);
					if (worker && (!worker.verdict || worker.verdict === "FAIL")) {
						failedToolCallIds.add(tcId);
					}
				}
			}
		}
	}

	// Check for similar consecutive delegate_task calls where previous FAILED
	const threshold = cfg.orchestration.retryPromptSimilarity;

	for (let i = 1; i < delegateCalls.length; i++) {
		const prev = delegateCalls[i - 1];
		const curr = delegateCalls[i];

		// Only compare same agent type
		if (prev.agentType !== curr.agentType) continue;

		// Only flag if previous delegation FAILED
		if (prev.toolCallId && !failedToolCallIds.has(prev.toolCallId)) continue;

		// If we can't determine toolCallId, check via workersSpawned as last resort
		if (!prev.toolCallId) {
			const prevWorker = t.workersSpawned.find(
				(w) => w.type === prev.agentType
			);
			if (prevWorker && prevWorker.verdict && prevWorker.verdict !== "FAIL") {
				continue; // Previous succeeded, not a retry
			}
		}

		const similarity = jaccardSimilarity(prev.task, curr.task);

		if (similarity >= threshold) {
			findings.push({
				detectorId: "D13",
				severity: similarity >= 0.95 ? "high" : "medium",
				title: `Near-identical retry after FAIL: "${curr.agentType}" delegated twice with ${(similarity * 100).toFixed(0)}% similar prompts`,
				evidence: {
					entryIds: [prev.entryId, curr.entryId],
					excerpt: [
						`Agent type: ${curr.agentType}`,
						`Previous result: FAIL`,
						`Similarity: ${(similarity * 100).toFixed(1)}% (threshold: ${(threshold * 100).toFixed(0)}%)`,
						`First prompt: "${prev.task.slice(0, 100)}..."`,
						`Second prompt: "${curr.task.slice(0, 100)}..."`,
					].join("\n"),
				},
				recommendation: "Retrying with nearly identical prompts after failure is unlikely to succeed. Change the approach or provide different instructions.",
			});
		}
	}

	return findings;
};

/**
 * Jaccard similarity between two strings based on word overlap.
 */
function jaccardSimilarity(a: string, b: string): number {
	if (a === b) return 1;
	if (!a || !b) return 0;

	const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
	const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2));

	if (wordsA.size === 0 && wordsB.size === 0) return 1;

	let intersection = 0;
	for (const w of wordsA) {
		if (wordsB.has(w)) intersection++;
	}

	const union = wordsA.size + wordsB.size - intersection;
	return union === 0 ? 0 : intersection / union;
}
