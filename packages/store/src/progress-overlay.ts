/**
 * FAN Store — Progress overlay with cancellable spinner.
 *
 * Lightweight bordered loader for TUI store operations.
 * Uses only @itone/fan-tui primitives (no coding-agent internals).
 */

import { CancellableLoader, Container, Spacer, Text, type TUI } from "@itone/fan-tui";

// ──────────────────────────────────────────────
// Minimal theme interface
// ──────────────────────────────────────────────

interface ThemeLike {
	fg(color: string, text: string): string;
}

// ──────────────────────────────────────────────
// ProgressOverlay
// ──────────────────────────────────────────────

/**
 * Cancellable spinner overlay with borders, status line, and cancel hint.
 *
 * Usage: pass to ctx.ui.custom() as factory return value. The overlay
 * auto-handles Escape via CancellableLoader and calls done() when work finishes.
 */
export class ProgressOverlay extends Container {
	private loader: CancellableLoader;
	private statusLine: Text;

	constructor(
		tui: TUI,
		theme: ThemeLike,
		initialMessage: string,
		onAbort?: () => void,
	) {
		super();

		// Top border
		this.addChild(new Text(theme.fg("border", "─".repeat(56)), 1, 0));
		this.addChild(new Spacer(1));

		// Cancellable spinner
		this.loader = new CancellableLoader(
			tui,
			(s) => theme.fg("accent", s),
			(s) => theme.fg("muted", s),
			initialMessage,
		);
		if (onAbort) {
			this.loader.onAbort = onAbort;
		}
		this.addChild(this.loader);

		// Status detail line (updated via setStatus)
		this.statusLine = new Text("", 1, 0);
		this.addChild(this.statusLine);

		this.addChild(new Spacer(1));

		// Cancel hint
		this.addChild(new Text(theme.fg("dim", "  Esc to cancel"), 1, 0));
		this.addChild(new Spacer(1));

		// Bottom border
		this.addChild(new Text(theme.fg("border", "─".repeat(56)), 1, 0));
	}

	/** AbortSignal that fires when user presses Escape. */
	get signal(): AbortSignal {
		return this.loader.signal;
	}

	/** Update the main spinner message. */
	setMessage(message: string): void {
		this.loader.setMessage(message);
	}

	/** Update the secondary status detail line. */
	setStatus(detail: string): void {
		this.statusLine.setText(`  ${detail}`);
	}

	/** Forward keyboard input to the loader (handles Escape). */
	handleInput(data: string): void {
		this.loader.handleInput(data);
	}

	dispose(): void {
		if ("dispose" in this.loader && typeof this.loader.dispose === "function") {
			this.loader.dispose();
		}
	}
}
