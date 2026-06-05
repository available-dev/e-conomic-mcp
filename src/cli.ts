/**
 * Command-line interface for e-conomic-mcp.
 *
 * Commands:
 *   serve (default)   Start the MCP server over stdio.
 *   auth <sub>        Manage locally stored credentials (login/set/status/logout).
 *   doctor            Verify credentials and API connectivity.
 *
 * Global flags: --help/-h, --version/-v
 */

import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import {
  clearCredentials,
  credentialsPath,
  loadStoredCredentials,
  maskSecret,
  saveCredentials,
} from "./credentials.js";

const HELP = `e-conomic-mcp — MCP server for the e-conomic REST API

Usage:
  e-conomic-mcp [serve]            Start the MCP server over stdio (default)
  e-conomic-mcp auth login         Interactively store credentials locally
  e-conomic-mcp auth set [flags]   Store credentials non-interactively
  e-conomic-mcp auth status        Show where credentials are coming from
  e-conomic-mcp auth logout        Remove locally stored credentials
  e-conomic-mcp doctor             Check credentials and API connectivity

Options:
  -h, --help        Show this help
  -v, --version     Show version

auth set flags:
  --app-secret <token>        app secret token
  --agreement-grant <token>   agreement grant token
  --base-url <url>            override API base URL

Credentials resolve from environment variables first, then the local store
(${credentialsPathSafe()}):
  ECONOMIC_APP_SECRET_TOKEN, ECONOMIC_AGREEMENT_GRANT_TOKEN, ECONOMIC_BASE_URL

Other environment (see .env.example):
  ECONOMIC_OPENAPI_SPEC, ECONOMIC_SCHEMA_DIR, ECONOMIC_DYNAMIC_TOOLS,
  ECONOMIC_DYNAMIC_TOOLS_LIMIT, ECONOMIC_PAGE_SIZE, ECONOMIC_TIMEOUT_MS
`;

export async function runCli(argv: string[]): Promise<void> {
  const args = [...argv];

  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  if (args.includes("-v") || args.includes("--version")) {
    process.stdout.write(`${await readVersion()}\n`);
    return;
  }

  const command = args[0] && !args[0].startsWith("-") ? args[0] : "serve";

  switch (command) {
    case "serve":
      await serve();
      return;
    case "auth":
      await auth(args.slice(1));
      return;
    case "doctor":
      await doctor();
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

async function serve(): Promise<void> {
  const config = loadConfig();
  const { server, toolCount, specLoaded } = await buildServer(config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `[e-conomic-mcp] Ready on stdio. ${toolCount} tools available` +
      `${specLoaded ? " (API schema loaded)" : ""}. Base URL: ${config.baseUrl}`,
  );
}

async function auth(rest: string[]): Promise<void> {
  const sub = rest[0] ?? "status";
  switch (sub) {
    case "login":
      await authLogin();
      return;
    case "set":
      authSet(rest.slice(1));
      return;
    case "status":
      authStatus();
      return;
    case "logout":
      authLogout();
      return;
    default:
      process.stderr.write(`Unknown auth subcommand: ${sub}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

async function authLogin(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write("Enter your e-conomic credentials (stored locally, never transmitted except to the API).\n");
    const appSecretToken = (await rl.question("App secret token: ")).trim();
    const agreementGrantToken = (await rl.question("Agreement grant token: ")).trim();
    const baseUrl = (await rl.question("Base URL [https://restapi.e-conomic.com]: ")).trim();

    if (!appSecretToken || !agreementGrantToken) {
      process.stderr.write("Both tokens are required. Aborted.\n");
      process.exitCode = 1;
      return;
    }
    const path = saveCredentials({
      appSecretToken,
      agreementGrantToken,
      baseUrl: baseUrl || undefined,
    });
    process.stderr.write(`✓ Saved credentials to ${path}\n`);
  } finally {
    rl.close();
  }
}

function authSet(rest: string[]): void {
  const flags = parseFlags(rest);
  const update = {
    appSecretToken: flags["app-secret"],
    agreementGrantToken: flags["agreement-grant"],
    baseUrl: flags["base-url"],
  };
  if (!update.appSecretToken && !update.agreementGrantToken && !update.baseUrl) {
    process.stderr.write(
      "Provide at least one of --app-secret, --agreement-grant, --base-url.\n",
    );
    process.exitCode = 1;
    return;
  }
  const path = saveCredentials(update);
  process.stderr.write(`✓ Saved credentials to ${path}\n`);
}

function authStatus(): void {
  const stored = loadStoredCredentials();
  const envSecret = process.env.ECONOMIC_APP_SECRET_TOKEN?.trim();
  const envGrant = process.env.ECONOMIC_AGREEMENT_GRANT_TOKEN?.trim();

  const secretSrc = envSecret ? "env" : stored?.appSecretToken ? "store" : "none";
  const grantSrc = envGrant ? "env" : stored?.agreementGrantToken ? "store" : "none";

  process.stderr.write(`Credential store: ${credentialsPath()}\n`);
  process.stderr.write(
    `App secret token:      ${maskSecret(envSecret || stored?.appSecretToken)} [${secretSrc}]\n`,
  );
  process.stderr.write(
    `Agreement grant token: ${maskSecret(envGrant || stored?.agreementGrantToken)} [${grantSrc}]\n`,
  );
  if (secretSrc === "none" || grantSrc === "none") {
    process.stderr.write("\nNot fully configured. Run `e-conomic-mcp auth login`.\n");
  }
}

function authLogout(): void {
  const removed = clearCredentials();
  process.stderr.write(
    removed ? "✓ Removed locally stored credentials.\n" : "No stored credentials to remove.\n",
  );
}

async function doctor(): Promise<void> {
  const config = loadConfig();
  process.stderr.write(`Checking connectivity to ${config.baseUrl} ...\n`);
  try {
    const res = await fetch(`${config.baseUrl}/`, {
      headers: {
        "X-AppSecretToken": config.appSecretToken,
        "X-AgreementGrantToken": config.agreementGrantToken,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      process.stderr.write(`✗ API returned HTTP ${res.status} ${res.statusText}\n`);
      process.exitCode = 1;
      return;
    }
    const root = (await res.json()) as Record<string, unknown>;
    const collections = Object.entries(root)
      .filter(([k, v]) => typeof v === "string" && (v as string).startsWith("http") && k !== "metaData")
      .map(([k]) => k);
    process.stderr.write(`✓ Authenticated. ${collections.length} resource collections available.\n`);
    process.stderr.write(`  ${collections.slice(0, 20).join(", ")}${collections.length > 20 ? ", ..." : ""}\n`);
  } catch (err) {
    process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

interface ParsedFlags {
  positional: string[];
  "app-secret"?: string;
  "agreement-grant"?: string;
  "base-url"?: string;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--app-secret") flags["app-secret"] = args[++i];
    else if (arg === "--agreement-grant") flags["agreement-grant"] = args[++i];
    else if (arg === "--base-url") flags["base-url"] = args[++i];
    else if (!arg.startsWith("-")) flags.positional.push(arg);
  }
  return flags;
}

function credentialsPathSafe(): string {
  try {
    return credentialsPath();
  } catch {
    return "~/.config/e-conomic-mcp/credentials.json";
  }
}

async function readVersion(): Promise<string> {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(await readFile(pkgUrl, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
