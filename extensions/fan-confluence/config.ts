import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ConfluenceConfig = {
  baseUrl: string;
  pat: string;
  spaceKey?: string;
  defaultParentId?: number;
};

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getEnvPath(): string {
  return resolve(__dirname, ".env");
}

function normalizeBaseUrl(url: string): string {
  let u = url.trim();
  if (u.endsWith("/")) u = u.slice(0, -1);
  return u;
}

export async function saveConfig(config: ConfluenceConfig): Promise<void> {
  const envPath = getEnvPath();
  let lines = "";
  lines += `# Confluence extension for fan\n`;
  lines += `CONFLUENCE_BASE_URL=${config.baseUrl}\n`;
  lines += `CONFLUENCE_PAT=${config.pat}\n`;
  if (config.spaceKey) {
    lines += `CONFLUENCE_SPACE_KEY=${config.spaceKey}\n`;
  }
  if (config.defaultParentId) {
    lines += `CONFLUENCE_DEFAULT_PARENT_ID=${config.defaultParentId}\n`;
  }
  await writeFile(envPath, lines, "utf8");
}

export function configExists(): Promise<boolean> {
  return readFile(getEnvPath(), "utf8")
    .then(() => true)
    .catch(() => false);
}

export async function loadConfig(): Promise<ConfluenceConfig> {
  const dotEnvPath = resolve(__dirname, ".env");

  let envContents = "";
  try {
    envContents = await readFile(dotEnvPath, "utf8");
  } catch {
    // .env not found — rely on process.env
  }

  // Parse .env manually (simple key=value, ignore comments)
  for (const line of envContents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }

  const baseUrl = process.env.CONFLUENCE_BASE_URL;
  const pat = process.env.CONFLUENCE_PAT;
  const spaceKey = process.env.CONFLUENCE_SPACE_KEY;
  const defaultParentIdStr = process.env.CONFLUENCE_DEFAULT_PARENT_ID;

  if (!baseUrl) {
    throw new Error(
      "CONFLUENCE_BASE_URL не указан. Добавьте его в файл ~/.fan/agent/extensions/fan-confluence/.env",
    );
  }
  if (!pat) {
    throw new Error(
      "CONFLUENCE_PAT не указан. Добавьте его в файл ~/.fan/agent/extensions/fan-confluence/.env",
    );
  }
  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    pat,
    spaceKey: spaceKey || undefined,
    defaultParentId: defaultParentIdStr ? parseInt(defaultParentIdStr, 10) : undefined,
  };
}
