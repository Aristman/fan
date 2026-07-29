/**
 * FAN Orchestrator — Configuration
 *
 * Loads config from config.json with fallback to defaults.
 * Provides model resolution and cloud health checking.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/** Default configuration values */
export const DEFAULTS = {
    cloud: { model: "", models: {} },
    local: { model: "", models: {} },
    providerMode: "cloud",
    presets: {},
    activePreset: null,
    coordinatorDefault: true,
    parallelWorkers: 3,
    workerTimeout: 600,
    stallTimeout: 600,
    planTimeout: 600,
    maxRetries: 2,
    agentTimeouts: {
        explore: 600,
        plan: 600,
        implement: 600,
        verify: 600,
    },
    temperature: 0.1,
    agentTemperature: {
        explore: 0.3,
        plan: 0.1,
        implement: 0.1,
        verify: 0.3,
        "bug-fix": 0.1,
        "code-research": 0.2,
        "tests-impl": 0.1,
        "docs-impl": 0.3,
    },
    dangerousCommands: [
        "rm -rf",
        "git push --force",
        "npm publish",
        "DROP TABLE",
        "TRUNCATE",
        "DELETE FROM",
        "mkfs",
        "shutdown",
    ],
};
/** Cloud health cache */
let cloudHealthCached = "unknown";
let cloudHealthCheckTime = 0;
const CLOUD_HEALTH_CACHE_MS = 5 * 60 * 1000; // 5 minutes
/**
 * Clamp temperature to valid range [0.0, 1.0].
 * Returns null for invalid/non-numeric values.
 */
function clampTemperature(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isNaN(parsed))
            return null;
        value = parsed;
    }
    if (typeof value !== "number" || Number.isNaN(value))
        return null;
    return Math.max(0.0, Math.min(1.0, value));
}
/**
 * Ensure temperature and agentTemperature fields exist and clamp all values.
 */
function normalizeTemperatureConfig(config) {
    if (config.temperature === undefined) {
        config.temperature = DEFAULTS.temperature;
    }
    else {
        config.temperature = clampTemperature(config.temperature) ?? DEFAULTS.temperature;
    }
    if (!config.agentTemperature || typeof config.agentTemperature !== "object" || Array.isArray(config.agentTemperature)) {
        config.agentTemperature = { ...DEFAULTS.agentTemperature };
        return;
    }
    for (const key of Object.keys(DEFAULTS.agentTemperature)) {
        if (config.agentTemperature[key] === undefined) {
            config.agentTemperature[key] = DEFAULTS.agentTemperature[key];
        }
        else {
            config.agentTemperature[key] = clampTemperature(config.agentTemperature[key]) ?? DEFAULTS.agentTemperature[key];
        }
    }
}
/**
 * Deep merge two objects (target overrides source).
 */
function deepMerge(source, target) {
    const result = { ...source };
    for (const key of Object.keys(target)) {
        const targetVal = target[key];
        if (targetVal &&
            typeof targetVal === "object" &&
            !Array.isArray(targetVal) &&
            typeof source[key] === "object" &&
            !Array.isArray(source[key])) {
            result[key] = deepMerge(source[key], targetVal);
        }
        else if (targetVal !== undefined) {
            result[key] = targetVal;
        }
    }
    return result;
}
/**
 * Normalize legacy config keys for backward compatibility.
 * Maps: cloud.defaultModel → cloud.model, local.defaultModel → local.model
 *       cloud.defaultProvider → cloud.provider, local.defaultProvider → local.provider
 *       stallTimeout → workerTimeout
 */
function normalizeConfigKeys(config) {
    for (const provider of ["cloud", "local"]) {
        if (config[provider] && typeof config[provider] === "object") {
            if (config[provider].defaultModel !== undefined && config[provider].model === undefined) {
                config[provider].model = config[provider].defaultModel;
            }
            if (config[provider].defaultProvider !== undefined && config[provider].provider === undefined) {
                config[provider].provider = config[provider].defaultProvider;
            }
        }
    }
    if (config.stallTimeout !== undefined && config.workerTimeout === undefined) {
        config.workerTimeout = config.stallTimeout;
    }
}
const RESERVED_PRESET_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Validate a preset value. A valid preset is an object with cloud and local
 * objects, each optionally containing a string model and an object models,
 * and a providerMode of "auto", "cloud", or "local".
 */
function isValidPreset(preset) {
    if (!preset || typeof preset !== "object" || Array.isArray(preset))
        return false;
    for (const key of ["cloud", "local"]) {
        const section = preset[key];
        if (!section || typeof section !== "object" || Array.isArray(section))
            return false;
        if (section.model !== undefined && typeof section.model !== "string")
            return false;
        if (section.models !== undefined &&
            (typeof section.models !== "object" || Array.isArray(section.models)))
            return false;
    }
    return ["auto", "cloud", "local"].includes(preset.providerMode);
}

/**
 * Ensure preset fields exist with safe defaults (migration for old config.json files).
 * Drops invalid preset entries and resets activePreset when it is dangling or invalid.
 */
function normalizePresetConfig(config) {
    if (!config.presets || typeof config.presets !== "object" || Array.isArray(config.presets)) {
        config.presets = {};
    }
    else {
        for (const name of Object.keys(config.presets)) {
            if (!isValidPreset(config.presets[name])) {
                delete config.presets[name];
            }
        }
    }
    if (config.activePreset === undefined ||
        typeof config.activePreset !== "string" ||
        !Object.hasOwn(config.presets, config.activePreset)) {
        config.activePreset = null;
    }
}

/**
 * Save the current model-related config (cloud, local, providerMode) as a named preset.
 * Sets the preset as active. Deep-copies the snapshot.
 * Returns false for reserved names (e.g. __proto__, constructor, prototype).
 */
export function savePreset(config, name) {
    if (RESERVED_PRESET_NAMES.has(name))
        return false;
    if (!config.presets || typeof config.presets !== "object" || Array.isArray(config.presets))
        config.presets = {};
    config.presets[name] = structuredClone({
        cloud: config.cloud,
        local: config.local,
        providerMode: config.providerMode,
    });
    config.activePreset = name;
    return true;
}
/**
 * Apply a named preset: copies its cloud/local/providerMode back into top-level
 * config fields (deep-copy) and marks it active. Returns false if the preset
 * does not exist or has an invalid shape.
 */
export function applyPreset(config, name) {
    const preset = config.presets?.[name];
    if (!isValidPreset(preset))
        return false;
    const copy = structuredClone(preset);
    config.cloud = copy.cloud;
    config.local = copy.local;
    config.providerMode = copy.providerMode;
    config.activePreset = name;
    return true;
}
/**
 * Delete a named preset. If it was the active preset, clears activePreset.
 * Returns true if the preset existed as an own property.
 */
export function deletePreset(config, name) {
    if (!config.presets || typeof config.presets !== "object" || Array.isArray(config.presets))
        return false;
    if (!Object.hasOwn(config.presets, name))
        return false;
    delete config.presets[name];
    if (config.activePreset === name)
        config.activePreset = null;
    return true;
}
/** List all preset names. */
export function listPresets(config) {
    return Object.keys(config.presets || {});
}

/**
 * Load orchestrator configuration.
 * Reads from config.json next to this module, merges with defaults.
 * If config.json doesn't exist, creates it from config.example.json (or DEFAULTS).
 * Falls back to defaults on parse error.
 */
const CONFIG_PATH = path.join(__dirname, "config.json");
/** Check if config.json exists */
export function configExists() {
    return fs.existsSync(CONFIG_PATH);
}
/** Get config.json path */
export function getConfigPath() {
    return CONFIG_PATH;
}
/** Save orchestrator configuration to config.json. */
export function saveConfig(config) {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
        console.log("[FAN Orchestrator] Config saved to config.json");
        return true;
    }
    catch (e) {
        console.error(`[FAN Orchestrator] Failed to save config.json: ${e.message}`);
        return false;
    }
}

export function loadConfig() {
    // If config doesn't exist — create from config.example.json (or DEFAULTS)
    if (!fs.existsSync(CONFIG_PATH)) {
        const examplePath = path.join(__dirname, "config.example.json");
        if (fs.existsSync(examplePath)) {
            try {
                const example = JSON.parse(fs.readFileSync(examplePath, "utf-8"));
                normalizeConfigKeys(example);
                normalizeTemperatureConfig(example);
                normalizePresetConfig(example);
                const merged = deepMerge(DEFAULTS, example);
                saveConfig(merged);
                console.log("[FAN Orchestrator] Created config.json from config.example.json");
                return merged;
            } catch (e) {
                console.warn(`[FAN Orchestrator] Failed to read config.example.json: ${e.message}. Using defaults.`);
            }
        }
        console.log("[FAN Orchestrator] No config.json found. Using defaults. Run /orchestrator init to configure.");
        return { ...DEFAULTS, presets: {}, activePreset: null };
    }
    // Load and merge with defaults
    try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        const userConfig = JSON.parse(raw);
        normalizeConfigKeys(userConfig);
        normalizeTemperatureConfig(userConfig);
        normalizePresetConfig(userConfig);
        return deepMerge(DEFAULTS, userConfig);
    }
    catch (e) {
        console.warn(`[FAN Orchestrator] Failed to parse config.json: ${e.message}. Using defaults.`);
        return { ...DEFAULTS, presets: {}, activePreset: null };
    }
}
/**
 * Resolve the model to use for a given agent type.
 * Checks per-agent override first, falls back to provider default.
 */
/**
 * Resolve worker model using the chain:
 *   per-agent override (config.{provider}.models[agentName])
 *   → orchestrator default (config.{provider}.model)
 *   → undefined (falls back to session model)
 */
export function resolveWorkerModel(agentName, config, providerMode) {
    const mode = providerMode ?? config.providerMode;
    const provider = mode === "local" ? config.local : config.cloud;
    return provider.models?.[agentName] || provider.model || undefined;
}
/**
 * Resolve the temperature to use for a given agent type.
 * Priority: per-agent override → orchestrator default → null (use DB/provider default).
 */
export function resolveWorkerTemperature(agentName, config) {
    if (config.agentTemperature && typeof config.agentTemperature === "object") {
        const perAgent = config.agentTemperature[agentName];
        if (perAgent !== null && perAgent !== undefined)
            return perAgent;
    }
    if (config.temperature !== null && config.temperature !== undefined)
        return config.temperature;
    return null;
}
/**
 * Check if cloud provider is available by running a quick health check.
 */
async function checkCloudHealth() {
    try {
        const invocation = getFnaInvocation(["--version"]);
        execSync(`${invocation.command} ${invocation.args.join(" ")}`, {
            timeout: 5000,
            stdio: "pipe",
        });
        return "available";
    }
    catch {
        return "unavailable";
    }
}
/**
 * Get cloud provider status, with 5-minute cache.
 */
export async function getCloudStatus() {
    const now = Date.now();
    if (now - cloudHealthCheckTime < CLOUD_HEALTH_CACHE_MS && cloudHealthCached !== "unknown") {
        return cloudHealthCached === "available" ? "available" : "unavailable";
    }
    cloudHealthCached = await checkCloudHealth();
    cloudHealthCheckTime = now;
    return cloudHealthCached;
}
/**
 * Synchronous getter for cached cloud health value.
 * Returns "unknown" if no check has been performed yet.
 */
export function getCloudHealthCached() {
    return cloudHealthCached;
}
/** Get the fan binary invocation — reuse from subagent-runner */
function getFnaInvocation(args) {
    const currentScript = process.argv[1];
    if (currentScript && fs.existsSync(currentScript)) {
        return { command: process.execPath, args: [currentScript, ...args] };
    }
    const execName = path.basename(process.execPath).toLowerCase();
    const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
    if (!isGenericRuntime) {
        return { command: process.execPath, args };
    }
    return { command: "fan", args };
}
//# sourceMappingURL=config.js.map