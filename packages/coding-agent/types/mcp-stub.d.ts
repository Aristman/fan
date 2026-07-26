// Stub declaration for @fan/mcp used during TypeScript type-checking only.
// At runtime, the real package is loaded via the bundled imports in
// loader.ts (VIRTUAL_MODULES). This stub breaks the circular dev-time
// dependency between coding-agent and @fan/mcp so that either can be
// built in either order.
//
// The declarations below mirror the real exports of @fan/mcp that
// coding-agent source files import (main.ts, workspace/mcp-switcher.ts).
// Keep them structurally compatible with packages/mcp/src/config.js and
// packages/mcp/src/manager.js when those change.
declare module "@fan/mcp" {
    export interface McpServerConfig {
        transport: "stdio" | "streamable-http";
        name?: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
        headers?: Record<string, string>;
        allowedTools?: string[];
        deniedTools?: string[];
        timeout?: number;
        autoRestart?: boolean;
        silentStderr?: boolean;
        allowLocal?: boolean;
        allowPrivate?: boolean;
    }

    export interface McpConfig {
        servers: McpServerConfig[];
    }

    export interface ConfigLoader {
        load(): Promise<McpConfig>;
    }

    export function createMcpConfigLoader(cwd?: string): ConfigLoader;
    export function loadMcpConfig(cwd?: string): Promise<McpConfig>;

    export const mcpExtension: unknown;
    export const createMcpClientManager: unknown;
    const _default: unknown;
    export default _default;
}
