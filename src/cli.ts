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
import { connect, DEFAULT_CALLBACK_PORT, callbackUrl } from "./connect.js";

const HELP = `e-conomic-mcp — MCP server for the e-conomic REST API

Usage:
  e-conomic-mcp [serve]            Start the MCP server over stdio (default)
  e-conomic-mcp auth connect       Grant access in the browser (recommended)
  e-conomic-mcp auth login         Interactively store credentials locally
  e-conomic-mcp auth set [flags]   Store credentials non-interactively
  e-conomic-mcp auth status        Show where credentials are coming from
  e-conomic-mcp auth logout        Remove locally stored credentials
  e-conomic-mcp doctor             Check credentials and API connectivity

Options:
  -h, --help        Show this help
  -v, --version     Show version

auth connect flags:
  --app-public <token>        app public token (from the developer portal)
  --app-secret <token>        app secret token (from the developer portal)
  --port <number>             loopback callback port (default: ${DEFAULT_CALLBACK_PORT};
                              must match the redirect URL registered on your app)
  --no-open                   don't open the browser automatically

auth set flags:
  --app-secret <token>        app secret token
  --agreement-grant <token>   agreement grant token
  --base-url <url>            override API base URL

Credentials resolve from environment variables first, then the local store
(${credentialsPathSafe()}):
  ECONOMIC_APP_SECRET_TOKEN, ECONOMIC_AGREEMENT_GRANT_TOKEN, ECONOMIC_BASE_URL

Other environment (see .env.example):
  ECONOMIC_OPENAPI_SPEC, ECONOMIC_DYNAMIC_TOOLS, ECONOMIC_DYNAMIC_TOOLS_LIMIT,
  ECONOMIC_PAGE_SIZE, ECONOMIC_TIMEOUT_MS
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
    case "connect":
      await authConnect(rest.slice(1));
      return;
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

async function authConnect(rest: string[]): Promise<void> {
  const flags = parseFlags(rest);
  const stored = loadStoredCredentials();

  const appPublicToken = (flags["app-public"] ?? stored?.appPublicToken ?? "").trim();
  let appSecretToken = (flags["app-secret"] ?? stored?.appSecretToken ?? "").trim();
  const port = flags.port ? Number.parseInt(flags.port, 10) : DEFAULT_CALLBACK_PORT;

  if (!appPublicToken || Number.isNaN(port) || port <= 0) {
    if (Number.isNaN(port) || port <= 0) {
      process.stderr.write(`Invalid --port value: "${flags.port}"\n`);
    } else {
      process.stderr.write(
        "Missing app public token. Pass --app-public <token> (find it on your app " +
          "in the e-conomic developer portal).\n",
      );
    }
    process.exitCode = 1;
    return;
  }

  // The app secret token is needed for actual API calls; prompt if we don't
  // already have it so the saved credentials are complete after connecting.
  if (!appSecretToken) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      appSecretToken = (await rl.question("App secret token: ")).trim();
    } finally {
      rl.close();
    }
  }

  try {
    const { agreementGrantToken, redirectUrl } = await connect({
      appPublicToken,
      port,
      openBrowser: !flags["no-open"],
    });
    const path = saveCredentials({
      appPublicToken,
      appSecretToken: appSecretToken || undefined,
      agreementGrantToken,
    });
    process.stderr.write(`\n✓ Connected. Saved credentials to ${path}\n`);
    process.stderr.write(`  Redirect URL used (register this on your app): ${redirectUrl}\n`);
    if (!appSecretToken) {
      process.stderr.write(
        "  Note: no app secret token stored — set it with `e-conomic-mcp auth set " +
          "--app-secret <token>` before the API will authenticate.\n",
      );
    }
  } catch (err) {
    process.stderr.write(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
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
    process.stderr.write(
      `\nNot fully configured. Run \`e-conomic-mcp auth connect\` to grant access in ` +
        `the browser (register redirect URL ${callbackUrl()} on your app), or ` +
        `\`e-conomic-mcp auth login\` to paste tokens manually.\n`,
    );
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
    const collections = collectResourceNames(root);
    process.stderr.write(`✓ Authenticated. ${collections.length} resource collections available.\n`);
    process.stderr.write(`  ${collections.slice(0, 20).join(", ")}${collections.length > 20 ? ", ..." : ""}\n`);
  } catch (err) {
    process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

/**
 * The e-conomic API root nests resource links under `resources.<category>`
 * (e.g. `stable`, `experimental`), each a map of name -> URL.
 */
function collectResourceNames(root: Record<string, unknown>): string[] {
  const names: string[] = [];
  const resources = root.resources;
  if (resources && typeof resources === "object") {
    for (const category of Object.values(resources as Record<string, unknown>)) {
      if (category && typeof category === "object") {
        for (const [name, url] of Object.entries(category as Record<string, unknown>)) {
          if (typeof url === "string" && url.startsWith("http")) names.push(name);
        }
      }
    }
  }
  return names;
}

interface ParsedFlags {
  positional: string[];
  "app-public"?: string;
  "app-secret"?: string;
  "agreement-grant"?: string;
  "base-url"?: string;
  port?: string;
  "no-open"?: boolean;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--app-public") flags["app-public"] = args[++i];
    else if (arg === "--app-secret") flags["app-secret"] = args[++i];
    else if (arg === "--agreement-grant") flags["agreement-grant"] = args[++i];
    else if (arg === "--base-url") flags["base-url"] = args[++i];
    else if (arg === "--port") flags.port = args[++i];
    else if (arg === "--no-open") flags["no-open"] = true;
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
