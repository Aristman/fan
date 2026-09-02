import { type as exploreType, definition as exploreDef } from "./explore.js";
import { type as planType, definition as planDef, PROMPT as PLAN_PROMPT } from "./plan.js";
import { type as implementType, definition as implementDef } from "./implement.js";
import { type as verifyType, definition as verifyDef } from "./verify.js";
import { type as securityType, definition as securityDef } from "./security.js";
import { type as bugFixType, definition as bugFixDef } from "./bug-fix.js";
import { type as codeResearchType, definition as codeResearchDef } from "./code-research.js";
import { type as testsImplType, definition as testsImplDef } from "./tests-impl.js";
import { type as docsImplType, definition as docsImplDef } from "./docs-impl.js";
/** All registered agent definitions. Keyed by agent type string. */
export const AGENT_REGISTRY = {
    [exploreType]: exploreDef,
    [planType]: planDef,
    [implementType]: implementDef,
    [verifyType]: verifyDef,
    [securityType]: securityDef,
    [bugFixType]: bugFixDef,
    [codeResearchType]: codeResearchDef,
    [testsImplType]: testsImplDef,
    [docsImplType]: docsImplDef,
};
/** Get all registered agent type names. */
export function getAgentTypes() {
    return Object.keys(AGENT_REGISTRY);
}
/** Get agent definition by type. */
export function getAgentDefinition(agentType) {
    return AGENT_REGISTRY[agentType];
}
/** Check if a given agent type is registered. */
export function isRegistered(agentType) {
    return agentType in AGENT_REGISTRY;
}
/** The planning prompt (used by /plan command). */
export const PLANNING_PROMPT = PLAN_PROMPT;
