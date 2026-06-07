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
 * Multiple accounts/companies are supported as named *profiles*. The on-disk
 * format (v2) stores a `profiles` map plus a `defaultProfile`. The original flat
 * single-account format (v1) is still read transparently and treated as the
 * "default" profile, so older files keep working without migration.
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

/** Credentials for a single account/company (one profile). */
export interface ProfileCredentials {
  appSecretToken?: string;
  agreementGrantToken?: string;
  baseUrl?: string;
  /** Reserved for future OAuth support. */
  oauth?: Record<string, unknown>;
}

/**
 * On-disk shape. v2 uses `profiles` + `defaultProfile`; v1 (legacy) stored a
 * single flat credential set at the top level, which is still read.
 */
export interface CredentialsFile {
  version?: number;
  defaultProfile?: string;
  profiles?: Record<string, ProfileCredentials>;
  // Legacy v1 flat fields — still read for backward compatibility.
  appSecretToken?: string;
  agreementGrantToken?: string;
  baseUrl?: string;
  oauth?: Record<string, unknown>;
}

/** Normalized in-memory view of the credential store. */
export interface CredentialStore {
  defaultProfile: string;
  profiles: Record<string, ProfileCredentials>;
}

/** Name used for the implicit profile (and for migrated legacy files). */
export const DEFAULT_PROFILE = "default";

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ECONOMIC_CONFIG_DIR?.trim()) return env.ECONOMIC_CONFIG_DIR.trim();
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "e-conomic-mcp");
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "credentials.json");
}

/** Coerce any on-disk shape (v1 flat or v2 profiles) into a normalized store. */
function normalize(raw: CredentialsFile | undefined): CredentialStore {
  if (!raw || typeof raw !== "object") {
    return { defaultProfile: DEFAULT_PROFILE, profiles: {} };
  }

  if (raw.profiles && typeof raw.profiles === "object") {
    const profiles: Record<string, ProfileCredentials> = { ...raw.profiles };
    const names = Object.keys(profiles);
    const defaultProfile =
      raw.defaultProfile && profiles[raw.defaultProfile]
        ? raw.defaultProfile
        : names[0] ?? DEFAULT_PROFILE;
    return { defaultProfile, profiles };
  }

  // Legacy v1 flat file → a single "default" profile.
  if (raw.appSecretToken || raw.agreementGrantToken || raw.baseUrl || raw.oauth) {
    return {
      defaultProfile: DEFAULT_PROFILE,
      profiles: {
        [DEFAULT_PROFILE]: {
          appSecretToken: raw.appSecretToken,
          agreementGrantToken: raw.agreementGrantToken,
          baseUrl: raw.baseUrl,
          oauth: raw.oauth,
        },
      },
    };
  }

  return { defaultProfile: DEFAULT_PROFILE, profiles: {} };
}

/** Read and normalize the credential store (empty if no file / unreadable). */
export function loadStore(env: NodeJS.ProcessEnv = process.env): CredentialStore {
  const path = credentialsPath(env);
  if (!existsSync(path)) return { defaultProfile: DEFAULT_PROFILE, profiles: {} };
  try {
    return normalize(JSON.parse(readFileSync(path, "utf8")) as CredentialsFile);
  } catch {
    return { defaultProfile: DEFAULT_PROFILE, profiles: {} };
  }
}

/** Persist a normalized store in the current (v2) on-disk format. */
export function saveStore(
  store: CredentialStore,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = credentialsPath(env);
  const file: CredentialsFile = {
    version: 2,
    defaultProfile: store.defaultProfile,
    profiles: store.profiles,
  };
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort on platforms without POSIX perms
  }
  return path;
}

/** Credentials for one profile, or undefined if it doesn't exist. */
export function loadProfileCredentials(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): ProfileCredentials | undefined {
  return loadStore(env).profiles[name];
}

export function listProfiles(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(loadStore(env).profiles);
}

/**
 * Merge `update` into the named profile and persist. Only defined fields are
 * written, so partial updates (e.g. just a new base URL) preserve the rest. If
 * the store had no profiles before, the new one becomes the default.
 */
export function saveProfileCredentials(
  name: string,
  update: ProfileCredentials,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const store = loadStore(env);
  const hadProfiles = Object.keys(store.profiles).length > 0;
  const existing = store.profiles[name] ?? {};
  const merged: ProfileCredentials = { ...existing };
  for (const [k, v] of Object.entries(update)) {
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
  }
  store.profiles[name] = merged;
  if (!hadProfiles) store.defaultProfile = name;
  return saveStore(store, env);
}

/** Set the default profile. Throws if the profile doesn't exist. */
export function setDefaultProfile(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const store = loadStore(env);
  if (!store.profiles[name]) {
    throw new Error(
      `No stored profile "${name}". Configured: ${Object.keys(store.profiles).join(", ") || "(none)"}.`,
    );
  }
  store.defaultProfile = name;
  return saveStore(store, env);
}

/**
 * Remove a profile. Returns false if it didn't exist. If the removed profile
 * was the default, a remaining profile (if any) becomes the new default.
 */
export function removeProfile(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const store = loadStore(env);
  if (!store.profiles[name]) return false;
  delete store.profiles[name];
  if (store.defaultProfile === name) {
    store.defaultProfile = Object.keys(store.profiles)[0] ?? DEFAULT_PROFILE;
  }
  saveStore(store, env);
  return true;
}

/** Remove the entire credential store file. */
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
