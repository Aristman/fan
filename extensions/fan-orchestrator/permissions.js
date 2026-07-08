/**
 * Dangerous command detection for the Orchestrator.
 *
 * Provides a single exported function `isDangerousCommand` that inspects
 * a bash/shell command string and returns a human-readable reason if the
 * command is considered dangerous, or `null` when it appears safe.
 *
 * Detection pipeline:
 *  1. Custom patterns (configurable)
 *  2. Pipe analysis — each segment checked individually;
 *     interpreter receiving piped dangerous content is flagged.
 *  3. Subshell extraction (bash -c, sh -c, eval with chaining commands).
 *  4. Heredoc extraction (<< EOF, <<-EOF, <<<).
 *  5. Interpreter inline code (node -e, python -c, perl -e, ruby -e).
 *  6. Stripped command (quotes removed) — catches bare dangerous commands.
 */

// ──────────────────────────────────────────────
//  Pattern matcher
// ──────────────────────────────────────────────

/**
 * Network/download commands that fetch external content.
 */
const DOWNLOAD_CMDS = /^(?:curl|wget|fetch|http)/i;

/**
 * Check common patterns on a plain text string.
 * Returns a reason string or null.
 */
function checkPatterns(text) {
    /* ── rm -rf (recursive forced delete) ── */
    // Separate flags: rm -r -f, rm --recursive --force
    if (/\brm\s+.*(?:-[a-zA-Z]*r[a-zA-Z]*|--recursive).*\s+.*(?:-[a-zA-Z]*f[a-zA-Z]*|--force)/i.test(text) ||
        /\brm\s+.*(?:-[a-zA-Z]*f[a-zA-Z]*|--force).*\s+.*(?:-[a-zA-Z]*r[a-zA-Z]*|--recursive)/i.test(text)) {
        return "Recursive forced delete (rm -rf)";
    }
    // Combined short flags: rm -rf, rm -fr
    if (/\brm\s+.*-[a-zA-Z]*rf[a-zA-Z]*/i.test(text) || /\brm\s+.*-[a-zA-Z]*fr[a-zA-Z]*/i.test(text)) {
        return "Recursive forced delete (rm -rf)";
    }
    // rm with variable expansion — risky indirection
    if (/\brm\s+.*\$\{[a-zA-Z_]+\}/.test(text)) {
        return "Recursive forced delete (rm -rf)";
    }
    // rm with brace expansion — can expand to many paths
    if (/\brm\s+.*\{[a-z,]+\}/.test(text)) {
        return "Recursive forced delete (rm -rf)";
    }

    /* ── git push --force ── */
    if (/\bgit\s+push\s+.*(?:--force\b|-f\b|--force-with-lease\b)/i.test(text)) {
        return "Force push to remote";
    }

    /* ── npm / yarn / pnpm publish ── */
    if (/\b(?:npm|yarn|pnpm)\s+publish\b/i.test(text)) {
        return "Publishing package to registry";
    }

    /* ── SQL destructive ── */
    if (/\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i.test(text) || /\bDELETE\s+FROM\b/i.test(text)) {
        return "Destructive SQL operation";
    }

    /* ── Disk format / partition ── */
    if (/\b(?:format|fdisk)\s/i.test(text) || /\bmkfs(?:\.\w+)?\s/i.test(text)) {
        return "Disk format/partition operation";
    }

    /* ── dd destructive ── */
    if (/\bdd\s+.*\s+of=\/dev\/(?:sd|hd|nvme|vd|xvd)/i.test(text)) {
        return "Destructive dd to block device";
    }

    /* ── mv to critical system paths ── */
    if (/\bmv\s+.*\s+\/(?:etc|boot|usr|var|sys|proc)\b/i.test(text)) {
        return "Move operation to critical system path";
    }

    /* ── chmod / chown on critical paths ── */
    if (/\bchmod\s+[0-7]{3,4}\s+\/(?:etc|usr|bin|var|boot|home)\b/i.test(text)) {
        return "Permission change on critical system path";
    }

    /* ── System power operations ── */
    // Whitelist: service restart / systemctl restart — these are legitimate uses
    const isWhitelistedServiceOp = /(?:systemctl\s+(?:stop|restart|reload)\s+\w+|service\s+\w+\s+(?:stop|restart|reload))\b/i.test(text);
    if (/\b(?:shutdown|reboot|halt|poweroff)\b/i.test(text) && !isWhitelistedServiceOp) {
        return "System power operation";
    }

    /* ── Recursive chmod/chown on root, /etc, /usr, /var, /boot, /home ── */
    if (/\b(?:chmod|chown)\s+(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\b.*\/(?:\s|$)/i.test(text) ||
        /\b(?:chmod|chown)\s+(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\b.*\/(?:etc|usr|var|boot|home)(?:\s|\/|$)/i.test(text)) {
        return "Recursive permission change on critical directory";
    }

    /* ── find -delete ── */
    if (/\bfind\b.*\s-delete\b/i.test(text)) {
        return "Find with delete operation";
    }

    /* ── Fork bomb ── */
    // Matches both :(){ :|:& };: and :() { :|:& };:
    if (/:\(\)\s*\{[\s\S]*?:\|[\s\S]*?\}/.test(text)) {
        return "Fork bomb (denial of service)";
    }

    return null;
}

// ──────────────────────────────────────────────
//  Extractors
// ──────────────────────────────────────────────

/**
 * Strip quoted content from a command to reduce false positives
 * from benign usages like echo "rm -rf /" or grep "rm -rf" log.txt.
 */
function stripQuotes(cmd) {
    return cmd
        .replace(/'(?:[^'\\]|\\.)*'/g, '""')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * Extract inner command from subshell invocations:
 *   bash -c "rm -rf /"
 *   bash -lc "command" (combined flags where -c is part of a flag group)
 *   env bash -c "command"
 *   sudo bash -c "command"
 *   eval "command"
 */
function extractSubshell(cmd) {
    // Strategy 1: shell with separate -c flag (bash -c "cmd")
    const re1 = /(?:(?:env|xargs|nice|time|nohup|sudo)\s+)?(?:bash|sh|zsh|dash|fish)\s+(-[a-zA-Z]*c[a-zA-Z]*\s+)?-c\s+(?:"([^"]*)"|'([^']*)'|(\S+))/i;
    const m1 = cmd.match(re1);
    if (m1 && (m1[2] || m1[3] || m1[4])) return (m1[2] || m1[3] || m1[4] || "").trim();

    // Strategy 2: shell with combined flag containing c (bash -lc "cmd")
    // The -c is embedded in the flag group, no separate -c after.
    // Use [a-zA-Z]* after c to handle -lc where c is the last character.
    const re2 = /(?:(?:env|xargs|nice|time|nohup|sudo)\s+)?(?:bash|sh|zsh|dash|fish)\s+(-[a-zA-Z]*c[a-zA-Z]*)\s+(?:"([^"]*)"|'([^']*)'|(\S+))/i;
    const m2 = cmd.match(re2);
    if (m2 && (m2[2] || m2[3] || m2[4])) return (m2[2] || m2[3] || m2[4] || "").trim();

    // Strategy 3: plain eval without shell prefix
    const evalMatch = cmd.match(/\beval\s+(?:"([^"]*)"|'([^']*)'|(\S+))/i);
    if (evalMatch) {
        return (evalMatch[1] || evalMatch[2] || evalMatch[3] || "").trim();
    }
    return null;
}

/**
 * Extract heredoc body from a command:
 *   << EOF … EOF
 *   <<-EOF … EOF
 *   <<< "inline string"
 */
function extractHeredoc(cmd) {
    // Heredoc: cat << EOF ... EOF
    const heredocMatch = cmd.match(/<<-?\s*(\w+)[\s\S]*?\n\1\b/m);
    if (heredocMatch) {
        const full = heredocMatch[0];
        const firstNewline = full.indexOf('\n');
        const lastMarker = full.lastIndexOf('\n' + heredocMatch[1]);
        if (firstNewline !== -1 && lastMarker !== -1) {
            return full.slice(firstNewline + 1, lastMarker).trim();
        }
        return full;
    }
    // Here-string: <<< "something"
    const hereStringMatch = cmd.match(/<<<\s+(?:"([^"]*)"|'([^']*)'|(\S+))/i);
    if (hereStringMatch) {
        return (hereStringMatch[1] || hereStringMatch[2] || hereStringMatch[3] || "").trim();
    }
    return null;
}

/**
 * Extract code from interpreter inline invocations.
 * Handles both simple quoted strings and strings with escaped inner quotes.
 */
function extractInterpreterInline(cmd) {
    function quotedContent(input, startPos) {
        const quote = input[startPos];
        if (quote !== '"' && quote !== "'") return undefined;
        let i = startPos + 1;
        let result = "";
        while (i < input.length) {
            if (input[i] === "\\" && i + 1 < input.length) {
                result += input[i + 1];
                i += 2;
            } else if (input[i] === quote) {
                return result;
            } else {
                result += input[i];
                i++;
            }
        }
        return undefined;
    }

    // node -e "...", node -p "...", node --eval "...", node --print "..."
    let m = cmd.match(/\bnode\s+(?:-([ep])\s+|--(?:eval|print)\s+)/i);
    if (m) {
        const after = cmd.slice(m.index + m[0].length);
        const content = quotedContent(after, 0);
        if (content !== undefined) return content;
    }

    // python / python3 -c "..."
    m = cmd.match(/\bpython(?:3)?\s+-c\s+/i);
    if (m) {
        const after = cmd.slice(m.index + m[0].length);
        const content = quotedContent(after, 0);
        if (content !== undefined) return content;
    }

    // perl -e "...", perl --execute "..."
    m = cmd.match(/\bperl\s+(?:-e\s+|--execute\s+)/i);
    if (m) {
        const after = cmd.slice(m.index + m[0].length);
        const content = quotedContent(after, 0);
        if (content !== undefined) return content;
    }

    // ruby -e "..."
    m = cmd.match(/\bruby\s+-e\s+/i);
    if (m) {
        const after = cmd.slice(m.index + m[0].length);
        const content = quotedContent(after, 0);
        if (content !== undefined) return content;
    }

    return null;
}

// ──────────────────────────────────────────────
//  Pipe analysis
// ──────────────────────────────────────────────

const INTERPRETER_NAMES = new Set([
    "sh", "bash", "zsh", "dash", "fish",
    "node", "python", "python3", "perl", "ruby",
]);

/**
 * Check each segment of a piped command.
 */
function checkPipes(cmd) {
    const segments = cmd.split(/\|(?![|])/);
    if (segments.length < 2) return null;

    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i].trim();
        if (!seg) continue;

        // Check each segment (stripped) for patterns
        const segResult = checkPatterns(stripQuotes(seg));
        if (segResult) return segResult;

        // Check if next segment is an interpreter
        if (i + 1 < segments.length) {
            const nextSeg = segments[i + 1].trim();
            const interpMatch = nextSeg.match(/^\s*(\w+)/);
            if (interpMatch && INTERPRETER_NAMES.has(interpMatch[1].toLowerCase())) {
                const interpName = interpMatch[1];

                // Network download to interpreter is always dangerous
                if (DOWNLOAD_CMDS.test(seg.trim())) {
                    return `Pipe network download to ${interpName}`;
                }

                // Source containing dangerous pattern (checked on RAW segment)
                // The interpreter receives unquoted content, so quotes don't protect.
                const rawResult = checkPatterns(seg);
                if (rawResult) {
                    return `Pipe dangerous content to ${interpName}: ${rawResult}`;
                }
            }
        }
    }
    return null;
}

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Check whether a shell command is dangerous.
 *
 * Detection order:
 *  1. Custom patterns
 *  2. Pipe analysis (checkPipes)
 *  3. Subshell extraction → checkPatterns
 *  4. Heredoc extraction → checkPatterns
 *  5. Interpreter inline → checkPatterns
 *  6. Strip quotes → checkPatterns (fallback)
 */
export function isDangerousCommand(cmd, customPatterns = []) {
    // 1. Custom patterns
    for (const pattern of customPatterns) {
        if (typeof pattern === "string" && pattern) {
            const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            try {
                if (new RegExp(`\\b${escaped}\\b`, "i").test(cmd)) {
                    return `Custom dangerous command: ${pattern}`;
                }
            } catch { /* skip invalid patterns */ }
        }
    }

    // 2. Pipe analysis
    const pipeResult = checkPipes(cmd);
    if (pipeResult) return pipeResult;

    // 3. Subshell
    const subshell = extractSubshell(cmd);
    if (subshell) {
        const subResult = checkPatterns(subshell);
        if (subResult) return `Subshell: ${subResult}`;
    }

    // 4. Heredoc
    const heredoc = extractHeredoc(cmd);
    if (heredoc) {
        const heredocResult = checkPatterns(heredoc);
        if (heredocResult) return `Heredoc: ${heredocResult}`;
    }

    // 5. Interpreter inline
    const inline = extractInterpreterInline(cmd);
    if (inline) {
        const inlineResult = checkPatterns(inline);
        if (inlineResult) return `Inline interpreter: ${inlineResult}`;
    }

    // 6. Strip quotes — fallback for bare dangerous commands
    const stripped = stripQuotes(cmd);
    const strippedResult = checkPatterns(stripped);
    if (strippedResult) return strippedResult;

    return null;
}
//# sourceMappingURL=permissions.js.map
