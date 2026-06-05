/**
 * Runtime configuration, read from environment variables and the local
 * credential store.
 *
 * Auth model: e-conomic's REST API authenticates every request with a pair of
 * tokens sent as headers — the app secret token (identifies the integration)
 * and the agreement grant token (identifies the company/agreement that granted
 * access). Tokens come from the environment, or from locally stored credentials.
 *
 * Multiple accounts/companies are modelled as named *profiles*. Non-credential
 * settings (page size, timeouts, dynamic tools, OpenAPI spec) are global and
 * shared by every profile; only the base URL and the two tokens vary per
 * profile. `loadProfiles()` returns a registry that resolves a fully-merged
 * `Config` for any profile on demand.
 */

import { DEFAULT_PROFILE, loadStore, type ProfileCredentials } from "./credentials.js";

export interface Config {
  baseUrl: string;
  appSecretToken: string;
  agreementGrantToken: string;
  openapiSpec?: string;
  dynamicTools: boolean;
  dynamicToolsLimit: number;
  pageSize: number;
  timeoutMs: number;
}

/** Global, profile-independent settings plus the default base URL. */
interface SharedSettings {
  defaultBaseUrl: string;
  openapiSpec?: string;
  dynamicTools: boolean;
  dynamicToolsLimit: number;
  pageSize: number;
  timeoutMs: number;
}

/** Safe, non-secret metadata about a configured profile. */
export interface ProfileInfo {
  name: string;
  baseUrl: string;
  hasAppSecret: boolean;
  hasAgreementGrant: boolean;
  /** Whether the profile has both tokens and can be used. */
  usable: boolean;
  isDefault: boolean;
}

/** Resolves credentials for any configured profile. */
export interface ProfileRegistry {
  /** Profile used when a caller doesn't name one. */
  defaultProfile: string;
  /** All configured profile names. */
  names: string[];
  /** Global settings shared across profiles. */
  settings: Omit<SharedSettings, "defaultBaseUrl">;
  has(name: string): boolean;
  /** Resolve a fully-merged Config; throws if the profile is unknown/incomplete. */
  get(name?: string): Config;
  /** Non-secret metadata for every profile (never throws). */
  describe(): ProfileInfo[];
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function loadSharedSettings(env: NodeJS.ProcessEnv): SharedSettings {
  const pageSize = Math.min(parseIntEnv("ECONOMIC_PAGE_SIZE", 100), 1000);
  return {
    defaultBaseUrl: "https://restapi.e-conomic.com",
    openapiSpec: env.ECONOMIC_OPENAPI_SPEC?.trim() || undefined,
    dynamicTools: parseBoolEnv("ECONOMIC_DYNAMIC_TOOLS", false),
    dynamicToolsLimit: parseIntEnv("ECONOMIC_DYNAMIC_TOOLS_LIMIT", 200),
    pageSize,
    timeoutMs: parseIntEnv("ECONOMIC_TIMEOUT_MS", 30000),
  };
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Build the profile registry from the environment and the local store.
 *
 * Environment variables (`ECONOMIC_APP_SECRET_TOKEN` /
 * `ECONOMIC_AGREEMENT_GRANT_TOKEN` / `ECONOMIC_BASE_URL`) configure the *active*
 * profile and take precedence over stored values for it, preserving the original
 * single-account behaviour. `ECONOMIC_PROFILE` selects which profile is active.
 */
export function loadProfiles(env: NodeJS.ProcessEnv = process.env): ProfileRegistry {
  const settings = loadSharedSettings(env);
  const store = loadStore(env);

  const profiles: Record<string, ProfileCredentials> = { ...store.profiles };

  const envSecret = env.ECONOMIC_APP_SECRET_TOKEN?.trim();
  const envGrant = env.ECONOMIC_AGREEMENT_GRANT_TOKEN?.trim();
  const envBaseUrl = env.ECONOMIC_BASE_URL?.trim();
  const envProfile = env.ECONOMIC_PROFILE?.trim();

  const defaultProfile = envProfile || store.defaultProfile || DEFAULT_PROFILE;

  // Overlay environment credentials onto the active profile (env wins).
  if (envSecret || envGrant || envBaseUrl) {
    const cur = profiles[defaultProfile] ?? {};
    profiles[defaultProfile] = {
      ...cur,
      appSecretToken: envSecret || cur.appSecretToken,
      agreementGrantToken: envGrant || cur.agreementGrantToken,
      baseUrl: envBaseUrl || cur.baseUrl,
    };
  }

  const cache = new Map<string, Config>();

  function resolve(rawName?: string): Config {
    const name = rawName?.trim() || defaultProfile;
    const cached = cache.get(name);
    if (cached) return cached;

    const creds = profiles[name];
    const appSecretToken = creds?.appSecretToken?.trim() || "";
    const agreementGrantToken = creds?.agreementGrantToken?.trim() || "";

    if (!creds || !appSecretToken || !agreementGrantToken) {
      const known = Object.keys(profiles);
      if (!creds && rawName && !known.includes(name)) {
        throw new Error(
          `Unknown profile "${name}". Configured: ${known.join(", ") || "(none)"}. ` +
            `Add one with \`e-conomic-mcp auth set --profile ${name} ...\`.`,
        );
      }
      const missing = [
        !appSecretToken ? "app secret token" : null,
        !agreementGrantToken ? "agreement grant token" : null,
      ].filter(Boolean);
      const where = name === DEFAULT_PROFILE ? "" : ` for profile "${name}"`;
      throw new Error(
        `Missing credentials${where}: ${missing.join(" and ")}. Provide them via ` +
          `ECONOMIC_APP_SECRET_TOKEN / ECONOMIC_AGREEMENT_GRANT_TOKEN, or run ` +
          `\`e-conomic-mcp auth login\` (use --profile to name an account).`,
      );
    }

    const config: Config = {
      baseUrl: normalizeBaseUrl(creds.baseUrl?.trim() || settings.defaultBaseUrl),
      appSecretToken,
      agreementGrantToken,
      openapiSpec: settings.openapiSpec,
      dynamicTools: settings.dynamicTools,
      dynamicToolsLimit: settings.dynamicToolsLimit,
      pageSize: settings.pageSize,
      timeoutMs: settings.timeoutMs,
    };
    cache.set(name, config);
    return config;
  }

  const { defaultBaseUrl: _defaultBaseUrl, ...sharedForRegistry } = settings;

  return {
    defaultProfile,
    get names() {
      return Object.keys(profiles);
    },
    settings: sharedForRegistry,
    has: (name) => Object.prototype.hasOwnProperty.call(profiles, name),
    get: resolve,
    describe() {
      return Object.entries(profiles).map(([name, creds]) => {
        const hasAppSecret = Boolean(creds.appSecretToken?.trim());
        const hasAgreementGrant = Boolean(creds.agreementGrantToken?.trim());
        return {
          name,
          baseUrl: normalizeBaseUrl(creds.baseUrl?.trim() || settings.defaultBaseUrl),
          hasAppSecret,
          hasAgreementGrant,
          usable: hasAppSecret && hasAgreementGrant,
          isDefault: name === defaultProfile,
        };
      });
    },
  };
}

/**
 * Resolve the configuration for the active/default profile.
 *
 * Retained for the single-account code paths (e.g. `doctor`); throws with a
 * helpful message if credentials are missing.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return loadProfiles(env).get();
}
