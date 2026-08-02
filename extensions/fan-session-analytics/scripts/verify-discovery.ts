/**
 * Verification script for discovery.ts functions.
 * Tests skill loading from real ~/.fan/agent/skills/ and model grouping on synthetic data.
 *
 * Usage: bun run extensions/fan-session-analytics/scripts/verify-discovery.ts
 */

import { discoverInstalledSkills, parseSkillName, groupModelsByProvider } from "../src/discovery.js";

const CWD = process.cwd();

console.log("=== Verify: Skill Discovery ===\n");

// 1. Test parseSkillName
console.log("--- parseSkillName ---");
const testCases: Array<[string, string | null]> = [
	["---\nname: code-research\ndescription: >\n  Some desc\n---\n", "code-research"],
	["---\nname: \"quoted-name\"\n---\n", "quoted-name"],
	["no frontmatter at all", null],
	["---\ndescription: no name field\n---\n", null],
];

let parsePassed = 0;
let parseFailed = 0;
for (const [input, expected] of testCases) {
	const result = parseSkillName(input);
	const ok = result === expected;
	if (ok) { parsePassed++; } else { parseFailed++; }
	console.log(`  ${ok ? "✅" : "❌"} parseSkillName(${JSON.stringify(input.slice(0, 40))}...) = ${JSON.stringify(result)} (expected ${JSON.stringify(expected)})`);
}

// 2. Test discoverInstalledSkills on real data
console.log("\n--- discoverInstalledSkills (real) ---");
const skills = discoverInstalledSkills(CWD);
console.log(`  Found ${skills.length} skill(s):`);
for (const s of skills) {
	console.log(`    - ${s.name} (${s.source})`);
}
const realSkillsCheck = skills.length >= 8;
console.log(`  ${realSkillsCheck ? "✅" : "❌"} At least 8 skills found: ${skills.length}`);

// 3. Test groupModelsByProvider on synthetic data
console.log("\n=== Verify: Model Grouping ===\n");

const syntheticModels = [
	{ provider: "anthropic", id: "claude-sonnet-4-20250514", name: "Claude 4 Sonnet", contextWindow: 200000, cost: { input: 3 } },
	{ provider: "anthropic", id: "claude-opus-4-20250514", name: "Claude 4 Opus", contextWindow: 200000, cost: { input: 15 } },
	{ provider: "openai", id: "gpt-4o", name: "GPT-4o", contextWindow: 128000, cost: { input: 2.5 } },
	{ provider: "openai", id: "o1-pro", name: "o1-pro", contextWindow: 200000, cost: { input: 150 } },
	{ provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 Mini", contextWindow: 1000000, cost: { input: 0.4 } },
	{ provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1000000, cost: { input: 1.25 } },
];

const { providers, modelsByProvider } = groupModelsByProvider(syntheticModels);

console.log("Providers:");
for (const p of providers) {
	console.log(`  - ${p.label}`);
}
console.log("\nModels by provider:");
for (const [provider, models] of modelsByProvider) {
	console.log(`  ${provider}: ${models.map(m => m.id).join(", ")}`);
}

const providerCheck = providers.length === 3;
const anthropicCheck = (modelsByProvider.get("anthropic") || []).length === 2;
const openaiCheck = (modelsByProvider.get("openai") || []).length === 3;
const googleCheck = (modelsByProvider.get("google") || []).length === 1;

console.log(`\n  ${providerCheck ? "✅" : "❌"} 3 providers found: ${providers.length}`);
console.log(`  ${anthropicCheck ? "✅" : "❌"} anthropic has 2 models`);
console.log(`  ${openaiCheck ? "✅" : "❌"} openai has 3 models`);
console.log(`  ${googleCheck ? "✅" : "❌"} google has 1 model`);

// Empty input test
const { providers: emptyProviders, modelsByProvider: emptyMap } = groupModelsByProvider([]);
const emptyCheck = emptyProviders.length === 0 && emptyMap.size === 0;
console.log(`  ${emptyCheck ? "✅" : "❌"} Empty input → empty output`);

// Summary
console.log("\n=== Summary ===");
const totalChecks = parsePassed + parseFailed + (realSkillsCheck ? 1 : 0) + (providerCheck ? 1 : 0) + (anthropicCheck ? 1 : 0) + (openaiCheck ? 1 : 0) + (googleCheck ? 1 : 0) + (emptyCheck ? 1 : 0);
const totalPassed = parsePassed + (realSkillsCheck ? 1 : 0) + (providerCheck ? 1 : 0) + (anthropicCheck ? 1 : 0) + (openaiCheck ? 1 : 0) + (googleCheck ? 1 : 0) + (emptyCheck ? 1 : 0);
console.log(`Passed: ${totalPassed}/${totalChecks}`);

if (totalPassed < totalChecks) {
	console.log("\n❌ SOME CHECKS FAILED");
	process.exit(1);
} else {
	console.log("\n✅ ALL CHECKS PASSED");
}
