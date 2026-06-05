/**
 * Runtime configuration, read from environment variables.
 *
 * Auth model: e-conomic's REST API authenticates every request with a pair of
 * tokens sent as headers — the app secret token (identifies the integration)
 * and the agreement grant token (identifies the company/agreement that granted
 * access). We take both directly from the environment.
 */

export interface Config {
  baseUrl: string;
  appSecretToken: string;
  agreementGrantToken: string;
  openapiSpec?: string;
  schemaDir?: string;
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
  const appSecretToken = env.ECONOMIC_APP_SECRET_TOKEN?.trim() ?? "";
  const agreementGrantToken = env.ECONOMIC_AGREEMENT_GRANT_TOKEN?.trim() ?? "";

  const missing: string[] = [];
  if (!appSecretToken) missing.push("ECONOMIC_APP_SECRET_TOKEN");
  if (!agreementGrantToken) missing.push("ECONOMIC_AGREEMENT_GRANT_TOKEN");
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `See .env.example for details.`,
    );
  }

  const pageSize = Math.min(parseIntEnv("ECONOMIC_PAGE_SIZE", 100), 1000);

  return {
    baseUrl: (env.ECONOMIC_BASE_URL?.trim() || "https://restapi.e-conomic.com").replace(/\/+$/, ""),
    appSecretToken,
    agreementGrantToken,
    openapiSpec: env.ECONOMIC_OPENAPI_SPEC?.trim() || undefined,
    schemaDir: env.ECONOMIC_SCHEMA_DIR?.trim() || undefined,
    dynamicTools: parseBoolEnv("ECONOMIC_DYNAMIC_TOOLS", false),
    dynamicToolsLimit: parseIntEnv("ECONOMIC_DYNAMIC_TOOLS_LIMIT", 200),
    pageSize,
    timeoutMs: parseIntEnv("ECONOMIC_TIMEOUT_MS", 30000),
  };
}
