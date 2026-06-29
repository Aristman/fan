import { Agent, type Dispatcher, fetch as undiciFetch } from "undici";
import { readFileSync, existsSync } from "node:fs";
import type { TlsConfig } from "./types.js";

const DEFAULT_TLS: TlsConfig = {
  rejectUnauthorized: false,
};

let cachedDispatcher: Dispatcher | undefined;
let cachedConfig: TlsConfig | undefined;

/**
 * Creates an undici Dispatcher configured with the given TLS settings.
 * Result is cached — same config returns same dispatcher.
 * 
 * Priority:
 * 1. Custom caPath from config
 * 2. NODE_EXTRA_CA_CERTS environment variable
 * 3. rejectUnauthorized setting (default: false)
 */
export function createTlsDispatcher(config?: TlsConfig): Dispatcher {
  const resolved = config ?? DEFAULT_TLS;

  // Return cached if same config
  if (cachedDispatcher && cachedConfig && JSON.stringify(cachedConfig) === JSON.stringify(resolved)) {
    return cachedDispatcher;
  }

  // Determine CA path: explicit config > env variable
  let caPath = resolved.caPath;
  if (!caPath && process.env.NODE_EXTRA_CA_CERTS) {
    caPath = process.env.NODE_EXTRA_CA_CERTS;
  }

  // Read custom CA if provided
  let ca: Buffer | undefined;
  if (caPath && existsSync(caPath)) {
    ca = readFileSync(caPath);
  }

  cachedDispatcher = new Agent({
    connect: {
      rejectUnauthorized: resolved.rejectUnauthorized,
      ...(ca ? { ca } : {}),
    },
  });

  cachedConfig = resolved;
  return cachedDispatcher;
}

/** Check if TLS verification is enabled (for logging) */
export function isTlsStrict(config?: TlsConfig): boolean {
  const resolved = config ?? DEFAULT_TLS;
  return resolved.rejectUnauthorized;
}

/**
 * Undici's fetch — supports the `dispatcher` option.
 * The global fetch() (Bun/Node) silently ignores `dispatcher`.
 */
export { undiciFetch as fetch };
