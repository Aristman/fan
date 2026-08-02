import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { parseSessionEntries } from "@seaagents/fan-coding-agent";
import type { FileEntry } from "@seaagents/fan-coding-agent";
import type { AnalyticsConfig } from "./types.js";

export interface ParsedSession {
	entries: FileEntry[];
	path: string;
	totalLines: number;
	validLines: number;
	invalidLines: number;
	truncated: boolean;
	size: number;
}

/**
 * Parse a single session file. Uses our own line-by-line split to count
 * invalid lines (for truncated flag), then delegates to parseSessionEntries
 * for the actual parsing.
 */
export async function parseSessionFile(filePath: string): Promise<ParsedSession> {
	const content = await readFile(filePath, "utf-8");
	const allLines = content.split("\n").filter((l) => l.trim().length > 0);
	const totalLines = allLines.length;

	// Count invalid lines ourselves
	let invalidLines = 0;
	for (const line of allLines) {
		try {
			JSON.parse(line);
		} catch {
			invalidLines++;
		}
	}

	// Use the official parser
	const entries = parseSessionEntries(content);
	const validLines = entries.length;

	const isTruncated = invalidLines > 0;

	const fileStat = await stat(filePath);

	return {
		entries,
		path: filePath,
		totalLines,
		validLines,
		invalidLines,
		truncated: isTruncated,
		size: fileStat.size,
	};
}

/**
 * Check if a session file path should be excluded (garbage filter).
 */
export function isGarbagePath(filePath: string, cfg: AnalyticsConfig): boolean {
	for (const pattern of cfg.filters.excludePathPatterns) {
		if (filePath.includes(pattern)) return true;
	}
	return false;
}

/**
 * Check if a session has too few entries (garbage filter).
 */
export function isGarbageSession(entries: FileEntry[], cfg: AnalyticsConfig): boolean {
	return entries.length < cfg.filters.minEntries;
}

/**
 * Check if session contains self-references to session_analyze (BR3).
 */
export function containsSessionAnalyze(entries: FileEntry[]): boolean {
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = (entry as any).message;
		if (!msg) continue;
		if (msg.role === "assistant") {
			const content = msg.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block?.type === "toolCall" && block?.name === "session_analyze") {
						return true;
					}
				}
			}
		}
		if (msg.role === "toolResult" && msg.toolName === "session_analyze") {
			return true;
		}
	}
	return false;
}

/**
 * Get sessions directory for a given cwd.
 * Mirrors getDefaultSessionDir() from packages/coding-agent/src/core/session-manager.ts.
 * Example: getSessionsDir("C:\\Users\\User") → "…/sessions/--C--Users-User--"
 */
export function getSessionsDir(cwd: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(homedir(), ".fan", "agent", "sessions", safePath);
}

/**
 * Find the last session file in a directory.
 */
export async function findLastSession(dirPath: string): Promise<string | null> {
	try {
		const files = await readdir(dirPath);
		const jsonlFiles = files
			.filter((f) => f.endsWith(".jsonl"))
			.sort()
			.reverse();
		if (jsonlFiles.length === 0) return null;
		return join(dirPath, jsonlFiles[0]);
	} catch {
		return null;
	}
}

/**
 * Find all session files in a directory, optionally filtered by since date.
 */
export async function findAllSessions(
	dirPath: string,
	since?: string
): Promise<string[]> {
	try {
		const files = await readdir(dirPath);
		const jsonlFiles = files.filter((f) => f.endsWith(".jsonl")).sort();

		const result: string[] = [];
		const sinceMs = since ? new Date(since).getTime() : 0;

		for (const f of jsonlFiles) {
			const fullPath = join(dirPath, f);

			if (sinceMs > 0) {
				const fileStat = await stat(fullPath);
				if (fileStat.mtimeMs < sinceMs) continue;
			}

			result.push(fullPath);
		}

		return result;
	} catch {
		return [];
	}
}

/**
 * Extract a slug from a session file path for report naming.
 */
export function sessionSlug(filePath: string): string {
	const name = basename(filePath, ".jsonl");
	// Format: 2026-06-27T09-22-14-191Z_393a7679-abbc-44e9-8291-6ab186e3a3e0
	// Keep date part and short uuid
	const parts = name.split("_");
	const datePart = parts[0]?.replace(/T/g, "_") || "unknown";
	const uuidPart = parts[1]?.slice(0, 8) || "";
	return `${datePart}_${uuidPart}`;
}
