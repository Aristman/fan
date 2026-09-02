import { describe, it, expect, vi } from "vitest";
import { showModelEditor, AGENT_TYPES } from "../model-editor.js";

const mockTheme = { fg: (_color, s) => s, bold: (s) => s };

const MODELS = [
  { id: "k3", provider: "kimi-coding", cost: { input: 0.5, output: 0 }, contextWindow: 128000 },
  { id: "kimi-k2.5", provider: "kimi-coding", cost: { input: 0.3, output: 0 }, contextWindow: 128000 },
  { id: "claude-3-7-sonnet", provider: "anthropic", cost: { input: 3, output: 0 }, contextWindow: 200000, reasoning: true },
  { id: "gpt-4o", provider: "openai", cost: { input: 2.5, output: 0 }, contextWindow: 128000 },
];

function makePreset() {
  return {
    cloud: { model: "kimi-coding/k3", models: { explore: "kimi-coding/kimi-k2.5" } },
    local: { model: "", models: {} },
    providerMode: "cloud",
  };
}

/**
 * Build a mock ctx whose ctx.ui.custom behaves like TUI mode:
 * the factory is called synchronously and the returned promise
 * resolves with whatever the component passes to done().
 */
function makeTuiCtx() {
  const state = { component: null, renderRequested: 0 };
  const ctx = {
    hasUI: true,
    ui: {
      custom: (factory) =>
        new Promise((resolve) => {
          const tui = { requestRender: () => state.renderRequested++ };
          state.component = factory(tui, mockTheme, undefined, resolve);
        }),
    },
  };
  return { ctx, state };
}

// List row indices: 0 providerMode, 1 default, 2..(N+1) workers, then save, cancel.
// Worker count derives from the agent registry (single source of truth since F-0.1).
const WORKER_COUNT = AGENT_TYPES().length;
const ROW_PROVIDER_MODE = 0;
const ROW_DEFAULT = 1;
const ROW_EXPLORE = 2; // first worker
const ROW_SAVE = 2 + WORKER_COUNT;
const ROW_CANCEL = ROW_SAVE + 1;

function moveTo(component, rowIndex) {
  // navigate up to top first, then down to the target row
  for (let i = 0; i < 20; i++) component.handleInput("k");
  for (let i = 0; i < rowIndex; i++) component.handleInput("j");
}

describe("showModelEditor", () => {
  it("returns undefined in RPC mode (custom resolves undefined)", async () => {
    const ctx = { hasUI: true, ui: { custom: async () => undefined } };
    expect(
      await showModelEditor({ presetData: makePreset(), presetName: "p", allModels: MODELS, ctx }),
    ).toBeUndefined();
  });

  it("returns undefined when ctx.ui.custom is missing", async () => {
    expect(
      await showModelEditor({ presetData: makePreset(), presetName: "p", allModels: MODELS, ctx: { ui: {} } }),
    ).toBeUndefined();
    expect(await showModelEditor({ presetData: makePreset(), presetName: "p", allModels: MODELS, ctx: null })).toBeUndefined();
  });

  it("logs and returns undefined when the custom UI factory throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = {
      ui: {
        custom: async () => {
          throw new Error("boom");
        },
      },
    };
    expect(
      await showModelEditor({ presetData: makePreset(), presetName: "p", allModels: MODELS, ctx }),
    ).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Custom model editor failed"));
    warnSpy.mockRestore();
  });

  it("save returns the correct data structure (Space quick-save)", async () => {
    const preset = makePreset();
    const { ctx, state } = makeTuiCtx();
    const promise = showModelEditor({ presetData: preset, presetName: "kimi-setup", allModels: MODELS, ctx });
    state.component.handleInput(" "); // Space — quick save
    const result = await promise;
    expect(result).toEqual({
      action: "save",
      data: {
        cloud: { model: "kimi-coding/k3", models: { explore: "kimi-coding/kimi-k2.5" } },
        local: { model: "", models: {} },
        providerMode: "cloud",
      },
    });
    // Original preset must not be mutated by the editor
    expect(preset).toEqual(makePreset());
  });

  it("Enter on the Save row returns { action: 'save' }", async () => {
    const { ctx, state } = makeTuiCtx();
    const promise = showModelEditor({ presetData: makePreset(), presetName: "p", allModels: MODELS, ctx });
    moveTo(state.component, ROW_SAVE);
    state.component.handleInput("\r");
    const result = await promise;
    expect(result?.action).toBe("save");
  });

  it("Esc returns undefined (cancel)", async () => {
    const { ctx, state } = makeTuiCtx();
    const promise = showModelEditor({ presetData: makePreset(), presetName: "p", allModels: MODELS, ctx });
    state.component.handleInput("\x1b");
    expect(await promise).toBeUndefined();
  });

  it("Enter on the Cancel row returns undefined", async () => {
    const { ctx, state } = makeTuiCtx();
    const promise = showModelEditor({ presetData: makePreset(), presetName: "p", allModels: MODELS, ctx });
    moveTo(state.component, ROW_CANCEL);
    state.component.handleInput("\r");
    expect(await promise).toBeUndefined();
  });

  it("cancel discards edits (working copy is a deep clone)", async () => {
    const preset = makePreset();
    const { ctx, state } = makeTuiCtx();
    const promise = showModelEditor({ presetData: preset, presetName: "p", allModels: MODELS, ctx });
    const c = state.component;
    moveTo(c, ROW_PROVIDER_MODE);
    c.handleInput("\r"); // cloud → local
    c.handleInput("\x1b"); // cancel
    expect(await promise).toBeUndefined();
    expect(preset).toEqual(makePreset());
  });

  it("cycles provider mode cloud → local → auto → cloud on Enter", async () => {
    const { ctx, state } = makeTuiCtx();
    const promise = showModelEditor({ presetData: makePreset(), presetName: "p", allModels: MODELS, ctx });
    const c = state.component;
    moveTo(c, ROW_PROVIDER_MODE);
    expect(c.edited.providerMode).toBe("cloud");
    c.handleInput("\r");
    expect(c.edited.providerMode).toBe("local");
    c.handleInput("\r");
    expect(c.edited.providerMode).toBe("auto");
    c.handleInput("\r");
    expect(c.edited.providerMode).toBe("cloud");
    c.handleInput(" "); // save
    expect((await promise)?.data.providerMode).toBe("cloud");
  });

  it("persists a changed provider mode in the save result", async () => {
    const { ctx, state } = makeTuiCtx();
    const promise = showModelEditor({ presetData: makePreset(), presetName: "p", allModels: MODELS, ctx });
    const c = state.component;
    moveTo(c, ROW_PROVIDER_MODE);
    c.handleInput("\r"); // cloud → local
    c.handleInput(" "); // save
    const result = await promise;
    expect(result?.data.providerMode).toBe("local");
  });

  it("selecting a model in the picker updates the working copy", async () => {
    const { ctx, state } = makeTuiCtx();
    const promise = showModelEditor({ presetData: makePreset(), presetName: "p", allModels: MODELS, ctx });
    const c = state.component;
    moveTo(c, ROW_EXPLORE);
    c.handleInput("\r"); // open picker for explore
    expect(c.view).toBe("picker");
    // Picker order: kimi-coding models first (k3, kimi-k2.5), then anthropic, openai, reset.
    // Current value is kimi-k2.5 (pre-selected index 1). Move down twice → openai/gpt-4o.
    c.handleInput("j");
    c.handleInput("j");
    c.handleInput("\r"); // select
    expect(c.view).toBe("list");
    c.handleInput(" "); // save
    const result = await promise;
    expect(result?.data.cloud.models.explore).toBe("openai/gpt-4o");
    expect(state.renderRequested).toBeGreaterThan(0);
  });

  it("picker groups current provider first, others with · provider suffix, reset last", async () => {
    const { ctx, state } = makeTuiCtx();
    const promise = showModelEditor({ presetData: makePreset(), presetName: "p", allModels: MODELS, ctx });
    const c = state.component;
    moveTo(c, ROW_EXPLORE);
    c.handleInput("\r"); // open picker
    const values = c.pickerItems.map((it) => (it.kind === "reset" ? "(reset)" : it.value));
    expect(values).toEqual([
      "kimi-coding/k3",
      "kimi-coding/kimi-k2.5",
      "anthropic/claude-3-7-sonnet",
      "openai/gpt-4o",
      "(reset)",
    ]);
    // current provider items have no suffix; others do
    expect(c.pickerItems[0].label).not.toContain("·");
    expect(c.pickerItems[2].label).toContain("· anthropic");
    expect(c.pickerItems[3].label).toContain("· openai");
    // current model is marked and pre-selected
    expect(c.pickerItems[1].isCurrent).toBe(true);
    expect(c.pickerIndex).toBe(1);
    c.handleInput("\x1b"); // back
    c.handleInput("\x1b"); // cancel editor
    await promise;
  });

  it("Esc in the picker returns to the list without changes", async () => {
    const { ctx, state } = makeTuiCtx();
    const promise = showModelEditor({ presetData: makePreset(), presetName: "p", allModels: MODELS, ctx });
    const c = state.component;
    moveTo(c, ROW_EXPLORE);
    c.handleInput("\r"); // open picker
    c.handleInput("j");
    c.handleInput("\x1b"); // back without change
    expect(c.view).toBe("list");
    c.handleInput(" "); // save
    const result = await promise;
    expect(result?.data.cloud.models.explore).toBe("kimi-coding/kimi-k2.5");
  });

  it("reset option clears the model for a worker", async () => {
    const { ctx, state } = makeTuiCtx();
    const promise = showModelEditor({ presetData: makePreset(), presetName: "p", allModels: MODELS, ctx });
    const c = state.component;
    moveTo(c, ROW_EXPLORE);
    c.handleInput("\r"); // open picker
    for (let i = 0; i < 10; i++) c.handleInput("j"); // clamp at bottom → reset row
    c.handleInput("\r"); // select reset
    c.handleInput(" "); // save
    const result = await promise;
    expect(result?.data.cloud.models).not.toHaveProperty("explore");
  });

  it("edits the default model via the default row picker", async () => {
    const { ctx, state } = makeTuiCtx();
    const promise = showModelEditor({ presetData: makePreset(), presetName: "p", allModels: MODELS, ctx });
    const c = state.component;
    moveTo(c, ROW_DEFAULT);
    c.handleInput("\r"); // open picker for default model
    expect(c.pickerTarget?.kind).toBe("default");
    c.handleInput("j"); // move down from k3 → kimi-k2.5
    c.handleInput(" "); // Space also selects in picker
    c.handleInput(" "); // save
    const result = await promise;
    expect(result?.data.cloud.model).toBe("kimi-coding/kimi-k2.5");
  });

  it("renders the worker list with title, rows, footer, and key hints", async () => {
    const { ctx, state } = makeTuiCtx();
    const promise = showModelEditor({ presetData: makePreset(), presetName: "kimi-setup", allModels: MODELS, ctx });
    const lines = state.component.render(60).join("\n");
    expect(lines).toContain('Orchestrator Presets — Edit "kimi-setup"');
    expect(lines).toContain("⚙️ Provider mode: ☁️ cloud");
    expect(lines).toContain("📦 Default model: kimi-coding/k3");
    expect(lines).toContain("🔍 explore");
    expect(lines).toContain("kimi-coding/kimi-k2.5");
    expect(lines).toContain("📝 docs-impl");
    expect(lines).toContain("(session default)");
    expect(lines).toContain("💾 Save changes");
    expect(lines).toContain("✖ Cancel");
    expect(lines).toContain("↑↓ navigate  Enter select/cycle  Space save  Esc cancel");
    expect(lines).toContain("─".repeat(20));
    expect(lines).toContain("→ ⚙️ Provider mode"); // cursor on first row
    state.component.handleInput("\x1b");
    await promise;
  });

  it("ignores input after finishing", async () => {
    const { ctx, state } = makeTuiCtx();
    const promise = showModelEditor({ presetData: makePreset(), presetName: "p", allModels: MODELS, ctx });
    const c = state.component;
    c.handleInput(" ");
    c.handleInput("j"); // should not throw or change result
    c.handleInput("\r");
    expect((await promise)?.action).toBe("save");
  });
});
