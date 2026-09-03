/**
 * Shared factory for read-only worker agent definitions.
 *
 * Extracts the fields duplicated across read-only agents (verify, security,
 * code-review): `readOnly: true` + the read-only tool set
 * [read, bash, grep, find, ls]. Per-agent fields (label/icon/description/
 * useFor) are passed through so each agent file keeps only its `type` +
 * `prompt` and spreads this fragment into its definition.
 *
 * @param {object} opts
 * @param {string} opts.label - UI label (task widget).
 * @param {string} opts.icon - Emoji icon (task widget).
 * @param {string} opts.description - Short description of the agent.
 * @param {string} opts.useFor - When the coordinator should use this agent.
 * @returns {{label: string, icon: string, description: string, useFor: string, readOnly: true, tools: string[]}}
 *   Definition fragment to spread into an agent definition object.
 */
export function makeReadOnlyAgent({ label, icon, description, useFor }) {
    return {
        label,
        icon,
        description,
        useFor,
        readOnly: true,
        tools: ["read", "bash", "grep", "find", "ls"],
    };
}
