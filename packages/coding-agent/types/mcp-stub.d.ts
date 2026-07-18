// Stub declaration for @fan/mcp used during TypeScript type-checking only.
// At runtime, the real package is loaded via the bundled imports in
// loader.ts (VIRTUAL_MODULES). This stub breaks the circular dev-time
// dependency between coding-agent and @fan/mcp so that either can be
// built in either order.
declare module "@fan/mcp" {
    export const mcpExtension: unknown;
    const _default: unknown;
    export default _default;
}
