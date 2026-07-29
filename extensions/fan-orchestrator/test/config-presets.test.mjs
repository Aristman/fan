import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULTS,
  applyPreset,
  deletePreset,
  listPresets,
  loadConfig,
  savePreset,
} from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "..", "config.json");

/** Build a minimal valid config object (plain data, no I/O). */
function makeConfig(overrides = {}) {
  return {
    ...structuredClone(DEFAULTS),
    ...overrides,
  };
}

describe("savePreset", () => {
  it("snapshots cloud/local/providerMode and sets activePreset", () => {
    const config = makeConfig();
    config.cloud.model = "openai/gpt-5";
    config.cloud.models = { implement: "openai/gpt-5" };
    config.local.model = "ollama/qwen3";
    config.providerMode = "local";

    savePreset(config, "work");

    expect(config.presets.work).toEqual({
      cloud: { model: "openai/gpt-5", models: { implement: "openai/gpt-5" } },
      local: { model: "ollama/qwen3", models: {} },
      providerMode: "local",
    });
    expect(config.activePreset).toBe("work");
  });

  it("does not snapshot non-model config fields", () => {
    const config = makeConfig();
    config.parallelWorkers = 7;
    savePreset(config, "lean");

    expect(config.presets.lean.parallelWorkers).toBeUndefined();
    expect(config.presets.lean.temperature).toBeUndefined();
  });

  it("deep-copies: mutating top-level cloud after savePreset does not mutate the preset", () => {
    const config = makeConfig();
    config.cloud.model = "openai/gpt-5";
    config.cloud.models = { implement: "openai/gpt-5" };
    savePreset(config, "frozen");

    config.cloud.model = "anthropic/claude-opus";
    config.cloud.models.implement = "anthropic/claude-opus";

    expect(config.presets.frozen.cloud.model).toBe("openai/gpt-5");
    expect(config.presets.frozen.cloud.models.implement).toBe("openai/gpt-5");
  });

  it("rejects reserved names and does not pollute the preset store", () => {
    const config = makeConfig();
    expect(savePreset(config, "__proto__")).toBe(false);
    expect(savePreset(config, "constructor")).toBe(false);
    expect(savePreset(config, "prototype")).toBe(false);
    expect(listPresets(config)).toEqual([]);
    expect(config.activePreset).toBeNull();
  });
});

describe("applyPreset", () => {
  it("round-trip: savePreset then applyPreset restores the snapshot", () => {
    const config = makeConfig();
    config.cloud.model = "openai/gpt-5";
    config.providerMode = "cloud";
    savePreset(config, "a");

    // Change config, then apply the preset
    config.cloud.model = "google/gemini-3";
    config.providerMode = "local";
    config.activePreset = null;

    expect(applyPreset(config, "a")).toBe(true);
    expect(config.cloud.model).toBe("openai/gpt-5");
    expect(config.providerMode).toBe("cloud");
    expect(config.activePreset).toBe("a");
  });

  it("returns false for a missing preset and leaves config untouched", () => {
    const config = makeConfig();
    config.cloud.model = "openai/gpt-5";

    expect(applyPreset(config, "nope")).toBe(false);
    expect(config.cloud.model).toBe("openai/gpt-5");
    expect(config.activePreset).toBeNull();
  });

  it("returns false for malformed preset entries and leaves config untouched", () => {
    const config = makeConfig();
    config.cloud.model = "openai/gpt-5";
    config.presets.stringPreset = "not-an-object";
    config.presets.nullPreset = null;
    config.presets.missingCloud = { local: { model: "ollama/qwen3" }, providerMode: "local" };
    config.presets.missingLocal = { cloud: { model: "openai/gpt-5" }, providerMode: "cloud" };
    config.presets.badProvider = {
      cloud: { model: "openai/gpt-5", models: {} },
      local: { model: "ollama/qwen3", models: {} },
      providerMode: "outer-space",
    };
    config.presets.badModelType = {
      cloud: { model: 123, models: {} },
      local: { model: "ollama/qwen3", models: {} },
      providerMode: "cloud",
    };
    config.presets.badModelsType = {
      cloud: { model: "openai/gpt-5", models: "not-an-object" },
      local: { model: "ollama/qwen3", models: {} },
      providerMode: "cloud",
    };

    for (const name of ["stringPreset", "nullPreset", "missingCloud", "missingLocal", "badProvider", "badModelType", "badModelsType"]) {
      expect(applyPreset(config, name)).toBe(false);
    }

    expect(config.cloud.model).toBe("openai/gpt-5");
    expect(config.local.model).toBe("");
    expect(config.providerMode).toBe("cloud");
    expect(config.activePreset).toBeNull();
  });

  it("deep-copies on apply: mutating config after apply does not mutate the stored preset", () => {
    const config = makeConfig();
    config.cloud.models = { plan: "openai/gpt-5" };
    savePreset(config, "iso");

    applyPreset(config, "iso");
    config.cloud.models.plan = "mutated";

    expect(config.presets.iso.cloud.models.plan).toBe("openai/gpt-5");
  });
});

describe("deletePreset", () => {
  it("removes an existing preset and returns true", () => {
    const config = makeConfig();
    savePreset(config, "tmp");

    expect(deletePreset(config, "tmp")).toBe(true);
    expect(config.presets.tmp).toBeUndefined();
  });

  it("clears activePreset when the active preset is deleted", () => {
    const config = makeConfig();
    savePreset(config, "active-one");
    expect(config.activePreset).toBe("active-one");

    deletePreset(config, "active-one");
    expect(config.activePreset).toBeNull();
  });

  it("keeps activePreset when a different preset is deleted", () => {
    const config = makeConfig();
    savePreset(config, "one");
    savePreset(config, "two");
    config.activePreset = "one";

    deletePreset(config, "two");
    expect(config.activePreset).toBe("one");
  });

  it("returns false for a missing preset", () => {
    const config = makeConfig();
    expect(deletePreset(config, "ghost")).toBe(false);
  });

  it("does not delete inherited properties and returns false", () => {
    const config = makeConfig();
    expect(deletePreset(config, "constructor")).toBe(false);
    expect(deletePreset(config, "__proto__")).toBe(false);
    expect(deletePreset(config, "toString")).toBe(false);
    expect(listPresets(config)).toEqual([]);
  });
});

describe("listPresets", () => {
  it("returns preset names", () => {
    const config = makeConfig();
    savePreset(config, "a");
    savePreset(config, "b");
    expect(listPresets(config).sort()).toEqual(["a", "b"]);
  });

  it("returns empty array when presets are missing", () => {
    expect(listPresets({})).toEqual([]);
    expect(listPresets(makeConfig())).toEqual([]);
  });
});

describe("loadConfig migration", () => {
  let original = null;

  afterEach(() => {
    // Always restore the real config.json after migration tests
    if (original !== null) {
      fs.writeFileSync(CONFIG_PATH, original, "utf-8");
      original = null;
    }
  });

  it("fills presets/activePreset defaults for an old config without those keys", () => {
    original = fs.readFileSync(CONFIG_PATH, "utf-8");
    const oldConfig = JSON.parse(original);
    delete oldConfig.presets;
    delete oldConfig.activePreset;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(oldConfig, null, 2), "utf-8");

    const loaded = loadConfig();
    expect(loaded.presets).toEqual({});
    expect(loaded.activePreset).toBeNull();
  });

  it("preserves existing presets on load", () => {
    original = fs.readFileSync(CONFIG_PATH, "utf-8");
    const existing = JSON.parse(original);
    existing.presets = {
      work: {
        cloud: { model: "openai/gpt-5", models: {} },
        local: { model: "", models: {} },
        providerMode: "cloud",
      },
    };
    existing.activePreset = "work";
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(existing, null, 2), "utf-8");

    const loaded = loadConfig();
    expect(loaded.activePreset).toBe("work");
    expect(loaded.presets.work.providerMode).toBe("cloud");
  });

  it("recovers from a malformed presets field", () => {
    original = fs.readFileSync(CONFIG_PATH, "utf-8");
    const broken = JSON.parse(original);
    broken.presets = "not-an-object";
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(broken, null, 2), "utf-8");

    const loaded = loadConfig();
    expect(loaded.presets).toEqual({});
  });

  it("drops invalid preset entries during migration", () => {
    original = fs.readFileSync(CONFIG_PATH, "utf-8");
    const broken = JSON.parse(original);
    broken.presets = {
      good: {
        cloud: { model: "openai/gpt-5", models: {} },
        local: { model: "ollama/qwen3", models: {} },
        providerMode: "cloud",
      },
      badString: "nope",
      badNull: null,
      badMissingCloud: { local: { model: "ollama/qwen3" }, providerMode: "local" },
      badProviderMode: {
        cloud: { model: "openai/gpt-5", models: {} },
        local: { model: "ollama/qwen3", models: {} },
        providerMode: "unknown",
      },
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(broken, null, 2), "utf-8");

    const loaded = loadConfig();
    expect(Object.keys(loaded.presets)).toEqual(["good"]);
  });

  it("resets dangling or non-string activePreset during migration", () => {
    original = fs.readFileSync(CONFIG_PATH, "utf-8");
    const broken = JSON.parse(original);
    broken.presets = {
      work: {
        cloud: { model: "openai/gpt-5", models: {} },
        local: { model: "ollama/qwen3", models: {} },
        providerMode: "cloud",
      },
    };
    broken.activePreset = "missing";
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(broken, null, 2), "utf-8");
    let loaded = loadConfig();
    expect(loaded.activePreset).toBeNull();

    broken.activePreset = 123;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(broken, null, 2), "utf-8");
    loaded = loadConfig();
    expect(loaded.activePreset).toBeNull();

    broken.activePreset = null;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(broken, null, 2), "utf-8");
    loaded = loadConfig();
    expect(loaded.activePreset).toBeNull();

    broken.activePreset = "work";
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(broken, null, 2), "utf-8");
    loaded = loadConfig();
    expect(loaded.activePreset).toBe("work");
  });
});
