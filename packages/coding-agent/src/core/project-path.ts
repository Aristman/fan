/**
 * Project path helpers — workspace-aware comparison of session cwd values (F-1.9).
 *
 * NOTE: `normalizeProjectPath` is an intentional duplicate of the same helper in
 * `packages/api-gateway/src/http-server.ts`. A cross-package dependency
 * (coding-agent → api-gateway) would invert the package layering (api-gateway is
 * the consumer of coding-agent, not vice versa), and a shared util package is
 * overkill for ~15 lines. Keep both copies in sync.
 */

/**
 * Normalize a filesystem path for equality comparison.
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

/**
 * Check whether a session cwd belongs to the given project path
 * (normalized equality comparison).
 *
 * Sessions without a cwd (`undefined`) never belong to any project —
 * this matches the HTTP-layer semantics (F-1.2/F-1.4), where cwd-less
 * sessions are excluded from project filters.
 */
export function sessionBelongsToProject(sessionCwd: string | undefined, projectPath: string): boolean {
	if (sessionCwd === undefined) return false;
	return normalizeProjectPath(sessionCwd) === normalizeProjectPath(projectPath);
}
