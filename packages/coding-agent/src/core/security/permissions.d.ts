/**
 * Check whether a shell command is dangerous.
 *
 * Detection pipeline:
 *  1. Custom patterns (configurable)
 *  2. Pipe analysis
 *  3. Subshell extraction
 *  4. Heredoc extraction
 *  5. Interpreter inline code
 *  6. Stripped command (fallback)
 *
 * @param cmd - The raw command string to evaluate.
 * @param customPatterns - Optional list of custom dangerous command patterns.
 * @returns A human-readable danger reason, or `null` if the command is safe.
 */
export function isDangerousCommand(cmd: string, customPatterns?: string[]): string | null;
