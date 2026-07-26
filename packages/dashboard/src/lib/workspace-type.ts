// @fan/dashboard/lib — workspace type icons (F-3.7)
//
// Maps a ProjectSummary.type to a Lucide icon + a CSS class:
//   code       → Code2        (💻) .type-code
//   research   → FlaskConical (🔬) .type-research
//   automation → Cog          (⚙️) .type-automation
//   unknown    → HelpCircle   (❓) .type-unknown
//
// Used by project-switcher (per-project icon) and session-sidebar (icon on
// cwd tree groups, resolved via a cwd→type mapping from dashboard-app state).

import { CircleQuestionMark, CodeXml, Cog, FlaskConical, type IconNode } from "lucide";
import { icon } from "./icon.js";

/** Known workspace types (F-3.1). Anything else falls back to "unknown". */
export const WORKSPACE_TYPES = ["code", "research", "automation", "unknown"] as const;
export type WorkspaceType = (typeof WORKSPACE_TYPES)[number];

const TYPE_ICONS: Record<WorkspaceType, IconNode> = {
	code: CodeXml, // 💻
	research: FlaskConical, // 🔬
	automation: Cog, // ⚙️
	unknown: CircleQuestionMark, // ❓
};

/** Normalize an arbitrary type string to a known WorkspaceType (default: unknown). */
export function normalizeWorkspaceType(type: string | null | undefined): WorkspaceType {
	const t = (type ?? "").trim().toLowerCase();
	return (WORKSPACE_TYPES as readonly string[]).includes(t) ? (t as WorkspaceType) : "unknown";
}

/** Lucide IconNode for a workspace type. */
export function workspaceTypeIcon(type: string | null | undefined): IconNode {
	return TYPE_ICONS[normalizeWorkspaceType(type)];
}

/** CSS class for a workspace type: "type-code" | "type-research" | ... */
export function workspaceTypeClass(type: string | null | undefined): string {
	return `type-${normalizeWorkspaceType(type)}`;
}

/**
 * Render the type icon as a span.workspace-type-icon.type-<t> containing the
 * Lucide SVG (via the shared icon() helper).
 */
export function renderWorkspaceTypeIcon(type: string | null | undefined, sizeClass = "w-4 h-4") {
	const t = normalizeWorkspaceType(type);
	return icon(TYPE_ICONS[t], `workspace-type-icon type-${t} ${sizeClass}`);
}

/**
 * Normalize a path for cwd↔project-path matching (separator + case +
 * trailing-slash tolerant). Mirrors the server-side normalizeProjectPath
 * used for sessionCount (api-gateway http-server.ts), simplified.
 */
export function normalizeProjectPath(p: string): string {
	let s = p.trim().replace(/\\/g, "/");
	while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
	return s.toLowerCase();
}

/**
 * Build a normalized-cwd → type lookup from a projects list
 * (dashboard-app state) for the session-sidebar tree groups.
 */
export function buildProjectTypeMap(projects: ReadonlyArray<{ path: string; type: string }>): Record<string, string> {
	const map: Record<string, string> = {};
	for (const p of projects) {
		map[normalizeProjectPath(p.path)] = normalizeWorkspaceType(p.type);
	}
	return map;
}
