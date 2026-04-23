/**
 * Tests for config.ts
 */
import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig, saveConfig, resolveModel, DEFAULTS, configExists } from "../config.js";

describe("Config", () => {
  describe("DEFAULTS", () => {
    it("should have expected defaults", () => {
      expect(DEFAULTS.parallelWorkers).toBe(3);
      expect(DEFAULTS.maxWorkers).toBe(10);
      expect(DEFAULTS.maxRetries).toBe(2);
      expect(DEFAULTS.stallTimeout).toBe(300_000);
      expect(DEFAULTS.providerMode).toBe("auto");
      expect(DEFAULTS.dangerousCommands.length).toBeGreaterThan(0);
    });
  });

  describe("loadConfig", () => {
    it("should load config successfully", () => {
      const config = loadConfig();
      expect(config.parallelWorkers).toBeGreaterThanOrEqual(1);
      expect(config.maxWorkers).toBeGreaterThanOrEqual(1);
      expect(["cloud", "local", "auto"]).toContain(config.providerMode);
    });
  });

  describe("resolveModel", () => {
    it("should resolve cloud model for agent type", () => {
      const config = {
        ...DEFAULTS,
        cloud: { ...DEFAULTS.cloud, defaultModel: "cloud-default", models: { explore: "cloud-explore" } },
        local: { ...DEFAULTS.local, defaultModel: "local-default", models: {} },
      };
      expect(resolveModel("explore", config, "cloud")).toBe("cloud-explore");
    });

    it("should fall back to default cloud model", () => {
      const config = {
        ...DEFAULTS,
        cloud: { ...DEFAULTS.cloud, defaultModel: "cloud-default", models: {} },
        local: { ...DEFAULTS.local, defaultModel: "local-default", models: {} },
      };
      expect(resolveModel("plan", config, "cloud")).toBe("cloud-default");
    });

    it("should resolve local model for agent type", () => {
      const config = {
        ...DEFAULTS,
        cloud: { ...DEFAULTS.cloud, defaultModel: "cloud-default", models: {} },
        local: { ...DEFAULTS.local, defaultModel: "local-default", models: { plan: "local-plan" } },
      };
      expect(resolveModel("plan", config, "local")).toBe("local-plan");
    });

    it("should default to cloud mode", () => {
      const config = {
        ...DEFAULTS,
        cloud: { ...DEFAULTS.cloud, defaultModel: "cloud-default", models: {} },
        local: { ...DEFAULTS.local, defaultModel: "local-default", models: {} },
      };
      expect(resolveModel("verify", config)).toBe("cloud-default");
    });
  });

  describe("configExists", () => {
    it("should return true since config.json exists", () => {
      expect(configExists()).toBe(true);
    });
  });
});
