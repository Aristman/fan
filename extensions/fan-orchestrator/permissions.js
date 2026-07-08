import { isDangerousCommand as coreIsDangerousCommand } from "@seaagents/fan-coding-agent";

/**
 * Check whether a shell command is dangerous.
 *
 * First checks extension-specific custom patterns, then delegates to the
 * core @seaagents/fan-coding-agent implementation for all standard checks.
 *
 * @param cmd - The raw command string to evaluate.
 * @param customPatterns - Optional list of custom dangerous command patterns.
 * @returns A human-readable danger reason, or `null` if the command is safe.
 */
export function isDangerousCommand(cmd, customPatterns = []) {
    // 1. Extension-specific custom patterns (checked first, before core patterns)
    for (const pattern of customPatterns) {
        if (typeof pattern === "string" && pattern) {
            const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            try {
                if (new RegExp(`\\b${escaped}\\b`, "i").test(cmd)) {
                    return `Custom dangerous command: ${pattern}`;
                }
            } catch { /* skip invalid patterns */ }
        }
    }

    // 2. Delegate all standard checks to the core implementation
    return coreIsDangerousCommand(cmd);
}
