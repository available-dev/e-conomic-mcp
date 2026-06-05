#!/usr/bin/env node
/**
 * Entry point for the e-conomic MCP server (stdio transport).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { server, toolCount, specLoaded } = await buildServer(config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `[e-conomic-mcp] Ready on stdio. ${toolCount} tools available` +
      `${specLoaded ? " (OpenAPI spec loaded)" : ""}. Base URL: ${config.baseUrl}`,
  );
}

main().catch((err) => {
  console.error(`[e-conomic-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
