/**
 * Generic, spec-agnostic tools. These provide full coverage of the e-conomic
 * REST API regardless of whether an OpenAPI spec is loaded: any endpoint can be
 * reached via `economic_request`, and the API's self-describing root powers
 * `economic_list_resources`.
 */

import { basename } from "node:path";
import { readFile } from "node:fs/promises";

import type { ClientRegistry } from "../clientRegistry.js";
import { EconomicApiError, type HttpMethod } from "../economicClient.js";
import type { ApiSpec } from "../openapi.js";
import { withProfile, type ToolDefinition } from "./types.js";

/**
 * Resolve the bytes + file name for an upload from either a local file path or
 * inline base64 content. Shared by the generic and typed upload tools.
 */
export async function resolveUploadData(args: Record<string, any>): Promise<{
  data: Uint8Array;
  fileName: string;
}> {
  const filePath = args.filePath ? String(args.filePath) : undefined;
  const content = args.content ? String(args.content) : undefined;

  if (filePath) {
    const data = await readFile(filePath);
    return { data, fileName: args.fileName ? String(args.fileName) : basename(filePath) };
  }
  if (content) {
    if (!args.fileName) {
      throw new EconomicApiError(
        "fileName is required when uploading inline base64 content.",
        400,
        null,
        "POST",
        "",
      );
    }
    return { data: new Uint8Array(Buffer.from(content, "base64")), fileName: String(args.fileName) };
  }
  throw new EconomicApiError(
    "Provide either filePath (a local file) or content (base64-encoded bytes) to upload.",
    400,
    null,
    "POST",
    "",
  );
}

export function genericTools(
  clients: ClientRegistry,
  spec: ApiSpec | undefined,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  tools.push({
    name: "economic_request",
    description:
      "Make an authenticated request to ANY e-conomic REST API endpoint. This is the " +
      "universal escape hatch that covers the entire API. Provide the HTTP method, the " +
      "endpoint path (e.g. '/customers', '/customers/123', '/invoices/drafts'), optional " +
      "query parameters, and an optional JSON body for writes. Auth headers are added " +
      "automatically.",
    inputSchema: {
      type: "object",
      properties: withProfile({
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "HTTP method.",
        },
        path: {
          type: "string",
          description:
            "Endpoint path relative to the API base URL (leading slash optional), " +
            "e.g. 'customers' or '/invoices/drafts/123'.",
        },
        query: {
          type: "object",
          additionalProperties: true,
          description:
            "Optional query parameters. Common ones: filter, sort, skippages, pagesize.",
        },
        body: {
          description: "Optional JSON body for POST/PUT/PATCH requests.",
        },
      }),
      required: ["method", "path"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const method = String(args.method).toUpperCase() as HttpMethod;
      const res = await clients.resolve(args.profile).request({
        method,
        path: String(args.path),
        query: args.query as Record<string, unknown> | undefined,
        body: args.body,
      });
      return { status: res.status, data: res.data };
    },
  });

  tools.push({
    name: "economic_upload_file",
    description:
      "Upload a binary file to ANY e-conomic endpoint that expects multipart/form-data — " +
      "the universal escape hatch for file uploads (the JSON-only economic_request cannot do " +
      "this). Use it for the attachment endpoints, e.g. POST a receipt to a voucher at " +
      "'/journals/{journalNumber}/vouchers/{accountingYear}-{voucherNumber}/attachment/file', " +
      "or to a draft invoice/order/quote at '/invoices/drafts/{n}/attachment/file'. Supported " +
      "formats are .pdf, .jpg, .jpeg, .gif and .png (draft invoices/orders/quotes accept PDF " +
      "only); max 9 MB. Provide the file via 'filePath' (read from disk) or 'content' " +
      "(base64-encoded bytes, with 'fileName'). Use method PATCH on a voucher to append pages " +
      "to an existing attachment. Auth headers and the multipart boundary are set automatically.",
    inputSchema: {
      type: "object",
      properties: withProfile({
        method: {
          type: "string",
          enum: ["POST", "PATCH"],
          description:
            "HTTP method. POST creates the attachment; PATCH appends pages (vouchers only). " +
            "Defaults to POST.",
        },
        path: {
          type: "string",
          description:
            "The multipart upload endpoint path, e.g. " +
            "'/journals/1/vouchers/2024-5/attachment/file'.",
        },
        filePath: {
          type: "string",
          description: "Absolute path to a local file to upload. Use this OR 'content'.",
        },
        content: {
          type: "string",
          description:
            "Base64-encoded file bytes, as an alternative to filePath. Requires 'fileName'.",
        },
        fileName: {
          type: "string",
          description:
            "File name including extension (e.g. 'receipt.pdf'). Required with 'content'; " +
            "defaults to the basename of filePath otherwise. The extension determines the MIME type.",
        },
        contentType: {
          type: "string",
          description: "Optional explicit MIME type; inferred from the file name when omitted.",
        },
      }),
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const { data, fileName } = await resolveUploadData(args);
      const res = await clients.resolve(args.profile).uploadFile({
        method: (args.method as "POST" | "PATCH" | undefined) ?? "POST",
        path: String(args.path),
        data,
        fileName,
        contentType: args.contentType as string | undefined,
      });
      return { status: res.status, data: res.data };
    },
  });

  tools.push({
    name: "economic_list_resources",
    description:
      "List the top-level resource collections exposed by the e-conomic REST API. " +
      "Uses the loaded OpenAPI spec when available, otherwise queries the API's " +
      "self-describing root. Use this to discover what endpoints exist before calling " +
      "economic_request.",
    inputSchema: {
      type: "object",
      properties: withProfile({}),
      additionalProperties: false,
    },
    handler: async (args) => {
      if (spec) {
        const byTag = spec.listByTag();
        const tags = Object.fromEntries(
          Object.entries(byTag).map(([tag, ops]) => [
            tag,
            ops.map((op) => `${op.method} ${op.path}${op.summary ? ` — ${op.summary}` : ""}`),
          ]),
        );
        return { source: "openapi-spec", operationCount: spec.operations.length, tags };
      }
      // Fall back to the self-describing root endpoint.
      const res = await clients.resolve(args.profile).request({ method: "GET", path: "/" });
      return { source: "api-root", data: res.data };
    },
  });

  tools.push({
    name: "economic_get_collection",
    description:
      "Fetch a collection endpoint with built-in pagination, filtering and sorting. " +
      "e-conomic uses a filter syntax like \"name$like:Acme\" and sort like \"name\" or " +
      "\"-customerNumber\". Set fetchAll=true to follow all pages (bounded by maxItems).",
    inputSchema: {
      type: "object",
      properties: withProfile({
        path: {
          type: "string",
          description: "Collection path, e.g. 'customers', 'products', 'invoices/booked'.",
        },
        filter: {
          type: "string",
          description:
            "e-conomic filter expression, e.g. \"customerNumber$gte:1000\" or " +
            "\"name$like:Acme\". Combine with '$and:' / '$or:'.",
        },
        sort: {
          type: "string",
          description: "Field to sort by; prefix with '-' for descending.",
        },
        pageSize: { type: "integer", minimum: 1, maximum: 1000 },
        maxItems: {
          type: "integer",
          minimum: 1,
          description: "Maximum total items to return.",
        },
        fetchAll: {
          type: "boolean",
          description: "Follow pagination until all pages are read (up to maxItems).",
        },
      }),
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const result = await clients.resolve(args.profile).collection(String(args.path), {
        filter: args.filter as string | undefined,
        sort: args.sort as string | undefined,
        pageSize: args.pageSize as number | undefined,
        maxItems: args.maxItems as number | undefined,
        fetchAll: Boolean(args.fetchAll),
      });
      return {
        count: result.items.length,
        pages: result.pages,
        truncated: result.truncated,
        items: result.items,
      };
    },
  });

  if (spec) {
    tools.push({
      name: "economic_describe_endpoint",
      description:
        "Return the parameters and request-body schema for a specific endpoint from the " +
        "loaded OpenAPI spec. Identify the endpoint by operationId or by 'METHOD /path' " +
        "(e.g. 'GET /customers'). Use this to learn required fields before a write.",
      inputSchema: {
        type: "object",
        properties: {
          endpoint: {
            type: "string",
            description: "operationId, a path, or 'METHOD /path'.",
          },
        },
        required: ["endpoint"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const op = spec.findOperation(String(args.endpoint));
        if (!op) {
          throw new EconomicApiError(
            `No endpoint found matching "${args.endpoint}". Use economic_list_resources to browse.`,
            404,
            null,
            "GET",
            String(args.endpoint),
          );
        }
        return {
          operationId: op.operationId,
          method: op.method,
          path: op.path,
          summary: op.summary,
          description: op.description,
          tags: op.tags,
          parameters: op.parameters,
          requestBodySchema: op.requestBodySchema,
          responseSchema: op.responseSchema,
          fileUpload: op.fileUpload,
          ...(op.fileUpload
            ? {
                uploadHint:
                  "This is a multipart/form-data file upload. Use economic_upload_file " +
                  "(or the dynamic tool, which takes filePath/content) — not economic_request, " +
                  "which only sends JSON.",
              }
            : {}),
        };
      },
    });
  }

  return tools;
}
