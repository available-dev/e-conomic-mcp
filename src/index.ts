#!/usr/bin/env node
/**
 * Binary entry point for the e-conomic MCP CLI.
 */

import { runCli } from "./cli.js";

runCli(process.argv.slice(2)).catch((err) => {
  console.error(`[e-conomic-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
