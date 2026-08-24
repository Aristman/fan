/**
 * Per-toolCall watchdog timer manager.
 *
 * Maintains an independent timeout timer for each active tool call so that
 * parallel tool executions do not interfere with each other.  Each timer is
 * keyed by `toolCallId`; arming, resetting and cancelling one tool call has no
 * effect on other active timers.
 */

export interface WatchdogEntry {
	timer: ReturnType<typeof setTimeout>;
	toolName: string;
	lastResetAt: number;
}

export interface WatchdogTimeoutEvent {
	toolCallId: string;
	toolName: string;
	elapsedMs: number;
}

export interface WatchdogCallbacks {
	/** Called when a timer fires. Receives the entry metadata. */
	onTimeout: (event: WatchdogTimeoutEvent) => void;
	/** Returns the timeout duration in ms. Called on every arm / reset. */
	getTimeoutMs: () => number;
	/** Returns whether the watchdog is enabled. */
	isEnabled: () => boolean;
}

export class WatchdogTimer {
	private _timers: Map<string, WatchdogEntry> = new Map();
	private _callbacks: WatchdogCallbacks;

	constructor(callbacks: WatchdogCallbacks) {
		this._callbacks = callbacks;
	}

	/** Number of currently active timers. */
	get size(): number {
		return this._timers.size;
	}

	/**
	 * Arm (or re-arm) the watchdog for a specific tool call.
	 * If a timer already exists for this toolCallId it is replaced.
	 * Other timers are not affected.
	 */
	arm(toolCallId: string, toolName: string): void {
		if (!this._callbacks.isEnabled()) return;
		const timeoutMs = this._resolveTimeout();
		if (timeoutMs <= 0) return;

		// Clear any existing timer for this id.
		this._clearEntry(toolCallId);

		const now = Date.now();
		const timer = setTimeout(() => {
			this._onTimeout(toolCallId);
		}, timeoutMs);

		this._timers.set(toolCallId, { timer, toolName, lastResetAt: now });
	}

	/**
	 * Reset the timer for a specific tool call without changing its metadata.
	 * No-op if no timer exists for the given toolCallId.
	 */
	reset(toolCallId: string): void {
		const entry = this._timers.get(toolCallId);
		if (entry === undefined) return;

		if (!this._callbacks.isEnabled()) {
			this.cancel(toolCallId);
			return;
		}
		const timeoutMs = this._resolveTimeout();
		if (timeoutMs <= 0) {
			this.cancel(toolCallId);
			return;
		}

		clearTimeout(entry.timer);
		const now = Date.now();
		entry.timer = setTimeout(() => {
			this._onTimeout(toolCallId);
		}, timeoutMs);
		entry.lastResetAt = now;
	}

	/** Cancel the timer for a specific tool call. No-op if not found. */
	cancel(toolCallId: string): void {
		this._clearEntry(toolCallId);
	}

	/** Cancel all active timers. */
	cancelAll(): void {
		for (const [id] of this._timers) {
			this._clearEntry(id);
		}
	}

	/** Alias for cancelAll — used on session dispose. */
	dispose(): void {
		this.cancelAll();
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	private _resolveTimeout(): number {
		return this._callbacks.getTimeoutMs();
	}

	private _clearEntry(toolCallId: string): void {
		const entry = this._timers.get(toolCallId);
		if (entry !== undefined) {
			clearTimeout(entry.timer);
			this._timers.delete(toolCallId);
		}
	}

	private _onTimeout(toolCallId: string): void {
		const entry = this._timers.get(toolCallId);
		if (entry === undefined) return; // already cancelled

		const elapsedMs = Date.now() - entry.lastResetAt;
		const toolName = entry.toolName;

		// Remove the entry before invoking the callback so that re-entrant
		// calls see a clean state.
		this._timers.delete(toolCallId);

		this._callbacks.onTimeout({ toolCallId, toolName, elapsedMs });
	}
}
