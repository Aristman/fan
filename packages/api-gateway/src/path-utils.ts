/**
 * Shared pure path helpers (no fs access, platform-independent).
 * Extracted from http-server.ts (F-5.7) so auth middleware and the WS
 * handler can apply the exact same normalization when comparing project
 * paths for per-project token scopes.
 */

/**
 * Normalize a filesystem path for equality comparison (F-1.2 ?project= filter).
 * Pure string-based (no fs access, platform-independent):
 * backslashes → forward slashes, resolve `.`/`..` segments, strip trailing slash,
 * lowercase drive letter on Windows-style paths (`C:\...`).
 */
export function normalizeProjectPath(p: string): string {
	let s = p.trim().replace(/\\/g, "/");
	// Collapse duplicate slashes
	s = s.replace(/\/{2,}/g, "/");
	// Resolve . and .. segments
	const isAbsolute = s.startsWith("/") || /^[A-Za-z]:\//.test(s);
	const segments: string[] = [];
	for (const seg of s.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
			else if (!isAbsolute) segments.push("..");
			continue;
		}
		segments.push(seg);
	}
	let normalized = segments.join("/");
	if (s.startsWith("/")) normalized = `/${normalized}`;
	// Windows: case-insensitive filesystem — compare case-folded
	if (/^[A-Za-z]:/.test(normalized)) normalized = normalized.toLowerCase();
	return normalized;
}

/** Basename of a normalized path (pure string-based, no fs access). */
export function pathBasename(p: string): string {
	const segments = p.split("/").filter((seg) => seg.length > 0);
	return segments.length > 0 ? segments[segments.length - 1] : p;
}
