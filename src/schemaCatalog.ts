/**
 * Loader for e-conomic's native per-endpoint JSON Schemas.
 *
 * e-conomic does not publish a single OpenAPI document. Instead each operation
 * has its own draft-03 JSON Schema file whose name encodes the path and method,
 * e.g.:
 *
 *   vat-zones.get.schema.json                 -> GET    /vat-zones
 *   vat-zones.vatZoneNumber.get.schema.json   -> GET    /vat-zones/{vatZoneNumber}
 *   customers.customerNumber.put.schema.json  -> PUT    /customers/{customerNumber}
 *
 * This loader reads a directory of such files, derives the operation list, and
 * exposes it through the shared {@link ApiSpec} interface so the discovery and
 * dynamic-tool layers work identically to the OpenAPI path. Draft-03 schemas
 * (which put `required` as a boolean on each property) are normalized to the
 * draft-07-style schemas MCP clients expect.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ApiSpec, JsonSchema, OperationInfo, ParameterInfo } from "./openapi.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

export class SchemaDirSpec implements ApiSpec {
  readonly version = "e-conomic-schemas";

  private constructor(readonly operations: OperationInfo[]) {}

  static async load(dir: string): Promise<SchemaDirSpec> {
    const files = await collectSchemaFiles(dir);
    const operations: OperationInfo[] = [];

    for (const file of files) {
      const parsed = parseFileName(file.name);
      if (!parsed) continue;
      let schema: JsonSchema;
      try {
        schema = JSON.parse(await readFile(file.fullPath, "utf8")) as JsonSchema;
      } catch {
        continue; // skip unparseable files rather than failing the whole load
      }
      operations.push(buildOperation(parsed, schema));
    }

    operations.sort((a, b) =>
      `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`),
    );
    return new SchemaDirSpec(operations);
  }

  listByTag(): Record<string, OperationInfo[]> {
    const groups: Record<string, OperationInfo[]> = {};
    for (const op of this.operations) {
      const tag = op.tags[0] ?? "(untagged)";
      (groups[tag] ??= []).push(op);
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

interface ParsedName {
  method: string;
  path: string;
  pathParams: string[];
  operationId: string;
  tag: string;
}

async function collectSchemaFiles(
  dir: string,
): Promise<Array<{ name: string; fullPath: string }>> {
  const out: Array<{ name: string; fullPath: string }> = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectSchemaFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".schema.json")) {
      out.push({ name: entry.name, fullPath: full });
    }
  }
  return out;
}

/**
 * Parse a schema filename into method + path. A dotted segment is treated as a
 * path parameter when it is camelCase (contains an uppercase letter); resource
 * names are lower/kebab-case (e.g. "vat-zones", "payment-terms").
 */
export function parseFileName(fileName: string): ParsedName | undefined {
  const base = fileName.replace(/\.schema\.json$/i, "");
  const tokens = base.split(".").filter(Boolean);
  if (tokens.length < 2) return undefined;

  const method = tokens[tokens.length - 1]!.toLowerCase();
  if (!HTTP_METHODS.has(method)) return undefined;

  const segments = tokens.slice(0, -1);
  const pathParams: string[] = [];
  const pathParts = segments.map((seg) => {
    if (isPathParam(seg)) {
      pathParams.push(seg);
      return `{${seg}}`;
    }
    return seg;
  });

  return {
    method: method.toUpperCase(),
    path: `/${pathParts.join("/")}`,
    pathParams,
    operationId: `${method}_${segments.join("_")}`,
    tag: segments[0] ?? "(untagged)",
  };
}

/**
 * Decide whether a dotted filename segment is a path parameter. e-conomic's
 * params are camelCase (e.g. `customerNumber`, `accountingYear`,
 * `accountingYear-voucherNumber`) plus a few bare lowercase identity tokens
 * (`id`, `code`, `customergroupnumber`). Literal sub-resources are lower/kebab
 * nouns (`totals`, `entries`, `lines`, `currency-specific-sales-prices`, ...).
 */
function isPathParam(seg: string): boolean {
  if (/[A-Z]/.test(seg)) return true;
  if (seg === "id") return true;
  if (/number$/i.test(seg) || /code$/i.test(seg)) return true;
  return false;
}

function buildOperation(parsed: ParsedName, schema: JsonSchema): OperationInfo {
  const normalized = normalizeDraft03(schema);

  const parameters: ParameterInfo[] = parsed.pathParams.map((name) => ({
    name,
    in: "path",
    required: true,
    description: `Path parameter: ${name}.`,
    schema: { type: /number$/i.test(name) ? "integer" : "string" },
  }));

  // For writes, the resource schema is the request body. For reads it describes
  // the response; we still surface it via requestBodySchema for documentation.
  const isWrite = parsed.method === "POST" || parsed.method === "PUT" || parsed.method === "PATCH";

  return {
    operationId: parsed.operationId,
    method: parsed.method,
    path: parsed.path,
    summary: typeof schema.title === "string" ? schema.title : undefined,
    description: typeof schema.description === "string" ? schema.description : undefined,
    tags: [parsed.tag],
    parameters,
    requestBodySchema: isWrite ? normalized : normalized,
  };
}

/**
 * Convert a draft-03 schema to a draft-07-ish schema:
 *  - move per-property `required: true` into a parent `required: [...]` array
 *  - recurse into properties/items
 *  - drop the `$schema`/`restdocs` meta keys
 */
export function normalizeDraft03(schema: JsonSchema): JsonSchema {
  if (!schema || typeof schema !== "object") return {};
  const out: JsonSchema = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema" || key === "restdocs" || key === "title" || key === "id") continue;
    if (key === "required" && typeof value === "boolean") continue; // handled by parent
    if (key === "properties" && value && typeof value === "object") {
      const props: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [propName, propSchema] of Object.entries(value as Record<string, JsonSchema>)) {
        if (propSchema && typeof propSchema === "object" && propSchema.required === true) {
          required.push(propName);
        }
        props[propName] = normalizeDraft03(propSchema);
      }
      out.properties = props;
      if (required.length > 0) {
        out.required = [...new Set([...(out.required as string[] ?? []), ...required])];
      }
    } else if (key === "items" && value && typeof value === "object") {
      out.items = normalizeDraft03(value as JsonSchema);
    } else {
      out[key] = value;
    }
  }

  return out;
}
