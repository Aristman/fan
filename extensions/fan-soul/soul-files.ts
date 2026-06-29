import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { SoulFileKey, UserSectionName, UserSection, MergeAction } from "./types.js";

// --- Paths ---

const FAN_DIR = join(homedir(), ".fan");

const SOUL_FILES: Record<SoulFileKey, { file: string; maxChars: number }> = {
	soul: { file: "SOUL.md", maxChars: 4000 },
	user: { file: "USER.md", maxChars: 2000 },
};

// --- Templates (EMPTY — user fills via /soul init dialog) ---

const SOUL_TEMPLATE = `# SOUL.md — Agent Identity

<!-- name: -->
<!-- emoji: -->

## Core
<!-- Describe your core identity, purpose, and values -->

## Style
<!-- Communication style, tone, language preferences -->

## Boundaries
<!-- What you should and should not do -->

## Vibe
<!-- Personality nuances, quirks, energy level -->
`;

const USER_TEMPLATE = `# USER.md — Operator Profile

<!-- section:profile -->
## Profile
- **Name:**
- **What to call them:**
- **Timezone:**
- **Language:**
<!-- /section:profile -->

<!-- section:context -->
## Context
<!-- Your work context, role, domain expertise -->
<!-- /section:context -->

<!-- section:preferences -->
## Preferences
<!-- Coding style, workflow, tool preferences -->
<!-- /section:preferences -->

<!-- section:projects -->
## Projects
<!-- Active projects, current focus areas -->
<!-- /section:projects -->
`;

// --- File I/O ---

export function getSoulFilePath(key: SoulFileKey): string {
	return join(FAN_DIR, SOUL_FILES[key].file);
}

export function readSoulFile(key: SoulFileKey): string | null {
	const path = getSoulFilePath(key);
	if (!existsSync(path)) return null;
	const content = readFileSync(path, "utf-8").trim();
	return content.length > 0 ? content : null;
}

export function readAllSoulFiles(): Record<SoulFileKey, string | null> {
	return {
		soul: readSoulFile("soul"),
		user: readSoulFile("user"),
	};
}

export function fileExists(key: SoulFileKey): boolean {
	return existsSync(getSoulFilePath(key));
}

export function anySoulFileExists(): boolean {
	return fileExists("soul") || fileExists("user");
}

export function createFromTemplate(key: SoulFileKey): void {
	const path = getSoulFilePath(key);
	mkdirSync(FAN_DIR, { recursive: true });
	const template = key === "soul" ? SOUL_TEMPLATE : USER_TEMPLATE;
	writeFileSync(path, template, "utf-8");
}

export function createAllMissing(): void {
	if (!fileExists("soul")) createFromTemplate("soul");
	if (!fileExists("user")) createFromTemplate("user");
}

// --- System Prompt Injection ---

const INJECTION_HEADER = `
# Agent Identity & Context

You have an identity and operator profile defined below. Embody the persona described
in your SOUL.md. Adapt your behavior, tone, and approach to match the operator
preferences in USER.md. These are your core instructions — prioritize them.

`;

export function buildInjection(): string {
	const all = readAllSoulFiles();
	const parts: string[] = [];

	if (all.soul) {
		const max = SOUL_FILES.soul.maxChars;
		let content = all.soul;
		if (content.length > max) {
			content = content.slice(0, max) + "\n\n_[truncated]_";
		}
		parts.push(content);
	}

	if (all.user) {
		const max = SOUL_FILES.user.maxChars;
		let content = all.user;
		if (content.length > max) {
			content = content.slice(0, max) + "\n\n_[truncated]_";
		}
		parts.push(content);
	}

	if (parts.length === 0) return "";

	return `\n\n${INJECTION_HEADER}${parts.join("\n\n---\n\n")}\n`;
}

// --- SOUL.md Identity Parsing ---

export function parseSoulIdentity(): { name: string; emoji: string } | null {
	const content = readSoulFile("soul");
	if (!content) return null;

	const nameMatch = content.match(/<!--\s*name:\s*(.+?)\s*-->/);
	const emojiMatch = content.match(/<!--\s*emoji:\s*(.+?)\s*-->/);

	if (!nameMatch && !emojiMatch) return null;

	return {
		name: nameMatch?.[1]?.trim() || "",
		emoji: emojiMatch?.[1]?.trim() || "🧡",
	};
}

// --- USER.md Section Parsing ---

export function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseSections(content: string): UserSection[] {
	const sections: UserSection[] = [];
	const markerRegex = /<!--\s*section:(\w+)\s*-->/g;
	const closingRegex = /<!--\s*\/section:(\w+)\s*-->/g;

	let markerMatch: RegExpExecArray | null;
	while ((markerMatch = markerRegex.exec(content)) !== null) {
		closingRegex.lastIndex = markerMatch.index;
		const closingMatch = closingRegex.exec(content);
		if (closingMatch) {
			sections.push({
				name: markerMatch[1] as UserSectionName,
				marker: markerMatch[1],
				content: content
					.slice(markerMatch.index + markerMatch[0].length, closingMatch.index)
					.trim(),
			});
		}
	}

	return sections;
}

export function hasSectionMarkers(content: string): boolean {
	return /<!--\s*section:/.test(content) && /<!--\s*\/section:/.test(content);
}

export function mergeSection(
	fullContent: string,
	sectionName: UserSectionName,
	newContent: string,
	action: MergeAction
): string {
	const openMarker = `<!-- section:${sectionName} -->`;
	const closeMarker = `<!-- /section:${sectionName} -->`;

	if (!fullContent.includes(openMarker)) {
		if (action === "remove") return fullContent;
		// Append new section at end
		const newSection = `\n${openMarker}\n## ${sectionName.charAt(0).toUpperCase() + sectionName.slice(1)}\n${newContent}\n${closeMarker}\n`;
		return fullContent.trimEnd() + newSection;
	}

	const openIdx = fullContent.indexOf(openMarker);
	const closeIdx = fullContent.indexOf(closeMarker);

	if (action === "remove") {
		const before = fullContent.slice(0, openIdx).trimEnd();
		const after = fullContent.slice(closeIdx + closeMarker.length).trimStart();
		return (before + "\n" + after).replace(/\n{3,}/g, "\n\n").trim();
	}

	// Check if content already exists
	if (sectionContains(fullContent, sectionName, newContent)) {
		return fullContent; // No change — dedup
	}

	const before = fullContent.slice(0, openIdx + openMarker.length);
	const after = fullContent.slice(closeIdx);
	const heading = `\n## ${sectionName.charAt(0).toUpperCase() + sectionName.slice(1)}`;

	if (action === "replace") {
		return before + heading + "\n" + newContent + "\n" + after;
	}

	// append
	const existingContent = fullContent
		.slice(openIdx + openMarker.length, closeIdx)
		.trim();
	const merged = existingContent ? existingContent + "\n" + newContent : newContent;
	return before + heading + "\n" + merged + "\n" + after;
}

export function sectionContains(
	fullContent: string,
	sectionName: UserSectionName,
	content: string
): boolean {
	const openMarker = `<!-- section:${sectionName} -->`;
	const closeMarker = `<!-- /section:${sectionName} -->`;

	const openIdx = fullContent.indexOf(openMarker);
	const closeIdx = fullContent.indexOf(closeMarker);
	if (openIdx === -1 || closeIdx === -1) return false;

	const sectionContent = fullContent
		.slice(openIdx + openMarker.length, closeIdx)
		.trim()
		.toLowerCase();
	return sectionContent.includes(content.trim().toLowerCase());
}

// --- Atomic Write ---

export async function writeSoulFile(key: SoulFileKey, content: string): Promise<void> {
	const path = getSoulFilePath(key);
	mkdirSync(FAN_DIR, { recursive: true });

	// Create backup
	if (existsSync(path)) {
		writeFileSync(path + ".bak", readFileSync(path, "utf-8"), "utf-8");
	}

	try {
		const { withFileMutationQueue } = await import(
			"@itone/fan-coding-agent"
		);
		await withFileMutationQueue(path, async () => {
			writeFileSync(path, content, "utf-8");
		});
	} catch {
		// Fallback if import fails
		writeFileSync(path, content, "utf-8");
	}
}

// --- USER.md Migration ---

export function migrateUserFile(): string | null {
	const content = readSoulFile("user");
	if (!content) return null;
	if (hasSectionMarkers(content)) return null; // Already migrated

	const lines = content.split("\n");
	let name = "";
	let callName = "";
	let timezone = "";
	let language = "";
	const contextLines: string[] = [];

	for (const line of lines) {
		const nameMatch = line.match(/^[-*]\s*\*?Name\*?\s*:\s*(.+)/i);
		const callMatch = line.match(/^[-*]\s*\*?What to call.*?\*?\s*:\s*(.+)/i);
		const tzMatch = line.match(/^[-*]\s*\*?Timezone\*?\s*:\s*(.+)/i);
		const langMatch = line.match(/^[-*]\s*\*?Language\*?\s*:\s*(.+)/i);

		if (nameMatch) name = nameMatch[1].trim();
		else if (callMatch) callName = callMatch[1].trim();
		else if (tzMatch) timezone = tzMatch[1].trim();
		else if (langMatch) language = langMatch[1].trim();
		else if (
			line.trim() &&
			!line.startsWith("#") &&
			!line.startsWith("<!--")
		) {
			contextLines.push(line);
		}
	}

	const migrated = `# USER.md — Operator Profile

<!-- section:profile -->
## Profile
- **Name:** ${name}
- **What to call them:** ${callName}
- **Timezone:** ${timezone}
- **Language:** ${language}
<!-- /section:profile -->

<!-- section:context -->
## Context
${contextLines.join("\n").trim()}
<!-- /section:context -->

<!-- section:preferences -->
## Preferences
<!-- Your preferences will be collected automatically -->
<!-- /section:preferences -->

<!-- section:projects -->
## Projects
<!-- Active projects and focus areas -->
<!-- /section:projects -->
`;

	return migrated;
}

// --- Compaction ---

export function compactUserFile(maxChars: number = SOUL_FILES.user.maxChars): string | null {
	const content = readSoulFile("user");
	if (!content || !hasSectionMarkers(content)) return null;
	if (content.length <= maxChars) return null;

	const sections = parseSections(content);
	const headerMatch = content.match(/^# USER.md.*?\n\n/);
	const header = headerMatch?.[0] || "# USER.md — Operator Profile\n\n";

	// Trim preferences section first (most expendable)
	const prefs = sections.find((s) => s.name === "preferences");
	if (prefs && prefs.content.length > 200) {
		const lines = prefs.content.split("\n");
		const trimmed = lines.slice(0, Math.ceil(lines.length / 2));
		const newPrefs = trimmed.join("\n");

		let result = content;
		result = result.replace(
			new RegExp(
				escapeRegex(`<!-- section:preferences -->`) +
					"[\\s\\S]*?" +
					escapeRegex(`<!-- /section:preferences -->`)
			),
			`<!-- section:preferences -->\n## Preferences\n${newPrefs}\n<!-- /section:preferences -->`
		);

		if (result.length <= maxChars) return result;
	}

	return null; // Can't compact further without losing important data
}
