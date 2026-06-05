/**
 * Dynamic per-endpoint tool generation from an OpenAPI spec.
 *
 * Enabled only when ECONOMIC_DYNAMIC_TOOLS=true and a spec is loaded. Each
 * OpenAPI operation becomes its own MCP tool whose input schema combines path,
 * query and (where applicable) body parameters. Generation is capped so large
 * specs don't exceed client tool limits.
 */

import type { ClientRegistry } from "../clientRegistry.js";
import type { HttpMethod } from "../economicClient.js";
import type { ApiSpec, OperationInfo } from "../openapi.js";
import { PROFILE_PROPERTY, type ToolDefinition } from "./types.js";

export function dynamicTools(
  clients: ClientRegistry,
  spec: ApiSpec,
  limit: number,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const used = new Set<string>();

  for (const op of spec.operations) {
    if (tools.length >= limit) break;
    const name = toolName(op, used);
    tools.push({
      name,
      description: buildDescription(op),
      inputSchema: buildInputSchema(op),
      handler: makeHandler(clients, op),
    });
  }

  return tools;
}

function toolName(op: OperationInfo, used: Set<string>): string {
  let base = `economic_op_${sanitize(op.operationId)}`.slice(0, 64);
  let name = base;
  let i = 2;
  while (used.has(name)) {
    name = `${base.slice(0, 60)}_${i++}`;
  }
  used.add(name);
  return name;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

function buildDescription(op: OperationInfo): string {
  const head = op.summary || op.description || `${op.method} ${op.path}`;
  return `${head} [${op.method} ${op.path}]`.slice(0, 1024);
}

function buildInputSchema(op: OperationInfo): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const p of op.parameters) {
    if (p.in === "header" || p.in === "cookie") continue; // auth headers are injected
    const propName = paramKey(p.in, p.name);
    properties[propName] = {
      ...p.schema,
      description: [p.description, `(${p.in} parameter)`].filter(Boolean).join(" "),
    };
    if (p.required) required.push(propName);
  }

  if (op.requestBodySchema) {
    properties.body = {
      ...op.requestBodySchema,
      description: "JSON request body.",
    };
    if (op.method !== "GET") required.push("body");
  }

  // Expose the per-call account selector, unless the operation already has a
  // parameter literally named "profile".
  if (!("profile" in properties)) {
    properties.profile = PROFILE_PROPERTY.profile;
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/** Namespacing avoids collisions when a path and query param share a name. */
function paramKey(location: string, name: string): string {
  return location === "path" ? `path_${name}` : name;
}

function makeHandler(clients: ClientRegistry, op: OperationInfo) {
  return async (args: Record<string, any>) => {
    // Substitute path parameters.
    let path = op.path;
    const query: Record<string, unknown> = {};

    for (const p of op.parameters) {
      if (p.in === "header" || p.in === "cookie") continue;
      const key = paramKey(p.in, p.name);
      const value = args[key];
      if (value === undefined) continue;
      if (p.in === "path") {
        path = path.replace(
          new RegExp(`\\{${escapeRegExp(p.name)}\\}`, "g"),
          encodeURIComponent(String(value)),
        );
      } else if (p.in === "query") {
        query[p.name] = value;
      }
    }

    const res = await clients.resolve(args.profile).request({
      method: op.method as HttpMethod,
      path,
      query: Object.keys(query).length > 0 ? query : undefined,
      body: args.body,
    });
    return { status: res.status, data: res.data };
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
