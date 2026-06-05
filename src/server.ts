/**
 * Builds the MCP server: loads config, constructs the e-conomic client, assembles
 * the tool set (generic + typed + optional dynamic), and wires up the
 * list/call request handlers.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import type { Config } from "./config.js";
import { EconomicClient, EconomicApiError } from "./economicClient.js";
import type { ApiSpec } from "./openapi.js";
import { OpenApiSpec } from "./openapi.js";
import { genericTools } from "./tools/generic.js";
import { typedTools } from "./tools/typed.js";
import { dynamicTools } from "./tools/dynamic.js";
import type { ToolDefinition } from "./tools/types.js";

export interface BuiltServer {
  server: Server;
  toolCount: number;
  specLoaded: boolean;
}

export async function buildServer(config: Config): Promise<BuiltServer> {
  const client = new EconomicClient(config);

  let spec: ApiSpec | undefined;
  if (config.openapiSpec) {
    try {
      spec = await OpenApiSpec.load(config.openapiSpec);
      console.error(
        `[e-conomic-mcp] Loaded OpenAPI spec (${spec.version}) with ${spec.operations.length} operations from ${config.openapiSpec}`,
      );
    } catch (err) {
      console.error(
        `[e-conomic-mcp] Warning: failed to load OpenAPI spec from ${config.openapiSpec}: ` +
          `${err instanceof Error ? err.message : String(err)}. Continuing without it.`,
      );
    }
  } else {
    // No schema source configured: fall back to the OpenAPI spec bundled with
    // the package (spec/economic-openapi.json at the package root), if present.
    const bundled = bundledOpenApiPath();
    if (bundled) {
      try {
        spec = await OpenApiSpec.load(bundled);
        console.error(
          `[e-conomic-mcp] Loaded ${spec.operations.length} operations from bundled spec.`,
        );
      } catch {
        // No bundled spec — fine, generic tools still cover everything.
      }
    }
  }

  const tools: ToolDefinition[] = [
    ...genericTools(client, spec),
    ...typedTools(client),
  ];

  if (config.dynamicTools) {
    if (spec) {
      const generated = dynamicTools(client, spec, config.dynamicToolsLimit);
      tools.push(...generated);
      console.error(
        `[e-conomic-mcp] Generated ${generated.length} per-endpoint tools (limit ${config.dynamicToolsLimit}).`,
      );
    } else {
      console.error(
        `[e-conomic-mcp] ECONOMIC_DYNAMIC_TOOLS is set but no OpenAPI spec is loaded; skipping dynamic tools.`,
      );
    }
  }

  const toolMap = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    if (toolMap.has(tool.name)) {
      console.error(`[e-conomic-mcp] Warning: duplicate tool name "${tool.name}" skipped.`);
      continue;
    }
    toolMap.set(tool.name, tool);
  }

  const server = new Server(
    { name: "e-conomic-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...toolMap.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as any,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = toolMap.get(request.params.name);
    if (!tool) {
      return errorResult(`Unknown tool: ${request.params.name}`);
    }
    try {
      const result = await tool.handler(request.params.arguments ?? {});
      return {
        content: [{ type: "text", text: stringify(result) }],
      };
    } catch (err) {
      return errorResult(formatError(err));
    }
  });

  return { server, toolCount: toolMap.size, specLoaded: Boolean(spec) };
}

/** Locate the OpenAPI spec shipped inside the package, if any. */
function bundledOpenApiPath(): string | undefined {
  try {
    const file = fileURLToPath(new URL("../spec/economic-openapi.json", import.meta.url));
    return existsSync(file) ? file : undefined;
  } catch {
    return undefined;
  }
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function formatError(err: unknown): string {
  if (err instanceof EconomicApiError) {
    const bodyText =
      err.body == null ? "" : `\nResponse body: ${stringify(err.body)}`;
    return `${err.message}${bodyText}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
