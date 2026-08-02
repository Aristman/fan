/**
 * Батчер: сжимает траекторию в компактные батчи для LLM-судьи.
 */

import type { AnalyticsConfig, JudgeBatch, Trajectory, TrajectoryStep } from "../types.js";

/**
 * Compress a trajectory into judge batches.
 * Respects batchMaxSteps AND batchMaxChars limits.
 * Does NOT split tool_call/tool_result pairs across batches.
 */
export function compressTrajectory(trajectory: Trajectory, cfg: AnalyticsConfig): JudgeBatch[] {
	const maxSteps = cfg.judge.batchMaxSteps;
	const maxChars = cfg.judge.batchMaxChars;
	const excerptLimit = cfg.judge.excerptLimit;

	const compressed = trajectory.steps.map((step, idx) => compressStep(step, idx, excerptLimit));

	// Find first user message for header
	const firstUserText = trajectory.steps
		.filter((s) => s.kind === "user")
		.map((s) => getStepText(s, 300))[0] || "(нет user-запроса)";
	const header = firstUserText.slice(0, 300);

	// Build batches
	const rawBatches: string[][] = [];
	let currentBatch: string[] = [];
	let currentChars = 0;

	for (let i = 0; i < compressed.length; i++) {
		const line = compressed[i];
		const lineChars = line.length;

		// Check if adding this line would exceed limits
		const wouldExceedSteps = currentBatch.length >= maxSteps;
		const wouldExceedChars = currentChars + lineChars > maxChars && currentBatch.length > 0;

		if (wouldExceedSteps || wouldExceedChars) {
			// Before splitting, check if we're about to split a tool_call/tool_result pair
			// If current step is a tool_result and the previous was a tool_call in the current batch, keep them together
			rawBatches.push(currentBatch);
			currentBatch = [];
			currentChars = 0;
		}

		// Check tool_call/tool_result pair constraint:
		// If this is a tool_result step and previous step was a tool_call
		// that ended up in the previous batch, move the tool_call to this batch instead.
		if (currentBatch.length === 0 && rawBatches.length > 0) {
			const prevBatch = rawBatches[rawBatches.length - 1];
			if (
				i > 0 &&
				trajectory.steps[i].kind === "tool_result" &&
				trajectory.steps[i - 1].kind === "tool_call" &&
				prevBatch.length > 0
			) {
				// Move the last tool_call from previous batch to this batch
				const moved = prevBatch.pop()!;
				currentBatch.push(moved);
				currentChars += moved.length;
			}
		}

		currentBatch.push(line);
		currentChars += lineChars;
	}

	if (currentBatch.length > 0) {
		rawBatches.push(currentBatch);
	}

	// Build JudgeBatch objects with header
	const totalBatches = rawBatches.length;
	return rawBatches.map((steps, idx) => ({
		index: idx,
		totalBatches,
		header: `Батч ${idx + 1} из ${totalBatches}. Первый запрос: "${header}"`,
		steps,
		isLast: idx === totalBatches - 1,
	}));
}

/**
 * Compress a single trajectory step into a compact string representation.
 */
function compressStep(step: TrajectoryStep, idx: number, excerptLimit: number): string {
	const num = idx + 1; // 1-based

	switch (step.kind) {
		case "user": {
			const text = getStepText(step, excerptLimit * 2);
			return `[#${num} user] ${text}`;
		}

		case "assistant_text": {
			const text = getStepText(step, excerptLimit * 2);
			return `[#${num} assistant] ${text}`;
		}

		case "tool_call": {
			const name = step.toolName || "unknown";
			const argsStr = step.args ? truncate(JSON.stringify(step.args), excerptLimit) : "";
			const argsPart = argsStr ? ` ${argsStr}` : "";
			return `[#${num} tool→${name}${argsPart}]`;
		}

		case "tool_result": {
			const name = step.toolName || "unknown";
			const status = step.isError ? "✗" : "✓";
			const text = getStepText(step, excerptLimit);
			return `[#${num} result${status} ${name}: ${text}]`;
		}

		case "thinking": {
			return `[#${num} thinking]`;
		}

		case "model_change": {
			return `[#${num} model→${step.model || "?"}]`;
		}

		case "compaction": {
			return `[#${num} compaction]`;
		}

		case "system": {
			return `[#${num} system]`;
		}

		default: {
			return `[#${num} ${step.kind}]`;
		}
	}
}

/**
 * Extract text content from a step (from args or generic text).
 */
function getStepText(step: TrajectoryStep, maxLen: number): string {
	// Try args.text, args.content, args.command, etc.
	if (step.args) {
		const text =
			(step.args.text as string) ||
			(step.args.content as string) ||
			(step.args.command as string) ||
			(step.args.message as string) ||
			"";
		if (text) return truncate(text, maxLen);
	}

	// Fallback: stringify args
	if (step.args) {
		const str = JSON.stringify(step.args);
		return truncate(str, maxLen);
	}

	return "";
}

function truncate(s: string, maxLen: number): string {
	if (s.length <= maxLen) return s;
	return s.slice(0, maxLen) + "…";
}
