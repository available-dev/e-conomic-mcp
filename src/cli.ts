/**
 * Command-line interface for e-conomic-mcp.
 *
 * Commands:
 *   serve (default)   Start the MCP server over stdio.
 *   crawl-schemas     Download e-conomic's per-endpoint JSON schema files.
 *   doctor            Verify credentials and API connectivity.
 *
 * Global flags: --help/-h, --version/-v
 */

import { readFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { crawlSchemas } from "./crawl.js";

const HELP = `e-conomic-mcp — MCP server for the e-conomic REST API

Usage:
  e-conomic-mcp [serve]                 Start the MCP server over stdio (default)
  e-conomic-mcp crawl-schemas [outDir]  Download e-conomic JSON schema files
  e-conomic-mcp doctor                  Check credentials and API connectivity

Options:
  -h, --help        Show this help
  -v, --version     Show version

Environment (see .env.example for the full list):
  ECONOMIC_APP_SECRET_TOKEN        (required) app secret token
  ECONOMIC_AGREEMENT_GRANT_TOKEN   (required) agreement grant token
  ECONOMIC_BASE_URL                API base URL (default https://restapi.e-conomic.com)
  ECONOMIC_SCHEMA_DIR              directory of downloaded *.schema.json files
  ECONOMIC_OPENAPI_SPEC            path/URL to an OpenAPI spec (alternative)
  ECONOMIC_DYNAMIC_TOOLS           "true" to generate one tool per operation

crawl-schemas flags:
  --out <dir>            output directory (default ./spec/schemas)
  --schema-base <url>    schema host base (default <ECONOMIC_BASE_URL>/schema)
  --file-list <path>     newline-separated list of filenames to fetch
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
    case "crawl-schemas":
      await runCrawl(args.slice(1));
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

async function runCrawl(rest: string[]): Promise<void> {
  const flags = parseFlags(rest);
  const apiBaseUrl = (process.env.ECONOMIC_BASE_URL?.trim() || "https://restapi.e-conomic.com").replace(
    /\/+$/,
    "",
  );
  const outDir = flags.positional[0] || flags.out || "./spec/schemas";

  const result = await crawlSchemas({
    outDir,
    apiBaseUrl,
    schemaBaseUrl: flags["schema-base"],
    fileListPath: flags["file-list"],
    appSecretToken: process.env.ECONOMIC_APP_SECRET_TOKEN?.trim(),
    agreementGrantToken: process.env.ECONOMIC_AGREEMENT_GRANT_TOKEN?.trim(),
  });

  if (result.downloaded === 0) {
    process.stderr.write(
      "Nothing downloaded — check the schema base URL and credentials.\n",
    );
    process.exitCode = 2;
  }
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
  out?: string;
  "schema-base"?: string;
  "file-list"?: string;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--out") flags.out = args[++i];
    else if (arg === "--schema-base") flags["schema-base"] = args[++i];
    else if (arg === "--file-list") flags["file-list"] = args[++i];
    else if (!arg.startsWith("-")) flags.positional.push(arg);
  }
  return flags;
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
