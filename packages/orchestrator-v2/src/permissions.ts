/**
 * FAN Orchestrator v2 — Permission System
 *
 * Detects dangerous bash commands via regex and shows a confirm dialog.
 */

/**
 * Check if a command is dangerous. Returns a human-readable reason
 * or null if the command is safe.
 */
export function isDangerousCommand(cmd: string): string | null {
  const c = cmd.toLowerCase().trim();

  // rm with BOTH recursive AND force
  if (/\brm\b/.test(c) && /-([a-zA-Z]*r[a-zA-Z]*|--recursive)/.test(c) && /-([a-zA-Z]*f[a-zA-Z]*|--force)/.test(c)) {
    return "rm recursive+force";
  }

  if (/\bgit\s+push.*(--force|-f)\b/.test(c)) return "git push --force";
  if (/\b(npm|yarn|pnpm)\s+publish\b/.test(c)) return "package publish";
  if (/\b(DROP|TRUNCATE|DELETE\s+FROM)\b(\s+(TABLE|DATABASE|SCHEMA))?\b/i.test(c)) return "SQL destructive";
  if (/\b(format|mkfs)\b/.test(c)) return "disk format";
  if (/\b(shutdown|reboot|halt|poweroff)\b/.test(c)) return "system shutdown";
  // chmod/chown on root paths — -r/-R handled after toLowerCase()
  if (/\b(chmod|chown)\s+(-r|-R|--recursive)?\s*[0-7]{3,4}\s+\//.test(c)) return "chmod on /";
  if (/\bfind\b.*-delete\b/.test(c)) return "find -delete";

  return null;
}
