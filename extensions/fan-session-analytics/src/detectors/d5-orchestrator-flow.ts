import type { DetectFn, Finding } from "../types.js";

/**
 * D5: Orchestrator Flow — detect issues in orchestrator patterns:
 * - implement/bug-fix worker without subsequent verify
 * - TaskUpdate without status
 * - > 3 attempts at implementing same task
 * - Repeated TaskUpdate with same status
 */
export const detectOrchestratorFlow: DetectFn = (t, _cfg) => {
	const findings: Finding[] = [];

	// Track delegate_task calls and their results
	const delegateCalls: Array<{
		entryId: string;
		toolCallId: string;
		agentType: string;
		task: string;
	}> = [];

	const taskUpdates: Array<{
		entryId: string;
		taskId?: string;
		status?: string;
	}> = [];

	const taskUpdateResults: Array<{
		entryId: string;
		toolCallId: string;
	}> = [];

	for (const step of t.steps) {
		if (step.kind === "tool_call") {
			if (step.toolName === "delegate_task") {
				const args = step.args || {};
				if (args.mode === "chain" && Array.isArray(args.chain)) {
					for (const item of args.chain) {
						delegateCalls.push({
							entryId: step.entryId,
							toolCallId: step.toolCallId || "",
							agentType: String(item.agent || "unknown"),
							task: typeof item.task === "string" ? item.task.slice(0, 200) : "",
						});
					}
				} else if (args.agent) {
					delegateCalls.push({
						entryId: step.entryId,
						toolCallId: step.toolCallId || "",
						agentType: String(args.agent),
						task: typeof args.task === "string" ? args.task.slice(0, 200) : "",
					});
				}
			}

			if (step.toolName === "TaskUpdate") {
				taskUpdates.push({
					entryId: step.entryId,
					taskId: step.args?.taskId as string | undefined,
					status: step.args?.status as string | undefined,
				});
			}
		}
	}

	// Check: implement/bug-fix without subsequent verify
	const implTypes = new Set(["implement", "bug-fix"]);
	const hasVerify = t.workersSpawned.some((w) => w.type === "verify");

	for (const call of delegateCalls) {
		if (implTypes.has(call.agentType) && !hasVerify) {
			findings.push({
				detectorId: "D5",
				severity: "medium",
				title: `"${call.agentType}" worker spawned without subsequent verify worker`,
				evidence: {
					entryIds: [call.entryId],
					excerpt: `Agent: ${call.agentType}\nTask: ${call.task.slice(0, 150)}`,
				},
				recommendation: "Best practice: always follow implement/bug-fix with a verify worker.",
			});
			break; // Report once
		}
	}

	// Check: TaskUpdate without status field
	const statusless = taskUpdates.filter((u) => !u.status);
	if (statusless.length > 0) {
		findings.push({
			detectorId: "D5",
			severity: "low",
			title: `${statusless.length} TaskUpdate call(s) without status field`,
			evidence: {
				entryIds: statusless.map((u) => u.entryId).slice(0, 5),
				excerpt: `TaskUpdate called ${statusless.length} time(s) without specifying status`,
			},
		});
	}

	// Check: Repeated TaskUpdate with same status for same task
	const updateByKey = new Map<string, { count: number; entryIds: string[] }>();
	for (const u of taskUpdates) {
		if (u.taskId && u.status) {
			const key = `${u.taskId}::${u.status}`;
			const existing = updateByKey.get(key) || { count: 0, entryIds: [] };
			existing.count++;
			existing.entryIds.push(u.entryId);
			updateByKey.set(key, existing);
		}
	}

	for (const [key, data] of updateByKey) {
		if (data.count >= 2) {
			const [taskId, status] = key.split("::");
			findings.push({
				detectorId: "D5",
				severity: "low",
				title: `TaskUpdate repeated: task "${taskId}" updated to "${status}" ${data.count}×`,
				evidence: {
					entryIds: data.entryIds,
					excerpt: `Task "${taskId}" received status "${status}" ${data.count} times`,
				},
			});
		}
	}

	// Check: > 3 delegate_task calls for similar tasks (re-implementation attempts)
	const taskGroups = new Map<string, { count: number; entryIds: string[] }>();
	for (const call of delegateCalls) {
		if (implTypes.has(call.agentType)) {
			// Group by first 100 chars of task description
			const key = call.task.slice(0, 100);
			const existing = taskGroups.get(key) || { count: 0, entryIds: [] };
			existing.count++;
			existing.entryIds.push(call.entryId);
			taskGroups.set(key, existing);
		}
	}

	for (const [taskDesc, data] of taskGroups) {
		if (data.count > 3) {
			findings.push({
				detectorId: "D5",
				severity: "high",
				title: `Excessive re-implementation: ${data.count} attempts at similar task`,
				evidence: {
					entryIds: data.entryIds,
					excerpt: `Task: "${taskDesc}..."\nAttempts: ${data.count}`,
				},
				recommendation: "Multiple implementation attempts suggest unclear requirements or approach. Consider re-planning.",
			});
		}
	}

	return findings;
};
