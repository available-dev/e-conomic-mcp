/**
 * Thin HTTP client for the e-conomic REST API.
 *
 * Handles auth headers, JSON (de)serialization, query-string building,
 * timeouts, structured error reporting, and collection pagination.
 */

import type { Config } from "./config.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  method: HttpMethod;
  /** Endpoint path, e.g. "/customers" or "customers/123". Leading slash optional. */
  path: string;
  /** Query parameters. Arrays are repeated; objects are JSON-stringified. */
  query?: Record<string, unknown> | undefined;
  /** JSON request body (objects/arrays). Ignored for GET/DELETE. */
  body?: unknown;
}

export interface EconomicResponse {
  status: number;
  ok: boolean;
  data: unknown;
}

/** Error thrown for non-2xx responses, carrying the parsed body for context. */
export class EconomicApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly method: string,
    readonly url: string,
  ) {
    super(message);
    this.name = "EconomicApiError";
  }
}

export class EconomicClient {
  constructor(private readonly config: Config) {}

  /** Build a fully-qualified URL with an encoded query string. */
  buildUrl(path: string, query?: Record<string, unknown>): string {
    const normalizedPath = path.startsWith("http")
      ? path
      : `${this.config.baseUrl}/${path.replace(/^\/+/, "")}`;
    const url = new URL(normalizedPath);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const v of value) url.searchParams.append(key, String(v));
        } else if (typeof value === "object") {
          url.searchParams.append(key, JSON.stringify(value));
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }
    return url.toString();
  }

  async request(opts: RequestOptions): Promise<EconomicResponse> {
    const url = this.buildUrl(opts.path, opts.query);
    const headers: Record<string, string> = {
      "X-AgreementGrantToken": this.config.agreementGrantToken,
      Accept: "application/json",
    };
    // When a proxy injects the secret server-side, the client has none to send.
    if (this.config.appSecretToken) {
      headers["X-AppSecretToken"] = this.config.appSecretToken;
    }

    const hasBody =
      opts.body !== undefined && opts.method !== "GET" && opts.method !== "DELETE";
    if (hasBody) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: opts.method,
        headers,
        body: hasBody ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new EconomicApiError(
          `Request timed out after ${this.config.timeoutMs}ms`,
          0,
          null,
          opts.method,
          url,
        );
      }
      throw new EconomicApiError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
        0,
        null,
        opts.method,
        url,
      );
    } finally {
      clearTimeout(timer);
    }

    const data = await parseBody(response);

    if (!response.ok) {
      throw new EconomicApiError(
        `e-conomic API returned ${response.status} ${response.statusText} for ${opts.method} ${url}`,
        response.status,
        data,
        opts.method,
        url,
      );
    }

    return { status: response.status, ok: response.ok, data };
  }

  /**
   * Fetch a collection endpoint, optionally following pagination.
   *
   * e-conomic collections are paged via `skippages` + `pagesize` and expose a
   * `pagination` object plus a `collection` array in the response.
   */
  async collection(
    path: string,
    options: {
      filter?: string;
      sort?: string;
      pageSize?: number;
      maxItems?: number;
      fetchAll?: boolean;
      query?: Record<string, unknown>;
    } = {},
  ): Promise<{ items: unknown[]; pages: number; truncated: boolean }> {
    const pageSize = Math.min(options.pageSize ?? this.config.pageSize, 1000);
    const maxItems = options.maxItems ?? (options.fetchAll ? Infinity : pageSize);

    const items: unknown[] = [];
    let skippages = 0;
    let pages = 0;
    let truncated = false;

    while (items.length < maxItems) {
      const query: Record<string, unknown> = {
        ...options.query,
        skippages,
        pagesize: pageSize,
      };
      if (options.filter) query.filter = options.filter;
      if (options.sort) query.sort = options.sort;

      const { data } = await this.request({ method: "GET", path, query });
      pages += 1;

      const collection = extractCollection(data);
      if (collection.length === 0) break;

      for (const item of collection) {
        if (items.length >= maxItems) {
          truncated = true;
          break;
        }
        items.push(item);
      }

      // Stop when the API signals there are no further pages, or a short page
      // indicates we've reached the end.
      const hasNext = hasNextPage(data);
      if (!hasNext || collection.length < pageSize) break;
      if (!options.fetchAll && items.length >= maxItems) break;

      skippages += 1;
    }

    return { items, pages, truncated };
  }
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") || looksLikeJson(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function looksLikeJson(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

function extractCollection(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray((data as any).collection)) {
    return (data as any).collection;
  }
  return [];
}

function hasNextPage(data: unknown): boolean {
  if (data && typeof data === "object") {
    const pagination = (data as any).pagination;
    if (pagination && typeof pagination === "object") {
      return typeof pagination.nextPage === "string" && pagination.nextPage.length > 0;
    }
  }
  return true; // unknown shape: let the short-page check decide
}
