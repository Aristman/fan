import { describe, it, expect, vi } from "vitest";
import { isCustomUIAvailable, showPresetSelector } from "../preset-selector.js";

const mockTheme = { fg: (_color, s) => s, bold: (s) => s };

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

/** Mock ctx whose ctx.ui.custom behaves like RPC mode: resolves undefined, factory never called. */
function makeRpcCtx() {
  let factoryCalled = false;
  const ctx = {
    hasUI: true,
    ui: {
      custom: async (factory) => {
        factoryCalled = true; // should never happen in RPC mode
        void factory;
        return undefined;
      },
    },
  };
  return { ctx, wasFactoryCalled: () => factoryCalled };
}

describe("isCustomUIAvailable", () => {
  it("returns true in TUI mode (factory invoked, done called)", async () => {
    const { ctx } = makeTuiCtx();
    expect(await isCustomUIAvailable(ctx)).toBe(true);
  });

  it("returns false in RPC mode (custom resolves undefined)", async () => {
    const { ctx, wasFactoryCalled } = makeRpcCtx();
    // RPC mock never resolves true; emulate real RPC where factory is not invoked
    ctx.ui.custom = async () => undefined;
    expect(await isCustomUIAvailable(ctx)).toBe(false);
    expect(wasFactoryCalled()).toBe(false);
  });

  it("returns false when ctx.ui.custom is missing", async () => {
    expect(await isCustomUIAvailable({ ui: {} })).toBe(false);
    expect(await isCustomUIAvailable({})).toBe(false);
    expect(await isCustomUIAvailable(null)).toBe(false);
  });
});

describe("showPresetSelector", () => {
  it("returns undefined for empty preset list without touching UI", async () => {
    const { ctx, state } = makeTuiCtx();
    expect(await showPresetSelector({ presets: [], activePreset: null, ctx })).toBeUndefined();
    expect(state.component).toBeNull();
  });

  it("returns undefined in RPC mode", async () => {
    const { ctx } = makeRpcCtx();
    ctx.ui.custom = async () => undefined;
    expect(await showPresetSelector({ presets: ["a"], activePreset: null, ctx })).toBeUndefined();
  });

  it("logs and returns undefined when custom UI factory throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = {
      ui: {
        custom: async () => {
          throw new Error("theme failure");
        },
      },
    };
    expect(await showPresetSelector({ presets: ["a"], activePreset: null, ctx })).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Custom preset selector failed"),
    );
    warnSpy.mockRestore();
  });

  it("notifies via ctx.ui.warn when custom UI factory throws and notify is available", async () => {
    const notify = vi.fn();
    const ctx = {
      ui: {
        notify,
        custom: async () => {
          throw new Error("theme failure");
        },
      },
    };
    expect(await showPresetSelector({ presets: ["a"], activePreset: null, ctx })).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Custom preset selector failed"),
      "warn",
    );
  });

  it("Enter on a preset returns { action: 'view', preset }", async () => {
    const { ctx, state } = makeTuiCtx();
    const promise = showPresetSelector({ presets: ["alpha", "beta"], activePreset: null, ctx });
    state.component.handleInput("\r"); // Enter on first item
    expect(await promise).toEqual({ action: "view", preset: "alpha" });
  });

  it("navigates with j/k and arrows", async () => {
    const { ctx, state } = makeTuiCtx();
    const promise = showPresetSelector({ presets: ["alpha", "beta"], activePreset: null, ctx });
    const c = state.component;
    c.handleInput("j"); // down → beta
    c.handleInput("j"); // down → Create new preset
    c.handleInput("j"); // clamped at bottom
    c.handleInput("k"); // up → beta
    c.handleInput("\x1b[A"); // arrow up → alpha
    c.handleInput("k"); // clamped at top
    c.handleInput("\r");
    expect(await promise).toEqual({ action: "view", preset: "alpha" });
    expect(state.renderRequested).toBeGreaterThan(0);
  });

  it("Space on a preset returns { action: 'activate', preset }", async () => {
    const { ctx, state } = makeTuiCtx();
    const promise = showPresetSelector({ presets: ["alpha", "beta"], activePreset: null, ctx });
    state.component.handleInput("j"); // → beta
    state.component.handleInput(" "); // Space → activate
    expect(await promise).toEqual({ action: "activate", preset: "beta" });
  });

  it("Enter on 'Create new preset' returns { action: 'create' }", async () => {
    const { ctx, state } = makeTuiCtx();
    const promise = showPresetSelector({ presets: ["alpha"], activePreset: null, ctx });
    state.component.handleInput("j"); // → Create new preset
    state.component.handleInput("\r");
    expect(await promise).toEqual({ action: "create" });
  });

  it("Space on 'Create new preset' is a no-op", async () => {
    const { ctx, state } = makeTuiCtx();
    const promise = showPresetSelector({ presets: ["alpha"], activePreset: null, ctx });
    const c = state.component;
    c.handleInput("j"); // → Create new preset
    c.handleInput(" "); // no-op
    c.handleInput("\x1b"); // Esc afterwards still works → cancelled
    expect(await promise).toBeUndefined();
  });

  it("Esc returns undefined (cancelled)", async () => {
    const { ctx, state } = makeTuiCtx();
    const promise = showPresetSelector({ presets: ["alpha"], activePreset: null, ctx });
    state.component.handleInput("\x1b");
    expect(await promise).toBeUndefined();
  });

  it("renders bordered list with title, active marker, and key hints", async () => {
    const { ctx, state } = makeTuiCtx();
    const promise = showPresetSelector({ presets: ["alpha", "beta"], activePreset: "beta", ctx });
    const lines = state.component.render(60).join("\n");
    expect(lines).toContain("Orchestrator Presets");
    expect(lines).toContain("⭐ beta (active)");
    expect(lines).toContain("alpha");
    expect(lines).toContain("➕ Create new preset");
    expect(lines).toContain("↑↓ navigate  Space activate  Enter details  Esc cancel");
    expect(lines).toContain("─".repeat(20)); // border lines
    expect(lines).toContain("→ alpha"); // selection cursor on first item
    state.component.handleInput("\x1b");
    await promise;
  });

  it("ignores input after finishing", async () => {
    const { ctx, state } = makeTuiCtx();
    const promise = showPresetSelector({ presets: ["alpha"], activePreset: null, ctx });
    const c = state.component;
    c.handleInput("\r");
    c.handleInput("j"); // should not throw or change result
    c.handleInput(" ");
    expect(await promise).toEqual({ action: "view", preset: "alpha" });
  });
});
