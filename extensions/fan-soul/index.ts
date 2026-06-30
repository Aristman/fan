import type { ExtensionAPI, ExtensionCommandContext } from "@seaagents/fan-coding-agent";
import { Type } from "@sinclair/typebox";
import { Extractor } from "./extractor.js";
import { DraftQueue } from "./drafts.js";
import {
	readSoulFile,
	readAllSoulFiles,
	fileExists,
	anySoulFileExists,
	createFromTemplate,
	createAllMissing,
	buildInjection,
	parseSoulIdentity,
	hasSectionMarkers,
	mergeSection,
	sectionContains,
	writeSoulFile,
	migrateUserFile,
	compactUserFile,
	getSoulFilePath,
	escapeRegex,
} from "./soul-files.js";
import type { SoulFileKey, UserSectionName, MergeAction } from "./types.js";
import type { AgentToolResult } from "@seaagents/fan-coding-agent";

const extractor = new Extractor();
const drafts = new DraftQueue();
let turnsSinceExtract = 0;

const VALID_SECTIONS: Set<string> = new Set<UserSectionName>([
	"profile", "context", "preferences", "projects",
]);

export default function (fan: ExtensionAPI) {
	// --- Lifecycle: session_start ---
	fan.on("session_start", (_event, ctx) => {
		// Parse identity for status widget
		const identity = parseSoulIdentity();
		if (identity) {
			ctx.ui.setStatus("0-soul", `${identity.emoji} ${identity.name}`);
		} else {
			ctx.ui.setStatus("0-soul", undefined);
		}

		// If no soul files exist, notify user
		if (!anySoulFileExists()) {
			ctx.ui.notify(
				"No agent identity found. Run /soul init to configure your agent personality and operator profile.",
				"info"
			);
		}

		// Auto-migrate USER.md if needed
		const userContent = readSoulFile("user");
		if (userContent && !hasSectionMarkers(userContent)) {
			const migrated = migrateUserFile();
			if (migrated) {
				writeSoulFile("user", migrated).then(() => {
					ctx.ui.notify("USER.md migrated to sectioned format.", "info");
				});
			}
		}
	});

	// --- Lifecycle: before_agent_start ---
	fan.on("before_agent_start", (event) => {
		if (!anySoulFileExists()) return;
		const injection = buildInjection();
		if (injection) {
			return { systemPrompt: event.systemPrompt + injection };
		}
		return;
	});

	// --- Lifecycle: turn_end ---
	fan.on("turn_end", (_event, ctx) => {
		turnsSinceExtract++;
		if (turnsSinceExtract < 5) return;

		// Check USER.md has section markers
		let userContent = readSoulFile("user");
		if (!userContent || !hasSectionMarkers(userContent)) return;

		try {
			const entries = ctx.sessionManager.getEntries();
			const messages = entries
				.filter((e): e is any => e.type === "message")
				.slice(-6);

			if (messages.length === 0) return;

			// Skip if last message is a slash command
			const lastMsg = messages[messages.length - 1];
			const lastContent = typeof lastMsg.message?.content === "string"
				? lastMsg.message.content
				: "";
			if (lastContent.startsWith("/")) return;

			const extractable = messages.map((e: any) => ({
				role: e.message?.role || "",
				content: e.message?.content || "",
			}));

			const facts = extractor.analyze(extractable);
			if (facts.length === 0) {
				turnsSinceExtract = 3; // Reset partially, not fully
				return;
			}

			turnsSinceExtract = 0;
			let changed = false;

			for (const fact of facts) {
				if (sectionContains(userContent, fact.section, fact.content)) continue;

				const significance = extractor.classifyFact(fact);

				if (significance === "trivial") {
					userContent = mergeSection(userContent, fact.section, fact.content, "append");
					changed = true;
					ctx.ui.notify(
						`Learned: ${fact.content.slice(0, 80)}${fact.content.length > 80 ? "..." : ""}`,
						"info"
					);
				} else {
					userContent = mergeSection(userContent, fact.section, fact.content, "append");
					changed = true;
					ctx.ui.notify(
						`Important: ${fact.content.slice(0, 80)}${fact.content.length > 80 ? "..." : ""}`,
						"info"
					);
				}
			}

			// Write updated userContent if facts were merged
			if (changed) {
				writeSoulFile("user", userContent);
			}

			// Compact if needed
			const compacted = compactUserFile();
			if (compacted) {
				writeSoulFile("user", compacted);
			}
		} catch {
			// Never disrupt conversation
		}
	});

	// --- Command: /soul ---
	fan.registerCommand("soul", {
		description: "Agent identity & operator profile management",
		getArgumentCompletions(prefix) {
			const cmds = [
				"init", "status", "soul", "user", "edit", "drafts", "migrate", "reset",
			];
			const filtered = cmds.filter((c) => c.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((c) => ({ value: c, label: c }))
				: null;
		},
		async handler(args: string, ctx: ExtensionCommandContext) {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0] || "status";

			switch (sub) {
				case "init":
					await handleInit(ctx);
					break;
				case "status":
					await handleStatus(ctx);
					break;
				case "soul":
					await handleFilePreview("soul", ctx);
					break;
				case "user":
					await handleFilePreview("user", ctx);
					break;
				case "edit":
					await handleEdit(ctx);
					break;
				case "drafts":
					await handleDrafts(ctx);
					break;
				case "migrate":
					await handleMigrate(ctx);
					break;
				case "reset":
					await handleReset(parts[1] as SoulFileKey, ctx);
					break;
				default:
					await handleStatus(ctx);
			}
		},
	});

	// --- Tool: soul_update ---
	fan.registerTool({
		name: "soul_update",
		label: "Soul Update",
		description:
			"Update agent identity (SOUL.md) or operator profile (USER.md). For SOUL.md changes require confirmation. For USER.md uses smart merge with deduplication.",
		parameters: Type.Object({
			target: Type.Union([Type.Literal("soul"), Type.Literal("user")]),
			section: Type.Optional(
				Type.Union([
					Type.Literal("profile"),
					Type.Literal("context"),
					Type.Literal("preferences"),
					Type.Literal("projects"),
					Type.Literal("core"),
					Type.Literal("style"),
					Type.Literal("boundaries"),
					Type.Literal("vibe"),
				])
			),
			action: Type.Union([Type.Literal("append"), Type.Literal("replace"), Type.Literal("remove")]),
			content: Type.String({ minLength: 1 }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { target, section, action, content } = params;

			if (target === "soul") {
				return await updateSoul(section, action, content, ctx);
			} else {
				return await updateUser(section as UserSectionName, action, content);
			}
		},
	});
}

// --- Command Handlers ---

async function handleInit(ctx: ExtensionCommandContext): Promise<void> {
	ctx.ui.notify("Starting soul configuration wizard...", "info");

	// --- SOUL.md setup ---
	const hasSoul = fileExists("soul");
	if (hasSoul) {
		const reconfig = await ctx.ui.confirm(
			"SOUL.md",
			"SOUL.md already exists. Recreate with new configuration?"
		);
		if (reconfig) {
			createFromTemplate("soul");
			ctx.ui.notify("SOUL.md template created.", "info");
		}
	} else {
		createFromTemplate("soul");
		ctx.ui.notify("SOUL.md template created.", "info");
	}

	// Collect SOUL.md data interactively
	const soulEmoji = await ctx.ui.input(
		"Agent Emoji",
		"e.g. 🧡, 🤖, 🔥, ✨"
	);
	const soulName = await ctx.ui.input(
		"Agent Name",
		"e.g. Filin, Atlas, Nova"
	);
	const soulCore = await ctx.ui.input(
		"Core Identity",
		"Describe the agent's core purpose, values, and personality"
	);
	const soulStyle = await ctx.ui.input(
		"Communication Style",
		"e.g. concise & technical, friendly & detailed, minimal & direct"
	);
	const soulBoundaries = await ctx.ui.input(
		"Boundaries",
		"What should the agent avoid doing?"
	);
	const soulVibe = await ctx.ui.input(
		"Personality Vibe",
		"e.g. calm & methodical, energetic & creative, quiet & focused"
	);

	const soulContent = `# SOUL.md — Agent Identity

<!-- name: ${soulName || ""} -->
<!-- emoji: ${soulEmoji || "🧡"} -->

## Core
${soulCore || "<Define your core identity>"}

## Style
${soulStyle || "<Define your communication style>"}

## Boundaries
${soulBoundaries || "<Define your boundaries>"}

## Vibe
${soulVibe || "<Define your personality nuances>"}
`;

	await writeSoulFile("soul", soulContent);
	ctx.ui.notify("SOUL.md configured.", "info");

	// --- USER.md setup ---
	const hasUser = fileExists("user");
	if (hasUser) {
		const reconfig = await ctx.ui.confirm(
			"USER.md",
			"USER.md already exists. Recreate with new configuration?"
		);
		if (reconfig) {
			createFromTemplate("user");
			ctx.ui.notify("USER.md template created.", "info");
		}
	} else {
		createFromTemplate("user");
		ctx.ui.notify("USER.md template created.", "info");
	}

	// Collect USER.md data interactively
	const userName = await ctx.ui.input(
		"Your Name",
		"Your real name or handle"
	);
	const callName = await ctx.ui.input(
		"What to call you",
		"Short name or nickname for the agent to use"
	);
	const timezone = await ctx.ui.input(
		"Timezone",
		"e.g. UTC+3, Europe/Moscow, America/New_York"
	);
	const language = await ctx.ui.input(
		"Preferred Language",
		"e.g. Russian, English, Mixed"
	);
	const workContext = await ctx.ui.input(
		"Work Context",
		"Your role, domain, expertise"
	);

	const userContent = `# USER.md — Operator Profile

<!-- section:profile -->
## Profile
- **Name:** ${userName || ""}
- **What to call them:** ${callName || ""}
- **Timezone:** ${timezone || ""}
- **Language:** ${language || ""}
<!-- /section:profile -->

<!-- section:context -->
## Context
${workContext || ""}
<!-- /section:context -->

<!-- section:preferences -->
## Preferences
<!-- Your preferences will be collected automatically from conversations -->
<!-- /section:preferences -->

<!-- section:projects -->
## Projects
<!-- Active projects and focus areas will be collected automatically -->
<!-- /section:projects -->
`;

	await writeSoulFile("user", userContent);
	ctx.ui.notify("USER.md configured.", "info");

	// Update status widget
	const identity = parseSoulIdentity();
	if (identity) {
		ctx.ui.setStatus("0-soul", `${identity.emoji} ${identity.name}`);
	}

	ctx.ui.notify("✅ Soul configuration complete! Files saved to ~/.fan/", "info");
}

async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
	const identity = parseSoulIdentity();
	const all = readAllSoulFiles();

	const lines: string[] = ["--- Soul Status ---"];

	if (identity) {
		lines.push(`Agent: ${identity.emoji} ${identity.name}`);
	} else {
		lines.push("Agent: not configured");
	}

	for (const [key, filePath] of [
		["soul", getSoulFilePath("soul")],
		["user", getSoulFilePath("user")],
	] as [SoulFileKey, string][]) {
		const content = all[key];
		if (content) {
			lines.push(`${key.toUpperCase()}: ${content.length} chars (${filePath})`);
		} else {
			lines.push(`${key.toUpperCase()}: not found`);
		}
	}

	const pending = drafts.listPending();
	if (pending.length > 0) {
		lines.push(`Drafts: ${pending.length} pending`);
	}

	lines.push("─────────────────");
	ctx.ui.notify(lines.join("\n"), "info");
}

async function handleFilePreview(key: SoulFileKey, ctx: ExtensionCommandContext): Promise<void> {
	if (!fileExists(key)) {
		createFromTemplate(key);
		ctx.ui.notify(`${key.toUpperCase()} created from template.`, "info");
	}

	const content = readSoulFile(key);
	if (!content) {
		ctx.ui.notify(`${key.toUpperCase()} is empty.`, "warning");
		return;
	}

	const preview = content.split("\n").slice(0, 10).join("\n");
	ctx.ui.notify(
		`${key.toUpperCase()} (${content.length} chars):\n${preview}${content.split("\n").length > 10 ? "\n..." : ""}`,
		"info"
	);
}

async function handleEdit(ctx: ExtensionCommandContext): Promise<void> {
	const content = readSoulFile("soul") || "";
	const edited = await ctx.ui.editor("Edit SOUL.md", content);
	if (edited) {
		await writeSoulFile("soul", edited);
		ctx.ui.notify("SOUL.md updated.", "info");

		const identity = parseSoulIdentity();
		if (identity) {
			ctx.ui.setStatus("0-soul", `${identity.emoji} ${identity.name}`);
		}
	}
}

async function handleDrafts(ctx: ExtensionCommandContext): Promise<void> {
	const pending = drafts.listPending();
	if (pending.length === 0) {
		ctx.ui.notify("No pending drafts.", "info");
		return;
	}

	const lines = [`Pending drafts (${pending.length}):`];
	for (const draft of pending.slice(0, 5)) {
		const age = Math.round((Date.now() - draft.createdAt) / 60000);
		lines.push(
			`  ${draft.id.slice(0, 8)} [${draft.fact.category}/${draft.fact.section}] ${draft.fact.content.slice(0, 60)}... (${age}m ago)`
		);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

async function handleMigrate(ctx: ExtensionCommandContext): Promise<void> {
	const migrated = migrateUserFile();
	if (!migrated) {
		ctx.ui.notify("USER.md is already in sectioned format or does not exist.", "info");
		return;
	}
	await writeSoulFile("user", migrated);
	ctx.ui.notify("USER.md migrated to sectioned format.", "info");
}

async function handleReset(key: SoulFileKey | undefined, ctx: ExtensionCommandContext): Promise<void> {
	if (!key || (key !== "soul" && key !== "user")) {
		ctx.ui.notify("Usage: /soul reset <soul|user>", "warning");
		return;
	}

	const confirmed = await ctx.ui.confirm(
		"Reset",
		`Reset ${key.toUpperCase()} to template? Current content will be lost.`
	);
	if (!confirmed) return;

	createFromTemplate(key);
	ctx.ui.notify(`${key.toUpperCase()} reset to template.`, "info");
}

// --- Tool Handlers ---

async function updateSoul(
	section: string | undefined,
	action: MergeAction,
	content: string,
	ctx: any
): Promise<AgentToolResult<Record<string, unknown>>> {
	const current = readSoulFile("soul");
	if (!current) {
		return { content: [{ type: "text", text: "SOUL.md does not exist. Run /soul init first." }], details: { error: true } };
	}

	// Confirm changes via UI
	const preview = `Action: ${action}${section ? ` on section "${section}"` : ""}\n\n${content.slice(0, 300)}${content.length > 300 ? "..." : ""}`;

	if (ctx.hasUI) {
		const confirmed = await ctx.ui.confirm("Soul Update", preview);
		if (!confirmed) {
			return { content: [{ type: "text", text: "Update cancelled by user." }], details: {} };
		}
	}

	let result = current;

	if (action === "remove" && section) {
		const regex = new RegExp(
			`## ${escapeRegex(section.charAt(0).toUpperCase() + section.slice(1))}\\n[\\s\\S]*?(?=\\n## |$)`,
			"i"
		);
		result = result.replace(regex, "").replace(/\n{3,}/g, "\n\n").trim();
	} else if (action === "replace" && section) {
		const heading = `## ${section.charAt(0).toUpperCase() + section.slice(1)}`;
		const regex = new RegExp(`## ${escapeRegex(section)}\\n[\\s\\S]*?(?=\\n## |$)`, "i");
		if (regex.test(result)) {
			result = result.replace(regex, `${heading}\n${content}`);
		} else {
			result = result.trimEnd() + `\n\n${heading}\n${content}`;
		}
	} else if (action === "append") {
		if (section) {
			const heading = `## ${section.charAt(0).toUpperCase() + section.slice(1)}`;
			const regex = new RegExp(`## ${escapeRegex(section)}\\n[\\s\\S]*?(?=\\n## |$)`, "i");
			if (regex.test(result)) {
				result = result.replace(regex, (match) => `${match}\n${content}`);
			} else {
				result = result.trimEnd() + `\n\n${heading}\n${content}`;
			}
		} else {
			result = result.trimEnd() + `\n\n${content}`;
		}
	}

	await writeSoulFile("soul", result);
	return { content: [{ type: "text", text: "SOUL.md updated." }], details: {} };
}

async function updateUser(
	section: UserSectionName | undefined,
	action: MergeAction,
	content: string
): Promise<AgentToolResult<Record<string, unknown>>> {
	let userContent = readSoulFile("user");
	if (!userContent) {
		return { content: [{ type: "text", text: "USER.md does not exist. Run /soul init first." }], details: { error: true } };
	}

	// Auto-migrate if needed
	if (!hasSectionMarkers(userContent)) {
		const migrated = migrateUserFile();
		if (migrated) {
			await writeSoulFile("user", migrated);
			userContent = migrated;
		}
	}

	if (!section || !VALID_SECTIONS.has(section)) {
		return { content: [{ type: "text", text: `Invalid section. Valid: ${[...VALID_SECTIONS].join(", ")}` }], details: { error: true } };
	}

	const result = mergeSection(userContent, section, content, action);

	if (result === userContent) {
		const msg = action === "remove"
			? "Section not found or already removed."
			: "Content already exists in section (dedup).";
		return { content: [{ type: "text", text: msg }], details: {} };
	}

	await writeSoulFile("user", result);
	return { content: [{ type: "text", text: `USER.md ${section} section ${action}ed.` }], details: {} };
}

