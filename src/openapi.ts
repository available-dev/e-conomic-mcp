/**
 * OpenAPI / Swagger loading and inspection.
 *
 * Supports both Swagger 2.0 and OpenAPI 3.x. The spec can be loaded from a
 * local file path or an HTTP(S) URL (set via ECONOMIC_OPENAPI_SPEC). It is used
 * for: (1) the discovery tools, and (2) optional per-endpoint tool generation.
 *
 * Loading is best-effort: if no spec is configured or it fails to load, the
 * server still runs with the generic + typed tools.
 */

import { readFile } from "node:fs/promises";

/**
 * Common surface implemented by every spec source (OpenAPI/Swagger and the
 * native e-conomic per-endpoint schema directory). The tool layer depends only
 * on this interface.
 */
export interface ApiSpec {
  readonly operations: OperationInfo[];
  readonly version: string;
  listByTag(): Record<string, OperationInfo[]>;
  findOperation(query: string): OperationInfo | undefined;
}

export interface OperationInfo {
  /** Stable identifier used as the tool name suffix. */
  operationId: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  parameters: ParameterInfo[];
  requestBodySchema?: JsonSchema;
  responseSchema?: JsonSchema;
}

export interface ParameterInfo {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description?: string;
  schema: JsonSchema;
}

export type JsonSchema = Record<string, unknown>;

interface RawSpec {
  swagger?: string;
  openapi?: string;
  paths?: Record<string, Record<string, any>>;
  definitions?: Record<string, any>;
  components?: { schemas?: Record<string, any> };
}

export class OpenApiSpec implements ApiSpec {
  private constructor(
    readonly raw: RawSpec,
    readonly operations: OperationInfo[],
    readonly version: "2.0" | "3.x",
  ) {}

  static async load(source: string): Promise<OpenApiSpec> {
    const text = await loadText(source);
    const raw = JSON.parse(text) as RawSpec;
    const version: "2.0" | "3.x" = raw.swagger?.startsWith("2") ? "2.0" : "3.x";
    const operations = extractOperations(raw, version);
    return new OpenApiSpec(raw, operations, version);
  }

  /** Group operation summaries by tag for discovery/listing. */
  listByTag(): Record<string, OperationInfo[]> {
    const groups: Record<string, OperationInfo[]> = {};
    for (const op of this.operations) {
      const tags = op.tags.length > 0 ? op.tags : ["(untagged)"];
      for (const tag of tags) {
        (groups[tag] ??= []).push(op);
      }
    }
    return groups;
  }

  findOperation(query: string): OperationInfo | undefined {
    const q = query.toLowerCase();
    return (
      this.operations.find((op) => op.operationId.toLowerCase() === q) ??
      this.operations.find((op) => `${op.method} ${op.path}`.toLowerCase() === q) ??
      this.operations.find((op) => op.path.toLowerCase() === q)
    );
  }
}

async function loadText(source: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`Failed to fetch OpenAPI spec from ${source}: HTTP ${res.status}`);
    }
    return res.text();
  }
  return readFile(source, "utf8");
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

function extractOperations(raw: RawSpec, version: "2.0" | "3.x"): OperationInfo[] {
  const operations: OperationInfo[] = [];
  const paths = raw.paths ?? {};

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    const sharedParams: any[] = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== "object") continue;

      const rawParams = [...sharedParams, ...(Array.isArray(op.parameters) ? op.parameters : [])]
        .map((p) => resolveRef(p, raw))
        .filter(Boolean);

      const parameters: ParameterInfo[] = [];
      let requestBodySchema: JsonSchema | undefined;

      for (const p of rawParams) {
        if (version === "2.0" && p.in === "body") {
          requestBodySchema = resolveSchema(p.schema, raw);
          continue;
        }
        parameters.push({
          name: p.name,
          in: p.in,
          required: Boolean(p.required),
          description: p.description,
          schema: version === "2.0" ? swagger2ParamSchema(p) : resolveSchema(p.schema, raw),
        });
      }

      if (version === "3.x" && op.requestBody) {
        const rb = resolveRef(op.requestBody, raw);
        const json = rb?.content?.["application/json"];
        if (json?.schema) requestBodySchema = resolveSchema(json.schema, raw);
      }

      const responseSchema = extractResponseSchema(op, raw, version);

      operations.push({
        operationId: op.operationId || synthesizeOperationId(method, path),
        method: method.toUpperCase(),
        path,
        summary: op.summary,
        description: op.description,
        tags: Array.isArray(op.tags) ? op.tags : [],
        parameters,
        requestBodySchema,
        responseSchema,
      });
    }
  }

  return operations;
}

/** Pull the success (2xx) response body schema, if present. */
function extractResponseSchema(op: any, raw: RawSpec, version: "2.0" | "3.x"): JsonSchema | undefined {
  const responses = op.responses;
  if (!responses || typeof responses !== "object") return undefined;
  const status =
    ["200", "201", "default"].find((s) => responses[s] !== undefined) ??
    Object.keys(responses).find((s) => s.startsWith("2"));
  if (!status) return undefined;
  const resp = resolveRef(responses[status], raw);
  if (!resp) return undefined;
  if (version === "2.0") {
    return resp.schema ? resolveSchema(resp.schema, raw) : undefined;
  }
  const json = resp.content?.["application/json"];
  return json?.schema ? resolveSchema(json.schema, raw) : undefined;
}

function swagger2ParamSchema(p: any): JsonSchema {
  const schema: JsonSchema = {};
  for (const key of ["type", "format", "enum", "items", "default", "minimum", "maximum"]) {
    if (p[key] !== undefined) schema[key] = p[key];
  }
  if (!schema.type) schema.type = "string";
  return schema;
}

function synthesizeOperationId(method: string, path: string): string {
  const slug = path
    .replace(/[{}]/g, "")
    .split("/")
    .filter(Boolean)
    .join("_")
    .replace(/[^a-zA-Z0-9_]/g, "_");
  return `${method}_${slug}`;
}

/** Resolve a single `$ref` one level (parameters/requestBody). */
function resolveRef(node: any, raw: RawSpec): any {
  if (node && typeof node === "object" && typeof node.$ref === "string") {
    return resolvePointer(node.$ref, raw) ?? node;
  }
  return node;
}

/**
 * Resolve a schema, expanding `$ref`s recursively (with cycle protection) so the
 * resulting JSON Schema is self-contained enough for an MCP tool input schema.
 */
function resolveSchema(schema: any, raw: RawSpec, seen = new Set<string>(), depth = 0): JsonSchema {
  if (!schema || typeof schema !== "object" || depth > 8) return {};
  if (typeof schema.$ref === "string") {
    if (seen.has(schema.$ref)) return {};
    seen.add(schema.$ref);
    const resolved = resolvePointer(schema.$ref, raw);
    return resolveSchema(resolved, raw, seen, depth + 1);
  }

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && value && typeof value === "object") {
      const props: Record<string, JsonSchema> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, any>)) {
        props[propName] = resolveSchema(propSchema, raw, new Set(seen), depth + 1);
      }
      out.properties = props;
    } else if (key === "items") {
      out.items = resolveSchema(value, raw, new Set(seen), depth + 1);
    } else if (key === "allOf" && Array.isArray(value)) {
      // Flatten allOf into a single object schema where possible.
      const merged: JsonSchema = { type: "object", properties: {} };
      for (const part of value) {
        const r = resolveSchema(part, raw, new Set(seen), depth + 1);
        if (r.properties) Object.assign(merged.properties as object, r.properties);
        if (r.required && Array.isArray(r.required)) {
          merged.required = [
            ...((merged.required as string[]) ?? []),
            ...(r.required as string[]),
          ];
        }
      }
      return merged;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function resolvePointer(ref: string, raw: RawSpec): any {
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref.slice(2).split("/");
  let node: any = raw;
  for (const part of parts) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    node = node?.[key];
    if (node === undefined) return undefined;
  }
  return node;
}
