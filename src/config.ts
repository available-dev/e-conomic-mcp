/**
 * Runtime configuration, read from environment variables.
 *
 * Auth model: e-conomic's REST API authenticates every request with a pair of
 * tokens sent as headers — the app secret token (identifies the integration)
 * and the agreement grant token (identifies the company/agreement that granted
 * access). Tokens come from the environment, or from locally stored credentials.
 */

import { loadStoredCredentials } from "./credentials.js";
import { BUNDLED_APP_SECRET_TOKEN } from "./appCredentials.js";

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Environment variables take precedence; fall back to locally stored
  // credentials (written by `e-conomic-mcp auth login` / `auth set`).
  const stored = loadStoredCredentials(env);
  // The app secret token can be bundled with the package (so users only need to
  // grant access); env vars and the local store still take precedence.
  const appSecretToken =
    env.ECONOMIC_APP_SECRET_TOKEN?.trim() ||
    stored?.appSecretToken?.trim() ||
    BUNDLED_APP_SECRET_TOKEN.trim() ||
    "";
  const agreementGrantToken =
    env.ECONOMIC_AGREEMENT_GRANT_TOKEN?.trim() || stored?.agreementGrantToken?.trim() || "";

  if (!appSecretToken || !agreementGrantToken) {
    const missing = [
      !appSecretToken ? "app secret token" : null,
      !agreementGrantToken ? "agreement grant token" : null,
    ].filter(Boolean);
    throw new Error(
      `Missing credentials: ${missing.join(" and ")}. Run ` +
        `\`e-conomic-mcp auth connect\` to grant access in the browser, or set ` +
        `ECONOMIC_APP_SECRET_TOKEN / ECONOMIC_AGREEMENT_GRANT_TOKEN.`,
    );
  }

  const pageSize = Math.min(parseIntEnv("ECONOMIC_PAGE_SIZE", 100), 1000);

  return {
    baseUrl: (
      env.ECONOMIC_BASE_URL?.trim() ||
      stored?.baseUrl?.trim() ||
      "https://restapi.e-conomic.com"
    ).replace(/\/+$/, ""),
    appSecretToken,
    agreementGrantToken,
    openapiSpec: env.ECONOMIC_OPENAPI_SPEC?.trim() || undefined,
    dynamicTools: parseBoolEnv("ECONOMIC_DYNAMIC_TOOLS", false),
    dynamicToolsLimit: parseIntEnv("ECONOMIC_DYNAMIC_TOOLS_LIMIT", 200),
    pageSize,
    timeoutMs: parseIntEnv("ECONOMIC_TIMEOUT_MS", 30000),
  };
}
