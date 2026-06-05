/**
 * Local credential storage for the CLI.
 *
 * Credentials can always be supplied via environment variables (which take
 * precedence). For convenience, `e-conomic-mcp auth login` / `auth set` persist
 * them to a local file so they don't have to be repeated in every client config.
 *
 * The file lives at $ECONOMIC_CONFIG_DIR or $XDG_CONFIG_HOME/e-conomic-mcp or
 * ~/.config/e-conomic-mcp/credentials.json, written with 0600 permissions.
 *
 * The shape is intentionally open to additional auth methods (e.g. OAuth tokens)
 * later without breaking the file format.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

export interface StoredCredentials {
  appSecretToken?: string;
  agreementGrantToken?: string;
  baseUrl?: string;
  /** Reserved for future OAuth support. */
  oauth?: Record<string, unknown>;
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ECONOMIC_CONFIG_DIR?.trim()) return env.ECONOMIC_CONFIG_DIR.trim();
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "e-conomic-mcp");
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "credentials.json");
}

export function loadStoredCredentials(
  env: NodeJS.ProcessEnv = process.env,
): StoredCredentials | undefined {
  const path = credentialsPath(env);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StoredCredentials;
  } catch {
    return undefined;
  }
}

export function saveCredentials(
  update: StoredCredentials,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = credentialsPath(env);
  const existing = loadStoredCredentials(env) ?? {};
  const merged: StoredCredentials = { ...existing };
  for (const [k, v] of Object.entries(update)) {
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
  }
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort on platforms without POSIX perms
  }
  return path;
}

export function clearCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = credentialsPath(env);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/** Mask a secret for display: keep the last 4 chars. */
export function maskSecret(value: string | undefined): string {
  if (!value) return "(not set)";
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}
