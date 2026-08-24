/**
 * Task persistence — orchestrator task-board snapshot hooks (F-48).
 *
 * Two pure functions, unit-testable in isolation (no dependency on the full
 * orchestrator-extension wiring):
 *
 *   writeTaskSnapshot(fan, taskManager)
 *     Persists the current board as a custom JSONL entry via fan.appendEntry.
 *     Never throws — persistence must not break task mutation hooks.
 *
 *   restoreTasks(fan, taskManager)
 *     Reads the board back via fan.getCustomEntries and deserializes the LAST
 *     snapshot. Missing API / no entries / malformed data → quiet no-op with
 *     an empty board (backward compatibility with pre-F-48 sessions).
 */
/** customType used for task-board snapshot entries */
export const TASK_SNAPSHOT_TYPE = "orchestrator-task-snapshot";
/**
 * Persist the current task board as a session snapshot.
 * Safe to call after every task mutation; failures are logged, never thrown.
 */
export function writeTaskSnapshot(fan, taskManager) {
	try {
		fan.appendEntry(TASK_SNAPSHOT_TYPE, taskManager.serialize());
	} catch (err) {
		console.warn("[FAN Orchestrator] writeTaskSnapshot failed:", err?.message ?? err);
	}
}
/**
 * Restore the task board from the last snapshot of this session.
 * Backward compatible: if the read-API is unavailable or no snapshot exists,
 * the board stays as-is (empty on a fresh session) and nothing throws.
 */
export function restoreTasks(fan, taskManager) {
	try {
		if (!fan || typeof fan.getCustomEntries !== "function") return;
		const entries = fan.getCustomEntries(TASK_SNAPSHOT_TYPE);
		if (!Array.isArray(entries) || entries.length === 0) return;
		const last = entries[entries.length - 1];
		taskManager.deserialize(last?.data);
	} catch (err) {
		console.warn("[FAN Orchestrator] restoreTasks failed:", err?.message ?? err);
	}
}
