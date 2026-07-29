/**
 * Custom preset selector component for `/orchestrator models`.
 *
 * A bordered TUI list of orchestrator model presets with extended keybindings:
 *   Up/Down (or j/k) — navigate
 *   Space            — activate the highlighted preset (apply + mark ⭐)
 *   Enter            — view preset details (summary + Edit/Rename/Delete/Back)
 *   Esc              — cancel
 *
 * In RPC/headless mode `ctx.ui.custom` returns undefined without invoking the
 * factory — use `isCustomUIAvailable()` to detect this and fall back to
 * `ctx.ui.select`.
 */
import { Container, Spacer, Text, getKeybindings } from "@seaagents/fan-tui";

const CREATE_LABEL = "➕ Create new preset";
const TITLE = "Orchestrator Presets";
const HINTS = "↑↓ navigate  Space activate  Enter details  Esc cancel";

/**
 * Horizontal border line that adjusts to viewport width.
 * (DynamicBorder is not exported from @seaagents/fan-tui, so this is a
 * minimal local equivalent.)
 */
class BorderLine {
    constructor(colorFn) {
        this.colorFn = colorFn || ((s) => s);
    }
    invalidate() {}
    render(width) {
        return [this.colorFn("─".repeat(Math.max(1, width)))];
    }
}

class PresetSelectorComponent extends Container {
    /**
     * @param {Object} opts
     * @param {string[]} opts.presets - preset names
     * @param {string|null} opts.activePreset - currently active preset name
     * @param {Object} opts.theme - theme from the ctx.ui.custom factory callback
     * @param {Object} [opts.keybindings] - keybindings manager (falls back to getKeybindings())
     * @param {Object} [opts.tui] - TUI instance for requestRender()
     * @param {(result: {action: "view"|"activate"|"create", preset?: string}|undefined) => void} opts.onDone
     */
    constructor({ presets, activePreset, theme, keybindings, tui, onDone }) {
        super();
        this.presets = presets;
        this.activePreset = activePreset ?? null;
        this.items = [...presets, CREATE_LABEL];
        this.selectedIndex = 0;
        this.onDone = onDone;
        this.tui = tui;
        this.kb = keybindings || getKeybindings();
        this.finished = false;

        const fg = (color, s) => theme?.fg?.(color, s) ?? s;
        const bold = (s) => theme?.bold?.(s) ?? s;
        this.accent = (s) => fg("accent", s);
        this.plain = (s) => fg("text", s);
        this.muted = (s) => fg("muted", s);
        const borderColor = (s) => fg("border", s);

        this.addChild(new BorderLine(borderColor));
        this.addChild(new Spacer(1));
        this.addChild(new Text(this.accent(bold(TITLE)), 1, 0));
        this.addChild(new Spacer(1));
        this.listContainer = new Container();
        this.addChild(this.listContainer);
        this.addChild(new Spacer(1));
        this.addChild(new Text(this.muted(HINTS), 1, 0));
        this.addChild(new Spacer(1));
        this.addChild(new BorderLine(borderColor));

        this.updateList();
    }

    updateList() {
        this.listContainer.clear();
        for (let i = 0; i < this.items.length; i++) {
            const isSelected = i === this.selectedIndex;
            const name = this.items[i];
            const label =
                name === CREATE_LABEL
                    ? name
                    : name === this.activePreset
                      ? `⭐ ${name} (active)`
                      : name;
            const line = isSelected
                ? this.accent("→ ") + this.accent(label)
                : `  ${this.plain(label)}`;
            this.listContainer.addChild(new Text(line, 1, 0));
        }
    }

    finish(result) {
        if (this.finished) return;
        this.finished = true;
        this.onDone(result);
    }

    handleInput(keyData) {
        if (this.finished) return;
        const kb = this.kb || getKeybindings();
        if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
            this.selectedIndex = Math.max(0, this.selectedIndex - 1);
            this.updateList();
        } else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
            this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
            this.updateList();
        } else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r") {
            const name = this.items[this.selectedIndex];
            if (name === CREATE_LABEL) return this.finish({ action: "create" });
            return this.finish({ action: "view", preset: name });
        } else if (kb.matches(keyData, "tui.select.cancel")) {
            return this.finish(undefined);
        } else if (keyData === " ") {
            // Space — activate the highlighted preset (no-op on "Create new preset")
            const name = this.items[this.selectedIndex];
            if (name !== CREATE_LABEL) return this.finish({ action: "activate", preset: name });
        }
        this.tui?.requestRender?.();
    }

    dispose() {}
}

/**
 * Detect whether custom TUI components are available (TUI mode) or not
 * (RPC/headless mode). In RPC mode `ctx.ui.custom` returns undefined
 * immediately without calling the factory; in TUI mode the factory is called
 * synchronously, so a probe that calls `done(true)` resolves to true without
 * flashing any UI.
 *
 * @param {Object} ctx - extension command context
 * @returns {Promise<boolean>}
 */
export async function isCustomUIAvailable(ctx) {
    if (!ctx?.ui || typeof ctx.ui.custom !== "function") return false;
    try {
        const probe = await ctx.ui.custom((_tui, _theme, _kb, done) => {
            done(true);
            return {
                render() { return []; },
                handleInput() {},
                invalidate() {},
                dispose() {},
            };
        });
        return probe === true;
    } catch {
        return false;
    }
}

/**
 * Show the preset selector component.
 *
 * @param {Object} opts
 * @param {string[]} opts.presets - preset names
 * @param {string|null} opts.activePreset - currently active preset name
 * @param {Object} opts.ctx - extension command context (needs ctx.ui.custom)
 * @returns {Promise<{action: "view"|"activate"|"create", preset?: string}|undefined>}
 *   undefined when cancelled (Esc) or when custom UI is unavailable (RPC mode).
 */
export async function showPresetSelector(opts) {
    const { presets, activePreset = null, ctx } = opts || {};
    if (!Array.isArray(presets) || presets.length === 0) return undefined;
    if (!ctx?.ui || typeof ctx.ui.custom !== "function") return undefined;
    try {
        return await ctx.ui.custom((tui, theme, keybindings, done) => {
            return new PresetSelectorComponent({
                presets,
                activePreset,
                theme,
                keybindings,
                tui,
                onDone: done,
            });
        });
    } catch (err) {
        const message = `[FAN Orchestrator] Custom preset selector failed: ${err?.message ?? err}`;
        if (ctx?.ui?.notify) {
            ctx.ui.notify(message, "warn");
        } else {
            console.warn(message);
        }
        return undefined;
    }
}
