import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs and child_process before importing config
vi.mock("node:fs", () => ({
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
    execSync: vi.fn(),
}));

import * as fs from "node:fs";
import { loadConfig, resolveModel, DEFAULTS } from "../config.js";

const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedReadFileSync = vi.mocked(fs.readFileSync);

describe("config", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default: no config file
        mockedExistsSync.mockReturnValue(false);
    });

    describe("DEFAULTS", () => {
        it("has expected structure", () => {
            expect(DEFAULTS).toBeDefined();
            expect(DEFAULTS.cloud).toBeDefined();
            expect(DEFAULTS.cloud.model).toBeTruthy();
            expect(DEFAULTS.local).toBeDefined();
            expect(DEFAULTS.local.model).toBeTruthy();
            expect(DEFAULTS.providerMode).toBe("cloud");
            expect(typeof DEFAULTS.parallelWorkers).toBe("number");
            expect(typeof DEFAULTS.workerTimeout).toBe("number");
            expect(typeof DEFAULTS.maxRetries).toBe("number");
            expect(typeof DEFAULTS.planTimeout).toBe("number");
            expect(DEFAULTS.agentTimeouts).toBeDefined();
            expect(typeof DEFAULTS.agentTimeouts.explore).toBe("number");
            expect(typeof DEFAULTS.agentTimeouts.plan).toBe("number");
            expect(typeof DEFAULTS.agentTimeouts.implement).toBe("number");
            expect(typeof DEFAULTS.agentTimeouts.verify).toBe("number");
            expect(Array.isArray(DEFAULTS.dangerousCommands)).toBe(true);
        });
    });

    describe("loadConfig", () => {
        it("returns defaults when no config.json exists", () => {
            mockedExistsSync.mockReturnValue(false);

            const config = loadConfig();

            expect(config.providerMode).toBe(DEFAULTS.providerMode);
            expect(config.cloud.model).toBe(DEFAULTS.cloud.model);
            expect(config.local.model).toBe(DEFAULTS.local.model);
            expect(config.parallelWorkers).toBe(DEFAULTS.parallelWorkers);
            expect(config.workerTimeout).toBe(DEFAULTS.workerTimeout);
            expect(config.maxRetries).toBe(DEFAULTS.maxRetries);
            expect(config.planTimeout).toBe(DEFAULTS.planTimeout);
            expect(config.agentTimeouts).toEqual(DEFAULTS.agentTimeouts);
            expect(config.dangerousCommands).toEqual(DEFAULTS.dangerousCommands);
        });

        it("merges user config with defaults", () => {
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue(JSON.stringify({
                providerMode: "local",
                parallelWorkers: 5,
                cloud: { model: "custom/cloud-model" },
            }));

            const config = loadConfig();

            // Overridden values
            expect(config.providerMode).toBe("local");
            expect(config.parallelWorkers).toBe(5);
            expect(config.cloud.model).toBe("custom/cloud-model");
            // Non-overridden values keep defaults
            expect(config.local.model).toBe(DEFAULTS.local.model);
            expect(config.workerTimeout).toBe(DEFAULTS.workerTimeout);
            expect(config.maxRetries).toBe(DEFAULTS.maxRetries);
            expect(config.agentTimeouts).toEqual(DEFAULTS.agentTimeouts);
        });

        it("handles invalid JSON gracefully", () => {
            mockedExistsSync.mockReturnValue(true);
            mockedReadFileSync.mockReturnValue("this is not valid json {{{");

            // Should not throw, should fallback to defaults
            const config = loadConfig();
            expect(config.providerMode).toBe(DEFAULTS.providerMode);
            expect(config.cloud.model).toBe(DEFAULTS.cloud.model);
            expect(config.local.model).toBe(DEFAULTS.local.model);
        });
    });

    describe("resolveModel", () => {
        const config = loadConfig();

        it("returns cloud model for cloud mode", () => {
            const model = resolveModel("explore", config, "cloud");
            expect(model).toBe(config.cloud.model);
        });

        it("returns local model for local mode", () => {
            const model = resolveModel("implement", config, "local");
            expect(model).toBe(config.local.model);
        });

        it("defaults to config.providerMode when mode is not specified", () => {
            const model = resolveModel("explore", config);
            expect(model).toBe(config.cloud.model); // defaults to "cloud"
        });
    });
});
