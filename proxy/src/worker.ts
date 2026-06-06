/**
 * e-conomic MCP proxy — Cloudflare Worker.
 *
 * Holds the app secret token server-side so end users never need it. The Worker
 * forwards every request to the e-conomic REST API, adding `X-AppSecretToken`
 * from a Cloudflare secret and passing through the caller's own
 * `X-AgreementGrantToken`.
 *
 * Deploy:
 *   cd proxy
 *   npm install
 *   npx wrangler secret put ECONOMIC_APP_SECRET_TOKEN   # paste the app secret
 *   npx wrangler deploy
 *
 * Then set BUNDLED_PROXY_URL in src/appCredentials.ts to the deployed URL.
 */

export interface Env {
  /** The e-conomic app secret token (set via `wrangler secret put`). */
  ECONOMIC_APP_SECRET_TOKEN: string;
  /** Upstream API base. Defaults to the production e-conomic REST API. */
  UPSTREAM_BASE_URL?: string;
}

const DEFAULT_UPSTREAM = "https://restapi.e-conomic.com";

// Headers we forward from the client to e-conomic. The secret is added by the
// Worker; hop-by-hop and host headers are intentionally dropped.
const FORWARD_REQUEST_HEADERS = [
  "x-agreementgranttoken",
  "accept",
  "content-type",
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.ECONOMIC_APP_SECRET_TOKEN) {
      return text(500, "Proxy misconfigured: ECONOMIC_APP_SECRET_TOKEN is not set.");
    }

    const grantToken = request.headers.get("X-AgreementGrantToken");
    if (!grantToken) {
      return text(401, "Missing X-AgreementGrantToken header.");
    }

    const incoming = new URL(request.url);
    if (incoming.pathname === "/" && request.method === "GET" && incoming.searchParams.has("health")) {
      return text(200, "ok");
    }

    const upstreamBase = (env.UPSTREAM_BASE_URL ?? DEFAULT_UPSTREAM).replace(/\/+$/, "");
    const target = `${upstreamBase}${incoming.pathname}${incoming.search}`;

    const headers = new Headers();
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("X-AppSecretToken", env.ECONOMIC_APP_SECRET_TOKEN);
    if (!headers.has("accept")) headers.set("Accept", "application/json");

    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
        // Required by Workers when streaming a request body through.
        ...(hasBody ? { duplex: "half" } : {}),
      } as RequestInit);
    } catch (err) {
      return text(502, `Upstream request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Pass the upstream response straight back, preserving status and content type.
    const respHeaders = new Headers();
    const contentType = upstream.headers.get("content-type");
    if (contentType) respHeaders.set("content-type", contentType);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  },
};

function text(status: number, body: string): Response {
  return new Response(body + "\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
