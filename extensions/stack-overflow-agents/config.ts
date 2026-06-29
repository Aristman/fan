// ─── Stack Overflow for Agents — Configuration Manager ───
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SofaConfig, SofaRegistrationResponse } from "./types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Paths ───
export function getExtensionDir(): string {
  return __dirname;
}

export function getEnvPath(): string {
  return join(__dirname, ".env");
}

export function getCredsDir(): string {
  return join(__dirname, ".sofa");
}

export function getCredsPath(): string {
  return join(getCredsDir(), "credentials.json");
}

// ─── Config Management ───
export function configExists(): boolean {
  return existsSync(getEnvPath());
}

export function loadConfig(): SofaConfig | null {
  try {
    if (existsSync(getEnvPath())) {
      const envContent = readFileSync(getEnvPath(), "utf-8");
      const envVars = parseEnvFile(envContent);

      const apiKey = envVars.SOFA_API_KEY || process.env.SOFA_API_KEY || "";
      const baseUrl = envVars.SOFA_BASE_URL || process.env.SOFA_BASE_URL || "https://agents.stackoverflow.com";
      const clientName = envVars.SOFA_CLIENT_NAME || process.env.SOFA_CLIENT_NAME || "fan-agent";
      const modelName = envVars.SOFA_MODEL_NAME || process.env.SOFA_MODEL_NAME || "";
      const modelProvider = envVars.SOFA_MODEL_PROVIDER || process.env.SOFA_MODEL_PROVIDER || undefined;
      const modelVersion = envVars.SOFA_MODEL_VERSION || process.env.SOFA_MODEL_VERSION || undefined;
      const modelSelectionMode = envVars.SOFA_MODEL_SELECTION_MODE || process.env.SOFA_MODEL_SELECTION_MODE || undefined;

      if (!apiKey) return null;
      if (!modelName) return null;

      return {
        apiKey,
        baseUrl: baseUrl.replace(/\/+$/, ""),
        clientName,
        modelName,
        modelProvider,
        modelVersion,
        modelSelectionMode,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveConfig(config: SofaConfig): void {
  const lines: string[] = [];
  lines.push(`SOFA_API_KEY=${config.apiKey}`);
  lines.push(`SOFA_BASE_URL=${config.baseUrl}`);
  lines.push(`SOFA_CLIENT_NAME=${config.clientName}`);
  lines.push(`SOFA_MODEL_NAME=${config.modelName}`);
  if (config.modelProvider) lines.push(`SOFA_MODEL_PROVIDER=${config.modelProvider}`);
  if (config.modelVersion) lines.push(`SOFA_MODEL_VERSION=${config.modelVersion}`);
  if (config.modelSelectionMode) lines.push(`SOFA_MODEL_SELECTION_MODE=${config.modelSelectionMode}`);
  lines.push("");
  writeFileSync(getEnvPath(), lines.join("\n"), "utf-8");
}

// ─── Credentials for Multi-Agent Coexistence ───
export function saveCredentials(data: SofaRegistrationResponse): void {
  const credsDir = getCredsDir();
  if (!existsSync(credsDir)) {
    mkdirSync(credsDir, { recursive: true });
  }

  const existing = loadCredentials();
  existing[data.agent_id] = data;
  writeFileSync(getCredsPath(), JSON.stringify(existing, null, 2), "utf-8");
}

export function loadCredentials(): Record<string, SofaRegistrationResponse> {
  try {
    const path = getCredsPath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch {
    // ignore
  }
  return {};
}

// ─── Helpers ───
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
