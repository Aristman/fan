import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

const AUDIT_DIR = path.join(homedir(), ".fan", "agent", "audit");
const AUDIT_FILE = path.join(AUDIT_DIR, "orchestrator.log");

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

export function logAuditDecision(entry) {
    ensureDir(AUDIT_DIR);
    const record = {
        timestamp: new Date().toISOString(),
        command: entry.command,
        reason: entry.reason,
        decision: entry.decision, // "allow" | "block" | "headless_block"
        agentType: entry.agentType || null,
        workerId: entry.workerId || null,
    };
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(record) + "\n", "utf-8");
}

export function getAuditLogPath() {
    return AUDIT_FILE;
}
