import type { AgentDefinition } from "../types.js";
/** All registered agent definitions. Keyed by agent type string. */
export declare const AGENT_REGISTRY: Record<string, AgentDefinition>;
/** Get all registered agent type names. */
export declare function getAgentTypes(): string[];
/** Get agent definition by type. */
export declare function getAgentDefinition(agentType: string): AgentDefinition | undefined;
/** Check if a given agent type is registered. */
export declare function isRegistered(agentType: string): boolean;
/** The planning prompt (used by /plan command). */
export declare const PLANNING_PROMPT: string;
