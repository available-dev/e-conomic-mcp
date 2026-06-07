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

import { loadProfiles } from "./config.js";
import { buildServer } from "./server.js";
import {
  DEFAULT_PROFILE,
  clearCredentials,
  credentialsPath,
  loadStore,
  maskSecret,
  removeProfile,
  saveProfileCredentials,
  setDefaultProfile,
} from "./credentials.js";

const HELP = `e-conomic-mcp — MCP server for the e-conomic REST API

Usage:
  e-conomic-mcp [serve]            Start the MCP server over stdio (default)
  e-conomic-mcp auth login         Interactively store credentials locally
  e-conomic-mcp auth set [flags]   Store credentials non-interactively
  e-conomic-mcp auth list          List configured account profiles
  e-conomic-mcp auth use <name>    Set the default account profile
  e-conomic-mcp auth status        Show where credentials are coming from
  e-conomic-mcp auth remove <name> Remove a stored account profile
  e-conomic-mcp auth logout        Remove all locally stored credentials
  e-conomic-mcp doctor             Check credentials and API connectivity

Options:
  -h, --help        Show this help
  -v, --version     Show version

auth set flags:
  --profile <name>            account profile to store under (default: ${DEFAULT_PROFILE})
  --app-secret <token>        app secret token
  --agreement-grant <token>   agreement grant token
  --base-url <url>            override API base URL

Multiple accounts/companies are supported as named profiles. Per-tool calls can
target a profile, and the active one can be switched at runtime. Select the
default profile with \`auth use <name>\` or the ECONOMIC_PROFILE env var.

Credentials resolve from environment variables first, then the local store
(${credentialsPathSafe()}):
  ECONOMIC_APP_SECRET_TOKEN, ECONOMIC_AGREEMENT_GRANT_TOKEN, ECONOMIC_BASE_URL,
  ECONOMIC_PROFILE

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
      await doctor(args.slice(1));
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

async function serve(): Promise<void> {
  const registry = loadProfiles();
  // Fail fast if the active profile can't be resolved (mirrors prior behaviour).
  const active = registry.get();
  const { server, toolCount, specLoaded } = await buildServer(registry);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const profileCount = registry.names.length;
  console.error(
    `[e-conomic-mcp] Ready on stdio. ${toolCount} tools available` +
      `${specLoaded ? " (API schema loaded)" : ""}. ` +
      `Active profile: ${registry.defaultProfile}` +
      `${profileCount > 1 ? ` (${profileCount} configured)` : ""}. Base URL: ${active.baseUrl}`,
  );
}

async function auth(rest: string[]): Promise<void> {
  const sub = rest[0] ?? "status";
  switch (sub) {
    case "login":
      await authLogin(rest.slice(1));
      return;
    case "set":
      authSet(rest.slice(1));
      return;
    case "list":
    case "ls":
      authList();
      return;
    case "use":
    case "select":
      authUse(rest.slice(1));
      return;
    case "remove":
    case "rm":
    case "delete":
      authRemove(rest.slice(1));
      return;
    case "status":
      authStatus(rest.slice(1));
      return;
    case "logout":
      authLogout(rest.slice(1));
      return;
    default:
      process.stderr.write(`Unknown auth subcommand: ${sub}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

async function authLogin(rest: string[]): Promise<void> {
  const flags = parseFlags(rest);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(
      "Enter your e-conomic credentials (stored locally, never transmitted except to the API).\n",
    );
    const profile =
      flags.profile?.trim() ||
      (await rl.question(`Profile name [${DEFAULT_PROFILE}]: `)).trim() ||
      DEFAULT_PROFILE;
    const appSecretToken = (await rl.question("App secret token: ")).trim();
    const agreementGrantToken = (await rl.question("Agreement grant token: ")).trim();
    const baseUrl = (await rl.question("Base URL [https://restapi.e-conomic.com]: ")).trim();

    if (!appSecretToken || !agreementGrantToken) {
      process.stderr.write("Both tokens are required. Aborted.\n");
      process.exitCode = 1;
      return;
    }
    const path = saveProfileCredentials(profile, {
      appSecretToken,
      agreementGrantToken,
      baseUrl: baseUrl || undefined,
    });
    process.stderr.write(`✓ Saved profile "${profile}" to ${path}\n`);
  } finally {
    rl.close();
  }
}

function authSet(rest: string[]): void {
  const flags = parseFlags(rest);
  const profile = flags.profile?.trim() || DEFAULT_PROFILE;
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
  const path = saveProfileCredentials(profile, update);
  process.stderr.write(`✓ Saved profile "${profile}" to ${path}\n`);
}

function authList(): void {
  const store = loadStore();
  const names = Object.keys(store.profiles);
  process.stderr.write(`Credential store: ${credentialsPath()}\n`);
  if (names.length === 0) {
    process.stderr.write("No stored profiles. Run `e-conomic-mcp auth login`.\n");
    return;
  }
  const envProfile = process.env.ECONOMIC_PROFILE?.trim();
  const active = envProfile || store.defaultProfile;
  for (const name of names) {
    const creds = store.profiles[name]!;
    const marker = name === active ? "*" : " ";
    const usable = creds.appSecretToken && creds.agreementGrantToken ? "" : "  (incomplete)";
    const base = creds.baseUrl ? `  ${creds.baseUrl}` : "";
    process.stderr.write(`${marker} ${name}${base}${usable}\n`);
  }
  process.stderr.write(`\n* = active profile${envProfile ? " (via ECONOMIC_PROFILE)" : ""}\n`);
}

function authUse(rest: string[]): void {
  const name = rest.find((a) => !a.startsWith("-"));
  if (!name) {
    process.stderr.write("Usage: e-conomic-mcp auth use <profile>\n");
    process.exitCode = 1;
    return;
  }
  try {
    setDefaultProfile(name);
    process.stderr.write(`✓ Default profile is now "${name}".\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

function authRemove(rest: string[]): void {
  const name = rest.find((a) => !a.startsWith("-"));
  if (!name) {
    process.stderr.write("Usage: e-conomic-mcp auth remove <profile>\n");
    process.exitCode = 1;
    return;
  }
  const removed = removeProfile(name);
  process.stderr.write(
    removed ? `✓ Removed profile "${name}".\n` : `No stored profile "${name}".\n`,
  );
  if (!removed) process.exitCode = 1;
}

function authStatus(rest: string[]): void {
  const flags = parseFlags(rest);
  const store = loadStore();
  const envProfile = process.env.ECONOMIC_PROFILE?.trim();
  const profile = flags.profile?.trim() || envProfile || store.defaultProfile;
  const stored = store.profiles[profile];

  const envSecret = process.env.ECONOMIC_APP_SECRET_TOKEN?.trim();
  const envGrant = process.env.ECONOMIC_AGREEMENT_GRANT_TOKEN?.trim();
  // Env credentials apply to the active profile only.
  const isActive = profile === (envProfile || store.defaultProfile);
  const effSecret = isActive ? envSecret : undefined;
  const effGrant = isActive ? envGrant : undefined;

  const secretSrc = effSecret ? "env" : stored?.appSecretToken ? "store" : "none";
  const grantSrc = effGrant ? "env" : stored?.agreementGrantToken ? "store" : "none";

  process.stderr.write(`Credential store: ${credentialsPath()}\n`);
  process.stderr.write(`Profile: ${profile}${profile === store.defaultProfile ? " (default)" : ""}\n`);
  process.stderr.write(
    `App secret token:      ${maskSecret(effSecret || stored?.appSecretToken)} [${secretSrc}]\n`,
  );
  process.stderr.write(
    `Agreement grant token: ${maskSecret(effGrant || stored?.agreementGrantToken)} [${grantSrc}]\n`,
  );
  if (secretSrc === "none" || grantSrc === "none") {
    process.stderr.write(
      `\nProfile "${profile}" is not fully configured. Run \`e-conomic-mcp auth login\`.\n`,
    );
  }
}

function authLogout(rest: string[]): void {
  const flags = parseFlags(rest);
  if (flags.profile?.trim()) {
    const removed = removeProfile(flags.profile.trim());
    process.stderr.write(
      removed
        ? `✓ Removed profile "${flags.profile.trim()}".\n`
        : `No stored profile "${flags.profile.trim()}".\n`,
    );
    return;
  }
  const removed = clearCredentials();
  process.stderr.write(
    removed ? "✓ Removed all locally stored credentials.\n" : "No stored credentials to remove.\n",
  );
}

async function doctor(rest: string[] = []): Promise<void> {
  const flags = parseFlags(rest);
  const registry = loadProfiles();

  let targets: string[];
  if (flags.all) {
    targets = registry.names;
    if (targets.length === 0) {
      process.stderr.write("No profiles configured. Run `e-conomic-mcp auth login`.\n");
      process.exitCode = 1;
      return;
    }
  } else {
    targets = [flags.profile?.trim() || registry.defaultProfile];
  }

  let anyFailed = false;
  for (const name of targets) {
    if (targets.length > 1) process.stderr.write(`\n[profile: ${name}]\n`);
    const ok = await doctorProfile(registry, name);
    if (!ok) anyFailed = true;
  }
  if (anyFailed) process.exitCode = 1;
}

async function doctorProfile(
  registry: ReturnType<typeof loadProfiles>,
  name: string,
): Promise<boolean> {
  let config;
  try {
    config = registry.get(name);
  } catch (err) {
    process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
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
      return false;
    }
    const root = (await res.json()) as Record<string, unknown>;
    const collections = collectResourceNames(root);
    process.stderr.write(`✓ Authenticated. ${collections.length} resource collections available.\n`);
    process.stderr.write(`  ${collections.slice(0, 20).join(", ")}${collections.length > 20 ? ", ..." : ""}\n`);
    return true;
  } catch (err) {
    process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
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
  profile?: string;
  all?: boolean;
  "app-secret"?: string;
  "agreement-grant"?: string;
  "base-url"?: string;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--profile" || arg === "-p") flags.profile = args[++i];
    else if (arg === "--all") flags.all = true;
    else if (arg === "--app-secret") flags["app-secret"] = args[++i];
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
