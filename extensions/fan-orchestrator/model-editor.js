/**
 * Custom inline model editor for `/orchestrator models` preset editing.
 *
 * Two-level TUI component that replaces the full wizard when editing an
 * existing preset:
 *   Level 1 (worker list): provider mode toggle, default model, one row per
 *           registered worker agent, Save / Cancel footer actions.
 *   Level 2 (model picker): all models from all providers (current provider
 *           first, others with `· provider` suffix), plus a reset entry.
 *
 * Keybindings:
 *   Up/Down (or j/k) — navigate
 *   Enter            — open picker / cycle provider mode / activate row
 *   Space            — quick save (list) or select model (picker)
 *   Esc              — cancel (list) or back to list (picker)
 *
 * TUI-only: in RPC/headless mode `ctx.ui.custom` returns undefined — callers
 * should detect this (isCustomUIAvailable) and fall back to the wizard flow.
 */
import { Container, Spacer, Text, getKeybindings } from "@seaagents/fan-tui";
import { getAgentTypes } from "./agents/index.js";

/** Built-in agent types — accessor over the agent registry (single source of truth). */
export function AGENT_TYPES() {
    return getAgentTypes();
}

const AGENT_ICONS = {
    explore: "🔍", plan: "📋", implement: "🔧", verify: "✅",
    "bug-fix": "🐛", "code-research": "🔬", "tests-impl": "🧪", "docs-impl": "📝",
    security: "🔒",
};

const PROVIDER_MODES = ["cloud", "local", "auto"];
const MODE_ICONS = { cloud: "☁️", local: "🏠", auto: "⚙️" };

const RESET_LABEL = "(reset — use session default)";
const SAVE_LABEL = "💾 Save changes";
const CANCEL_LABEL = "✖ Cancel";
const LIST_HINTS = "↑↓ navigate  Enter select/cycle  Space save  Esc cancel";
const PICKER_HINTS = "↑↓ navigate  Space/Enter select  Esc back";

/**
 * Horizontal border line that adjusts to viewport width.
 * (Same minimal local equivalent as preset-selector.js.)
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

/**
 * Format a model for display — same label format as `modelLabel` in
 * orchestrator-extension.js: `Name (id) 🧠📚 [$cost/M] [provider]`.
 */
function modelLabel(m) {
    if (!m) return "(none)";
    const name = m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id;
    const cost = (m.cost?.input || 0) + (m.cost?.output || 0);
    const costStr = cost > 0 ? `$${(cost).toFixed(1)}/M` : "free";
    const tags = [];
    if (m.reasoning) tags.push("🧠");
    if (m.contextWindow >= 500000) tags.push("📚");
    return `${name} ${tags.join("")} [${costStr}] [${m.provider}]`;
}

/** Extract the provider from a "provider/id" model reference ("" if bare id). */
function providerOf(value) {
    return typeof value === "string" && value.includes("/") ? value.split("/")[0] : "";
}

class ModelEditorComponent extends Container {
    /**
     * @param {Object} opts
     * @param {Object} opts.presetData - working copy { cloud, local, providerMode } (already cloned)
     * @param {string} opts.presetName
     * @param {Object[]} opts.allModels - from ctx.modelRegistry.getAvailable()
     * @param {Object} opts.theme - theme from the ctx.ui.custom factory callback
     * @param {Object} [opts.keybindings] - keybindings manager (falls back to getKeybindings())
     * @param {Object} [opts.tui] - TUI instance for requestRender()
     * @param {(result: {action: "save", data: {cloud, local, providerMode}}|undefined) => void} opts.onDone
     */
    constructor({ presetData, presetName, allModels, theme, keybindings, tui, onDone }) {
        super();
        this.presetName = presetName;
        this.allModels = Array.isArray(allModels) ? allModels : [];
        this.onDone = onDone;
        this.tui = tui;
        this.kb = keybindings || getKeybindings();
        this.finished = false;

        // Working copy — normalize shape so every section is editable.
        this.edited = presetData && typeof presetData === "object" ? presetData : {};
        for (const section of ["cloud", "local"]) {
            if (!this.edited[section] || typeof this.edited[section] !== "object" || Array.isArray(this.edited[section])) {
                this.edited[section] = { model: "", models: {} };
            }
            if (typeof this.edited[section].model !== "string") this.edited[section].model = "";
            if (!this.edited[section].models || typeof this.edited[section].models !== "object" || Array.isArray(this.edited[section].models)) {
                this.edited[section].models = {};
            }
        }
        if (!PROVIDER_MODES.includes(this.edited.providerMode)) this.edited.providerMode = "cloud";

        this.view = "list"; // "list" | "picker"
        this.selectedIndex = 0;
        this.pickerTarget = null; // { kind: "worker", worker } | { kind: "default" }
        this.pickerItems = [];
        this.pickerIndex = 0;

        const fg = (color, s) => theme?.fg?.(color, s) ?? s;
        const bold = (s) => theme?.bold?.(s) ?? s;
        this.accent = (s) => fg("accent", s);
        this.plain = (s) => fg("text", s);
        this.muted = (s) => fg("muted", s);
        const borderColor = (s) => fg("border", s);

        this.addChild(new BorderLine(borderColor));
        this.addChild(new Spacer(1));
        this.titleText = new Text("", 1, 0);
        this.addChild(this.titleText);
        this.addChild(new Spacer(1));
        this.listContainer = new Container();
        this.addChild(this.listContainer);
        this.addChild(new Spacer(1));
        this.hintsText = new Text("", 1, 0);
        this.addChild(this.hintsText);
        this.addChild(new Spacer(1));
        this.addChild(new BorderLine(borderColor));

        this.renderView();
    }

    /** The config section being edited for the current provider mode. */
    get section() {
        const mode = this.edited.providerMode === "local" ? "local" : "cloud";
        return this.edited[mode];
    }

    /** Selectable rows for the list view. */
    get listRows() {
        return [
            { kind: "providerMode" },
            { kind: "default" },
            ...AGENT_TYPES().map((worker) => ({ kind: "worker", worker })),
            { kind: "save" },
            { kind: "cancel" },
        ];
    }

    formatModelValue(value) {
        return value ? this.plain(value) : this.muted("(session default)");
    }

    renderView() {
        this.listContainer.clear();
        if (this.view === "list") this.renderListView();
        else this.renderPickerView();
    }

    renderListView() {
        this.titleText.setText(this.accent(this.presetName
            ? `Orchestrator Presets — Edit "${this.presetName}"`
            : "Orchestrator Presets — Edit preset"));
        this.hintsText.setText(this.muted(LIST_HINTS));

        const mode = this.edited.providerMode;
        const section = this.section;
        const rows = this.listRows;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const isSelected = i === this.selectedIndex;
            const cursor = isSelected ? this.accent("→ ") : "  ";
            let content;
            switch (row.kind) {
                case "providerMode":
                    content = `⚙️ Provider mode: ${MODE_ICONS[mode]} ${mode}`;
                    break;
                case "default":
                    content = `📦 Default model: ${this.formatModelValue(section.model)}`;
                    break;
                case "worker": {
                    const icon = AGENT_ICONS[row.worker] || "🤖";
                    const name = row.worker.padEnd(14);
                    const value = section.models[row.worker] || "";
                    content = `${icon} ${name} ─ ${this.formatModelValue(value)}`;
                    break;
                }
                case "save":
                    content = SAVE_LABEL;
                    break;
                case "cancel":
                    content = CANCEL_LABEL;
                    break;
                default:
                    content = "";
            }
            // Separator spacers: before workers block and before footer.
            if (row.kind === "worker" && rows[i - 1]?.kind === "default") {
                this.listContainer.addChild(new Spacer(1));
            }
            if (row.kind === "save") {
                this.listContainer.addChild(new Spacer(1));
            }
            const line = isSelected ? cursor + this.accent(content) : cursor + content;
            this.listContainer.addChild(new Text(line, 1, 0));
        }
    }

    renderPickerView() {
        const target = this.pickerTarget;
        const title = target?.kind === "worker"
            ? `Select model for ${AGENT_ICONS[target.worker] || "🤖"} ${target.worker}`
            : "Select default model";
        this.titleText.setText(this.accent(title));
        this.hintsText.setText(this.muted(PICKER_HINTS));

        for (let i = 0; i < this.pickerItems.length; i++) {
            const item = this.pickerItems[i];
            const isSelected = i === this.pickerIndex;
            const cursor = isSelected ? this.accent("→ ") : "  ";
            let content;
            if (item.kind === "reset") {
                content = RESET_LABEL;
            } else {
                content = item.label + (item.isCurrent ? this.muted(" ✓ current") : "");
            }
            const line = isSelected ? cursor + this.accent(content) : cursor + content;
            this.listContainer.addChild(new Text(line, 1, 0));
        }
    }

    /** Current model reference ("provider/id" or "") for the picker target. */
    currentTargetValue() {
        if (this.pickerTarget?.kind === "worker") {
            return this.section.models[this.pickerTarget.worker] || "";
        }
        return this.section.model || "";
    }

    applyTargetValue(value) {
        if (this.pickerTarget?.kind === "worker") {
            if (value) {
                this.section.models[this.pickerTarget.worker] = value;
            } else {
                delete this.section.models[this.pickerTarget.worker];
            }
        } else {
            this.section.model = value;
        }
    }

    openPicker(target) {
        this.pickerTarget = target;
        const currentValue = this.currentTargetValue();

        // Determine "current provider": provider of the row's current value,
        // else provider of the default model, else first provider alphabetically.
        let currentProvider = providerOf(currentValue) || providerOf(this.section.model);
        if (!currentProvider) {
            const providers = [...new Set(this.allModels.map((m) => m.provider))].sort();
            currentProvider = providers[0] || "";
        }

        const isCurrent = (m) =>
            currentValue === `${m.provider}/${m.id}` ||
            (!currentValue.includes("/") && currentValue === m.id);

        const own = [];
        const othersByProvider = new Map();
        for (const m of this.allModels) {
            if (m.provider === currentProvider) {
                own.push(m);
            } else {
                if (!othersByProvider.has(m.provider)) othersByProvider.set(m.provider, []);
                othersByProvider.get(m.provider).push(m);
            }
        }
        const otherProviders = [...othersByProvider.keys()].sort((a, b) => a.localeCompare(b));

        this.pickerItems = [
            ...own.map((m) => ({ kind: "model", model: m, value: `${m.provider}/${m.id}`, label: modelLabel(m), isCurrent: isCurrent(m) })),
            ...otherProviders.flatMap((p) =>
                othersByProvider.get(p).map((m) => ({
                    kind: "model",
                    model: m,
                    value: `${m.provider}/${m.id}`,
                    label: `${modelLabel(m)} · ${m.provider}`,
                    isCurrent: isCurrent(m),
                })),
            ),
            { kind: "reset", value: "" },
        ];

        // Pre-select the current model (or the reset row when empty).
        const idx = this.pickerItems.findIndex((it) => it.kind === "model" && it.isCurrent);
        this.pickerIndex = idx >= 0 ? idx : this.pickerItems.length - 1;

        this.view = "picker";
        this.renderView();
    }

    closePicker(apply) {
        if (apply) {
            const item = this.pickerItems[this.pickerIndex];
            if (item) this.applyTargetValue(item.kind === "reset" ? "" : item.value);
        }
        this.view = "list";
        this.pickerTarget = null;
        this.pickerItems = [];
        this.pickerIndex = 0;
        this.renderView();
    }

    cycleProviderMode() {
        const idx = PROVIDER_MODES.indexOf(this.edited.providerMode);
        this.edited.providerMode = PROVIDER_MODES[(idx + 1) % PROVIDER_MODES.length];
        this.renderView();
    }

    save() {
        this.finish({
            action: "save",
            data: {
                cloud: this.edited.cloud,
                local: this.edited.local,
                providerMode: this.edited.providerMode,
            },
        });
    }

    finish(result) {
        if (this.finished) return;
        this.finished = true;
        this.onDone(result);
    }

    handleInput(keyData) {
        if (this.finished) return;
        const kb = this.kb || getKeybindings();
        const isUp = kb.matches(keyData, "tui.select.up") || keyData === "k";
        const isDown = kb.matches(keyData, "tui.select.down") || keyData === "j";
        const isConfirm = kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\r";
        const isCancel = kb.matches(keyData, "tui.select.cancel");
        const isSpace = keyData === " ";

        if (this.view === "list") {
            const rows = this.listRows;
            if (isUp) {
                this.selectedIndex = Math.max(0, this.selectedIndex - 1);
                this.renderView();
            } else if (isDown) {
                this.selectedIndex = Math.min(rows.length - 1, this.selectedIndex + 1);
                this.renderView();
            } else if (isConfirm) {
                const row = rows[this.selectedIndex];
                if (row.kind === "providerMode") this.cycleProviderMode();
                else if (row.kind === "default") this.openPicker({ kind: "default" });
                else if (row.kind === "worker") this.openPicker({ kind: "worker", worker: row.worker });
                else if (row.kind === "save") return this.save();
                else if (row.kind === "cancel") return this.finish(undefined);
            } else if (isSpace) {
                // Space — quick save from anywhere in the list.
                return this.save();
            } else if (isCancel) {
                return this.finish(undefined);
            }
        } else {
            // picker view
            if (isUp) {
                this.pickerIndex = Math.max(0, this.pickerIndex - 1);
                this.renderView();
            } else if (isDown) {
                this.pickerIndex = Math.min(this.pickerItems.length - 1, this.pickerIndex + 1);
                this.renderView();
            } else if (isConfirm || isSpace) {
                this.closePicker(true);
            } else if (isCancel) {
                this.closePicker(false);
            }
        }
        this.tui?.requestRender?.();
    }

    dispose() {}
}

/**
 * Show the inline model editor for an existing preset.
 *
 * @param {Object} opts
 * @param {Object} opts.presetData - preset snapshot { cloud, local, providerMode } (deep-cloned internally)
 * @param {string} opts.presetName
 * @param {Object[]} opts.allModels - from ctx.modelRegistry.getAvailable()
 * @param {Object} opts.ctx - extension command context (needs ctx.ui.custom)
 * @returns {Promise<{action: "save", data: {cloud, local, providerMode}}|undefined>}
 *   undefined when cancelled (Esc/Cancel) or when custom UI is unavailable (RPC mode).
 */
export async function showModelEditor(opts) {
    const { presetData, presetName = "", allModels = [], ctx } = opts || {};
    if (!ctx?.ui || typeof ctx.ui.custom !== "function") return undefined;
    let workingCopy;
    try {
        workingCopy = structuredClone(presetData ?? {});
    } catch {
        workingCopy = JSON.parse(JSON.stringify(presetData ?? {}));
    }
    try {
        return await ctx.ui.custom((tui, theme, keybindings, done) => {
            return new ModelEditorComponent({
                presetData: workingCopy,
                presetName,
                allModels,
                theme,
                keybindings,
                tui,
                onDone: done,
            });
        });
    } catch (err) {
        const message = `[FAN Orchestrator] Custom model editor failed: ${err?.message ?? err}`;
        if (ctx?.ui?.notify) {
            ctx.ui.notify(message, "warn");
        } else {
            console.warn(message);
        }
        return undefined;
    }
}
