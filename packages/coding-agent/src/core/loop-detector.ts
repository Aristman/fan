/**
 * LoopDetector — detects repeated identical tool failures (F-04).
 *
 * Signature: toolName + JSON-hash(args) + normalized error message.
 * When the same signature appears `threshold` times in a row the detector
 * fires an `onLoopDetected` callback.  Only a successful (non-error) call
 * with the *same* tool + args resets that specific series counter.
 *
 * Pattern mirrors WatchdogTimer (callback-based, deterministic, no timers).
 */

// ============================================================================
// Public types
// ============================================================================

export interface LoopDetectorDiagnostic {
	reason: "loop_detected";
	tool: string;
	error: string;
	count: number;
}

export interface LoopDetectorCallbacks {
	/** Called when the threshold is reached. */
	onLoopDetected: (diagnostic: LoopDetectorDiagnostic) => void;
	/** Returns the current threshold (minimum consecutive matches to fire). */
	getThreshold: () => number;
	/** Returns whether the detector is enabled. */
	isEnabled: () => boolean;
}

// ============================================================================
// Internal types
// ============================================================================

interface PendingCall {
	toolName: string;
	argsHash: string;
}

interface ErrorSignature {
	toolName: string;
	argsHash: string;
	error: string;
}

// ============================================================================
// Class
// ============================================================================

export class LoopDetector {
	private _pending: Map<string, PendingCall> = new Map();
	private _lastSig: ErrorSignature | undefined;
	private _count = 0;
	private _fired = false;
	private _callbacks: LoopDetectorCallbacks;

	constructor(callbacks: LoopDetectorCallbacks) {
		this._callbacks = callbacks;
	}

	// ------------------------------------------------------------------
	// Lifecycle hooks — called from AgentSession._processAgentEvent
	// ------------------------------------------------------------------

	/**
	 * Record a tool call start so we can match it on end.
	 * No-op when disabled.
	 */
	onToolStart(toolCallId: string, toolName: string, args: unknown): void {
		if (!this._callbacks.isEnabled()) return;
		this._pending.set(toolCallId, { toolName, argsHash: hashToolCall(toolName, args) });
	}

	/**
	 * Process a tool call outcome.
	 * - Success with same tool+args as last error → reset that series counter.
	 * - Error → compare signature; increment or reset counter; fire if threshold reached.
	 */
	onToolEnd(toolCallId: string, isError: boolean, errorText: string | undefined): void {
		if (!this._callbacks.isEnabled()) return;

		const start = this._pending.get(toolCallId);
		if (!start) return;
		this._pending.delete(toolCallId);

		if (!isError) {
			// A successful call resets the counter ONLY if it matches the
			// last error series (same tool + args).  A different tool's
			// success does not reset an unrelated error series.
			if (this._lastSig && this._lastSig.toolName === start.toolName && this._lastSig.argsHash === start.argsHash) {
				this._lastSig = undefined;
				this._count = 0;
			}
			return;
		}

		const error = normalizeErrorText(errorText ?? "");
		const sig: ErrorSignature = { toolName: start.toolName, argsHash: start.argsHash, error };

		if (
			this._lastSig &&
			this._lastSig.toolName === sig.toolName &&
			this._lastSig.argsHash === sig.argsHash &&
			this._lastSig.error === sig.error
		) {
			this._count++;
		} else {
			this._lastSig = sig;
			this._count = 1;
		}

		if (this._count >= this._callbacks.getThreshold() && !this._fired) {
			this._fired = true;
			this._callbacks.onLoopDetected({
				reason: "loop_detected",
				tool: start.toolName,
				error,
				count: this._count,
			});
		}
	}

	/** Reset all internal state. */
	reset(): void {
		this._pending.clear();
		this._lastSig = undefined;
		this._count = 0;
		this._fired = false;
	}

	/** Alias for reset — used on session dispose. */
	dispose(): void {
		this.reset();
	}
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Deterministic JSON serialization of tool arguments with sorted keys.
 * `{a:1,b:2}` and `{b:2,a:1}` produce the same hash.
 * Handles circular references safely — falls back to a unique marker
 * (not `"[object Object]"`) on failure.
 */
export function hashToolCall(toolName: string, args: unknown): string {
	try {
		const sorted = canonicalStringify(args ?? {});
		return `${toolName}:${sorted}`;
	} catch {
		return `${toolName}:__circular_${typeof args === "object" && args !== null ? (args.constructor?.name ?? "obj") : String(args)}`;
	}
}

/**
 * Recursively stringify a value with sorted object keys.
 * Throws on circular references so the caller can fall back.
 */
function canonicalStringify(value: unknown, seen?: WeakSet<object>): string {
	if (value === null || value === undefined) return JSON.stringify(value);
	if (typeof value !== "object") return JSON.stringify(value);

	if (seen?.has(value as object)) {
		throw new Error("circular reference");
	}

	if (Array.isArray(value)) {
		const newSeen = seen ?? new WeakSet();
		newSeen.add(value as object);
		const items = value.map((v) => canonicalStringify(v, newSeen));
		return `[${items.join(",")}]`;
	}

	const obj = value as Record<string, unknown>;
	const newSeen = seen ?? new WeakSet();
	newSeen.add(obj);
	const keys = Object.keys(obj).sort();
	const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k], newSeen)}`);
	return `{${pairs.join(",")}}`;
}

/**
 * Normalize volatile fragments in error text so the same logical error
 * with different paths/PIDs/line-numbers produces the same signature.
 *
 * Replacements:
 * - `/tmp/...` paths → `<PATH>`
 * - PID patterns (`pid 12345`, `PID=12345`) → `<PID>`
 * - Line/column references (`:123:45`) → `:<LINE>:<COL>`
 */
export function normalizeErrorText(text: string): string {
	return text
		.replace(/\/tmp\/[^\s:)]+/g, "<PATH>")
		.replace(/(?<=\bpid\s*)\d+/gi, "<PID>")
		.replace(/(?<=\bPID[=:])\d+/gi, "<PID>")
		.replace(/:\d+:\d+/g, ":<LINE>:<COL>");
}
